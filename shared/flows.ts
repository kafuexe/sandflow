import type { Flow, FlowColor } from "./types";

/** Every colour a flow can be tagged with, in palette order. */
export const FLOW_COLORS: readonly FlowColor[] = ["red", "orange", "amber", "green", "teal", "blue", "violet", "pink"];

export function isFlowColor(v: unknown): v is FlowColor {
  return typeof v === "string" && (FLOW_COLORS as readonly string[]).includes(v);
}

/** Drop a `color` that isn't in the palette (hand-edited files, older/newer clients) — everything else is kept. */
export function sanitizeFlowColor(f: Flow): Flow {
  if (f.color === undefined || isFlowColor(f.color)) return f;
  const { color: _drop, ...rest } = f;
  return rest;
}

export function newFlow(id: string, name: string): Flow {
  return { id, name, nodes: [], edges: [] };
}

/** A fully independent copy of a flow (node ids are per-flow, so they are kept). */
export function cloneFlow(source: Flow, id: string, name: string): Flow {
  const { nodes, edges } = structuredClone({ nodes: source.nodes, edges: source.edges });
  return {
    id,
    name,
    nodes,
    edges,
    ...(isFlowColor(source.color) ? { color: source.color } : {}),
    ...(source.runOn ? { runOn: source.runOn } : {}),
  };
}
