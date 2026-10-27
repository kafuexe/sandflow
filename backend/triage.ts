// The real triage agent (recovery, see backend/recovery.ts): one `claude -p` run on this machine, in the run's
// worktree, with read-only tools only. Its answer holds the decision JSON (MEOW's triage role writes a decision file
// the code validates; here the answer is validated the same way, so the agent needs no write access at all).

import fs from "node:fs";
import os from "node:os";
import { cmdLine, resolveCli } from "./chats";
import { exitText, runTree } from "./proc";
import type { TriageRunner } from "./recovery";

/** Read the repo, never change it: file reads / search, and git history / diffs. */
export const TRIAGE_TOOLS = ["Read", "Grep", "Glob", "Bash(git log:*)", "Bash(git diff:*)", "Bash(git status:*)", "Bash(git show:*)"];
/** Refused even when the user's own Claude settings would allow them (e.g. acceptEdits). */
export const TRIAGE_DENIED = ["Edit", "Write", "NotebookEdit", "WebFetch", "WebSearch", "Task"];
/** A triage run that takes longer than this is a failed triage (the run is held). */
export const TRIAGE_TIMEOUT_MS = 15 * 60_000;

export function triageArgs(model: string): string[] {
  return [
    "-p",
    "--output-format", "json",
    "--permission-mode", "default",
    "--allowedTools", TRIAGE_TOOLS.join(","),
    "--disallowedTools", TRIAGE_DENIED.join(","),
    ...(model ? ["--model", model] : []),
  ];
}

/** The agent's final answer from `claude -p --output-format json` (an error result throws). */
export function triageAnswer(stdout: string): string {
  let out: { result?: unknown; is_error?: unknown; subtype?: unknown };
  try {
    out = JSON.parse(stdout.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? "");
  } catch {
    // Not the JSON envelope (an older CLI): the text is the answer.
    return stdout;
  }
  if (out.is_error === true || (typeof out.subtype === "string" && out.subtype !== "success")) {
    throw new Error(`the triage agent ended with ${String(out.subtype ?? "an error")}${typeof out.result === "string" && out.result ? `: ${out.result.slice(0, 500)}` : ""}`);
  }
  return typeof out.result === "string" ? out.result : "";
}

/**
 * Claude Code on this machine (its own login), read-only in the run's worktree; the prompt goes in on stdin. Uses
 * the same CLI lookup as "Edit with AI" chats (SANDFLOW_CLAUDE_PATH, Windows .cmd shims).
 */
export const claudeTriage: TriageRunner = async (req) => {
  const env = process.env;
  const bin = resolveCli(["claude"], env);
  const args = triageArgs(req.model);
  const cwd = req.cwd && fs.existsSync(req.cwd) ? req.cwd : os.tmpdir();
  const r = bin.viaCmd
    ? await runTree(env.ComSpec || "cmd.exe", ["/d", "/s", "/c", cmdLine(bin.cmd, args)], { cwd, env, stdin: req.prompt, signal: req.signal, timeoutMs: TRIAGE_TIMEOUT_MS, windowsVerbatimArguments: true })
    : await runTree(bin.cmd, [...bin.args, ...args], { cwd, env: bin.args.length ? { ...env, ELECTRON_RUN_AS_NODE: "1" } : env, stdin: req.prompt, signal: req.signal, timeoutMs: TRIAGE_TIMEOUT_MS });
  if (r.killed) throw new Error(`claude ${r.killed}`);
  if (r.code !== 0) throw new Error(`claude ${exitText(r)}${r.stderr.trim() ? `: ${r.stderr.trim().slice(-500)}` : ""}`);
  return triageAnswer(r.stdout);
};
