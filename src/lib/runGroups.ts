// How the Agent screen's run list is organised: top-level runs in sections, Box Stack children grouped under the run
// that started them (one group per time the stack ran, latest attempt per task).

import { isSettled } from "../../shared/journal";
import type { RunSummary } from "../../shared/types";

export interface StackGroup {
  groupId: string;
  /** The stack node's label. */
  name: string;
  total: number;
  /** Tasks that are finished for good (succeeded or dropped). */
  settled: number;
  /** Latest attempt of each task, in task order. */
  tasks: RunSummary[];
  /** Every attempt per task index, oldest first. */
  attempts: Map<number, RunSummary[]>;
}

export interface RunTree {
  /** Runs nobody started (newest first). */
  roots: RunSummary[];
  /** Stack groups under each run id, oldest group first. */
  groups: Map<string, StackGroup[]>;
  byId: Map<string, RunSummary>;
}

export function groupRuns(list: RunSummary[]): RunTree {
  const byId = new Map(list.map((r) => [r.id, r]));
  const roots = list.filter((r) => !r.parent);
  const raw = new Map<string, Map<string, RunSummary[]>>();
  for (const r of list) {
    if (!r.parent || !r.stack) continue;
    const perParent = raw.get(r.parent.runId) ?? new Map<string, RunSummary[]>();
    raw.set(r.parent.runId, perParent);
    perParent.set(r.stack.groupId, [...(perParent.get(r.stack.groupId) ?? []), r]);
  }
  const groups = new Map<string, StackGroup[]>();
  for (const [parentId, perParent] of raw) {
    const out: StackGroup[] = [];
    for (const [groupId, members] of perParent) {
      const attempts = new Map<number, RunSummary[]>();
      for (const m of members) attempts.set(m.stack!.index, [...(attempts.get(m.stack!.index) ?? []), m]);
      for (const a of attempts.values()) a.sort((x, y) => x.stack!.attempt - y.stack!.attempt);
      const tasks = [...attempts.entries()].sort(([a], [b]) => a - b).map(([, a]) => a[a.length - 1]);
      const first = members[0].stack!;
      out.push({
        groupId,
        name: first.name,
        total: first.total,
        settled: tasks.filter((t) => t.stack!.outcome === "succeeded" || t.stack!.outcome === "dropped").length,
        tasks,
        attempts,
      });
    }
    out.sort((a, b) => Math.min(...a.tasks.map((t) => t.startedAt)) - Math.min(...b.tasks.map((t) => t.startedAt)));
    groups.set(parentId, out);
  }
  return { roots, groups, byId };
}

export interface RunSections {
  flagged: RunSummary[];
  /** Any run waiting for an answer, stack children included. */
  waiting: RunSummary[];
  running: RunSummary[];
  earlier: RunSummary[];
}

const hasFlags = (r: RunSummary) => !!r.flags && r.flags.warning + r.flags.error > 0;

export function sectionRuns(list: RunSummary[]): RunSections {
  const roots = list.filter((r) => !r.parent);
  // A paused run isn't working: it sits with the finished ones (flagged when it waits for you).
  return {
    flagged: roots.filter((r) => isSettled(r) && hasFlags(r)),
    waiting: list.filter((r) => !isSettled(r) && r.pendingQuestion),
    running: roots.filter((r) => !isSettled(r) && !r.pendingQuestion),
    earlier: roots.filter((r) => isSettled(r) && !hasFlags(r)),
  };
}

export type TaskTone = "done" | "dropped" | "running" | "waiting" | "cancelled";

/** Where a stack task (its latest attempt) got to. A rejected attempt means a retry is on its way. */
export function taskTone(r: RunSummary): TaskTone {
  if (r.stack?.outcome === "succeeded") return "done";
  if (r.stack?.outcome === "dropped") return "dropped";
  if (r.stack?.outcome === "rejected") return "running";
  if (!r.finishedAt) return r.pendingQuestion ? "waiting" : "running";
  return r.status === "cancelled" ? "cancelled" : r.status === "done" ? "done" : "running";
}
