// The run journal: `runs/<id>.json` is enough on its own to continue a run as the same run after a crash, quit or
// update (modelled on MEOW's execution/run_state.py). Shared by the engine, the server and the UI.
//
// - `phase` + `transitions[]` say where the run is; `status` (what the UI shows) is derived from the phase.
// - A node whose attempt started and didn't finish is active (`startedAt` without `finishedAt`); continuing re-runs it,
//   skips finished nodes, and restores every graph's queue (`queues`) and the step count (`steps`).
// - A journal is loaded strictly: one that doesn't validate is never continued (fail closed) — it's preserved as-is.

import type { NodeRunStatus, PauseReason, RunPhase, RunState, RunStatus } from "./types";

export const JOURNAL_SCHEMA = 1;

export const RUN_PHASES: readonly RunPhase[] = ["running", "waiting", "pausing", "paused", "interrupted", "continuing", "done", "failed", "cancelled"];

/** Phases after which a run no longer does work — the one place that decides it. */
export const TERMINAL_PHASES: ReadonlySet<RunPhase> = new Set<RunPhase>(["done", "failed", "cancelled"]);

/** Phases of a run that waits to be continued. */
export const PAUSED_PHASES: ReadonlySet<RunPhase> = new Set<RunPhase>(["paused", "interrupted"]);

/** Default for Settings → maxContinues: continues in a row without a step finishing before auto-continue gives up. */
export const MAX_CONTINUES = 5;

/** How long running steps get to finish by themselves when the run pauses, before their processes are stopped. */
export const PAUSE_GRACE_MS = 5_000;
/** Longest a pause / Stop waits for an irreversible step (Create MR, Post comment, …) to finish. */
export const DELIVERY_WAIT_MS = 30_000;

/** What an interrupted agent is told when it continues (its own session, or a fresh one with its task after it). */
export const INTERRUPTED_PROMPT = "You were interrupted. Check the work in the repo against your task, don't redo what's finished, then complete it.";

export const PAUSE_REASON_TEXT: Record<PauseReason, string> = {
  quit: "Sandflow was closed",
  update: "Sandflow was updated",
  crash: "Sandflow stopped unexpectedly",
  blocked: "a failed step needs you",
};

/** The status the UI shows for a phase (`waiting` keeps meaning "needs your answer"). */
export function statusOfPhase(phase: RunPhase, current?: RunStatus): RunStatus {
  switch (phase) {
    case "paused":
    case "interrupted":
      return "paused";
    case "pausing":
      return current === "waiting" ? "waiting" : "running";
    case "continuing":
      return "running";
    default:
      return phase;
  }
}

/** A run that waits to be continued (paused by a quit / update, or interrupted by a crash). */
export const isPaused = (r: Pick<RunState, "phase">): boolean => !!r.phase && PAUSED_PHASES.has(r.phase);

/** A run whose work is over or on hold — nothing in memory drives it (finished, paused, or interrupted). */
export const isSettled = (r: Pick<RunState, "finishedAt" | "phase">): boolean => !!r.finishedAt || isPaused(r);

/** Node statuses that mean "this attempt is under way". */
const ACTIVE: ReadonlySet<NodeRunStatus> = new Set<NodeRunStatus>(["running", "waiting"]);
const NODE_STATUSES: ReadonlySet<string> = new Set(["idle", "queued", "running", "waiting", "done", "failed"]);

/** Node keys whose attempt started and never finished (what continuing re-runs). */
export function activeNodeKeys(r: Pick<RunState, "nodes">): string[] {
  return Object.entries(r.nodes)
    .filter(([, ns]) => ns.interrupted || (ACTIVE.has(ns.status) && ns.startedAt !== undefined && ns.finishedAt === undefined))
    .map(([k]) => k);
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const isIO = (v: unknown) => v === undefined || (isObj(v) && ["artifact", "steer"].every((k) => v[k] === undefined || typeof v[k] === "string"));

/**
 * Why `raw` isn't a journal that can be continued safely (undefined when it is). Strict on purpose (MEOW
 * `RunStore.load`): whatever it doesn't trust, it refuses.
 */
export function journalProblem(raw: unknown, id?: string): string | undefined {
  if (!isObj(raw)) return "not a JSON object";
  if (raw.schemaVersion !== JOURNAL_SCHEMA) return `unsupported schema version ${JSON.stringify(raw.schemaVersion)}`;
  if (typeof raw.id !== "string" || (id !== undefined && raw.id !== id)) return "its id doesn't match its file name";
  for (const k of ["flowId", "flowName"]) if (typeof raw[k] !== "string") return `invalid ${k}`;
  if (typeof raw.startedAt !== "number") return "invalid startedAt";
  if (typeof raw.phase !== "string" || !RUN_PHASES.includes(raw.phase as RunPhase)) return `invalid phase ${JSON.stringify(raw.phase)}`;
  if (!Number.isInteger(raw.attempt) || (raw.attempt as number) < 1) return "invalid attempt";
  if (!Array.isArray(raw.transitions) || !raw.transitions.every((t) => isObj(t) && RUN_PHASES.includes(t.phase as RunPhase) && typeof t.at === "number")) {
    return "invalid transition history";
  }
  if (!Array.isArray(raw.logs)) return "invalid logs";
  if (!isObj(raw.nodes)) return "invalid nodes";
  for (const [k, ns] of Object.entries(raw.nodes)) {
    if (!isObj(ns) || !NODE_STATUSES.has(ns.status as string) || typeof ns.executions !== "number" || !isIO(ns.inputs) || !isIO(ns.outputs)) {
      return `invalid state for step "${k}"`;
    }
  }
  if (raw.queues !== undefined) {
    if (!isObj(raw.queues)) return "invalid queues";
    for (const q of Object.values(raw.queues)) {
      if (!Array.isArray(q) || !q.every((s) => isObj(s) && typeof s.nodeId === "string" && isObj(s.inputs) && isIO(s.inputs))) return "invalid queues";
    }
  }
  if (raw.steps !== undefined && (!Number.isInteger(raw.steps) || (raw.steps as number) < 0)) return "invalid steps";
  return undefined;
}
