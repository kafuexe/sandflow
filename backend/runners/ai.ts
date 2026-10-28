import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { auxModelEnv, ENDPOINT_ENV, GATEWAY_ENV } from "../../shared/agents";
import { INTERRUPTED_PROMPT } from "../../shared/journal";
import { CORE_PACK } from "../../shared/packs";
import { agentOrigin, nodeLabel, PROJECT_ENV, resolveNode } from "../../shared/resolve";
import { hostAgentEnv, resolveRunOn } from "../../shared/runOn";
import { SKILL_NAME_RE, SKILL_SOURCE_RE, skillKey } from "../../shared/skills";
import { agentIdleTimeoutSeconds } from "../../shared/supervisor";
import type { AgentProvider, EnvValues, Flow, FlowNode, NodeIO, QaPair, ResolvedConfig, RunOn, SandboxKind, SkillRef } from "../../shared/types";
import type { NodeResult, RerunFrom, RunContext } from "../engine";
import { buildPrompt, parseOutput, tail, type RouteOption } from "../prompt";
import { ensureSandboxReady, execCli, sandboxProviderOptions, stoppableProvider, withAgentEnv } from "../sandbox";
import { SKILL_FILE_PATH_RE, type SkillFile } from "../skills";
import { agentStreamHandler, type StreamEvent } from "./activity";
import { canResumeSessions, resumingAgent, Steering, steerPrompt } from "./steer";
import { codeOwner, filesPack, trustedOnHost } from "./trust";
import { onlyDocsChanged, parseVerdict } from "../../shared/gates";
import { startDevServer } from "./devServer";
import { gateResult } from "./gate";
import { shQuote } from "./script";

/** Where installed packs are mounted (read-only) inside the run's sandbox. */
export const SANDBOX_PACKS_DIR = "/opt/sandflow/packs";

/** The subset of sandcastle's `Sandbox` / `SandboxRunResult` this runner relies on. */
interface RunResultLike {
  stdout: string;
  completionSignal?: string;
  commits: { sha: string }[];
  iterations: { usage?: { inputTokens: number; outputTokens: number; cacheReadInputTokens: number; cacheCreationInputTokens: number } }[];
  resume?: (prompt: string, options?: Record<string, unknown>) => Promise<RunResultLike>;
}
export interface SandboxLike {
  exec(command: string, options?: { stdin?: string; cwd?: string; onLine?: (line: string) => void }): Promise<{ exitCode: number; stdout?: string; stderr?: string }>;
  run(options: Record<string, unknown>): Promise<RunResultLike>;
  close(): Promise<unknown>;
}

const AGENT_FLAGS: Partial<Record<AgentProvider, string>> = {
  claudeCode: "claude-code",
  codex: "codex",
  opencode: "opencode",
  cursor: "cursor",
  copilot: "github-copilot",
};

export const agentFlag = (p: AgentProvider) => AGENT_FLAGS[p];

/** `npx skills add …` command for a skill, or undefined when the ref isn't safe to put on a command line. */
export function skillInstallCommand(skill: SkillRef, provider: AgentProvider): string | undefined {
  if (!skill.source || !SKILL_SOURCE_RE.test(skill.source) || !SKILL_NAME_RE.test(skill.name)) return undefined;
  const flag = agentFlag(provider);
  return `npx -y skills@latest add ${skill.source} --skill ${skill.name} -g${flag ? ` -a ${flag}` : ""} -y`;
}

const MAX_QUESTION_ROUNDS = 5;
/** Extra turns for steering messages that couldn't be delivered mid-turn. */
const MAX_STEER_TURNS = 10;
const COMPLETE = "<promise>COMPLETE</promise>";

/** Where each agent reads user-level skills from (relative to $HOME). Only Claude Code for now. */
const SKILL_HOME: Partial<Record<AgentProvider, string>> = { claudeCode: ".claude/skills" };

/**
 * Copy a file skill into the agent's user-level skills dir: inside the container via `exec` + stdin,
 * or straight onto this machine when running without a sandbox.
 */
