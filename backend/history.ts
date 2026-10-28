// ~/.sandflow/history.jsonl: one line per run start / status change, written by every Sandflow instance (the desktop
// app and the CLI daemon), so `sandflow -r` can list runs from both. Append-only (concurrent writers just append);
// the latest line per run wins. Compacted now and then to the latest line per run.

import fs from "node:fs";
import path from "node:path";
import type { RunState, RunStatus } from "../shared/types";

export type HistorySource = "cli" | "desktop";

export interface HistoryEntry {
  runId: string;
  flowId: string;
  flowName: string;
  status: RunStatus;
  repo?: string;
  startedAt: number;
  endedAt?: number;
  dataDir: string;
  source: HistorySource;
  prompt?: string;
}

/** Compact when the file has more lines than this; keep at most `KEEP_RUNS` runs. */
export const COMPACT_LINES = 4000;
export const KEEP_RUNS = 1000;
const PROMPT_CHARS = 300;

export function historyEntry(run: RunState, dataDir: string, source: HistorySource): HistoryEntry {
  const prompt = run.prompt?.trim();
  return {
    runId: run.id,
    flowId: run.flowId,
    flowName: run.flowName,
    status: run.status,
    ...(run.workspace?.repo ? { repo: run.workspace.repo } : {}),
    startedAt: run.startedAt,
    ...(run.finishedAt ? { endedAt: run.finishedAt } : {}),
    dataDir,
    source,
    ...(prompt ? { prompt: prompt.slice(0, PROMPT_CHARS) } : {}),
  };
}

export function appendHistory(file: string, e: HistoryEntry) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(e)}\n`);
}

function readLines(file: string): string[] {
  try {
    return fs.readFileSync(file, "utf8").split("\n").filter((l) => l.trim());
  } catch {
    return [];
  }
}

/** Latest entry per run, newest start first. Broken lines (a writer cut off mid-line) are skipped. */
export function readHistory(file: string): HistoryEntry[] {
  const byId = new Map<string, HistoryEntry>();
  for (const line of readLines(file)) {
    try {
      const e = JSON.parse(line) as HistoryEntry;
      if (e && typeof e.runId === "string" && typeof e.startedAt === "number") {
        byId.delete(e.runId); // re-insert so the map's order is "last written"
        byId.set(e.runId, e);
      }
    } catch {
      /* partial line */
    }
  }
  return [...byId.values()].sort((a, b) => b.startedAt - a.startedAt);
}

/** Rewrite as the latest line per run when the file has grown past `maxLines`. Returns whether it did. */
export function compactHistory(file: string, maxLines = COMPACT_LINES, keepRuns = KEEP_RUNS): boolean {
  if (readLines(file).length <= maxLines) return false;
  const keep = readHistory(file).slice(0, keepRuns).reverse();
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, keep.map((e) => `${JSON.stringify(e)}\n`).join(""));
    fs.renameSync(tmp, file);
    return true;
  } catch {
    // Another writer has it open (Windows) — try again next time.
    fs.rmSync(tmp, { force: true });
    return false;
  }
}

/**
 * What the API calls on every run save: appends a line only when a run is new or its status changed, so the
 * frequent journal saves cost a map lookup. Box Stack tasks aren't listed (they continue with their run).
 */
export function createHistoryRecorder(o: { file: string; source: HistorySource; dataDir: string }) {
  const seen = new Map<string, string>();
  let appended = 0;
  compactHistory(o.file);
  return (run: RunState) => {
    if (run.parent) return;
    const key = `${run.status}:${run.finishedAt ?? ""}`;
    if (seen.get(run.id) === key) return;
    seen.set(run.id, key);
    try {
      appendHistory(o.file, historyEntry(run, o.dataDir, o.source));
      if (++appended % 500 === 0) compactHistory(o.file);
    } catch (e) {
      console.warn(`[history] couldn't write ${o.file}: ${(e as Error).message}`);
    }
  };
}
