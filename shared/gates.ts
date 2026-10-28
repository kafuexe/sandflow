// Gates (from MEOW): blocks that leave through `pass` or `fail` — a Checks block (lint / tests / build commands) and
// an agent with a verdict (a reviewer or tester that must answer PASS or FAIL; a missing answer counts as FAIL).

import type { ResolvedConfig } from "./types";

export const GATE_EXITS = ["pass", "fail"] as const;

/** A Checks block, or an agent block with `verdict` on. */
export const isGate = (cfg: Pick<ResolvedConfig, "kind" | "autoAction" | "verdict">): boolean =>
  (cfg.kind === "auto" && cfg.autoAction === "checks") || (cfg.kind === "ai" && cfg.verdict);

/** The agent's verdict from its output: the last `<verdict>…</verdict>`, or undefined when there isn't a valid one. */
export function parseVerdict(stdout: string): "pass" | "fail" | undefined {
  let last: string | undefined;
  for (const m of stdout.matchAll(/<verdict>\s*([\s\S]*?)\s*<\/verdict>/gi)) last = m[1];
  const v = last?.trim().toUpperCase();
  return v === "PASS" ? "pass" : v === "FAIL" ? "fail" : undefined;
}

/** Files that are only documentation: an AI tester has nothing to run for them (MEOW's risk selection). */
export function isDocsFile(file: string): boolean {
  const f = file.replace(/\\/g, "/").replace(/^\.\//, "");
  if (/^docs?\//i.test(f)) return true;
  if (/\.(md|mdx|markdown|rst|txt|adoc)$/i.test(f)) return true;
  // Top-level README / CHANGELOG / LICENSE without an extension.
  return !f.includes("/") && /^(README|CHANGELOG|CHANGES|LICENSE|LICENCE|NOTICE|AUTHORS|CONTRIBUTING)(\..*)?$/i.test(f);
}

/** Only docs changed (and something did): a tester with `skipDocsOnly` passes without running. */
export const onlyDocsChanged = (files: string[]): boolean => files.length > 0 && files.every(isDocsFile);
