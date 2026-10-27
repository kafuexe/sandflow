// Box Stack execution: split the input into tasks (orchestrator), run the child flow once per task as its own run
// (up to maxConcurrent at once, retrying rejected tasks), then combine what succeeded (orchestrator again).

import { randomUUID } from "node:crypto";
import { normaliseTasks, parseSplit, SPLIT_PROTOCOL } from "../shared/stack";
import { isPaused } from "../shared/journal";
import type { Flow, FlowNode, NodeIO, ResolvedConfig, RunState, StackJournal, StackRunInfo } from "../shared/types";
import type { NodeResult, NodeRunner, RunContext, RunHandle } from "./engine";

/** Extra tries when the orchestrator's split can't be used. */
const SPLIT_RETRIES = 2;
const REASON_CHARS = 1500;

export interface StackDeps {
  /** The parent run's context (unscoped: node keys are full keys). */
  ctx: RunContext;
  /** The context of the graph the stack node is in (what the orchestrator agent runs with). */
  scoped: RunContext;
  /** The stack node's full key in the parent run (`s`, or `sub/s` inside a subflow). */
  nodeKey: string;
  label: string;
  ai: NodeRunner;
  /** Start one attempt of a task as a child run. */
  spawn(child: Flow, o: { entry: NodeIO; stack: StackRunInfo; shared: boolean; branch?: string; baseBranch?: string }): RunHandle;
  /** A child's `stack.outcome` changed after it finished (so it can be saved again). */
  settled(h: RunHandle): void;
  /**
   * Continuing the run: pick a task's child run up again (it continues as the same run), or its final state when it
   * had already finished. Undefined when it can't be found.
   */
  resumeChild?(runId: string, child: Flow, o: { shared: boolean; branch?: string; baseBranch?: string }): RunHandle | RunState | undefined;
  /** The parent run stopped or is pausing: start nothing new. */
  halted?(): boolean;
}

type Outcome =
  | { ok: true; name: string; outputs: NodeIO; branch?: string }
  | { ok: false; name: string; reason: string; attempts: number };

/** Branch the parent run works on (what an isolated child is cut from). */
export function parentBranch(ctx: RunContext): string {
  return ctx.run.branch || ctx.branch || ctx.env.BRANCH_NAME?.trim() || `sandflow/${ctx.run.id}`;
}

const mergeLocks = new Map<string, Promise<unknown>>();

/** Run `fn` once every earlier merge of this stack group is over (so parallel tasks never race on one branch). */
export function withMergeLock<T>(groupId: string, fn: () => Promise<T>): Promise<T> {
  const prev = mergeLocks.get(groupId) ?? Promise.resolve();
  const run = prev.catch(() => {}).then(fn);
  const tail = run.catch(() => {});
  mergeLocks.set(groupId, tail);
  void tail.then(() => {
    if (mergeLocks.get(groupId) === tail) mergeLocks.delete(groupId);
  });
  return run;
}

const clip = (s: string, n = REASON_CHARS) => (s.length > n ? `${s.slice(0, n)}…` : s);

/** Why an attempt didn't count as a success, or undefined when it did. */
function rejection(final: RunState, successExits: string[]): string | undefined {
  if (final.status === "cancelled") return "cancelled";
  if (final.status === "failed") return final.error ?? "failed";
  const exit = final.result?.exit;
  if (exit !== undefined && successExits.includes(exit)) return undefined;
  const said = final.result?.outputs?.artifact?.trim();
  return `${exit === undefined ? "ended without reaching a Flow output" : `ended at exit "${exit}"`}${said ? `:\n${clip(said)}` : ""}`;
}

