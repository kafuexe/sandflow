// Checks block (MEOW's verify gates): run the project's lint / test / build commands in the run's worktree and leave
// through `pass` or `fail`. A failed required check hands its output on as the steer, so a fix step gets the errors.
// When the worktree and the commands haven't changed since the last passing execution, its results are reused.

import { createHash } from "node:crypto";
import type { ChecksEvidence, FlowNode, NodeIO, ResolvedConfig } from "../../shared/types";
import type { NodeResult, RunContext } from "../engine";
import { tail } from "../prompt";
import { exitText, runTree } from "../proc";
import { getSandbox, type SandboxLike } from "./ai";
import { shQuote } from "./script";
import { codeOwner, trustedOnHost } from "./trust";

export const DEFAULT_CHECK_TIMEOUT_S = 600;
/** Output kept per check (in the report, the steer and the journal). */
const OUTPUT_CHARS = 4000;

type Result = ChecksEvidence["results"][number];

/** What the commands run on: the commit, uncommitted changes and untracked files. Undefined when git can't tell. */
async function worktreeState(sandbox: SandboxLike): Promise<string | undefined> {
  const r = await sandbox.exec("git rev-parse HEAD && git status --porcelain --untracked-files=all && git diff HEAD");
  return r.exitCode === 0 ? r.stdout ?? "" : undefined;
}

export const checksFingerprint = (commands: ResolvedConfig["checks"]["commands"], state: string) =>
  createHash("sha256").update(JSON.stringify(commands.map((c) => [c.name, c.run, c.required !== false]))).update("\0").update(state).digest("hex");

/** The report (artifact) and, when it failed, what to fix (steer). */
export function checksReport(results: Result[], reused: boolean): { artifact: string; steer?: string; passed: boolean } {
  const failedRequired = results.filter((r) => !r.ok && r.required);
  const passed = failedRequired.length === 0;
  const line = (r: Result) => `- ${r.ok ? "✓" : r.required ? "✗" : "⚠"} ${r.name}${r.ok ? "" : r.required ? " — failed" : " — failed (advisory)"} (${r.seconds}s)`;
  const head = `# Checks: ${passed ? "PASS" : "FAIL"}${reused ? " (unchanged since the last run — results reused)" : ""}`;
  const details = results
    .filter((r) => !r.ok)
    .map((r) => `## ${r.name}${r.required ? "" : " (advisory)"} — ${r.code === null ? "timed out" : `exit ${r.code}`}\n\n\`\`\`\n${r.output.trim()}\n\`\`\``);
  const artifact = [head, results.map(line).join("\n"), ...details].join("\n\n");
  const steer = passed
    ? undefined
    : `These required checks fail — fix them:\n${failedRequired.map((r, i) => `${i + 1}. ${r.name}:\n${r.output.trim()}`).join("\n\n")}`;
  return { artifact, steer, passed };
}

export async function runChecks(ctx: RunContext, node: FlowNode, cfg: ResolvedConfig, inputs: NodeIO): Promise<NodeResult> {
  const commands = cfg.checks.commands.filter((c) => c.run?.trim());
  if (!commands.length) throw new Error("Checks block has no commands (add them under Checks)");
  const onHost = ctx.settings.sandbox === "none";
  if (onHost) {
    // Without a sandbox the commands run on this machine: ones from a pack need that pack to be trusted.
    const owner = codeOwner(ctx, node, (c) => c.checks?.commands?.map((x) => x.run).join("\n"));
    if (!trustedOnHost(ctx, owner)) throw new Error(`These checks come from pack "${owner}", which isn't allowed to run code on this machine (Packs → ${owner})`);
  }
  const sandbox = await getSandbox(ctx);
  const env = ctx.blockEnv(cfg);
  const ns = ctx.nodeState?.(node.id);
  const state = await worktreeState(sandbox);
  const fingerprint = state === undefined ? undefined : checksFingerprint(commands, state);
  const prev = ns?.checks;
  if (cfg.checks.reuse && fingerprint && prev?.passed && prev.fingerprint === fingerprint) {
    ctx.log("info", "Nothing changed since these checks last passed — reusing their results", node.id);
    const report = checksReport(prev.results, true);
    return { exit: "pass", outputs: { artifact: report.artifact, steer: inputs.steer } };
  }

  const results: Result[] = [];
  for (const c of commands) {
    if (ctx.abort.signal.aborted) throw new Error("Run cancelled");
    const timeoutS = c.timeoutSeconds ?? DEFAULT_CHECK_TIMEOUT_S;
    const name = c.name?.trim() || c.run.trim();
    ctx.log("info", `$ ${c.run.trim()}  (check "${name}"${c.required === false ? ", advisory" : ""})`, node.id);
    const started = Date.now();
    let code: number | null;
    let output: string;
    if (onHost) {
      const worktree = (sandbox as { worktreePath?: string }).worktreePath;
      const r = await runTree(c.run, null, {
        cwd: worktree,
        env: { ...process.env, ...env },
        signal: ctx.abort.signal,
        timeoutMs: timeoutS * 1000,
        stdoutTail: OUTPUT_CHARS * 4,
        onLine: (l) => ctx.log("agent", l, node.id),
      });
      if (r.killed === "cancelled") throw new Error("Run cancelled");
      code = r.killed ? null : r.code;
      output = `${r.stdout}\n${r.stderr}`;
      if (!r.killed && r.code !== 0 && r.signal) output += `\n(${exitText(r)})`;
    } else {
      const exports = Object.entries(env).map(([k, v]) => `export ${k}=${shQuote(v)}`).join("\n");
      const r = await sandbox.exec(`${exports}\ntimeout ${timeoutS} sh -c ${shQuote(c.run)} 2>&1`, { onLine: (l) => ctx.log("agent", l, node.id) });
      if (ctx.abort.signal.aborted) throw new Error("Run cancelled");
      code = r.exitCode === 124 ? null : r.exitCode;
      output = `${r.stdout ?? ""}\n${r.stderr ?? ""}`;
    }
    const ok = code === 0;
    const result: Result = { name, required: c.required !== false, ok, code, seconds: Math.round((Date.now() - started) / 1000), output: tail(output.trim(), OUTPUT_CHARS) };
    results.push(result);
    ctx.log(ok ? "info" : result.required ? "warn" : "info", `Check "${name}": ${ok ? "passed" : code === null ? `timed out after ${timeoutS}s` : `failed (exit ${code})`}`, node.id);
  }

  const report = checksReport(results, false);
  if (ns && fingerprint) {
    ns.checks = { fingerprint, passed: report.passed, results, at: Date.now() };
    ctx.journal?.();
  }
  return { exit: report.passed ? "pass" : "fail", outputs: { artifact: report.artifact, steer: report.steer ?? inputs.steer } };
}