export async function installFileSkill(
  ctx: RunContext,
  sandbox: SandboxLike,
  provider: AgentProvider,
  skill: SkillRef,
  files: SkillFile[],
  nodeId: string,
  home = os.homedir(),
  onHost = ctx.settings.sandbox === "none",
) {
  const rel = SKILL_HOME[provider];
  if (!rel) {
    ctx.log("warn", `Skill ${skill.name} skipped: file skills are only supported for claudeCode agents (this block uses ${provider})`, nodeId);
    return;
  }
  if (!SKILL_NAME_RE.test(skill.name)) throw new Error(`Invalid skill name "${skill.name}"`);
  for (const f of files) if (!SKILL_FILE_PATH_RE.test(f.path)) throw new Error(`Invalid skill file path "${f.path}"`);
  // Scripts saved with Windows line endings fail with "/bin/sh^M: bad interpreter" — normalise them.
  files = files.map((f) => (f.content.startsWith("#!") ? { ...f, content: f.content.replace(/\r\n/g, "\n") } : f));

  if (onHost) {
    const dest = path.join(home, ...rel.split("/"), skill.name);
    for (const f of files) {
      const p = path.join(dest, ...f.path.split("/"));
      await fs.mkdir(path.dirname(p), { recursive: true });
      await fs.writeFile(p, f.content, { mode: f.content.startsWith("#!") ? 0o755 : 0o644 });
    }
    ctx.log("info", `Installed skill ${skill.name} to ${dest} (no sandbox — this is your own home directory)`, nodeId);
    return;
  }

  const base = `"$HOME/${rel}/${skill.name}`;
  const clear = await sandbox.exec(`rm -rf ${base}"`);
  if (clear.exitCode !== 0) throw new Error(`could not clear old copy (exit ${clear.exitCode})`);
  for (const f of files) {
    const dir = f.path.includes("/") ? `/${f.path.slice(0, f.path.lastIndexOf("/"))}` : "";
    const target = `${base}/${f.path}"`;
    const chmod = f.content.startsWith("#!") ? ` && chmod +x ${target}` : "";
    const r = await sandbox.exec(`mkdir -p ${base}${dir}" && cat > ${target}${chmod}`, { stdin: f.content });
    if (r.exitCode !== 0) throw new Error(`writing ${f.path} failed (exit ${r.exitCode}): ${tail(r.stderr ?? "", 300)}`);
  }
  ctx.log("info", `Installed skill ${skill.name} (${files.length} file${files.length === 1 ? "" : "s"})`, nodeId);
}

/** Branch for the run's shared sandbox: Create task's branch, else BRANCH_NAME, else a per-run branch. */
export function sandboxBranch(ctx: RunContext): string {
  return ctx.branch || ctx.env.BRANCH_NAME?.trim() || `sandflow/${ctx.run.id}`;
}

const execFileP = promisify(execFile);

/** No REPO_PATH: agents of this run work in an empty scratch workspace instead of a project checkout. */
export const usesScratchWorkspace = (ctx: RunContext) => !ctx.env[PROJECT_ENV]?.trim();

/**
 * A fresh, empty workspace for a run without a project: a temp dir made a git repo with one empty commit, so
 * sandcastle's worktree/branch handling works unchanged (the history is throwaway).
 */
export async function createScratchWorkspace(): Promise<string> {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "sandflow-scratch-")));
  const git = (...args: string[]) => execFileP("git", args, { cwd: dir, windowsHide: true });
  try {
    await git("init", "-q");
    await git("-c", "user.name=Sandflow", "-c", "user.email=sandflow@localhost", "-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", "Empty workspace");
  } catch (e) {
    await fs.rm(dir, { recursive: true, force: true });
    throw new Error(`Could not create a scratch workspace (is git installed?): ${(e as Error).message}`);
  }
  return dir;
}

const scratchDirs = new WeakMap<object, { dir: Promise<string>; keep: boolean }>();

/**
 * The run's scratch workspace (created once per run, shared by all its agents). It is removed when the run ends —
 * unless an agent ran on this computer in it, then it's kept (and its path logged) so the user can look at the result.
 */
export function scratchWorkspace(ctx: RunContext, onHost = false): Promise<string> {
  let entry = scratchDirs.get(ctx.run);
  if (!entry) {
    const created = { dir: createScratchWorkspace(), keep: false };
    entry = created;
    scratchDirs.set(ctx.run, entry);
    ctx.cleanup.push(async () => {
      const dir = await created.dir.catch(() => undefined);
      if (dir && !created.keep) await fs.rm(dir, { recursive: true, force: true });
    });
  }
  if (onHost && !entry.keep) {
    entry.keep = true;
    void entry.dir.then((d) => ctx.log("info", `No project path (${PROJECT_ENV}) — the agent works in a new folder on this computer: ${d}`), () => {});
  }
  return entry.dir;
}

/**
 * The run's shared sandbox (created on first use): a worktree on the task branch, with every installed pack mounted.
 * `kind` defaults to Settings → Sandbox; another kind (an agent block's own `runOn`) gets its own sandbox on the same
 * branch — sandcastle reuses the branch's worktree, so container and host agents see the same files.
 * Without REPO_PATH it is a worktree of the run's scratch workspace (see `scratchWorkspace`).
 */
export async function getSandbox(ctx: RunContext, kind: SandboxKind = ctx.settings.sandbox): Promise<SandboxLike> {
  const cached = kind === ctx.settings.sandbox ? ctx.sandbox : ctx.sandboxes?.[kind];
  if (cached) return cached as SandboxLike;
  // Calls that arrive while it's being created wait for the same one (stack children sharing a workspace run at once).
  const pending = (ctx.sandboxPending ??= {});
  pending[kind] ??= createRunSandbox(ctx, kind).finally(() => {
    delete pending[kind];
  });
  return (await pending[kind]) as SandboxLike;
}

