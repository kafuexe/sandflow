// Integration blocks: run one action of another harness's CLI (e.g. `meow run "<task>"`) on this machine.
//
// The harness brings its own pipeline (worktrees, agents, review, MR), so it runs with your own login and config
// like an agent on "This computer". Arguments come from the integration's templates and are passed as argv — never
// through a shell — so a prompt can't be expanded or injected. Its exit code picks the block's exit.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { eventMarkdown } from "../../shared/events";
import { actionExits, buildArgs, DEFAULT_INTEGRATION_TIMEOUT_S, outputMatches, renderTemplate, type TemplateVars } from "../../shared/integrations";
import type { FlowNode, IntegrationDef, IntegrationInfo, NodeIO, ResolvedConfig } from "../../shared/types";
import { cmdLine, resolveCli } from "../chats";
import type { NodeResult, RunContext } from "../engine";
import { tail } from "../prompt";
import { exitText, runTree, type TreeResult } from "../proc";

/** stdout kept for the artifact (the log gets every line). */
const STDOUT_TAIL = 200_000;

export interface HarnessRun {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  signal?: AbortSignal;
  onLine?: (line: string) => void;
}

/** Run the harness's executable with `args` (no shell). Rejects when it can't be started (not installed). */
export async function runHarness(def: IntegrationDef, args: string[], o: HarnessRun = {}): Promise<TreeResult & { path: string }> {
  const env = o.env ?? process.env;
  const bin = resolveCli([def.command], env);
  const r = bin.viaCmd
    ? await runTree(env.ComSpec || "cmd.exe", ["/d", "/s", "/c", cmdLine(bin.cmd, args)], { ...o, env, windowsVerbatimArguments: true, stdoutTail: STDOUT_TAIL })
    : await runTree(bin.cmd, [...bin.args, ...args], { ...o, env: bin.args.length ? { ...env, ELECTRON_RUN_AS_NODE: "1" } : env, stdoutTail: STDOUT_TAIL });
  return { ...r, path: bin.cmd };
}

/** Why an integration can't run here, if it can't. */
export function blockedReason(info: IntegrationInfo): string | undefined {
  if (info.problems.length) return `Integration "${info.def.name}" has problems: ${info.problems.join("; ")}`;
  if (!info.trusted) return `The ${info.pack} pack isn't allowed to run code on this machine (Packs → ${info.pack} → Allow running on this machine)`;
  return undefined;
}

/** Everything an action's templates can use. */
export function templateVars(ctx: RunContext, inputs: NodeIO, env: Record<string, string>, worktree: string | undefined): TemplateVars {
  const prompt = ctx.settings.startingPrompt;
  const t = ctx.run.trigger;
  // A Manual start's artifact only says "you pressed Run" — the task is the starting prompt.
  const fromManualStart = t?.source === "manual" && inputs.artifact === eventMarkdown(t);
  const vars: TemplateVars = {
    // What to work on: the incoming artifact, else the starting prompt.
    input: inputs.artifact?.trim() && !fromManualStart ? inputs.artifact : prompt,
    artifact: inputs.artifact,
    steer: inputs.steer,
    prompt,
    "run.id": ctx.run.id,
    "run.branch": ctx.run.branch ?? ctx.branch,
    worktree: worktree || env.REPO_PATH,
    "trigger.title": t?.title,
    "trigger.body": t?.body,
    "trigger.url": t?.url,
    "trigger.author": t?.author,
    "trigger.repo": t?.repo,
    "trigger.branch": t?.branch,
    "trigger.number": t?.number === undefined ? undefined : String(t.number),
  };
  for (const [k, v] of Object.entries(env)) vars[`env.${k}`] = v;
  return vars;
}