export async function runStack(deps: StackDeps, node: FlowNode, cfg: ResolvedConfig, inputs: NodeIO): Promise<NodeResult> {
  const { ctx, nodeKey } = deps;
  const s = cfg.stack;
  const childFlow = ctx.flows.find((f) => f.id === s.flowId);
  if (!childFlow) throw new Error(s.flowId ? `Box Stack runs unknown flow "${s.flowId}"` : "Box Stack has no flow selected");
  // Every task runs the flow as it was when the stack started, even if it's edited meanwhile.
  const child = structuredClone(childFlow);
  const orchestrator = (instructions: string): ResolvedConfig => ({
    ...cfg,
    kind: "ai",
    instructions,
    extraInstructions: "",
    inputs: { artifact: true, steer: true, startingPrompt: false },
    outputs: { artifact: true, steer: true },
    allowQuestions: false,
    maxIterations: 1,
  });
  // Continuing after an interruption: the tasks journaled last time (finished ones aren't redone).
  const ns = ctx.run.nodes[nodeKey];
  const saved = ctx.takeInterrupted?.(nodeKey) && ns?.stack?.tasks.length ? ns.stack : undefined;
  const journal = (j: StackJournal) => {
    if (ns) ns.stack = j;
    ctx.journal?.();
  };
  const failed = (message: string, details?: string): NodeResult => {
    ctx.flag("error", message, { nodeKey, details });
    return { outputs: { artifact: details ? `${message}\n\n${details}` : message }, exit: "failed" };
  };

  // ---- split ----
  const original = inputs.artifact ?? "";
  let tasks: ReturnType<typeof normaliseTasks> | undefined = saved?.tasks.map((t) => ({ name: t.name, slug: t.slug, input: t.input }));
  let problem = "";
  if (saved) ctx.log("info", `Continuing the Box Stack: ${saved.tasks.filter((t) => t.status === "done").length} of ${saved.tasks.length} task(s) already finished`, nodeKey);
  for (let attempt = 0; attempt <= SPLIT_RETRIES && !tasks; attempt++) {
    if (ctx.abort.signal.aborted) throw new Error("Run cancelled");
    const artifact = problem ? `${original}\n\n---\nYour previous answer couldn't be used: ${problem} Answer again.` : original;
    const r = await deps.ai(deps.scoped, node, orchestrator(`${s.splitInstructions}\n\n${SPLIT_PROTOCOL}`), { artifact, steer: inputs.steer });
    const parsed = parseSplit(r.outputs.artifact ?? "");
    if ("error" in parsed) problem = parsed.error;
    else if (parsed.tasks.length > s.maxChildren) problem = `You split it into ${parsed.tasks.length} tasks, but at most ${s.maxChildren} are allowed — merge related ones.`;
    else tasks = normaliseTasks(parsed.tasks);
    if (problem && !tasks) ctx.log("warn", `Split unusable: ${problem}`, nodeKey);
  }
  if (!tasks) return failed(`Box Stack couldn't split the input into tasks`, problem);
  ctx.log("info", `Split into ${tasks.length} task(s): ${tasks.map((t) => t.name).join(", ")}`, nodeKey);

  // ---- children ----
  const groupId = saved?.groupId ?? randomUUID();
  const isolated = s.workspace === "isolated";
  const base = isolated ? parentBranch(ctx) : undefined;
  const live = new Set<RunHandle>();
  // Pausing the run pauses its tasks' runs (they continue with it); stopping it stops them.
  const stopAll = () =>
    live.forEach((h) => ((ctx.abort.signal.reason as Error | undefined)?.message === "Run paused" ? void h.pause(ctx.run.pauseReason === "update" ? "update" : "quit") : h.cancel()));
  ctx.abort.signal.addEventListener("abort", stopAll);
  const outcomes: Outcome[] = new Array(tasks.length);
  const maxAttempts = s.maxRetries + 1;
  const halted = () => ctx.abort.signal.aborted || !!deps.halted?.();
  const state: StackJournal = {
    groupId,
    tasks: tasks.map((t, i) => saved?.tasks[i] ?? { name: t.name, slug: t.slug, input: t.input, status: "pending", attempt: 0 }),
  };
  journal(state);

  async function runTask(index: number) {
    const t = tasks![index];
    const js = state.tasks[index];
    if (js.status === "done") {
      outcomes[index] = { ok: true, name: t.name, outputs: js.outputs ?? {}, branch: js.branch };
      return;
    }
    if (js.status === "dropped") {
      outcomes[index] = { ok: false, name: t.name, reason: js.reason ?? "dropped", attempts: js.attempt };
      return;
    }
    let reason = js.reason ?? "";
    // A task whose run was going when the stack was interrupted: that run continues (same run, same attempt).
    let carryOn = js.status === "running" && js.runId ? js.runId : undefined;
    for (let attempt = carryOn ? js.attempt : js.attempt + 1; attempt <= maxAttempts; attempt++) {
      if (halted()) return;
      const branch = isolated ? `${base}-${groupId.slice(0, 4)}-${index + 1}-${t.slug}${attempt > 1 ? `-try${attempt}` : ""}` : undefined;
      let h: RunHandle | undefined;
      let final: RunState;
      const resumed = carryOn ? deps.resumeChild?.(carryOn, child, { shared: !isolated, branch, baseBranch: base }) : undefined;
      carryOn = undefined;
      if (resumed && !("done" in resumed)) final = resumed;
      else {
        h = (resumed as RunHandle | undefined) ?? deps.spawn(child, {
          entry: { artifact: reason ? `The previous attempt at this task was rejected:\n${reason}\n\nTry again.\n\n---\n\n${t.input}` : t.input, steer: inputs.steer },
          stack: { groupId, name: deps.label, index, total: tasks!.length, task: t.name, attempt, maxAttempts, ...(branch ? { branch } : {}) },
          shared: !isolated,
          branch,
          baseBranch: base,
        });
        Object.assign(js, { status: "running", runId: h.state.id, attempt, branch });
        journal(state);
        live.add(h);
        final = await h.done;
        live.delete(h);
      }
      // Paused with the run: it stays "running" in the journal and continues when the run does.
      if (isPaused(final)) return;
      const stack = final.stack ?? h?.state.stack;
      const why = rejection(final, s.successExits);
      if (!why) {
        if (stack) stack.outcome = "succeeded";
        if (h) deps.settled(h);
        outcomes[index] = { ok: true, name: t.name, outputs: final.result?.outputs ?? {}, branch };
        Object.assign(js, { status: "done", outputs: final.result?.outputs ?? {} });
        journal(state);
        ctx.log("info", `✓ task "${t.name}"`, nodeKey);
        return;
      }
      if (ctx.abort.signal.aborted) return;
      // Stopped by hand (the stack itself is still going): that's a decision, not a failure to retry.
      const stopped = final.status === "cancelled";
      reason = stopped ? "stopped by you" : why;
      if (stack) stack.outcome = attempt < maxAttempts && !stopped ? "rejected" : "dropped";
      if (h) deps.settled(h);
      ctx.log("warn", `Task "${t.name}" attempt ${attempt}/${maxAttempts} ${stopped ? "stopped" : `rejected: ${clip(why, 300)}`}`, nodeKey);
      Object.assign(js, { reason, status: stopped || attempt >= maxAttempts ? "dropped" : "pending" });
      journal(state);
      if (stopped) {
        outcomes[index] = { ok: false, name: t.name, reason, attempts: attempt };
        return;
      }
    }
    outcomes[index] = { ok: false, name: t.name, reason, attempts: maxAttempts };
  }

  // A fixed pool: each worker takes the next task and keeps its slot through the task's retries.
  let next = 0;
  const worker = async () => {
    while (next < tasks!.length && !halted()) await runTask(next++);
  };
  try {
    await Promise.all(Array.from({ length: Math.min(Math.max(1, s.maxConcurrent), tasks.length) }, worker));
  } finally {
    ctx.abort.signal.removeEventListener("abort", stopAll);
  }
  if (ctx.abort.signal.aborted) throw new Error("Run cancelled");
  if (halted()) throw new Error("Run paused");

  const done = outcomes.filter((o): o is Extract<Outcome, { ok: true }> => o.ok);
  const dropped = outcomes.filter((o): o is Extract<Outcome, { ok: false }> => !o.ok);
  const droppedList = dropped.map((d) => `- ${d.name} (${d.attempts} attempt${d.attempts === 1 ? "" : "s"}): ${d.reason}`).join("\n");
  if (tasks.length && !done.length) return failed(`Box Stack: no task succeeded (${tasks.length} tried)`, droppedList);

  // ---- combine ----
  const parts = [`# Original input\n\n${original}`, `# Results`];
  for (const d of done) {
    parts.push(`## ${d.name}${d.branch ? `\n\nBranch: ${d.branch}` : ""}\n\n${d.outputs.artifact ?? "(no output)"}${d.outputs.steer ? `\n\nNotes: ${d.outputs.steer}` : ""}`);
  }
  if (!tasks.length) parts.push("(The split produced no tasks.)");
  if (dropped.length) parts.push(`# Dropped tasks\n\nThese failed every attempt and are not in the results:\n${droppedList}`);
  let combined: NodeResult;
  try {
    combined = await deps.ai(deps.scoped, node, orchestrator(s.combineInstructions), { artifact: parts.join("\n\n"), steer: inputs.steer });
  } catch (e) {
    if (ctx.abort.signal.aborted) throw e;
    const branches = done.filter((d) => d.branch).map((d) => `- ${d.name}: ${d.branch}`).join("\n");
    return failed(`Box Stack couldn't combine the results: ${(e as Error).message}`, branches ? `Finished work is on these branches:\n${branches}` : undefined);
  }
  if (dropped.length) {
    ctx.flag("warning", `${dropped.length} of ${tasks.length} tasks dropped after retries: ${dropped.map((d) => d.name).join(", ")}`, { nodeKey, details: droppedList });
  }
  return { outputs: combined.outputs, exit: "done" };
}
