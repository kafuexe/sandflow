// What happens after a step fails (part 3 of durable runs), decided in one place: `decideAfterFailure`, called by the
// engine before a failure fails the run. Modelled on MEOW: narrow automatic retries (agents/base.py `run_query`),
// review before redo (an interrupted mutation resumes at review), session recycling (`SessionAgent._turn`), and the
// triage agent's validated decision with a bounded recovery budget and guards (orchestration/triage.py).

import { nodeLabel, resolveNode } from "../shared/resolve";
import {
  AUTO_RETRY_CAUSES,
  CAUSE_TEXT,
  GUARD_TEXT,
  isDeliveryStep,
  parseDecision,
  retryDelay,
  reviewPrompt,
  sameDecision,
  type RecoverySettings,
  type TriageDecision,
} from "../shared/recovery";
import type { BlockDef, FailureCause, Flow, FlowNode, NodeIO, NodeRecovery, RecoveryEntry, RecoveryGuard, ResolvedConfig, RunState } from "../shared/types";

/** One triage agent run: read-only in the run's worktree, answering with a decision JSON (see `triagePrompt`). */
export interface TriageRequest {
  runId: string;
  nodeKey: string;
  prompt: string;
  /** The run's worktree (or project); undefined = none exists yet. */
  cwd?: string;
  /** Empty = the CLI's default model. */
  model: string;
  signal: AbortSignal;
}
/** Runs the triage agent and returns its answer (the decision JSON is read out of it). Throws when the agent fails. */
export type TriageRunner = (req: TriageRequest) => Promise<string>;

export interface Failure {
  cause: FailureCause;
  message: string;
  at: number;
}

/** What the engine does next with a failed step. */
export type AfterFailure =
  | { kind: "fail" }
  /**
   * Run it again (after `delayMs`). Agents: `session` says whether it continues its own session with `prompt`
   * (`resume`), starts fresh with `prompt` in front of its task (`fresh`), or just starts again (absent).
   * `task` replaces its input artifact (rescope).
   */
  | { kind: "retry"; delayMs: number; session?: "resume" | "fresh"; prompt?: string; task?: string }
  /** Go on as if it finished, with `output` as its artifact. */
  | { kind: "skip"; output?: string }
  /** Pause the run for a human (part 1's paused + hold `blocked`). */
  | { kind: "hold"; guard: RecoveryGuard; reason: string };

export interface RecoveryContext {
  settings: RecoverySettings;
  triage?: TriageRunner;
  /** Aborted when the run is stopped or paused (the triage agent is stopped with it). */
  signal: AbortSignal;
  run: RunState;
  nodeKey: string;
  /** The graph the step is in (the subflow's own flow inside a subflow). */
  flow: Flow;
  blocks: BlockDef[];
  /** The step's inputs for the attempt that failed. */
  inputs: NodeIO;
  /** Where the triage agent looks (the run's worktree). */
  cwd?: string;
  /** False in a Box Stack task (its stack retries it instead): a hold fails the step. */
  canHold: boolean;
  log(level: "info" | "warn" | "error", msg: string): void;
}

const isAgent = (cfg: ResolvedConfig) => cfg.kind === "ai" || cfg.kind === "manager";
const trim = (s: string | undefined, max: number) => (!s ? "" : s.length > max ? `${s.slice(0, max)}\n…(cut)` : s);

/**
 * After a step failed: retry it (automatically, or as triage decided), skip it, hold the run for a human, or fail
 * (recovery off). Records what it decided in `history` (the journal's `run.recovery[key]`). Never retries in a run
 * that's being stopped or paused — the engine checks that before asking.
 */