async function createRunSandbox(ctx: RunContext, kind: SandboxKind): Promise<SandboxLike> {
  const isDefault = kind === ctx.settings.sandbox;
  const sc = await import("@ai-hero/sandcastle");
  const settings = isDefault ? ctx.settings : { ...ctx.settings, sandbox: kind };
  // Docker/Podman: the image must already be loaded (offline bundle) — never let `docker run` try to pull it.
  await ensureSandboxReady(settings);
  const packMounts = (ctx.packs?.dirs() ?? [])
    .filter((p) => existsSync(p.dir))
    .map((p) => ({ hostPath: p.dir, sandboxPath: `${SANDBOX_PACKS_DIR}/${p.id}` }));
  // The sandbox outlives the node that creates it: only the run's own abort tears it down.
  const signal = (ctx.runAbort ?? ctx.abort).signal;
  if (signal.aborted) throw new Error("Run cancelled");
  const baseProvider =
    kind === "docker"
      ? (await import("@ai-hero/sandcastle/sandboxes/docker")).docker(sandboxProviderOptions(settings, packMounts))
      : kind === "podman"
        ? (await import("@ai-hero/sandcastle/sandboxes/podman")).podman(sandboxProviderOptions(settings, packMounts))
        : (await import("@ai-hero/sandcastle/sandboxes/no-sandbox")).noSandbox();
  // Stopping the run kills the agent's processes / container, not just the wait for them.
  // Container ids and agent pids go into the journal: what a crash leaves behind is removed before the run continues.
  const provider = stoppableProvider(baseProvider, kind, signal, undefined, {
    container: (id) => kind !== "none" && ctx.noteContainer?.(kind, id),
    process: (pid, startedAt, running) => ctx.noteProcess?.(pid, startedAt, running),
  });
  const scratch = usesScratchWorkspace(ctx);
  const repo = scratch ? await scratchWorkspace(ctx, kind === "none") : ctx.env[PROJECT_ENV]!.trim();
  const branch = sandboxBranch(ctx);
  const where = kind === "none" ? "this computer" : `${kind} sandbox`;
  ctx.log("info", scratch ? `No ${PROJECT_ENV} — preparing ${where} in an empty scratch workspace…` : `Preparing ${where} on branch ${branch}…`);
  const sandbox = await sc.createSandbox({
    branch,
    // A scratch workspace has only its own branch to fork from.
    baseBranch: scratch ? undefined : ctx.baseBranch || ctx.env.BASE_BRANCH?.trim() || undefined,
    sandbox: provider as Parameters<typeof sc.createSandbox>[0]["sandbox"],
    cwd: repo,
  });
  // Stopped while the sandbox was starting: the run's cleanup has already run, so tear this one down now.
  if (signal.aborted) {
    await sandbox.close().catch(() => {});
    throw new Error("Run cancelled");
  }
  if (isDefault) ctx.sandbox = sandbox;
  else (ctx.sandboxes ??= {})[kind] = sandbox;
  // A scratch branch exists nowhere after the run — don't report it as the run's branch.
  if (!scratch) ctx.run.branch ??= branch;
  // First in line: the worktree must close before the scratch workspace it lives in is removed.
  ctx.cleanup.unshift(async () => {
    const res = await sandbox.close();
    if (res.preservedWorktreePath && !scratch) ctx.log("warn", `Worktree had uncommitted changes, preserved at ${res.preservedWorktreePath}`);
  });
  ctx.log("info", `${kind === "none" ? "Ready on this computer" : "Sandbox ready"} (${scratch ? "scratch workspace" : "worktree"} ${sandbox.worktreePath})`);
  return sandbox as unknown as SandboxLike;
}

/** The node's flow, then the flows around it (subflows), innermost first. */
const flowChain = (ctx: RunContext): Flow[] => [ctx.flow, ...(ctx.outerFlows ?? [])].filter((f): f is Flow => !!f);

/** Where an agent node runs: its own `runOn` (node, then block chain), then its flow's and the enclosing flows', then Settings → Sandbox. */
export function agentRunOn(ctx: RunContext, cfg: ResolvedConfig): RunOn {
  return resolveRunOn([cfg.runOn, ...flowChain(ctx).map((f) => f.runOn)], ctx.settings.sandbox)!;
}

/** The sandbox kind for an agent node: `none` on this computer; a container otherwise (Docker when Settings say None). */
export function agentSandboxKind(ctx: RunContext, cfg: ResolvedConfig): SandboxKind {
  if (agentRunOn(ctx, cfg) === "host") return "none";
  return ctx.settings.sandbox === "none" ? "docker" : ctx.settings.sandbox;
}

/**
 * The pack that chose to run this node on this computer (undefined = you did, or nobody chose explicitly). Like
 * Script blocks, a pack may only do that when you trust it to run code on this machine.
 */
