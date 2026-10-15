import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { ENDPOINT_ENV } from "../../shared/agents";
import { CORE_PACK } from "../../shared/packs";
import { nodeLabel, PROJECT_ENV, resolveNode } from "../../shared/resolve";
import { hostAgentEnv, resolveRunOn } from "../../shared/runOn";
import { SKILL_NAME_RE, SKILL_SOURCE_RE, skillKey } from "../../shared/skills";
import type { AgentProvider, Flow, FlowNode, NodeIO, QaPair, ResolvedConfig, RunOn, SandboxKind, SkillRef } from "../../shared/types";
import type { NodeResult, RunContext } from "../engine";
import { buildPrompt, parseOutput, tail, type RouteOption } from "../prompt";
import { ensureSandboxReady, execCli, sandboxProviderOptions } from "../sandbox";
import { SKILL_FILE_PATH_RE, type SkillFile } from "../skills";
import { codeOwner, filesPack, trustedOnHost } from "./trust";

/** Where installed packs are mounted (read-only) inside the run's sandbox. */
export const SANDBOX_PACKS_DIR = "/opt/sandflow/packs";

/** The subset of sandcastle's `Sandbox` / `SandboxRunResult` this runner relies on. */
interface RunResultLike {
  stdout: string;
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
  const isDefault = kind === ctx.settings.sandbox;
  const cached = isDefault ? ctx.sandbox : ctx.sandboxes?.[kind];
  if (cached) return cached as SandboxLike;
  const sc = await import("@ai-hero/sandcastle");
  const settings = isDefault ? ctx.settings : { ...ctx.settings, sandbox: kind };
  // Docker/Podman: the image must already be loaded (offline bundle) — never let `docker run` try to pull it.
  await ensureSandboxReady(settings);
  const packMounts = (ctx.packs?.dirs() ?? [])
    .filter((p) => existsSync(p.dir))
    .map((p) => ({ hostPath: p.dir, sandboxPath: `${SANDBOX_PACKS_DIR}/${p.id}` }));
  const provider =
    kind === "docker"
      ? (await import("@ai-hero/sandcastle/sandboxes/docker")).docker(sandboxProviderOptions(settings, packMounts))
      : kind === "podman"
        ? (await import("@ai-hero/sandcastle/sandboxes/podman")).podman(sandboxProviderOptions(settings, packMounts))
        : (await import("@ai-hero/sandcastle/sandboxes/no-sandbox")).noSandbox();
  const scratch = usesScratchWorkspace(ctx);
  const repo = scratch ? await scratchWorkspace(ctx, kind === "none") : ctx.env[PROJECT_ENV]!.trim();
  const branch = sandboxBranch(ctx);
  const where = kind === "none" ? "this computer" : `${kind} sandbox`;
  ctx.log("info", scratch ? `No ${PROJECT_ENV} — preparing ${where} in an empty scratch workspace…` : `Preparing ${where} on branch ${branch}…`);
  const sandbox = await sc.createSandbox({
    branch,
    // A scratch workspace has only its own branch to fork from.
    baseBranch: scratch ? undefined : ctx.env.BASE_BRANCH?.trim() || undefined,
    sandbox: provider as Parameters<typeof sc.createSandbox>[0]["sandbox"],
    cwd: repo,
  });
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

/** The flow a top-level run started from (subflows see their own flow as `ctx.flow`). */
const rootFlow = (ctx: RunContext): Flow | undefined => ctx.flows?.find((f) => f.id === ctx.run.flowId);

/** Where an agent node runs: its own `runOn` (node, then block chain), then its flow's, then Settings → Sandbox. */
export function agentRunOn(ctx: RunContext, cfg: ResolvedConfig): RunOn {
  return resolveRunOn([cfg.runOn, ctx.flow?.runOn, rootFlow(ctx)?.runOn], ctx.settings.sandbox)!;
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
  if (cfg.runOn === "inherit") return packOf(ctx.flow?.runOn ? ctx.flow : rootFlow(ctx));
  return undefined;
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
  // Env goes on the agent only — agent env and sandbox env must not overlap.
  return factory(cfg.agent.model, { effort: cfg.agent.effort, env });
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

function logUsage(ctx: RunContext, nodeId: string, res: RunResultLike) {
  const usage = res.iterations.reduce(
    (a, i) => ({ in: a.in + (i.usage?.inputTokens ?? 0), out: a.out + (i.usage?.outputTokens ?? 0) }),
    { in: 0, out: 0 },
  );
  ctx.log(
    "info",
    `Agent finished: ${res.iterations.length} iteration(s), ${res.commits.length} commit(s), tokens in ${usage.in} / out ${usage.out}`,
    nodeId,
  );
  // When streaming to a log dir the agent text is already in the run log.
  if (!ctx.logDir && res.stdout.trim()) ctx.log("agent", tail(res.stdout, 1500), nodeId);
}

export async function runAi(ctx: RunContext, node: FlowNode, cfg: ResolvedConfig, inputs: NodeIO): Promise<NodeResult> {
  const kind = agentSandboxKind(ctx, cfg);
  const onHost = kind === "none";
  // Chosen on the block / node / flow (not just Settings → Sandbox: None): use the local CLI's own login.
  const explicitHost = resolveRunOn([cfg.runOn, ctx.flow?.runOn, rootFlow(ctx)?.runOn]) === "host";
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
  const blockEnv = ctx.blockEnv(cfg);
  const env = explicitHost ? hostAgentEnv(blockEnv, !!cfg.agent.endpoint?.trim()) : blockEnv;
  const label = nodeLabel(node, ctx.blocks);

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
  const agent = await makeAgent(cfg, { ...agentEnv(cfg, env), ...(packDir ? { PACK_DIR: packDir } : {}) });
  if (cfg.agent.endpoint?.trim()) ctx.log("info", `Agent endpoint: ${cfg.agent.endpoint.trim()}`, node.id);
  const routes = cfg.kind === "manager" ? routesFor(ctx, node) : undefined;
  const qa: QaPair[] = [];
  const baseOptions = {
    name: label,
    signal: ctx.abort.signal,
    ...(cfg.maxIterations > 1 ? { completionSignal: COMPLETE } : {}),
    ...(ctx.logDir
      ? {
          logging: {
            type: "file",
            path: path.join(ctx.logDir, `${node.id.replace(/[^\w-]/g, "_")}.log`),
            onAgentStreamEvent: (ev: { type: string; message?: string; name?: string; formattedArgs?: string }) => {
              if (ev.type === "text" && ev.message?.trim()) ctx.log("agent", ev.message.trim(), node.id);
              else if (ev.type === "toolCall") ctx.log("agent", `🔧 ${ev.name} ${ev.formattedArgs ?? ""}`.trim(), node.id);
            },
          },
        }
      : {}),
  };

  const runFresh = () =>
    sandbox.run({
      ...baseOptions,
      agent,
      prompt: buildPrompt({ cfg, inputs, startingPrompt: ctx.settings.startingPrompt, qa, routes, packDir, scratch: usesScratchWorkspace(ctx) }),
      maxIterations: cfg.maxIterations,
    });
  // Follow up in the same agent session when possible, otherwise re-run with the extra context in the prompt.
  const followUp = (res: RunResultLike, message: string) =>
    res.resume ? res.resume(message, { name: label, signal: ctx.abort.signal }) : runFresh();

  let res = await runFresh();
  logUsage(ctx, node.id, res);
  let parsed = parseOutput(res.stdout);

  if (cfg.allowQuestions) {
    for (let round = 0; parsed.question && round < MAX_QUESTION_ROUNDS; round++) {
      const answer = await ctx.ask(node.id, parsed.question);
      qa.push({ question: parsed.question, answer });
      res = await followUp(res, `The user answered your question.\n\nQ: ${parsed.question}\nA: ${answer}\n\nContinue the task and follow the output protocol.`);
      logUsage(ctx, node.id, res);
      parsed = parseOutput(res.stdout);
    }
  }

  if (cfg.kind === "manager") {
    const valid = routes?.map((r) => r.id) ?? [];
    if (valid.length && (!parsed.route || !valid.includes(parsed.route))) {
      ctx.log("warn", `Invalid route "${parsed.route ?? ""}" — asking the manager again`, node.id);
      res = await followUp(res, `"${parsed.route ?? ""}" is not a valid route. Reply with exactly one of: ${valid.map((v) => `<route>${v}</route>`).join(" ")}`);
      const retry = parseOutput(res.stdout);
      parsed = { ...parsed, route: retry.route, steer: retry.steer ?? parsed.steer };
    }
    return {
      route: parsed.route,
      outputs: { artifact: inputs.artifact, steer: parsed.steer ?? inputs.steer },
    };
  }

  const outputs: NodeIO = {};
  if (cfg.outputs.artifact) outputs.artifact = parsed.artifact ?? tail(res.stdout.trim());
  if (cfg.outputs.steer && parsed.steer !== undefined) outputs.steer = parsed.steer;
  return { outputs };
}
