// What happened in a run, as a list of events a watcher (Claude Code's watch_run) can page through.
//
// Events are derived from the saved run, never kept separately, so a watcher that reconnects later (or after
// Sandflow restarted) still sees them. Every source is append-only — phase transitions, finished node executions,
// questions, flags — so a cursor is just how many of each the watcher has seen.

import type { RunState, RunStatus } from "./types";

/** Phases a watcher is told about as they happen (the journal also records running / waiting / pausing); the run's
 * end is always one `end` event, last. */
const REPORTED_PHASES = new Set(["interrupted", "paused", "continuing"]);

export type RunEvent =
  | { type: "phase"; phase: string; at: number; attempt?: number }
  | { type: "node"; node: string; status: "done" | "failed"; execution: number; error?: string }
  | { type: "question"; node: string; question: string; answer?: string; pending?: true }
  | { type: "flag"; severity: string; message: string; node?: string }
  /** What the supervisor noticed / did (silent, stuck, timeout, loop, reminder, sandbox, overseer). */
  | { type: "supervisor"; kind: string; detail: string; at: number; node?: string; action?: string }
  /** What recovery did after a step failed (see shared/recovery.ts); `guard` when it held the run. */
  | { type: "recovery"; node: string; cause: string; decision: string; reason?: string; guard?: string }
  | { type: "end"; status: RunStatus; error?: string };

/** The journal fields of durable runs; optional so runs saved before them still work. */
type Journal = RunState & { transitions?: { phase: string; at: number; attempt?: number }[] };

interface Cursor {
  /** Phase transitions seen. */
  t: number;
  q: number;
  f: number;
  /** Supervision entries seen (counting ones since cut off the front). */
  s: number;
  /** Finished executions seen, per node key. */
  n: Record<string, number>;
  /** Recovery history entries seen, per node key. */
  r: Record<string, number>;
  e: number;
}

const START: Cursor = { t: 0, q: 0, f: 0, s: 0, n: {}, r: {}, e: 0 };

/** Executions of a node that have finished (a running node's current one hasn't). Copied steps don't count. */
function finished(ns: RunState["nodes"][string]): number {
  if (ns.restored) return 0;
  return ns.status === "done" || ns.status === "failed" ? ns.executions : Math.max(0, ns.executions - 1);
}

function collect(run: Journal, from: Cursor): { events: RunEvent[]; cursor: Cursor } {
  const events: RunEvent[] = [];
  const transitions = run.transitions ?? [];
  for (const tr of transitions.slice(from.t)) {
    if (REPORTED_PHASES.has(tr.phase)) events.push({ type: "phase", phase: tr.phase, at: tr.at, ...(tr.attempt !== undefined ? { attempt: tr.attempt } : {}) });
  }
  const n: Record<string, number> = {};
  for (const [key, ns] of Object.entries(run.nodes)) {
    n[key] = finished(ns);
    for (let i = (from.n[key] ?? 0) + 1; i <= n[key]; i++) {
      const last = i === ns.executions;
      // An earlier execution of a node that ran again finished fine (a failure ends the node's path).
      const status = last && ns.status === "failed" ? "failed" : "done";
      events.push({ type: "node", node: key, status, execution: i, ...(status === "failed" && ns.error ? { error: ns.error } : {}) });
    }
  }
  const questions = run.questions ?? [];
  for (const q of questions.slice(from.q)) {
    const pending = q.answer === undefined && run.pendingQuestion?.askedAt === q.askedAt && run.pendingQuestion.nodeId === q.nodeId;
    events.push({ type: "question", node: q.nodeId, question: q.question, ...(q.answer !== undefined ? { answer: q.answer } : pending ? { pending: true as const } : {}) });
  }
  const flags = run.flags ?? [];
  for (const f of flags.slice(from.f)) events.push({ type: "flag", severity: f.severity, message: f.message, ...(f.nodeKey ? { node: f.nodeKey } : {}) });
  const supervision = run.supervision ?? [];
  const dropped = run.supervisionDropped ?? 0;
  for (const x of supervision.slice(Math.max(0, from.s - dropped))) {
    events.push({ type: "supervisor", kind: x.kind, detail: x.detail, at: x.at, ...(x.node ? { node: x.node } : {}), ...(x.action ? { action: x.action } : {}) });
  }
  const r: Record<string, number> = {};
  for (const [key, rec] of Object.entries(run.recovery ?? {})) {
    r[key] = rec.history.length;
    for (const h of rec.history.slice(from.r[key] ?? 0)) {
      events.push({ type: "recovery", node: key, cause: h.cause, decision: h.decision, ...(h.reason ? { reason: h.reason } : {}), ...(h.guard ? { guard: h.guard } : {}) });
    }
  }
  const ended = runEnded(run);
  if (ended && !from.e) events.push({ type: "end", status: run.status, ...(run.error ? { error: run.error } : {}) });
  return { events, cursor: { t: transitions.length, q: questions.length, f: flags.length, s: dropped + supervision.length, n, r, e: ended ? 1 : from.e } };
}

/** Every event of the run so far, oldest source first. */
export function runEvents(run: RunState): RunEvent[] {
  return collect(run, START).events;
}

const encode = (c: Cursor) => Buffer.from(JSON.stringify(c)).toString("base64url");

function decode(s: string | undefined): Cursor {
  if (!s) return START;
  try {
    const c = JSON.parse(Buffer.from(s, "base64url").toString("utf8")) as Partial<Cursor>;
    const num = (v: unknown) => (typeof v === "number" && v >= 0 ? v : 0);
    const perNode = (m: unknown) => (m && typeof m === "object" ? Object.fromEntries(Object.entries(m).map(([k, v]) => [k, num(v)])) : {});
    return { t: num(c.t), q: num(c.q), f: num(c.f), s: num(c.s), n: perNode(c.n), r: perNode(c.r), e: num(c.e) };
  } catch {
    return START;
  }
}

/** Events after `cursor` (an earlier call's; absent or unreadable = from the start), and the cursor to pass next time. */
export function eventsAfter(run: RunState, cursor?: string): { events: RunEvent[]; cursor: string } {
  const r = collect(run, decode(cursor));
  return { events: r.events, cursor: encode(r.cursor) };
}

/** Phases in which a run does no more work (durable-runs journals); without a phase, a run is over once it finished. */
const TERMINAL = new Set(["done", "failed", "cancelled"]);

export function runEnded(run: RunState): boolean {
  const phase = (run as RunState & { phase?: string }).phase;
  return phase ? TERMINAL.has(phase) : !!run.finishedAt;
}