export function hostChoiceOwner(ctx: RunContext, node: FlowNode, cfg: ResolvedConfig): string | undefined {
  const packOf = (f: Flow | undefined) => (f?.pack && f.pack !== CORE_PACK ? f.pack : undefined);
  if (cfg.runOn === "host") {
    if (node.data.overrides?.runOn === "host") return packOf(ctx.flow);
    return codeOwner(ctx, node, (c) => (c.runOn === "host" ? c.runOn : undefined));
  }
  // Inherited: the innermost flow that chose.
  if (cfg.runOn === "inherit") return packOf(flowChain(ctx).find((f) => f.runOn === "sandbox" || f.runOn === "host"));
  return undefined;
}

/** The provider's gateway settings from Inputs (see GATEWAY_ENV), under whatever the block passes itself. */
export function withGatewayEnv(cfg: ResolvedConfig, env: EnvValues, blockEnv: Record<string, string>): Record<string, string> {
  const keys = GATEWAY_ENV[cfg.agent.provider] ?? [];
  const gateway = keys.filter((k) => env[k]?.trim()).map((k) => [k, env[k].trim()]);
  // A blank login var (say, no API key next to a gateway token) is left out rather than passed empty.
  const own = Object.entries(blockEnv).filter(([k, v]) => !keys.includes(k) || v.trim());
  return { ...Object.fromEntries(gateway), ...Object.fromEntries(own) };
}

/** The block's env plus the custom endpoint (if any) under the provider's base-URL variable. */
export function agentEnv(cfg: ResolvedConfig, blockEnv: Record<string, string>): Record<string, string> {
  const endpoint = cfg.agent.endpoint?.trim();
  if (!endpoint) return blockEnv;
  const name = cfg.agent.endpointEnv?.trim() || ENDPOINT_ENV[cfg.agent.provider];
  if (!name) {
    throw new Error(`Set "Endpoint env var" — ${cfg.agent.provider} has no default variable for a custom endpoint`);
  }
  return { ...blockEnv, [name]: endpoint };
}

async function makeAgent(cfg: ResolvedConfig, env: Record<string, string>) {
  const sc = (await import("@ai-hero/sandcastle")) as unknown as Record<string, unknown>;
  const factory = sc[cfg.agent.provider];
  if (typeof factory !== "function") {
    throw new Error(`Agent provider "${cfg.agent.provider}" is not exported by @ai-hero/sandcastle`);
  }
  const model = cfg.agent.model?.trim();
  // Env goes on the agent only — agent env and sandbox env must not overlap.
  const agent = factory(model || CLI_DEFAULT_MODEL, { effort: cfg.agent.effort, env });
  return model ? agent : withoutModelFlag(agent as AgentLike);
}

/** Stand-in model name for "no model set": its `--model` / `-m` flag is removed from the CLI command. */
export const CLI_DEFAULT_MODEL = "__sandflow_cli_default_model__";

type AgentLike = {
  buildPrintCommand?: (...a: unknown[]) => { command: string } & Record<string, unknown>;
  buildInteractiveArgs?: (...a: unknown[]) => string[];
} & Record<string, unknown>;

/**
 * Sandcastle's agent providers always pass a model (`--model <m>`, codex `-m <m>`). With no model set we want the
 * CLI's own default — the same as the Edit-with-AI chat — so drop the placeholder's flag from the command it builds.
 */
export function withoutModelFlag<T extends AgentLike>(agent: T): T {
  const flag = new RegExp(` (?:--model|-m) '${CLI_DEFAULT_MODEL}'`, "g");
  const out: AgentLike = { ...agent };
  const print = agent.buildPrintCommand;
  if (print) out.buildPrintCommand = (...a) => {
    const r = print.apply(agent, a);
    return { ...r, command: r.command.replace(flag, "") };
  };
  const interactive = agent.buildInteractiveArgs;
  if (interactive) out.buildInteractiveArgs = (...a) => {
    const args = interactive.apply(agent, a);
    const i = args.indexOf(CLI_DEFAULT_MODEL);
    return i > 0 && (args[i - 1] === "--model" || args[i - 1] === "-m") ? [...args.slice(0, i - 1), ...args.slice(i + 1)] : args;
  };
  return out as T;
}

/** Where the node's model was set, for the run log: this node, a block / template in its chain, or the default. */
function modelSource(node: FlowNode, ctx: RunContext): string {
  const o = agentOrigin("model", node.data.blockId, ctx.blocks, node.data.overrides);
  return o.layer === "node" ? "set on this node" : o.layer === "block" ? `from ${o.blockName}` : "no model set";
}

function routesFor(ctx: RunContext, node: FlowNode): RouteOption[] {
  const edges = ctx.flow.edges.filter((e) => e.source === node.id);
  const targets = [...new Set(edges.map((e) => e.target))];
  return targets.flatMap((id) => {
    const t = ctx.flow.nodes.find((n) => n.id === id);
    if (!t) return [];
    let description = "";
    try {
      description = resolveNode(t, ctx.blocks).description;
    } catch {
      /* broken template chain — still offer the route */
    }
    return [{
      id,
      label: nodeLabel(t, ctx.blocks),
      description,
      handles: [...new Set(edges.filter((e) => e.target === id).map((e) => e.targetHandle))],
    }];
  });
}