export async function decideAfterFailure(
  rc: RecoveryContext,
  node: FlowNode,
  cfg: ResolvedConfig,
  failure: Failure,
  history: NodeRecovery,
): Promise<AfterFailure> {
  const s = rc.settings;
  if (s.mode === "off") return { kind: "fail" };
  const base = { at: Date.now(), cause: failure.cause, message: trim(failure.message, 2000) };
  const record = (e: Omit<RecoveryEntry, "at" | "cause" | "message">) => void history.history.push({ ...base, ...e });
  const hold = (guard: RecoveryGuard, reason: string, decision: RecoveryEntry["decision"] = "hold", by: RecoveryEntry["by"] = "triage"): AfterFailure => {
    if (!rc.canHold) {
      record({ decision: "fail", by, guard, reason });
      rc.log("warn", `Recovery: ${GUARD_TEXT[guard]} (${reason}) — this Box Stack task fails instead of holding (its stack may retry it)`);
      return { kind: "fail" };
    }
    record({ decision, by, guard, reason });
    return { kind: "hold", guard, reason };
  };

  // 1. Narrow automatic retries, with backoff (MEOW: only crashes and OS failures retry by themselves).
  const retries = history.retries ?? 0;
  if (AUTO_RETRY_CAUSES.has(failure.cause) && retries < s.maxRetries) {
    const delayMs = retryDelay(retries);
    history.retries = retries + 1;
    let session: "resume" | "fresh" | undefined;
    if (isAgent(cfg)) {
      // Review before redo: the agent continues its own session — for stuck / timed-out agents only once, then a
      // fresh session (MEOW recycles a session that keeps failing).
      const recycled = (failure.cause === "stuck" || failure.cause === "timeout") && resumedAfterStall(history, retries);
      session = recycled ? "fresh" : "resume";
    }
    record({ decision: "retry", by: "auto", delayMs, ...(session ? { session } : {}) });
    rc.log("warn", `Recovery: the step ${CAUSE_TEXT[failure.cause]} — retrying it in ${Math.round(delayMs / 1000)}s (automatic retry ${retries + 1} of ${s.maxRetries})${session === "fresh" ? " in a fresh agent session" : ""}`);
    return { kind: "retry", delayMs, ...(session ? { session, prompt: reviewPrompt(failure.cause, failure.message) } : {}) };
  }

  // 2. Everything else — `error`, or any cause once its retries are used up — goes to triage, within the budget.
  if (history.cycles >= s.maxRecoveryCycles) {
    return hold("recovery-exhausted", `It used all ${s.maxRecoveryCycles} recovery cycles — fix the cause, then Continue`, "hold", "auto");
  }
  if (!rc.triage) return { kind: "fail" };
  rc.log("info", `Recovery: the step ${CAUSE_TEXT[failure.cause]} — asking the triage agent what to do`);
  let answer: string;
  try {
    answer = await rc.triage({ runId: rc.run.id, nodeKey: rc.nodeKey, prompt: triagePrompt(rc, node, cfg, failure, history), cwd: rc.cwd, model: s.model, signal: rc.signal });
  } catch (e) {
    if (rc.signal.aborted) throw e;
    return hold("triage-failed", `The triage agent failed: ${trim((e as Error).message, 500)}`);
  }
  const parsed = parseDecision(answer);
  if (!parsed.ok) return hold("invalid-decision", `Triage's decision is invalid: ${parsed.error}`);
  const d = parsed.decision;
  if (d.action === "blocked") return hold("needs-human", d.reason, "blocked");
  const previous = [...history.history].reverse().find((h) => h.by === "triage" && h.decision !== "hold" && h.decision !== "fail");
  if (previous && sameDecision(d, { action: previous.decision as TriageDecision["action"], notes: previous.notes, task: previous.task })) {
    return hold("repeated-decision", `Triage chose ${d.action} again with nothing changed (${d.reason})`);
  }
  if (d.action === "skip" && isDeliveryStep(cfg)) {
    return hold("invalid-decision", `Triage wanted to skip a delivery step (${d.reason}) — Create MR, Post comment and Merge are never skipped`);
  }

  history.cycles++;
  history.retries = 0;
  const entry = { decision: d.action, by: "triage" as const, reason: d.reason, ...(d.notes ? { notes: d.notes } : {}), ...(d.task ? { task: d.task } : {}) };
  rc.log("warn", `Recovery: triage decided to ${d.action} (cycle ${history.cycles} of ${s.maxRecoveryCycles}): ${d.reason}`);
  switch (d.action) {
    case "skip":
      record(entry);
      return { kind: "skip", output: d.output };
    case "retry":
      record({ ...entry, ...(isAgent(cfg) ? { session: "fresh" as const } : {}) });
      return { kind: "retry", delayMs: 0 };
    case "resume": {
      // MEOW appends the triage notes to the plan: here to the step's instructions, for the rest of the run.
      const notes = d.notes || d.reason;
      (history.notes ??= []).push(notes);
      record({ ...entry, ...(isAgent(cfg) ? { session: "resume" as const } : {}) });
      return { kind: "retry", delayMs: 0, ...(isAgent(cfg) ? { session: "resume" as const, prompt: `${reviewPrompt(failure.cause, failure.message)}\n\nTriage notes: ${notes}` } : {}) };
    }
    case "rescope":
      record({ ...entry, ...(isAgent(cfg) ? { session: "fresh" as const } : {}) });
      return { kind: "retry", delayMs: 0, task: d.task };
  }
}

/** Whether one of the current streak's automatic retries (the last `retries`) already continued a stuck / timed-out agent's session. */
function resumedAfterStall(h: NodeRecovery, retries: number): boolean {
  if (!retries) return false;
  const streak = h.history.filter((e) => e.by === "auto" && e.decision === "retry").slice(-retries);
  return streak.some((e) => e.session === "resume" && (e.cause === "stuck" || e.cause === "timeout"));
}

/** Notes triage left for this step, appended to its instructions for the rest of the run. */
export function withTriageNotes(cfg: ResolvedConfig, h: NodeRecovery | undefined): ResolvedConfig {
  if (!h?.notes?.length) return cfg;
  return { ...cfg, instructions: `${cfg.instructions}\n\n## Triage notes (from earlier attempts in this run)\n\n${h.notes.join("\n\n")}` };
}