/** Show a command line in the log: quoted where needed, long arguments (a prompt) cut short. */
export function displayCommand(cmd: string, args: string[]): string {
  const show = (a: string) => {
    const s = a.length > 80 ? `${a.slice(0, 77).replace(/\s+/g, " ")}…` : a.replace(/\s+/g, " ");
    return /^[\w./:=@%+,-]+$/.test(s) ? s : JSON.stringify(s);
  };
  return [cmd, ...args].map(show).join(" ");
}

export async function runIntegration(ctx: RunContext, node: FlowNode, cfg: ResolvedConfig, inputs: NodeIO): Promise<NodeResult> {
  const { ref, action: actionId, options } = cfg.integration;
  const info = ref ? ctx.integrations?.get(ref) : undefined;
  if (!info) throw new Error(ref ? `Integration "${ref}" isn't installed (add the pack it comes from, or create it under Integrations)` : "Integration block has no integration set");
  const def = info.def;
  const action = def.actions.find((a) => a.id === actionId);
  if (!action) throw new Error(`Integration "${def.name}" has no action "${actionId}"`);
  const blocked = blockedReason(info);
  if (blocked) throw new Error(blocked);

  const env = ctx.blockEnv(cfg);
  const missing = cfg.env.filter((k) => !env[k]?.trim());
  if (missing.length) throw new Error(`Missing env var ${missing.join(", ")}`);
  const worktree = (ctx.sandbox as { worktreePath?: string } | undefined)?.worktreePath;
  const vars = templateVars(ctx, inputs, env, worktree);
  const args = buildArgs(def, action, options, vars);

  let scratch: string | undefined;
  let cwd = action.cwd ? renderTemplate(action.cwd, vars).trim() : worktree || env.REPO_PATH?.trim();
  if (!cwd) cwd = scratch = fs.mkdtempSync(path.join(os.tmpdir(), "sandflow-integration-"));
  if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) throw new Error(`Working directory not found: ${cwd}`);

  const timeoutS = action.timeoutSeconds ?? DEFAULT_INTEGRATION_TIMEOUT_S;
  ctx.log("info", `$ ${displayCommand(def.command, args)}  (this machine, in ${cwd})`, node.id);
  let r: Awaited<ReturnType<typeof runHarness>>;
  try {
    r = await runHarness(def, args, {
      cwd,
      // Your own environment (the harness's login, PATH) plus only the vars this block declares.
      env: { ...process.env, ...env },
      timeoutMs: timeoutS * 1000,
      signal: ctx.abort.signal,
      onLine: (l) => ctx.log("agent", l, node.id),
    });
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === "ENOENT") throw new Error(`"${def.command}" isn't installed on this machine (or not on PATH) — see Integrations → ${def.name}`);
    throw e;
  } finally {
    if (scratch) fs.rmSync(scratch, { recursive: true, force: true });
  }
  if (r.killed === "cancelled") throw new Error("Run cancelled");
  if (r.killed) throw new Error(`${def.command} ${r.killed}`);

  const exits = actionExits(action);
  const mapped = action.exitCodes?.[String(r.code)];
  let exit: string | undefined;
  const flags: NonNullable<NodeResult["flags"]> = [];
  if (mapped) exit = mapped;
  else if (r.code === 0) exit = exits[0];
  else if (action.failExit) {
    exit = action.failExit;
    flags.push({ severity: "warning", message: `${action.name} exited with code ${r.code}`, details: tail(r.stderr.trim() || r.stdout.trim(), 4000) });
  } else {
    throw new Error(`${def.command} ${exitText(r)}${r.stderr.trim() ? `: ${tail(r.stderr.trim(), 2000)}` : ""}`);
  }

  const out = { ...vars, stdout: r.stdout.trim(), stderr: r.stderr.trim(), code: String(r.code), ...outputMatches(action, `${r.stdout}\n${r.stderr}`) };
  const artifact = renderTemplate(action.artifact ?? "{{stdout}}", out).trim();
  return { outputs: { artifact, steer: inputs.steer }, ...(exit !== undefined ? { exit } : {}), ...(flags.length ? { flags } : {}) };
}