function logUsage(ctx: RunContext, nodeId: string, res: RunResultLike, cfg: ResolvedConfig) {
  const usage = res.iterations.reduce(
    (a, i) => ({
      in: a.in + (i.usage?.inputTokens ?? 0),
      out: a.out + (i.usage?.outputTokens ?? 0),
      cacheRead: a.cacheRead + (i.usage?.cacheReadInputTokens ?? 0),
      cacheWrite: a.cacheWrite + (i.usage?.cacheCreationInputTokens ?? 0),
    }),
    { in: 0, out: 0, cacheRead: 0, cacheWrite: 0 },
  );
  // Journaled per result when the agent reports usage. sandcastle doesn't report cost: the engine prices it by model
  // (Claude Code only — other providers' model names aren't in the price table).
  const model = cfg.agent.provider === "claudeCode" ? cfg.agent.model.trim() : undefined;
  if (res.iterations.some((i) => i.usage)) {
    ctx.noteUsage?.(nodeId, { inputTokens: usage.in, outputTokens: usage.out, cacheReadTokens: usage.cacheRead, cacheWriteTokens: usage.cacheWrite, model });
  }
  ctx.log(
    "info",
    `Agent finished: ${res.iterations.length} iteration(s), ${res.commits.length} commit(s), tokens in ${usage.in} / out ${usage.out}` +
      (usage.cacheRead || usage.cacheWrite ? ` / cache read ${usage.cacheRead} / cache write ${usage.cacheWrite}` : ""),
    nodeId,
  );
  // When streaming to a log dir the agent text is already in the run log.
  if (!ctx.logDir && res.stdout.trim()) ctx.log("agent", tail(res.stdout, 1500), nodeId);
}

export async function runAi(ctx: RunContext, node: FlowNode, cfg: ResolvedConfig, inputs: NodeIO): Promise<NodeResult> {
  const release: (() => unknown)[] = [];
  try {
    return await runAgentNode(ctx, node, cfg, inputs, release);
  } finally {
    for (const fn of release) await Promise.resolve().then(fn).catch(() => {});
  }
}

/** Files the run's branch changed against its base (committed and not), or undefined when that can't be told. */
async function changedFiles(ctx: RunContext, sandbox: SandboxLike): Promise<string[] | undefined> {
  const base = ctx.baseBranch || ctx.env.BASE_BRANCH?.trim();
  if (!base) return undefined;
  const r = await sandbox.exec(
    `{ git diff --name-only ${shQuote(`origin/${base}`)}...HEAD 2>/dev/null || git diff --name-only ${shQuote(base)}...HEAD; } && git status --porcelain --untracked-files=all | cut -c4-`,
  );
  if (r.exitCode !== 0) return undefined;
  return [...new Set((r.stdout ?? "").split(/\r?\n/).map((l) => l.trim().replace(/^.* -> /, "")).filter(Boolean))];
}

