import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ENDPOINT_ENV } from "../../shared/agents";
import { nodeLabel, resolveNode } from "../../shared/resolve";
import { SKILL_NAME_RE, SKILL_SOURCE_RE, skillKey } from "../../shared/skills";
import type { AgentProvider, FlowNode, NodeIO, QaPair, ResolvedConfig, SkillRef } from "../../shared/types";
import type { NodeResult, RunContext } from "../engine";
import { buildPrompt, parseOutput, tail, type RouteOption } from "../prompt";
import { ensureSandboxReady, sandboxProviderOptions } from "../sandbox";
import { SKILL_FILE_PATH_RE, type SkillFile } from "../skills";

/** The subset of sandcastle's `Sandbox` / `SandboxRunResult` this runner relies on. */
interface RunResultLike {
  stdout: string;
  commits: { sha: string }[];
  iterations: { usage?: { inputTokens: number; outputTokens: number; cacheReadInputTokens: number; cacheCreationInputTokens: number } }[];
  resume?: (prompt: string, options?: Record<string, unknown>) => Promise<RunResultLike>;
}
interface SandboxLike {
  exec(command: string, options?: { stdin?: string }): Promise<{ exitCode: number; stdout?: string; stderr?: string }>;
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

  if (ctx.settings.sandbox === "none") {
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

async function getSandbox(ctx: RunContext): Promise<SandboxLike> {
  if (ctx.sandbox) return ctx.sandbox as SandboxLike;
  const sc = await import("@ai-hero/sandcastle");
  const kind = ctx.settings.sandbox;
  // Docker/Podman: the image must already be loaded (offline bundle) — never let `docker run` try to pull it.
  await ensureSandboxReady(ctx.settings);
  const provider =
    kind === "docker"
      ? (await import("@ai-hero/sandcastle/sandboxes/docker")).docker(sandboxProviderOptions(ctx.settings))
      : kind === "podman"
        ? (await import("@ai-hero/sandcastle/sandboxes/podman")).podman(sandboxProviderOptions(ctx.settings))
        : (await import("@ai-hero/sandcastle/sandboxes/no-sandbox")).noSandbox();
  const repo = ctx.env.REPO_PATH?.trim();
  if (!repo) throw new Error("Missing env var REPO_PATH");
  const branch = sandboxBranch(ctx);
  ctx.log("info", `Creating ${kind} sandbox on branch ${branch}…`);
  const sandbox = await sc.createSandbox({
    branch,
    baseBranch: ctx.env.BASE_BRANCH?.trim() || undefined,
    sandbox: provider as Parameters<typeof sc.createSandbox>[0]["sandbox"],
    cwd: repo,
  });
  ctx.sandbox = sandbox;
  ctx.run.branch ??= branch;
  ctx.cleanup.push(async () => {
    const res = await sandbox.close();
    if (res.preservedWorktreePath) ctx.log("warn", `Worktree had uncommitted changes, preserved at ${res.preservedWorktreePath}`);
  });
  ctx.log("info", `Sandbox ready (worktree ${sandbox.worktreePath})`);
  return sandbox as unknown as SandboxLike;
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
  const sandbox = await getSandbox(ctx);
  const env = ctx.blockEnv(cfg);
  const label = nodeLabel(node, ctx.blocks);

  for (const skill of cfg.skills) {
    const key = skillKey(skill);
    if (ctx.installedSkills.has(key)) continue;
    ctx.installedSkills.add(key);
    if (skill.file) {
      try {
        if (!ctx.loadSkill) throw new Error("no skill store configured");
        const files = await ctx.loadSkill(skill.file);
        await installFileSkill(ctx, sandbox, cfg.agent.provider, skill, files, node.id);
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

  const agent = await makeAgent(cfg, agentEnv(cfg, env));
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
      prompt: buildPrompt({ cfg, inputs, startingPrompt: ctx.settings.startingPrompt, qa, routes }),
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
