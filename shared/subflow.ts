// Flows inside flows. A flow used as a subflow talks to its parent through Flow input blocks (what it accepts)
// and Flow output blocks (named exits). On the parent's canvas the subflow node gets those inputs and one
// `exit:<name>` handle per output name.

import { resolveNode } from "./resolve";
import type { BlockDef, ExitHandle, Flow, FlowNode, ResolvedConfig } from "./types";

export const DEFAULT_EXIT = "done";
/** Subflows nested deeper than this stop the run (a cycle check also runs before saving / running). */
export const MAX_SUBFLOW_DEPTH = 8;

export const exitHandle = (name: string): ExitHandle => `exit:${name}`;
export const isExitHandle = (h: string): h is ExitHandle => h.startsWith("exit:");
export const exitName = (h: string) => h.slice("exit:".length);
export const EXIT_NAME_RE = /^[\w-]{1,40}$/;

export interface FlowInterface {
  /** What the subflow node accepts (union of its Flow input blocks' outputs). */
  inputs: { artifact: boolean; steer: boolean };
  /** Exit names, one per distinct Flow output name, in canvas order (top to bottom). */
  exits: string[];
  hasInput: boolean;
}

function tryResolve(node: FlowNode, blocks: BlockDef[]): ResolvedConfig | undefined {
  try {
    return resolveNode(node, blocks);
  } catch {
    return undefined;
  }
}

/** How a flow looks from the outside when it's used as a subflow. */
export function flowInterface(flow: Flow, blocks: BlockDef[]): FlowInterface {
  const inputs = { artifact: false, steer: false };
  let hasInput = false;
  const outs: { name: string; y: number }[] = [];
  for (const n of flow.nodes) {
    const cfg = tryResolve(n, blocks);
    if (!cfg) continue;
    if (cfg.kind === "flow-input") {
      hasInput = true;
      inputs.artifact ||= cfg.outputs.artifact;
      inputs.steer ||= cfg.outputs.steer;
    } else if (cfg.kind === "flow-output") {
      const name = cfg.flowOutput.name.trim() || DEFAULT_EXIT;
      if (!outs.some((o) => o.name === name)) outs.push({ name, y: n.position.y });
    }
  }
  outs.sort((a, b) => a.y - b.y);
  return { inputs, exits: outs.map((o) => o.name), hasInput };
}

/**
 * A node's config as placed in a flow: like `resolveNode`, but a subflow node takes its inputs from the child
 * flow's interface. `exits` = the node's named exits (Script exits, or the child flow's outputs).
 */
export function resolveNodeIn(node: FlowNode, blocks: BlockDef[], flows: Flow[]): ResolvedConfig & { exits: string[] } {
  const cfg = resolveNode(node, blocks);
  if (cfg.kind === "script") return { ...cfg, exits: cfg.script.exits.filter(Boolean) };
  if (cfg.kind !== "subflow") return { ...cfg, exits: [] };
  const child = flows.find((f) => f.id === cfg.subflow.flowId);
  if (!child) return { ...cfg, inputs: { ...cfg.inputs, artifact: false, steer: false }, outputs: { artifact: false, steer: false }, exits: [] };
  const fi = flowInterface(child, blocks);
  return {
    ...cfg,
    inputs: { ...cfg.inputs, artifact: fi.inputs.artifact, steer: fi.inputs.steer },
    outputs: { artifact: false, steer: false },
    exits: fi.exits,
  };
}

/** The ids of every flow `flowId` runs as a subflow, directly or nested. */
export function subflowIds(flowId: string, flows: Flow[], blocks: BlockDef[]): Set<string> {
  const out = new Set<string>();
  const walk = (id: string) => {
    const f = flows.find((x) => x.id === id);
    if (!f) return;
    for (const n of f.nodes) {
      const cfg = tryResolve(n, blocks);
      const child = cfg?.kind === "subflow" ? cfg.subflow.flowId : "";
      if (child && !out.has(child)) {
        out.add(child);
        walk(child);
      }
    }
  };
  walk(flowId);
  return out;
}

/** "A › B › A" when a flow (eventually) contains itself, else undefined. */
export function subflowCycle(flowId: string, flows: Flow[], blocks: BlockDef[]): string | undefined {
  const name = (id: string) => flows.find((f) => f.id === id)?.name ?? id;
  const walk = (id: string, path: string[]): string | undefined => {
    const f = flows.find((x) => x.id === id);
    if (!f) return undefined;
    for (const n of f.nodes) {
      const cfg = tryResolve(n, blocks);
      const child = cfg?.kind === "subflow" ? cfg.subflow.flowId : "";
      if (!child) continue;
      if (path.includes(child)) return [...path, child].map(name).join(" › ");
      const found = walk(child, [...path, child]);
      if (found) return found;
    }
    return undefined;
  };
  return walk(flowId, [flowId]);
}

/** Label of a run's node key: `review/cr` (a node inside a subflow) → "Review until approved › CR". */
export function runNodeLabel(key: string, flow: Flow | undefined, flows: Flow[], blocks: BlockDef[]): string {
  const parts: string[] = [];
  let f = flow;
  for (const id of key.split("/")) {
    const n = f?.nodes.find((x) => x.id === id);
    if (!n) return parts.length ? `${parts.join(" › ")} › ${id}` : key;
    parts.push(n.data.label || blocks.find((b) => b.id === n.data.blockId)?.name || id);
    const cfg = tryResolve(n, blocks);
    f = cfg?.kind === "subflow" ? flows.find((x) => x.id === cfg.subflow.flowId) : undefined;
  }
  return parts.join(" › ");
}
