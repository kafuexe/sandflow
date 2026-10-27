// Recovery after a step fails (part 3 of durable runs), modelled on MEOW: the narrow automatic retries of
// agents/base.py (`_looks_like_a_crash`, `_is_os_failure`) and the triage decisions of orchestration/triage.py.
// Pure helpers shared by the engine, the server and the UI; the decision itself is made in backend/recovery.ts.

import { resolveNode } from "./resolve";
import type { BlockDef, FailureCause, Flow, FlowRecovery, RecoveryAction, RecoveryGuard, RecoveryMode, ResolvedConfig } from "./types";

export const DEFAULT_MAX_RETRIES = 2;
export const DEFAULT_MAX_RECOVERY_CYCLES = 3;
/** Backoff before automatic retry n (0-based): 1 s, 2 s, 4 s…, capped. */
export const RETRY_BASE_MS = 1_000;
export const RETRY_MAX_MS = 60_000;
export const retryDelay = (n: number): number => Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.max(0, n));

/** Causes retried without asking anyone (MEOW: only crashes and OS failures retry by themselves). `error` never is. */
export const AUTO_RETRY_CAUSES: ReadonlySet<FailureCause> = new Set<FailureCause>(["crash", "transient", "sandbox", "stuck", "timeout"]);

export const RECOVERY_ACTIONS: readonly RecoveryAction[] = ["retry", "resume", "rescope", "skip", "blocked"];

/** How the previous attempt ended, for the agent's review prompt and the log. */
export const CAUSE_TEXT: Record<FailureCause, string> = {
  error: "failed",
  timeout: "ran out of time",
  stuck: "was stopped because it seemed stuck",
  crash: "crashed",
  transient: "hit a connection or system error",
  sandbox: "lost its sandbox container",
  interrupted: "was interrupted",
};

export const GUARD_TEXT: Record<RecoveryGuard, string> = {
  "needs-human": "triage says it needs you",
  "repeated-decision": "triage decided the same thing as last time, with nothing changed",
  "invalid-decision": "triage's decision couldn't be used",
  "triage-failed": "the triage agent failed",
  "recovery-exhausted": "the step used up its recovery budget",
};

/** What a step that runs again after a failure is told (MEOW resumes an interrupted mutation at review). */
export function reviewPrompt(cause: FailureCause, message: string): string {
  const why = message.trim() ? `: ${message.trim().slice(0, 2000)}` : "";
  return `Your previous attempt ${CAUSE_TEXT[cause]}${why}. Check the work in the repo against your task, don't redo what's finished, then complete it.`;
}

/** Irreversible steps (Create MR / push, Post comment, Merge into parent): triage may never skip them. */
export function isDeliveryStep(cfg: Pick<ResolvedConfig, "kind" | "autoAction">): boolean {
  return cfg.kind === "auto" && (cfg.autoAction === "create-mr" || cfg.autoAction === "post-comment" || cfg.autoAction === "merge-parent");
}

/** Whether the flow (or a subflow / Box Stack flow it reaches) has an agent block. */
export function hasAgentBlocks(flow: Flow, flows: Flow[], blocks: BlockDef[], seen = new Set<string>()): boolean {
  if (seen.has(flow.id)) return false;
  seen.add(flow.id);
  for (const n of flow.nodes) {
    let cfg: ResolvedConfig;
    try {
      cfg = resolveNode(n, blocks);
    } catch {
      continue;
    }
    if (cfg.kind === "ai" || cfg.kind === "manager") return true;
    const ref = cfg.kind === "subflow" ? cfg.subflow.flowId : cfg.kind === "stack" ? cfg.stack.flowId : undefined;
    const sub = ref ? flows.find((f) => f.id === ref) : undefined;
    if (sub && hasAgentBlocks(sub, flows, blocks, seen)) return true;
  }
  return false;
}

export interface RecoverySettings {
  mode: RecoveryMode;
  model: string;
  maxRecoveryCycles: number;
  maxRetries: number;
}

