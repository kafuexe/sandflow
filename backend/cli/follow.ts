// Following a run in the terminal: the run's event stream (`GET /api/runs/:id/events`, a state per change) turned
// into lines — step starts / ends, warnings, questions, flags — and a summary when it settles.

import readline from "node:readline";
import { PAUSE_REASON_TEXT, isSettled } from "../../shared/journal";
import type { LogLine, RunState } from "../../shared/types";
import { request, type Ctx } from "./client";

export const EXIT = { ok: 0, failed: 1, usage: 2, question: 3, paused: 75 } as const;

/** What a settled (or waiting) run means as an exit code. */
export function exitCodeFor(run: Pick<RunState, "status">): number {
  switch (run.status) {
    case "done":
      return EXIT.ok;
    case "waiting":
      return EXIT.question;
    case "paused":
      return EXIT.paused;
    default:
      return EXIT.failed;
  }
}

const hhmmss = (ts: number) => new Date(ts).toTimeString().slice(0, 8);

export function logLine(l: LogLine, withAgent = false): string | undefined {
  if (l.level === "agent" && !withAgent) return undefined;
  const tag = l.level === "warn" ? "warn  " : l.level === "error" ? "error " : l.level === "agent" ? "agent " : "";
  return `${hhmmss(l.ts)} ${tag}${l.nodeId && l.level === "agent" ? `[${l.nodeId}] ` : ""}${l.msg}`;
}

export interface Seen {
  /** Log lines printed so far, and the time of the last one (logs may be trimmed from the front). */
  logs: number;
  lastTs: number;
  flags: Set<string>;
}

export const newSeen = (): Seen => ({ logs: 0, lastTs: 0, flags: new Set() });

/** Lines for what changed since `seen` (and updates it). The engine's own log lines already say ▶ / ✓ / ↪ per step. */
export function changeLines(run: RunState, seen: Seen, withAgent = false): string[] {
  const out: string[] = [];
  let fresh = run.logs.slice(seen.logs);
  if (run.logs.length < seen.logs) fresh = run.logs.filter((l) => l.ts > seen.lastTs);
  for (const l of fresh) {
    const s = logLine(l, withAgent);
    if (s) out.push(s);
  }
  seen.logs = run.logs.length;
  if (run.logs.length) seen.lastTs = run.logs[run.logs.length - 1].ts;
  for (const f of run.flags ?? []) {
    if (f.dismissed || seen.flags.has(f.id + f.message)) continue;
    seen.flags.add(f.id + f.message);
    out.push(`⚑ ${f.severity}: ${f.message}`);
  }
  return out;
}

export const money = (usd?: number) => (usd ? `$${usd < 1 ? usd.toFixed(3) : usd.toFixed(2)}` : "");

/** The line printed when a run settles (or stops at a question). */
export function summaryLine(run: RunState): string {
  const cost = run.costUsd ? ` · cost ${money(run.costUsd)}` : "";
  switch (run.status) {
    case "done":
      return `✓ ${run.flowName} finished${run.branch ? ` (branch ${run.branch})` : ""}${cost}`;
    case "failed":
      return `✗ ${run.flowName} failed${run.error ? `: ${run.error}` : ""}${cost} — sandflow resume ${run.id} retries from the failed step`;
    case "cancelled":
      return `■ ${run.flowName} was stopped${cost}`;
    case "paused": {
      const why = run.hold ? `held: ${run.hold.problems[0] ?? run.hold.reason}` : PAUSE_REASON_TEXT[run.pauseReason ?? "crash"].toLowerCase();
      return `⏸ ${run.flowName} is paused (${why})${cost} — sandflow resume ${run.id} continues it`;
    }
    case "waiting":
      return `? ${run.pendingQuestion?.question ?? "The run is waiting for an answer"}\n  answer with: sandflow answer ${run.id} "<your answer>"`;
    default:
      return `${run.flowName} is ${run.status}${cost}`;
  }
}

export const runResult = (r: RunState) => ({
  runId: r.id,
  flowId: r.flowId,
  flowName: r.flowName,
  status: r.status,
  ...(r.phase ? { phase: r.phase } : {}),
  ...(r.branch ? { branch: r.branch } : {}),
  ...(r.costUsd ? { costUsd: r.costUsd } : {}),
  ...(r.error ? { error: r.error } : {}),
  ...(r.pendingQuestion ? { pendingQuestion: r.pendingQuestion } : {}),
  ...(r.hold ? { hold: r.hold } : {}),
});

