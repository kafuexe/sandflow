// MCP run tools: Claude Code (or any MCP client) starts a flow, watches it until it ends, answers its questions,
// steers or stops it. Registered on the MCP server in mcp.ts; the run lifecycle itself stays in api.ts.

import { ENV_NAME_RE } from "../shared/resolve";
import { eventsAfter, runEnded } from "../shared/runEvents";
import type { EnvValues, RunStartedBy, RunState, RunStatus, RunSummary } from "../shared/types";
import type { McpTool } from "./mcp";

export interface McpRuns {
  /** Fails (throws) like POST /runs: unknown flow, missing inputs. `env` overrides the saved inputs for this run only. */
  start(flowId: string, o: { prompt?: string; env?: EnvValues; startedBy: RunStartedBy }): { runId: string; flowName: string; warning?: string };
  /** A live run, or the saved one. Throws for an unknown run. */
  get(runId: string): RunState;
  /** Newest first. */
  list(): RunSummary[];
  answer(runId: string, answer: string): void;
  steer(runId: string, nodeKey: string, message: string): void;
  stop(runId: string): RunStatus;
  /** Calls `fn` whenever the live run changes; returns the unsubscribe. */
  onChange(runId: string, fn: () => void): () => void;
}

/** A watch returns by then at the latest, so an MCP client's request never hangs for long. */
export const MAX_WATCH_SECONDS = 600;
const DEFAULT_WATCH_SECONDS = 540;
/** Also re-read the run this often while watching (a saved run changed by another process, a continued run). */
const WATCH_POLL_MS = 2000;
const OUTPUT_PREVIEW = 600;

const str = (v: unknown, name: string): string => {
  if (typeof v !== "string" || !v.trim()) throw new Error(`${name} is required`);
  return v.trim();
};