const count = (v: unknown, dflt: number) => (typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : dflt);

/** A flow's Recovery setting with its defaults filled in. */
export function recoverySettings(flow: Flow, flows: Flow[], blocks: BlockDef[]): RecoverySettings {
  const r: FlowRecovery = flow.recovery ?? {};
  const mode = r.mode ?? (hasAgentBlocks(flow, flows, blocks) ? "triage" : "off");
  return {
    mode,
    model: r.agent?.model?.trim() ?? "",
    maxRecoveryCycles: count(r.maxRecoveryCycles, DEFAULT_MAX_RECOVERY_CYCLES),
    maxRetries: count(r.maxRetries, DEFAULT_MAX_RETRIES),
  };
}

// ---------- why a step failed ----------

/** MEOW `_NTSTATUS_SEVERITY_BIT`: a raw unsigned Windows NTSTATUS (0xC0000005…) has the top bit of a 32-bit word set. */
const NTSTATUS_SEVERITY_BIT = 0x80000000;

/**
 * MEOW `_looks_like_a_crash`: negative (POSIX killed by a signal; Windows NTSTATUS sign-extended) or ≥ 0x80000000
 * (the raw unsigned NTSTATUS) — a well-behaved program never chooses such a status.
 */
export const looksLikeACrash = (code: number | undefined | null): boolean => typeof code === "number" && (code < 0 || code >= NTSTATUS_SEVERITY_BIT);

/** OS / network error codes a short wait and a fresh attempt often clear (MEOW `_is_os_failure`; ENOENT = the CLI is missing, a real failure). */
const TRANSIENT_CODES = new Set([
  "ECONNRESET", "ECONNREFUSED", "ECONNABORTED", "ETIMEDOUT", "ESOCKETTIMEDOUT", "EPIPE", "EAI_AGAIN", "ENETUNREACH", "ENETDOWN",
  "ENETRESET", "EHOSTUNREACH", "EHOSTDOWN", "EBUSY", "EAGAIN", "EMFILE", "ENFILE", "EPERM", "EACCES", "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT",
]);
/** The same failures as they appear in an agent CLI's / a command's message (its exit code alone says nothing). */
const TRANSIENT_RE =
  /\b(ECONNRESET|ECONNREFUSED|ECONNABORTED|ETIMEDOUT|EPIPE|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|EBUSY)\b|socket hang up|fetch failed|connection (?:error|reset|refused|closed|timed out)|network (?:error|is unreachable)|overloaded_error|\bOverloaded\b|being used by another process|resource temporarily unavailable/i;
const SIGNAL_RE = /\b(?:killed by signal|terminated by signal|receipt of signal)\b|\bsignal:? SIG[A-Z]+\b/i;
const EXIT_RE = /\bexit(?:ed)?(?: with)?(?: code| status)?:? (-?\d+)/i;
/** A runner's own time limit (a script's timeout, a command killed after N s). */
const TIMEOUT_RE = /\btimed out after\b/i;

/** The exit code a runner put on its error, or wrote in its message. */
function exitCodeOf(err: unknown): number | undefined {
  const e = err as { exitCode?: unknown; code?: unknown; message?: unknown } | undefined;
  if (typeof e?.exitCode === "number") return e.exitCode;
  if (typeof e?.code === "number") return e.code;
  const m = EXIT_RE.exec(String(e?.message ?? err ?? ""));
  return m ? Number(m[1]) : undefined;
}

/**
 * Why a step failed, from its error: `crash` (crash-like exit code or killed by a signal), `transient` (OS / network /
 * CLI connection errors), `timeout` (the runner's own time limit), else `error` (the block itself failed). The
 * supervisor's causes (stuck, sandbox, its timeouts) come with its stop request instead (see the engine).
 */
