// Resuming a finished run: "Retry failed step" / "Re-run from here". Shared by the server (which plans and starts the
// resumed run) and the UI (which says up front whether, and from where, a run can be resumed).
//
// Semantics: a resume never changes the original run. It starts a NEW run of the flow as it is NOW (current blocks,
// settings and env, so configuration fixes apply), linked to the original (`resumedFrom`). The restart steps get the
// inputs they received in their last execution in the original run (or, for steps still queued when it ended, the
// inputs they were queued with); every step that isn't downstream of a restart step keeps the outputs it had
// (`restored`), so the restart steps and everything after them see what they would have seen. The resumed run keeps
// the original's trigger event and starting prompt, and works on the original's branch so code changes made by the
// earlier steps are there.

import { isPaused } from "./journal";
import { nodeLabel, resolveNode } from "./resolve";
import type { BlockDef, Flow, NodeIO, NodeRunState, QuestionRecord, RunState } from "./types";

export interface ResumeStart {
  nodeId: string;
  inputs: NodeIO;
}

export interface ResumePlan {
  /** Restart steps (top-level node ids), in the order given. */
  nodeIds: string[];
  starts: ResumeStart[];
  /** Node states copied from the original run (steps not re-run), by node key (subflow nodes included). */
  restored: Record<string, NodeRunState>;
  /** Questions asked (and answered) by restored steps. */
  questions: QuestionRecord[];
  /** Branch the resumed run works on (undefined: scratch workspace — a new one is created). */
  branch?: string;
  /** REPO_PATH the original run used (undefined: scratch workspace). */
  repo?: string;
  warnings: string[];
}

export type ResumeResult = { ok: true; plan: ResumePlan } | { ok: false; problems: string[] };

/** Top-level node id of a node key (`sub/inner` → `sub`). */
const topOf = (key: string) => key.split("/")[0];

/** Why this run can't be resumed at all (whatever step is picked), or undefined when it can. */
export function resumeBlocker(run: Pick<RunState, "finishedAt" | "parent" | "workspace" | "phase">): string | undefined {
  if (!run.finishedAt) return isPaused(run) ? "The run is paused — Continue it instead (it carries on as the same run)" : "The run is still going";
  if (run.parent) return "This is a Box Stack task — resume the run that started it instead";
  if (!run.workspace) return "This run was started by an older version of Sandflow, which didn't record what a resume needs (its branch / workspace). Start a new run instead.";
  return undefined;
}

/** Steps "Retry failed step" restarts: the failed / stopped / interrupted top-level steps, plus steps still queued when the run ended. */
export function defaultResumeNodes(run: Pick<RunState, "nodes" | "unstarted">): string[] {
  const ids: string[] = [];
  for (const [k, ns] of Object.entries(run.nodes)) {
    if (k.includes("/")) continue;
    // Failed, stopped, or still going when Sandflow itself stopped (an interrupted run is saved mid-step).
    const interrupted = (ns.status === "running" || ns.status === "waiting") && ns.executions > 0;
    if (ns.status === "failed" || interrupted || (ns.status !== "done" && ns.error === "Stopped")) ids.push(k);
  }
  for (const u of run.unstarted ?? []) if (!ids.includes(u.nodeId)) ids.push(u.nodeId);
  return ids;
}

/** Whether this node executed (or was about to) in the run — what "Re-run from here" can start from. */
export function canRestartAt(run: Pick<RunState, "nodes" | "unstarted">, nodeId: string): boolean {
  if (nodeId.includes("/")) return false;
  return (run.nodes[nodeId]?.executions ?? 0) > 0 || !!run.unstarted?.some((u) => u.nodeId === nodeId);
}

/** Every node reachable from `starts` along the flow's edges (the starts included). */
function downstream(flow: Flow, starts: string[]): Set<string> {
  const seen = new Set<string>();
  const todo = [...starts];
  while (todo.length) {
    const id = todo.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const e of flow.edges) if (e.source === id && !seen.has(e.target)) todo.push(e.target);
  }
  return seen;
}

/**
 * Plan resuming `orig` on the current `flow` from `fromNodeIds` (default: `defaultResumeNodes`). Problems are written
 * for the user: they say which step is the trouble and what to do.
 */