/** States from the run's event stream until it ends (the server closes it once the run is settled). */
export async function* runEvents(ctx: Pick<Ctx, "fetch">, base: string, runId: string, signal?: AbortSignal): AsyncGenerator<RunState> {
  const r = await ctx.fetch(`${base}/api/runs/${encodeURIComponent(runId)}/events`, { signal });
  if (!r.ok || !r.body) throw new Error(`Couldn't watch run ${runId} (${r.status})`);
  const dec = new TextDecoder();
  let buf = "";
  for await (const chunk of r.body as unknown as AsyncIterable<Uint8Array>) {
    buf += dec.decode(chunk, { stream: true });
    let i: number;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const block = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const data = block
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trimStart())
        .join("\n");
      if (/^event: ?state$/m.test(block) && data) yield JSON.parse(data) as RunState;
    }
  }
}

function ask(ctx: Ctx, question: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: ctx.stdin, output: process.stderr });
    let done = false;
    rl.on("SIGINT", () => {
      done = true;
      rl.close();
      resolve(undefined);
    });
    rl.on("close", () => !done && resolve(undefined));
    rl.question(`? ${question}\n> `, (a) => {
      done = true;
      rl.close();
      resolve(a);
    });
  });
}

export interface FollowOptions {
  /** Print JSON at the end (progress goes to stderr). */
  json?: boolean;
  /** Ask pending questions on the terminal (else stop at one with exit 3). */
  interactive?: boolean;
  /** Also print agent output lines. */
  agent?: boolean;
}

/**
 * Follow a run until it settles; returns the exit code. Ctrl+C detaches — the run keeps going in its Sandflow.
 */
export async function followRun(ctx: Ctx, base: string, runId: string, o: FollowOptions = {}): Promise<number> {
  const print = o.json ? ctx.err : ctx.out;
  const seen = newSeen();
  const asked = new Set<string>();
  const ac = new AbortController();
  let detached = false;
  const onSigint = () => {
    detached = true;
    ac.abort();
  };
  process.once("SIGINT", onSigint);
  let last: RunState | undefined;
  try {
    for (let attempt = 0; attempt < 3 && !detached; attempt++) {
      try {
        for await (const s of runEvents(ctx, base, runId, ac.signal)) {
          last = s;
          attempt = 0;
          changeLines(s, seen, o.agent).forEach((l) => print(l));
          const q = s.pendingQuestion;
          if (s.status === "waiting" && q && !asked.has(`${q.nodeId}:${q.askedAt ?? ""}:${q.question}`)) {
            if (!o.interactive) {
              ac.abort();
              break;
            }
            asked.add(`${q.nodeId}:${q.askedAt ?? ""}:${q.question}`);
            const a = await ask(ctx, q.question);
            if (a === undefined) {
              detached = true;
              ac.abort();
              break;
            }
            await request(ctx, base, "POST", `/runs/${encodeURIComponent(runId)}/answer`, { answer: a }).catch((e: Error) => print(`Couldn't answer: ${e.message}`));
          }
        }
      } catch (e) {
        if (detached || ac.signal.aborted) break;
        print(`(lost the run's event stream: ${(e as Error).message} — reconnecting)`);
      }
      if (last && (isSettled(last) || last.status === "waiting")) break;
      // The stream ended early (a restart): look again.
      last = await request<RunState>(ctx, base, "GET", `/runs/${encodeURIComponent(runId)}`).catch(() => last);
      if (last && isSettled(last)) break;
    }
  } finally {
    process.removeListener("SIGINT", onSigint);
  }
  if (detached) {
    ctx.err(`\nDetached — run ${runId} keeps going in the background. Follow it again: sandflow resume ${runId}  (or: sandflow logs ${runId} --follow)`);
    return EXIT.ok;
  }
  if (!last) throw new Error(`Couldn't watch run ${runId}`);
  print(summaryLine(last));
  if (o.json) ctx.out(JSON.stringify(runResult(last)));
  return exitCodeFor(last);
}