export function classifyFailure(err: unknown): FailureCause {
  const e = err as { code?: unknown; signal?: unknown; message?: unknown; cause?: unknown } | undefined;
  const msg = String(e?.message ?? err ?? "");
  if (looksLikeACrash(exitCodeOf(err)) || (typeof e?.signal === "string" && e.signal) || SIGNAL_RE.test(msg)) return "crash";
  if (typeof e?.code === "string" && TRANSIENT_CODES.has(e.code)) return "transient";
  const inner = e?.cause as { code?: unknown } | undefined;
  if (typeof inner?.code === "string" && TRANSIENT_CODES.has(inner.code)) return "transient";
  if (TRANSIENT_RE.test(msg)) return "transient";
  if (TIMEOUT_RE.test(msg)) return "timeout";
  return "error";
}

// ---------- triage decisions (MEOW `parse_decision`) ----------

export interface TriageDecision {
  action: RecoveryAction;
  reason: string;
  notes?: string;
  task?: string;
  output?: string;
}

const DECISION_KEYS = new Set(["action", "reason", "notes", "task", "output"]);

/** The decision JSON in the triage agent's answer: the whole answer, else its last ```json block, else its last {…}. */
function decisionJson(text: string): unknown {
  const t = text.trim();
  const tries: string[] = [t];
  const fenced = [...t.matchAll(/```(?:json)?\s*\n?([\s\S]*?)```/g)].map((m) => m[1].trim());
  tries.push(...fenced.reverse());
  const start = t.lastIndexOf('{"action"') >= 0 ? t.lastIndexOf('{"action"') : t.search(/\{\s*"action"/);
  if (start >= 0) {
    const end = t.lastIndexOf("}");
    if (end > start) tries.push(t.slice(start, end + 1));
  }
  for (const s of tries) {
    try {
      return JSON.parse(s);
    } catch {
      /* next */
    }
  }
  throw new Error("its answer has no decision JSON");
}

/**
 * Validate a triage decision (MEOW: unknown keys, an unknown action or a missing reason are refused; only rescope
 * takes a task, only skip an output). The error names the first problem.
 */
export function parseDecision(text: string): { ok: true; decision: TriageDecision } | { ok: false; error: string } {
  let raw: unknown;
  try {
    raw = decisionJson(text);
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "the decision must be a JSON object" };
  const o = raw as Record<string, unknown>;
  const unknown = Object.keys(o).filter((k) => !DECISION_KEYS.has(k));
  if (unknown.length) return { ok: false, error: `unknown key(s): ${unknown.sort().join(", ")}` };
  if (!RECOVERY_ACTIONS.includes(o.action as RecoveryAction)) return { ok: false, error: `unknown action ${JSON.stringify(o.action)} (expected one of ${RECOVERY_ACTIONS.join(", ")})` };
  for (const k of ["reason", "notes", "task", "output"]) {
    if (o[k] !== undefined && o[k] !== null && typeof o[k] !== "string") return { ok: false, error: `${k} must be a string` };
  }
  const text_ = (k: string) => (typeof o[k] === "string" ? (o[k] as string).trim() : "");
  const action = o.action as RecoveryAction;
  const reason = text_("reason");
  if (!reason) return { ok: false, error: "reason must be a non-empty string" };
  const notes = text_("notes");
  const task = text_("task");
  const output = typeof o.output === "string" ? o.output : undefined;
  if (action === "rescope" && !task) return { ok: false, error: "rescope needs a task" };
  if (action !== "rescope" && task) return { ok: false, error: `${action} takes no task` };
  if (action !== "skip" && output !== undefined && output.trim()) return { ok: false, error: `${action} takes no output` };
  return { ok: true, decision: { action, reason, ...(notes ? { notes } : {}), ...(task ? { task } : {}), ...(action === "skip" && output !== undefined ? { output } : {}) } };
}

/** Two decisions are the same when action, notes and task are (MEOW `TriageDecision.key`). */
export const sameDecision = (a: Pick<TriageDecision, "action" | "notes" | "task">, b: Pick<TriageDecision, "action" | "notes" | "task">): boolean =>
  a.action === b.action && (a.notes ?? "") === (b.notes ?? "") && (a.task ?? "") === (b.task ?? "");
