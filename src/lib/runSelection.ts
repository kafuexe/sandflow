import { isSettled } from "../../shared/journal";
import type { RunState, RunSummary } from "../../shared/types";

/** Pure helpers for showing several runs at once: which runs of a flow are going, and which one the builder shows. */

export function toSummary(r: RunState): RunSummary {
  const t = r.trigger;
  return {
    id: r.id,
    flowId: r.flowId,
    flowName: r.flowName,
    status: r.status,
    startedAt: r.startedAt,
    finishedAt: r.finishedAt,
    trigger: t ? { source: t.source, type: t.type, author: t.author, title: t.title } : undefined,
    prompt: r.prompt,
    pendingQuestion: r.pendingQuestion,
    ...(r.phase ? { phase: r.phase } : {}),
    ...(r.pauseReason ? { pauseReason: r.pauseReason } : {}),
    ...(r.hold ? { hold: r.hold } : {}),
  };
}

/**
 * The runs list with `run` merged in: its live state replaces the (polled, possibly older) summary of the same run,
 * or it is added if the list hasn't seen it yet (just started). Newest first.
 */
export function mergeRun(runs: RunSummary[], run: RunState | RunSummary | undefined): RunSummary[] {
  if (!run) return runs;
  const s = "logs" in run ? toSummary(run) : run;
  const rest = runs.filter((r) => r.id !== s.id);
  return [s, ...rest].sort((a, b) => b.startedAt - a.startedAt);
}

/** Runs of `flowId` that haven't finished, newest first (the watched run's live state wins over its summary). */
export function activeRunsOf(runs: RunSummary[], flowId: string | null | undefined, watched?: RunState): RunSummary[] {
  if (!flowId) return [];
  return mergeRun(runs, watched).filter((r) => r.flowId === flowId && !isSettled(r));
}

/**
 * Which run the builder should show for `flowId` after switching to it: keep the watched run if it belongs to that
 * flow, else the flow's most recent unfinished run. Undefined: nothing better — keep what is shown.
 */
export function runToShow(runs: RunSummary[], flowId: string | null | undefined, watched?: RunState): string | undefined {
  if (!flowId) return undefined;
  if (watched?.flowId === flowId) return watched.id;
  return activeRunsOf(runs, flowId, watched)[0]?.id;
}

/** "2 running", "1 running · 1 waiting" — the top bar's summary of a flow's active runs. */
export function activeRunsLabel(active: RunSummary[]): string {
  const waiting = active.filter((r) => r.status === "waiting" || r.pendingQuestion).length;
  const running = active.length - waiting;
  return [running && `${running} running`, waiting && `${waiting} waiting`].filter(Boolean).join(" · ");
}