export function planResume(orig: RunState, flow: Flow, blocks: BlockDef[], fromNodeIds?: string[]): ResumeResult {
  const blocked = resumeBlocker(orig);
  if (blocked) return { ok: false, problems: [blocked] };
  if (flow.id !== orig.flowId) return { ok: false, problems: ["That flow isn't the one this run ran"] };
  const byId = new Map(flow.nodes.map((n) => [n.id, n]));
  const label = (id: string) => {
    const n = byId.get(id);
    return n ? `"${nodeLabel(n, blocks)}"` : `"${id}"`;
  };

  const nodeIds = [...new Set(fromNodeIds?.length ? fromNodeIds : defaultResumeNodes(orig))];
  if (!nodeIds.length) {
    return { ok: false, problems: [orig.status === "done" ? "This run finished — pick a step to re-run from" : "No step failed in this run — pick a step to re-run from"] };
  }

  const problems: string[] = [];
  const starts: ResumeStart[] = [];
  for (const id of nodeIds) {
    if (id.includes("/")) {
      problems.push(`"${id}" is inside a subflow — re-run from the subflow step ("${topOf(id)}") instead; it runs its whole flow again`);
      continue;
    }
    const node = byId.get(id);
    if (!node) {
      problems.push(`Step "${id}" is no longer in the flow`);
      continue;
    }
    let cfg;
    try {
      cfg = resolveNode(node, blocks);
    } catch (e) {
      problems.push(`${label(id)}: ${(e as Error).message}`);
      continue;
    }
    const hasIncoming = flow.edges.some((e) => e.target === id);
    const ns = orig.nodes[id];
    const queued = orig.unstarted?.find((u) => u.nodeId === id);
    let inputs: NodeIO | undefined;
    if (ns && ns.executions > 0) inputs = ns.inputs ?? {};
    else if (queued) inputs = queued.inputs;
    else if (!hasIncoming) inputs = {};
    if (!inputs) {
      problems.push(`${label(id)} never ran in the original run, so its inputs aren't known — re-run from a step that ran`);
      continue;
    }
    // The block may take fewer inputs now (a subflow takes whatever its Flow input does).
    const accepts = (h: keyof NodeIO) => cfg.kind === "subflow" || cfg.inputs[h];
    const filtered: NodeIO = {};
    if (inputs.artifact !== undefined && accepts("artifact")) filtered.artifact = inputs.artifact;
    if (inputs.steer !== undefined && accepts("steer")) filtered.steer = inputs.steer;
    starts.push({ nodeId: id, inputs: filtered });
  }
  if (problems.length) return { ok: false, problems };

  // What runs again: the restart steps and everything after them. The rest keeps what it had in the original run.
  const rerun = downstream(flow, nodeIds);
  // A step feeding a restart step from outside the re-run part must have existed back then — otherwise the flow
  // changed upstream since, and what the restart step would get now isn't known.
  for (const id of nodeIds) {
    for (const e of flow.edges) {
      if (e.target !== id || rerun.has(e.source)) continue;
      if (!orig.nodes[e.source]) {
        problems.push(
          `${label(e.source)} (feeding ${label(id)}) was added after the original run, so it has no output to restore — re-run from ${label(e.source)} or an earlier step`,
        );
      }
    }
  }
  if (problems.length) return { ok: false, problems: [...new Set(problems)] };

  const restored: Record<string, NodeRunState> = {};
  for (const [k, ns] of Object.entries(orig.nodes)) {
    const top = topOf(k);
    if (!byId.has(top) || rerun.has(top)) continue;
    if (ns.executions === 0 && ns.outputs === undefined) continue;
    restored[k] = { ...structuredClone(ns), status: ns.status === "done" ? "done" : "idle", restored: true };
  }
  const questions = (orig.questions ?? []).filter((q) => restored[q.nodeId]).map((q) => ({ ...q }));

  const warnings: string[] = [];
  const ws = orig.workspace!;
  if (!ws.repo) {
    warnings.push(
      "The original run had no project (REPO_PATH): its scratch workspace was removed when it ended, so the re-run steps start in a new, empty workspace. Earlier steps' outputs are restored; files they wrote are not.",
    );
  }
  return {
    ok: true,
    plan: {
      nodeIds,
      starts,
      restored,
      questions,
      branch: ws.repo ? (orig.branch ?? ws.branch) : undefined,
      repo: ws.repo,
      warnings,
    },
  };
}