// ---------- the triage agent's prompt ----------

/** Log lines the triage agent gets (MEOW hands triage the evidence of the failed attempt). */
const LOG_LINES = 200;

function labelOf(flow: Flow, blocks: BlockDef[], id: string): string {
  const n = flow.nodes.find((x) => x.id === id);
  return n ? `${nodeLabel(n, blocks)} (${id})` : id;
}

/** Everything triage decides from: the task, its inputs, the failure, recent log / activity, history, the flow around. */
export function triagePrompt(rc: RecoveryContext, node: FlowNode, cfg: ResolvedConfig, failure: Failure, history: NodeRecovery): string {
  const { run, nodeKey: key, flow, blocks } = rc;
  const from = [...new Set(flow.edges.filter((e) => e.target === node.id).map((e) => e.source))].map((id) => labelOf(flow, blocks, id));
  const to = [...new Set(flow.edges.filter((e) => e.source === node.id).map((e) => e.target))].map((id) => labelOf(flow, blocks, id));
  const logs = run.logs.filter((l) => l.nodeId === key).slice(-LOG_LINES).map((l) => `[${l.level}] ${l.msg}`);
  const activity = (run.activity?.[key] ?? []).slice(-LOG_LINES).map((a) => `(${a.kind}${a.name ? ` ${a.name}` : ""}${a.isError ? " error" : ""}) ${a.text}`);
  const lines = [...logs, ...activity].slice(-LOG_LINES);
  const past = history.history.map((h) =>
    `- ${new Date(h.at).toISOString()} ${h.cause}: ${trim(h.message, 300)} → ${h.decision} (${h.by})${h.reason ? ` — ${h.reason}` : ""}${h.notes ? ` · notes: ${h.notes}` : ""}${h.task ? ` · task: ${trim(h.task, 300)}` : ""}${h.guard ? ` · held: ${h.guard}` : ""}`,
  );
  const delivery = isDeliveryStep(cfg);
  let kind: string = cfg.kind;
  try {
    kind = cfg.kind === "auto" ? `auto / ${resolveNode(node, blocks).autoAction}` : cfg.kind;
  } catch {
    /* as resolved */
  }
  return [
    "# Sandflow recovery triage",
    "",
    "A step of a Sandflow flow run failed. Decide what happens next. You may look at the repository in the current",
    "directory (read-only: Read, Grep, Glob, git log / diff / status / show) — never change files.",
    "",
    "Answer with exactly one JSON object and nothing else:",
    '{"action": "retry" | "resume" | "rescope" | "skip" | "blocked", "reason": "…", "notes": "…", "task": "…", "output": "…"}',
    "",
    "- retry: run the step again as it is (an agent starts a fresh session) — for flaky failures.",
    "- resume: run it again with `notes` added to its instructions (an agent continues its own session with them).",
    "- rescope: run it again with `task` replacing its input (a smaller or clearer task). Only rescope takes `task`.",
    `- skip: don't run it again; the flow goes on as if it finished with \`output\` as its result. Only skip takes \`output\`.${delivery ? " NOT ALLOWED for this step: it delivers (MR / push / comment / merge)." : ""}`,
    "- blocked: it needs a human (missing credentials, a decision only a person can make, a broken environment). Say what's needed in `reason`.",
    "`reason` is required. Deciding the same thing as last time with nothing changed holds the run for a human.",
    "",
    `## The step: ${nodeLabel(node, blocks)} (${key}), ${kind}`,
    cfg.description ? `Description: ${trim(cfg.description, 1000)}` : "",
    cfg.instructions?.trim() ? `Instructions:\n${trim(cfg.instructions, 4000)}` : "",
    "",
    "## Its inputs",
    rc.inputs.artifact !== undefined ? `Artifact:\n${trim(rc.inputs.artifact, 4000)}` : "(no artifact)",
    rc.inputs.steer !== undefined ? `Steer:\n${trim(rc.inputs.steer, 2000)}` : "",
    "",
    "## The failure",
    `Cause: ${failure.cause} (${CAUSE_TEXT[failure.cause]})`,
    `Message: ${trim(failure.message, 3000)}`,
    `Execution: ${run.nodes[key]?.executions ?? 1}`,
    "",
    "## The flow around it",
    `Fed by: ${from.length ? from.join(", ") : "nothing (a start step)"}`,
    `Feeds: ${to.length ? to.join(", ") : "nothing (the flow ends here)"}`,
    "",
    `## Its recovery history in this run (${history.cycles} recovery cycle${history.cycles === 1 ? "" : "s"} used)`,
    past.length ? past.join("\n") : "(none)",
    "",
    `## Its last ${lines.length} log / activity lines`,
    lines.length ? lines.join("\n") : "(none)",
  ]
    .filter((l, i, a) => l !== "" || a[i - 1] !== "")
    .join("\n");
}
