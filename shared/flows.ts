import type { Flow } from "./types";

export function newFlow(id: string, name: string): Flow {
  return { id, name, nodes: [], edges: [] };
}

/** A fully independent copy of a flow (node ids are per-flow, so they are kept). */
export function cloneFlow(source: Flow, id: string, name: string): Flow {
  const { nodes, edges } = structuredClone({ nodes: source.nodes, edges: source.edges });
  return { id, name, nodes, edges };
}