async function runAgentNode(ctx: RunContext, node: FlowNode, cfg: ResolvedConfig, inputs: NodeIO, release: (() => unknown)[]): Promise<NodeResult> {
  // Steering messages are accepted from the start; ones sent while the sandbox is prepared go into the first prompt.
  const steering = new Steering({
    steerable: ctx.steerable ? (onSteer) => ctx.steerable!(node.id, onSteer) : undefined,
    log: (level, msg) => ctx.log(level, msg, node.id),
  });
  release.push(() => steering.close());
  const kind = agentSandboxKind(ctx, cfg);
  const onHost = kind === "none";
  // Chosen on the block / node / flow (not just Settings → Sandbox: None): use the local CLI's own login.
  const explicitHost = resolveRunOn([cfg.runOn, ...flowChain(ctx).map((f) => f.runOn)]) === "host";
  if (explicitHost) {
    const owner = hostChoiceOwner(ctx, node, cfg);
    if (owner && !trustedOnHost(ctx, owner)) {
      throw new Error(
        `Pack "${owner}" wants this agent to run on this computer, but it isn't allowed to run code here — trust the pack in Packs, or set "Run on" to Sandbox container on this node`,
      );
    }
    ctx.log("warn", "Running on this computer with your own agent CLI and login — no container; the agent can access this machine", node.id);
  }
  const sandbox = await getSandbox(ctx, kind);
  const blockEnv = withGatewayEnv(cfg, ctx.env, ctx.blockEnv(cfg));
  const endpointVar = cfg.agent.endpointEnv?.trim() || ENDPOINT_ENV[cfg.agent.provider];
  const endpoint = cfg.agent.endpoint?.trim() || (endpointVar ? blockEnv[endpointVar] : undefined);
  // Talking to a custom endpoint or gateway needs its credentials, even with the local CLI's own login.
  const env = explicitHost ? hostAgentEnv(blockEnv, !!endpoint) : blockEnv;
  const label = nodeLabel(node, ctx.blocks);

  // A tester has nothing to run when only docs changed (MEOW's risk selection): pass without starting the agent.
  if (cfg.verdict && cfg.skipDocsOnly) {
    const files = await changedFiles(ctx, sandbox);
    if (files && onlyDocsChanged(files)) {
      ctx.log("info", `Only docs changed (${files.join(", ")}) — skipped, counted as PASS`, node.id);
      return gateResult(ctx, node, {
        artifact: `Skipped: this branch only changes documentation (${files.join(", ")}), so there was nothing to test.`,
        passSteer: inputs.steer,
      });
    }
  }

  for (const skill of cfg.skills) {
    // Container and host have separate homes, so a skill is installed once per place.
    const key = `${kind}:${skillKey(skill)}`;
    if (ctx.installedSkills.has(key)) continue;
    ctx.installedSkills.add(key);
    if (skill.file) {
      try {
        if (!ctx.loadSkill) throw new Error("no skill store configured");
        const files = await ctx.loadSkill(skill.file);
        await installFileSkill(ctx, sandbox, cfg.agent.provider, skill, files, node.id, undefined, onHost);
      } catch (e) {
        ctx.log("warn", `Skill ${skill.name} failed to install: ${(e as Error).message}`, node.id);
      }
      continue;
    }
    const cmd = skillInstallCommand(skill, cfg.agent.provider);
    if (!cmd) {
      ctx.log("warn", `Skipping skill with unsafe name/source: ${skill.source} ${skill.name}`, node.id);
      continue;
    }
    ctx.log("info", `Installing skill ${skill.name} (${skill.source})`, node.id);
    const r = await sandbox.exec(cmd);
    if (r.exitCode !== 0) ctx.log("warn", `Skill ${skill.name} failed to install (exit ${r.exitCode}): ${tail(r.stderr ?? "", 500)}`, node.id);
  }

  // Files of the pack this block comes from: mounted in the sandbox, or right where they are without one.
  const pack = filesPack(ctx, node);
  const packDir = pack ? (onHost ? ctx.packs?.runtime(pack)?.dir : `${SANDBOX_PACKS_DIR}/${pack}`) : undefined;
  const finalEnv = agentEnv(cfg, env);
  const aux = auxModelEnv(cfg.agent.provider, cfg.agent.model, finalEnv, !!endpoint);
  const fullEnv = { ...finalEnv, ...aux, ...(packDir ? { PACK_DIR: packDir } : {}) };
  // sandcastle doesn't hand a sandbox's agent its provider env: the sandbox's exec does (see withAgentEnv).
  const scoped = withAgentEnv(await makeAgent(cfg, fullEnv), fullEnv);
  release.push(scoped.release);
  // This node stopped on its own (`stopNode`: stuck, timeout…): kill the agent's current command, not the sandbox.
  const stopAgent = () => void scoped.interrupt().catch(() => {});
  if (ctx.runAbort) {
    ctx.abort.signal.addEventListener("abort", stopAgent, { once: true });
    release.push(() => ctx.abort.signal.removeEventListener("abort", stopAgent));
  }
  const agent = scoped.agent;
  steering.agent = agent;
  steering.interrupt = scoped.interrupt;
  ctx.log(
    "info",
    cfg.agent.model.trim()
      ? `Agent: ${cfg.agent.provider} · model ${cfg.agent.model} (${modelSource(node, ctx)})`
      : `Agent: ${cfg.agent.provider} · the CLI's default model (no model set)`,
    node.id,
  );
  if (Object.keys(aux).length) ctx.log("info", `Gateway with a non-Claude model: Claude Code's other models (${Object.keys(aux).join(", ")}) use ${cfg.agent.model} too`, node.id);
  if (endpoint) ctx.log("info", `Agent endpoint: ${endpoint}`, node.id);
  const routes = cfg.kind === "manager" ? routesFor(ctx, node) : undefined;
  /** Where this agent's session lives: this computer, or the run's current container of its kind. */
  const where = onHost ? "host" : (ctx.run.sandboxes?.filter((c) => c.kind === kind).at(-1)?.containerId ?? kind);
  const qa: QaPair[] = [];
  const stream = agentStreamHandler(ctx, node.id, cfg.agent.provider);
  const idle = agentIdleTimeoutSeconds(ctx.settings);
  const baseOptions = {
    name: label,
    // Sandcastle's idle timeout sits above the supervisor's stuck check: the supervisor decides (and says why).
    ...(idle ? { idleTimeoutSeconds: idle } : {}),
    ...(cfg.maxIterations > 1 ? { completionSignal: COMPLETE } : {}),
    ...(ctx.logDir
      ? {
          logging: {
            type: "file",
            path: path.join(ctx.logDir, `${node.id.replace(/[^\w-]/g, "_")}.log`),
            onAgentStreamEvent: (ev: StreamEvent & { iteration?: number }) => {
              stream(ev);
              // The agent's session id, so a steering message can resume it — and a continued run, after a crash.
              if (ev.type === "raw" && typeof ev.line === "string") {
                steering.seeLine(ev.line, ev.iteration);
                if (steering.session) ctx.noteSession?.(node.id, { id: steering.session, where });
              }
            },
          },
        }
      : {}),
  };

  type Start = (signal: AbortSignal) => Promise<RunResultLike>;
  const runFresh = (signal: AbortSignal, maxIterations = cfg.maxIterations, preface?: string) =>
    sandbox.run({
      ...baseOptions,
      signal,
      agent,
      prompt: (preface ? `${preface}\n\n---\n\n` : "") + buildPrompt({
        cfg,
        inputs,
        startingPrompt: ctx.settings.startingPrompt,
        qa,
        routes,
        packDir,
        scratch: usesScratchWorkspace(ctx),
        steering: steering.applied,
      }),
      maxIterations,
    });
  // Follow up in the same agent session when possible, otherwise re-run with the extra context in the prompt.
  // Steering messages that are still waiting go along with it.
  const followUp = (res: RunResultLike, message: string): Start => {
    const steers = steering.take("next-turn");
    const text = steers.length ? `${steerPrompt(steers, false)}\n\n${message}` : message;
    return (signal) => (res.resume ? res.resume(text, { name: label, signal, ...(idle ? { idleTimeoutSeconds: idle } : {}) }) : runFresh(signal));
  };
  const merge = (a: RunResultLike | undefined, b: RunResultLike): RunResultLike =>
    a ? { ...b, stdout: a.stdout + b.stdout, commits: [...a.commits, ...b.commits], iterations: [...a.iterations, ...b.iterations] } : b;

  /**
   * One turn of the agent (`budget` = its iterations). A steering message interrupts it and resumes the same
   * session with the message; then, in an iteration loop, the iterations still due run as usual.
   */
  const turn = async (start: Start, budget = 1): Promise<RunResultLike> => {
    let call = start;
    let resuming = false;
    let used = 0;
    let done: RunResultLike | undefined;
    for (;;) {
      const ctl = new AbortController();
      steering.begin(ctl);
      let res: RunResultLike;
      try {
        res = await call(AbortSignal.any([ctx.abort.signal, ctl.signal]));
      } catch (e) {
        if (ctx.abort.signal.aborted) throw e;
        if (steering.steered(ctl)) {
          if (!resuming) used += Math.max(1, steering.iteration);
          const session = steering.session!;
          await steering.settled();
          if (ctx.abort.signal.aborted) throw new Error("Run cancelled");
          const messages = steering.take("interrupt");
          ctx.log("info", `Resuming the agent's session ${session} with the steering message`, node.id);
          call = (signal) => sandbox.run({ ...baseOptions, signal, agent: resumingAgent(agent, session), prompt: steerPrompt(messages, true), maxIterations: 1 });
          resuming = true;
          continue;
        }
        if (resuming) {
          // E.g. the agent was stopped before its session was saved: start over, the messages are in the prompt.
          ctx.log("warn", `Couldn't resume the agent's session after steering (${tail((e as Error).message, 300)}) — starting it again with your message in its prompt`, node.id);
          call = (signal) => runFresh(signal, Math.max(1, budget - used));
          resuming = false;
          continue;
        }
        throw e;
      } finally {
        steering.end(ctl);
      }
      if (!resuming) used += Math.max(1, res.iterations.length);
      done = merge(done, res);
      // Iteration loop: an interrupted iteration was finished by the resumed turn; the rest still run.
      if (resuming && budget - used > 0 && !res.completionSignal) {
        const left = budget - used;
        call = (signal) => runFresh(signal, left);
        resuming = false;
        continue;
      }
      logUsage(ctx, node.id, done, cfg);
      return done;
    }
  };
  /**
   * The first call of the attempt. After an interruption (pause / crash) the agent first continues its own session
   * with "you were interrupted…" (MEOW resumes a session on its first query only); when that session can't be
   * continued (its container is gone, it was never saved, the resume fails) it starts fresh with that message plus
   * its original task. After a failure (recovery) the message says how the previous attempt ended; a recycled
   * session (`fresh`) starts fresh with it right away.
   */
  function firstCall(again: RerunFrom | undefined): Start {
    if (!again) return (signal) => runFresh(signal);
    const prompt = again.prompt ?? INTERRUPTED_PROMPT;
    const what = again.prompt ? "This step runs again after its failure" : "This step was interrupted";
    const recap = (signal: AbortSignal) => runFresh(signal, cfg.maxIterations, prompt);
    if (again.fresh) {
      ctx.log("info", `${what} — starting a fresh agent session with its task and a note to check what's already done`, node.id);
      return recap;
    }
    const s = again.session;
    const why =
      !s ? "its session was never saved"
      : !canResumeSessions(agent) ? `${cfg.agent.provider} can't continue a session`
      : s.where !== where ? (s.where === "host" ? "it ran on this computer, now it runs in a container" : "its container is gone")
      : undefined;
    if (why) {
      ctx.log("warn", `${what}; its agent session can't be continued (${why}) — starting it again with its task and a note to check what's already done`, node.id);
      return recap;
    }
    return async (signal) => {
      ctx.log("info", `${what} — continuing the agent's own session ${s!.id}`, node.id);
      try {
        return await sandbox.run({ ...baseOptions, signal, agent: resumingAgent(agent, s!.id), prompt, maxIterations: 1 });
      } catch (e) {
        if (signal.aborted) throw e;
        ctx.log("warn", `Couldn't continue the agent's session ${s!.id} (${tail((e as Error).message, 300)}) — starting it again with its task and a note to check what's already done`, node.id);
        return recap(signal);
      }
    };
  }

  /** Steering messages that arrived when the agent couldn't take them mid-turn: one more turn with them. */
  const settle = async (res: RunResultLike): Promise<RunResultLike> => {
    for (let i = 0; i < MAX_STEER_TURNS && steering.pending().length; i++) {
      const steers = steering.take("next-turn");
      ctx.log("info", "Giving the agent the steering message as its next turn", node.id);
      res = await turn((signal) => (res.resume ? res.resume(steerPrompt(steers, false), { name: label, signal, ...(idle ? { idleTimeoutSeconds: idle } : {}) }) : runFresh(signal)));
    }
    return res;
  };

  if (onHost && cfg.devServer.command.trim()) {
    const owner = codeOwner(ctx, node, (c) => c.devServer?.command);
    if (!trustedOnHost(ctx, owner)) throw new Error(`This dev server command comes from pack "${owner}", which isn't allowed to run code on this machine (Packs → ${owner})`);
  }
  const server = await startDevServer(ctx, node.id, cfg, sandbox, onHost, env);
  if (server) release.push(() => server.stop());

  // Messages sent while the sandbox was being prepared are part of the first prompt.
  steering.take("next-turn");
  let res = await settle(await turn(firstCall(ctx.takeInterrupted?.(node.id)), cfg.maxIterations));
  let parsed = parseOutput(res.stdout);

  if (cfg.allowQuestions) {
    for (let round = 0; parsed.question && round < MAX_QUESTION_ROUNDS; round++) {
      const answer = await ctx.ask(node.id, parsed.question);
      qa.push({ question: parsed.question, answer });
      res = await settle(await turn(followUp(res, `The user answered your question.\n\nQ: ${parsed.question}\nA: ${answer}\n\nContinue the task and follow the output protocol.`)));
      parsed = parseOutput(res.stdout);
    }
  }

  if (cfg.kind === "manager") {
    const valid = routes?.map((r) => r.id) ?? [];
    if (valid.length && (!parsed.route || !valid.includes(parsed.route))) {
      ctx.log("warn", `Invalid route "${parsed.route ?? ""}" — asking the manager again`, node.id);
      res = await settle(await turn(followUp(res, `"${parsed.route ?? ""}" is not a valid route. Reply with exactly one of: ${valid.map((v) => `<route>${v}</route>`).join(" ")}`)));
      const retry = parseOutput(res.stdout);
      parsed = { ...parsed, route: retry.route, steer: retry.steer ?? parsed.steer };
    }
    return {
      route: parsed.route,
      outputs: { artifact: inputs.artifact, steer: parsed.steer ?? inputs.steer },
    };
  }

  if (cfg.verdict) {
    // A gate: PASS or FAIL decides the exit. Asked once more when it's missing; still missing = FAIL (MEOW).
    let verdict = parseVerdict(res.stdout);
    if (!verdict) {
      ctx.log("warn", "No verdict in the agent's answer — asking it for one", node.id);
      res = await settle(await turn(followUp(res, "You didn't give a verdict. Reply with your artifact again, ending with exactly <verdict>PASS</verdict> or <verdict>FAIL</verdict>.")));
      const retry = parseOutput(res.stdout);
      parsed = { ...parsed, artifact: retry.artifact ?? parsed.artifact, steer: retry.steer ?? parsed.steer };
      verdict = parseVerdict(res.stdout);
    }
    if (!verdict) ctx.log("warn", "Still no valid verdict — counted as FAIL", node.id);
    ctx.log("info", `Verdict: ${verdict ? verdict.toUpperCase() : "missing (FAIL)"}`, node.id);
    const artifact = parsed.artifact ?? tail(res.stdout.trim());
    const steer = parsed.steer ?? inputs.steer;
    // FAIL and no verdict both get the block's failure level.
    return gateResult(ctx, node, {
      level: verdict === "pass" ? undefined : cfg.onFail,
      failures: verdict ? "verdict FAIL" : "no valid verdict",
      artifact: verdict ? artifact : `${artifact}\n\n(No valid verdict was given, so this counts as FAIL.)`,
      passSteer: steer,
      failSteer: steer,
    });
  }

  const outputs: NodeIO = {};
  if (cfg.outputs.artifact) outputs.artifact = parsed.artifact ?? tail(res.stdout.trim());
  if (cfg.outputs.steer && parsed.steer !== undefined) outputs.steer = parsed.steer;
  return { outputs };
}