const time = (ms?: number) => (ms ? new Date(ms).toISOString() : "");
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}… (${s.length - n} more characters)` : s);
const phaseOf = (run: RunState) => (run as RunState & { phase?: string; attempt?: number });

function describeRun(run: RunState): string {
  const j = phaseOf(run);
  const lines = [`Run ${run.id} — ${run.flowName} (flow ${run.flowId})`];
  lines.push(`Status: ${run.status}${j.phase ? ` · phase: ${j.phase}` : ""}${j.attempt && j.attempt > 1 ? ` · attempt ${j.attempt}` : ""}`);
  lines.push(`Started: ${time(run.startedAt)}${run.finishedAt ? ` · finished: ${time(run.finishedAt)}` : ""}`);
  if (run.startedBy) lines.push(`Started by: ${run.startedBy.label}`);
  if (run.prompt?.trim()) lines.push(`Prompt: ${clip(run.prompt.trim(), 300)}`);
  if (run.error) lines.push(`Error: ${run.error}`);
  if (run.pendingQuestion) lines.push(`Waiting for an answer from ${run.pendingQuestion.nodeId}: ${run.pendingQuestion.question}`);
  const flags = (run.flags ?? []).filter((f) => !f.dismissed);
  if (flags.length) lines.push("Flags:", ...flags.map((f) => `- [${f.severity}] ${f.message}${f.nodeKey ? ` (${f.nodeKey})` : ""}`));
  lines.push("Steps:");
  for (const [key, ns] of Object.entries(run.nodes)) {
    lines.push(`- ${key}: ${ns.status}${ns.executions > 1 ? ` ×${ns.executions}` : ""}${ns.restored ? " (copied from the resumed run)" : ""}${ns.error ? ` — ${ns.error}` : ""}`);
    if (ns.outputs?.artifact && (ns.status === "done" || ns.status === "failed")) lines.push(`  ${clip(ns.outputs.artifact, OUTPUT_PREVIEW).replace(/\n/g, "\n  ")}`);
  }
  if (run.result?.outputs?.artifact) lines.push(`Result${run.result.exit ? ` (${run.result.exit})` : ""}: ${clip(run.result.outputs.artifact, OUTPUT_PREVIEW * 2)}`);
  return lines.join("\n");
}

export function runTools(runs: McpRuns): McpTool[] {
  const runIdProp = { runId: { type: "string", description: "Run id (start_run returns it; list_runs lists them)" } };
  return [
    {
      name: "start_run",
      description:
        "Start a run of a flow. Returns the run id; then call watch_run to follow it until it ends. " +
        "Fails with the inputs still missing (starting prompt, env vars) — pass prompt, or env for this run only.",
      unscopedOnly: true,
      inputSchema: {
        type: "object",
        required: ["flowId"],
        properties: {
          flowId: { type: "string", description: "Flow id (list_flows shows them)" },
          prompt: { type: "string", description: "Starting prompt for this run (default: the one set in Sandflow)" },
          env: { type: "object", additionalProperties: { type: "string" }, description: "Env vars for this run only, on top of the ones set in Sandflow's Inputs tab" },
        },
      },
      run: (a, ctx) => {
        const flowId = str(a.flowId, "flowId");
        let env: EnvValues | undefined;
        if (a.env !== undefined) {
          if (!a.env || typeof a.env !== "object" || Array.isArray(a.env)) throw new Error("env must be an object of NAME: value");
          const bad = Object.keys(a.env).filter((k) => !ENV_NAME_RE.test(k));
          if (bad.length) throw new Error(`Invalid env var name: ${bad.join(", ")}`);
          env = Object.fromEntries(Object.entries(a.env).map(([k, v]) => [k, String(v)]));
        }
        const prompt = typeof a.prompt === "string" && a.prompt.trim() ? a.prompt.trim() : undefined;
        const r = runs.start(flowId, { prompt, env, startedBy: ctx.client ?? { kind: "mcp", label: "MCP client" } });
        return [
          `Started a run of "${r.flowName}". Run id: ${r.runId}`,
          ...(r.warning ? [`Warning: ${r.warning}`] : []),
          `Next: watch_run {"runId": "${r.runId}"} returns when something happens (a step finishes or fails, a question, the run is interrupted, continues or ends). Call it again with the cursor it returns until it says ended.`,
        ].join("\n");
      },
    },
    {
      name: "watch_run",
      description:
        "Wait until a run has news after the cursor, then return it as JSON: {status, events, cursor, ended}. " +
        "Events: step finished / failed, a question waiting for an answer, a flag, the run interrupted / paused / continuing / done / failed. " +
        "Pass the returned cursor as `after` next time (omit it to get everything from the start). Returns after ~9 minutes with timedOut " +
        "and no events if nothing happened — just call it again. Events are kept in the run, so nothing is missed between calls.",
      unscopedOnly: true,
      inputSchema: {
        type: "object",
        required: ["runId"],
        properties: {
          ...runIdProp,
          after: { type: "string", description: "Cursor from the previous watch_run" },
          timeoutSeconds: { type: "number", description: `Longest wait (default ${DEFAULT_WATCH_SECONDS}, at most ${MAX_WATCH_SECONDS})` },
        },
      },
      run: async (a, ctx) => {
        const runId = str(a.runId, "runId");
        const after = typeof a.after === "string" ? a.after : undefined;
        const secs = typeof a.timeoutSeconds === "number" && a.timeoutSeconds >= 0 ? Math.min(a.timeoutSeconds, MAX_WATCH_SECONDS) : DEFAULT_WATCH_SECONDS;
        const deadline = Date.now() + secs * 1000;
        for (;;) {
          const run = runs.get(runId);
          const r = eventsAfter(run, after);
          const ended = runEnded(run);
          const timedOut = Date.now() >= deadline || !!ctx.signal?.aborted;
          if (r.events.length || ended || timedOut) {
            const j = phaseOf(run);
            return JSON.stringify({
              runId,
              status: run.status,
              ...(j.phase ? { phase: j.phase } : {}),
              ...(run.pendingQuestion ? { pendingQuestion: { node: run.pendingQuestion.nodeId, question: run.pendingQuestion.question } } : {}),
              events: r.events,
              cursor: r.cursor,
              ended,
              ...(!r.events.length && !ended ? { timedOut: true } : {}),
            });
          }
          await new Promise<void>((resolve) => {
            const done = () => {
              off();
              clearTimeout(timer);
              ctx.signal?.removeEventListener("abort", done);
              resolve();
            };
            const off = runs.onChange(runId, done);
            const timer = setTimeout(done, Math.max(0, Math.min(WATCH_POLL_MS, deadline - Date.now())));
            ctx.signal?.addEventListener("abort", done, { once: true });
          });
        }
      },
    },
    {
      name: "answer_question",
      description: "Answer the question a run is waiting on (watch_run / get_run show it).",
      unscopedOnly: true,
      inputSchema: { type: "object", required: ["runId", "answer"], properties: { ...runIdProp, answer: { type: "string" } } },
      run: (a) => {
        runs.answer(str(a.runId, "runId"), String(a.answer ?? ""));
        return "Answered — the run continues.";
      },
    },
    {
      name: "steer_run",
      description: "Send a message to an agent step while it works (\"focus on X\", \"wrap up\"). nodeId is the step's key from get_run (subflow steps: \"sub/plan\").",
      unscopedOnly: true,
      inputSchema: {
        type: "object",
        required: ["runId", "nodeId", "message"],
        properties: { ...runIdProp, nodeId: { type: "string" }, message: { type: "string" } },
      },
      run: (a) => {
        runs.steer(str(a.runId, "runId"), str(a.nodeId, "nodeId"), String(a.message ?? ""));
        return "Sent to the agent.";
      },
    },
    {
      name: "stop_run",
      description: "Stop (cancel) a run. Only when the user asks for it — a stopped run is never continued automatically.",
      unscopedOnly: true,
      inputSchema: { type: "object", required: ["runId"], properties: runIdProp },
      run: (a) => `Stopping. Status: ${runs.stop(str(a.runId, "runId"))}`,
    },
    {
      name: "get_run",
      description: "A run's status, phase, who started it, each step's state and output, the question it waits on and its flags.",
      unscopedOnly: true,
      inputSchema: { type: "object", required: ["runId"], properties: runIdProp },
      run: (a) => describeRun(runs.get(str(a.runId, "runId"))),
    },
    {
      name: "list_runs",
      description: "Recent runs, newest first (optionally of one flow).",
      unscopedOnly: true,
      inputSchema: { type: "object", properties: { flowId: { type: "string", description: "Only runs of this flow" } } },
      run: (a) => {
        const flowId = typeof a.flowId === "string" && a.flowId ? a.flowId : undefined;
        const shown = runs.list().filter((r) => !flowId || r.flowId === flowId).slice(0, 30);
        return (
          shown
            .map(
              (r) =>
                `- ${r.id}: ${r.flowName} — ${r.status}${r.pendingQuestion ? ", waiting for an answer" : ""}` +
                `${r.startedBy ? `, started by ${r.startedBy.label}` : ""}${r.parent ? `, part of run ${r.parent.runId}` : ""} (${time(r.startedAt)})`,
            )
            .join("\n") || "(no runs)"
        );
      },
    },
  ];
}
