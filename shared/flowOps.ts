// Structured flow editing shared by the MCP tools (agents) and the UI: edge references, validation,
// batched edit operations and auto-layout. Agents never send coordinates or edge ids.

import { nodeLabel, resolveNode } from "./resolve";
import type { BlockConfig, BlockDef, EdgeInputKind, Flow, FlowEdge, FlowNode, ResolvedConfig, SourceHandle } from "./types";

export const NODE_ID_RE = /^[A-Za-z][\w-]{0,63}$/;
const SOURCE_HANDLES: SourceHandle[] = ["artifact", "steer", "true", "false"];
const TARGET_HANDLES: EdgeInputKind[] = ["artifact", "steer"];

export const COL = 320;
export const ROW = 200;

export interface EdgeRef {
  source: string;
  sourceHandle: SourceHandle;
  target: string;
  targetHandle: EdgeInputKind;
}

export const edgeId = (e: EdgeRef) => `e-${e.source}-${e.sourceHandle}-${e.target}-${e.targetHandle}`;
export const formatEdge = (e: EdgeRef) => `${e.source}.${e.sourceHandle} -> ${e.target}.${e.targetHandle}`;

/**
 * Parse `plan.artifact -> implement.steer`. Handles are optional and default to `artifact`
 * (`plan -> implement` = artifact to artifact). Condition branches: `check.true -> fix`.
 */
export function parseEdge(ref: string): EdgeRef {
  const m = /^\s*([\w-]+)(?:\.([\w]+))?\s*-+>\s*([\w-]+)(?:\.([\w]+))?\s*$/.exec(ref);
  if (!m) throw new Error(`Can't read edge "${ref}". Write it as "source.handle -> target.handle", e.g. "plan.artifact -> implement.artifact"`);
  const sourceHandle = (m[2] ?? "artifact") as SourceHandle;
  const targetHandle = (m[4] ?? "artifact") as EdgeInputKind;
  if (!SOURCE_HANDLES.includes(sourceHandle)) {
    throw new Error(`"${ref}": "${sourceHandle}" isn't an output handle. Use artifact, steer, or true/false out of an If block`);
  }
  if (!TARGET_HANDLES.includes(targetHandle)) {
    throw new Error(`"${ref}": "${targetHandle}" isn't an input handle. Use artifact or steer`);
  }
  return { source: m[1], sourceHandle, target: m[3], targetHandle };
}

function tryResolve(node: FlowNode, blocks: BlockDef[]): ResolvedConfig | undefined {
  try {
    return resolveNode(node, blocks);
  } catch {
    return undefined;
  }
}

/** Why this edge can't exist in `flow` (undefined = fine). */
export function edgeProblem(flow: Flow, blocks: BlockDef[], e: EdgeRef): string | undefined {
  const src = flow.nodes.find((n) => n.id === e.source);
  const dst = flow.nodes.find((n) => n.id === e.target);
  if (!src) return `No node "${e.source}" in this flow`;
  if (!dst) return `No node "${e.target}" in this flow`;
  if (e.source === e.target) return `A node can't connect to itself ("${e.source}")`;
  const s = tryResolve(src, blocks);
  const t = tryResolve(dst, blocks);
  if (!s) return `Node "${e.source}" uses unknown block "${src.data.blockId}"`;
  if (!t) return `Node "${e.target}" uses unknown block "${dst.data.blockId}"`;
  if (s.kind === "condition") {
    if (e.sourceHandle !== "true" && e.sourceHandle !== "false") {
      return `"${e.source}" is an If block — connect from "${e.source}.true" or "${e.source}.false"`;
    }
  } else if (e.sourceHandle === "true" || e.sourceHandle === "false") {
    return `"${e.source}" isn't an If block, so it has no ${e.sourceHandle} output`;
  } else if (!s.outputs[e.sourceHandle]) {
    const valid = (["artifact", "steer"] as const).filter((k) => s.outputs[k]);
    return `"${e.source}" doesn't output ${e.sourceHandle}. Valid: ${valid.join(", ") || "none (it has no outputs)"}`;
  }
  if (t.kind === "trigger") return `"${e.target}" is a trigger — triggers start a flow and take no inputs`;
  if (!t.inputs[e.targetHandle]) {
    const valid = (["artifact", "steer"] as const).filter((k) => t.inputs[k]);
    return `"${e.target}" doesn't accept ${e.targetHandle}. Valid: ${valid.join(", ") || "none (it takes no edge inputs)"}`;
  }
  return undefined;
}

export interface FlowReport {
  errors: string[];
  warnings: string[];
}

/** Everything wrong with a flow. Errors make it unrunnable; warnings are likely mistakes. */
export function validateFlow(flow: Flow, blocks: BlockDef[]): FlowReport {
  const errors: string[] = [];
  const warnings: string[] = [];
  const ids = new Set<string>();
  for (const n of flow.nodes) {
    if (ids.has(n.id)) errors.push(`Duplicate node id "${n.id}"`);
    ids.add(n.id);
    if (!blocks.some((b) => b.id === n.data.blockId)) errors.push(`Node "${n.id}" uses unknown block "${n.data.blockId}"`);
  }
  const seen = new Set<string>();
  for (const e of flow.edges) {
    const problem = edgeProblem(flow, blocks, e);
    if (problem) errors.push(`${formatEdge(e)}: ${problem}`);
    const key = formatEdge(e);
    if (seen.has(key)) warnings.push(`Duplicate edge ${key}`);
    seen.add(key);
  }
  if (!flow.nodes.length) return { errors, warnings: ["The flow is empty"] };

  const incoming = new Set(flow.edges.map((e) => e.target));
  if (!flow.nodes.some((n) => !incoming.has(n.id))) {
    errors.push("No start node: every node has an incoming edge, so nothing can run first");
  }
  for (const n of flow.nodes) {
    const cfg = tryResolve(n, blocks);
    if (!cfg) continue;
    const out = flow.edges.filter((e) => e.source === n.id);
    const targets = new Set(out.map((e) => e.target));
    if (cfg.kind === "manager" && targets.size < 2) {
      warnings.push(`Manager "${n.id}" routes to ${targets.size} node(s); a manager should have 2+ outgoing targets to choose between`);
    }
    if (cfg.kind === "condition" && !out.length) warnings.push(`If "${n.id}" has no outgoing branch`);
    if (flow.nodes.length > 1 && !out.length && !incoming.has(n.id)) warnings.push(`Node "${n.id}" isn't connected to anything`);
  }
  return { errors, warnings };
}

// ---------- operations ----------

export type FlowOp =
  | { op: "add_node"; id: string; block: string; label?: string; overrides?: BlockConfig }
  | { op: "update_node"; id: string; block?: string; label?: string | null; overrides?: Record<string, unknown> | null }
  | { op: "remove_node"; id: string }
  | { op: "connect"; edge: string }
  | { op: "disconnect"; edge: string }
  | { op: "rename_flow"; name: string }
  | { op: "auto_layout" };

export interface OpsResult {
  flow: Flow;
  /** Human-readable change list, one line per change: `+ node plan (Plan)`, `- edge …`, `~ node …`. */
  changes: string[];
  /** Node ids added or modified (for highlighting). */
  touched: string[];
}

/** Apply ops in order to a copy of `flow`. Throws with the failing op's index on the first bad op. */
export function applyOps(flow: Flow, blocks: BlockDef[], ops: FlowOp[]): OpsResult {
  let f: Flow = structuredClone(flow);
  const changes: string[] = [];
  const touched = new Set<string>();
  const added = new Set<string>();
  let relayout = false;
  const blockName = (id: string) => blocks.find((b) => b.id === id)?.name ?? id;
  const requireBlock = (id: string) => {
    const b = blocks.find((x) => x.id === id);
    if (!b) throw new Error(`Unknown block "${id}". Call list_blocks to see the available block ids`);
    return b;
  };

  ops.forEach((op, i) => {
    try {
      switch (op.op) {
        case "add_node": {
          if (!NODE_ID_RE.test(op.id ?? "")) {
            throw new Error(`Node id "${op.id}" is invalid: start with a letter, then letters, digits, _ or - (max 64)`);
          }
          if (f.nodes.some((n) => n.id === op.id)) throw new Error(`Node "${op.id}" already exists`);
          requireBlock(op.block);
          const data: FlowNode["data"] = { blockId: op.block };
          if (op.label?.trim()) data.label = op.label.trim();
          if (op.overrides && Object.keys(op.overrides).length) data.overrides = op.overrides;
          f.nodes.push({ id: op.id, type: "block", position: { x: 0, y: 0 }, data });
          added.add(op.id);
          touched.add(op.id);
          changes.push(`+ node ${op.id} (${blockName(op.block)})`);
          break;
        }
        case "update_node": {
          const n = f.nodes.find((x) => x.id === op.id);
          if (!n) throw new Error(`No node "${op.id}" in this flow`);
          const what: string[] = [];
          if (op.block !== undefined && op.block !== n.data.blockId) {
            requireBlock(op.block);
            n.data.blockId = op.block;
            what.push(`block → ${blockName(op.block)}`);
          }
          if (op.label !== undefined) {
            if (op.label === null || !op.label.trim()) delete n.data.label;
            else n.data.label = op.label.trim();
            what.push(op.label ? `label "${op.label.trim()}"` : "label cleared");
          }
          if (op.overrides === null) {
            delete n.data.overrides;
            what.push("overrides cleared");
          } else if (op.overrides) {
            const o: Record<string, unknown> = { ...n.data.overrides };
            for (const [k, v] of Object.entries(op.overrides)) {
              if (v === null) delete o[k];
              else o[k] = v;
            }
            if (Object.keys(o).length) n.data.overrides = o as BlockConfig;
            else delete n.data.overrides;
            what.push(`overrides: ${Object.keys(op.overrides).join(", ")}`);
          }
          touched.add(n.id);
          changes.push(`~ node ${n.id}${what.length ? ` (${what.join("; ")})` : ""}`);
          break;
        }
        case "remove_node": {
          if (!f.nodes.some((n) => n.id === op.id)) throw new Error(`No node "${op.id}" in this flow`);
          const dropped = f.edges.filter((e) => e.source === op.id || e.target === op.id);
          f = { ...f, nodes: f.nodes.filter((n) => n.id !== op.id), edges: f.edges.filter((e) => !dropped.includes(e)) };
          changes.push(`- node ${op.id}`);
          dropped.forEach((e) => changes.push(`- edge ${formatEdge(e)}`));
          break;
        }
        case "connect": {
          const e = parseEdge(op.edge);
          const problem = edgeProblem(f, blocks, e);
          if (problem) throw new Error(problem);
          const id = edgeId(e);
          if (!f.edges.some((x) => x.id === id)) {
            f.edges.push({ id, ...e } as FlowEdge);
            changes.push(`+ edge ${formatEdge(e)}`);
          }
          break;
        }
        case "disconnect": {
          const e = parseEdge(op.edge);
          const before = f.edges.length;
          f.edges = f.edges.filter(
            (x) => !(x.source === e.source && x.target === e.target && x.sourceHandle === e.sourceHandle && x.targetHandle === e.targetHandle),
          );
          if (f.edges.length === before) throw new Error(`There is no edge ${formatEdge(e)}`);
          changes.push(`- edge ${formatEdge(e)}`);
          break;
        }
        case "rename_flow": {
          if (!op.name?.trim()) throw new Error("Flow name can't be empty");
          f.name = op.name.trim();
          changes.push(`~ flow renamed to "${f.name}"`);
          break;
        }
        case "auto_layout":
          relayout = true;
          changes.push("~ layout tidied");
          break;
        default:
          throw new Error(`Unknown op "${(op as { op: string }).op}"`);
      }
    } catch (e) {
      throw new Error(`Op ${i + 1} (${(op as { op?: string }).op ?? "?"}): ${(e as Error).message}`);
    }
  });

  f = relayout ? autoLayout(f) : placeNew(f, added);
  return { flow: f, changes, touched: [...touched].filter((id) => f.nodes.some((n) => n.id === id)) };
}

// ---------- layout ----------

/** Columns by longest path from the start nodes (back edges of loops ignored), rows by order within a column. */
function layers(flow: Flow): Map<string, number> {
  const out = new Map<string, string[]>();
  for (const e of flow.edges) out.set(e.source, [...(out.get(e.source) ?? []), e.target]);
  // Find back edges with a DFS so loops (CR → fix → CR) don't push columns forever.
  const back = new Set<string>();
  const state = new Map<string, 1 | 2>();
  const incoming = new Set(flow.edges.map((e) => e.target));
  const roots = flow.nodes.filter((n) => !incoming.has(n.id)).map((n) => n.id);
  const visit = (id: string) => {
    state.set(id, 1);
    for (const t of out.get(id) ?? []) {
      if (state.get(t) === 1) back.add(`${id}>${t}`);
      else if (!state.has(t)) visit(t);
    }
    state.set(id, 2);
  };
  [...roots, ...flow.nodes.map((n) => n.id)].forEach((id) => state.has(id) || visit(id));

  const col = new Map(flow.nodes.map((n) => [n.id, 0]));
  for (let pass = 0; pass < flow.nodes.length; pass++) {
    let changed = false;
    for (const e of flow.edges) {
      if (back.has(`${e.source}>${e.target}`)) continue;
      const c = (col.get(e.source) ?? 0) + 1;
      if (c > (col.get(e.target) ?? 0)) {
        col.set(e.target, c);
        changed = true;
      }
    }
    if (!changed) break;
  }
  return col;
}

/** Lay the whole flow out left → right. */
export function autoLayout(flow: Flow): Flow {
  const col = layers(flow);
  const rows = new Map<number, number>();
  const nodes = flow.nodes.map((n) => {
    const c = col.get(n.id) ?? 0;
    const r = rows.get(c) ?? 0;
    rows.set(c, r + 1);
    return { ...n, position: { x: c * COL, y: r * ROW } };
  });
  return { ...flow, nodes };
}

/** Give newly added nodes a free spot next to their neighbours, leaving existing positions alone. */
function placeNew(flow: Flow, added: Set<string>): Flow {
  if (!added.size) return flow;
  if (added.size === flow.nodes.length) return autoLayout(flow);
  const pos = new Map(flow.nodes.filter((n) => !added.has(n.id)).map((n) => [n.id, n.position]));
  const taken = (p: { x: number; y: number }) =>
    [...pos.values()].some((q) => Math.abs(q.x - p.x) < COL * 0.75 && Math.abs(q.y - p.y) < ROW * 0.75);
  const col = layers(flow);
  const order = [...added].sort((a, b) => (col.get(a) ?? 0) - (col.get(b) ?? 0));
  for (const id of order) {
    const pred = flow.edges.find((e) => e.target === id && pos.has(e.source));
    const succ = flow.edges.find((e) => e.source === id && pos.has(e.target));
    let p: { x: number; y: number };
    if (pred) p = { x: pos.get(pred.source)!.x + COL, y: pos.get(pred.source)!.y };
    else if (succ) p = { x: pos.get(succ.target)!.x - COL, y: pos.get(succ.target)!.y };
    else {
      const all = [...pos.values()];
      p = { x: all.length ? Math.min(...all.map((q) => q.x)) : 0, y: all.length ? Math.max(...all.map((q) => q.y)) + ROW : 0 };
    }
    while (taken(p)) p = { ...p, y: p.y + ROW };
    pos.set(id, p);
  }
  return { ...flow, nodes: flow.nodes.map((n) => (added.has(n.id) ? { ...n, position: pos.get(n.id)! } : n)) };
}

// ---------- descriptions for agents ----------

/** Compact text view of a flow: nodes with their block and wired handles, then edges. */
export function describeFlow(flow: Flow, blocks: BlockDef[]): string {
  const lines = [`Flow "${flow.name}" (id: ${flow.id})${flow.active ? " — triggers active" : ""}`];
  if (!flow.nodes.length) return `${lines[0]}\n(empty — no nodes yet)`;
  lines.push("", "Nodes:");
  for (const n of flow.nodes) {
    const cfg = tryResolve(n, blocks);
    const io = cfg
      ? ` [${cfg.kind}; in: ${ioList(cfg.inputs) || "-"}; out: ${cfg.kind === "condition" ? "true, false" : ioList(cfg.outputs) || "-"}]`
      : " [unknown block]";
    const ov = n.data.overrides && Object.keys(n.data.overrides).length ? ` overrides: ${JSON.stringify(n.data.overrides)}` : "";
    lines.push(`- ${n.id}: ${nodeLabel(n, blocks)} (block ${n.data.blockId})${io}${ov}`);
  }
  lines.push("", "Edges:");
  if (!flow.edges.length) lines.push("(none)");
  for (const e of flow.edges) lines.push(`- ${formatEdge(e)}`);
  return lines.join("\n");
}

function ioList(io: object): string {
  return Object.entries(io)
    .filter(([, v]) => v)
    .map(([k]) => (k === "startingPrompt" ? "starting prompt" : k))
    .join(", ");
}

/** One entry per usable block (templates included — they can be placed too). */
export function describeBlocks(blocks: BlockDef[]): string {
  return blocks
    .map((b) => {
      let cfg: ResolvedConfig | undefined;
      try {
        cfg = resolveNode({ id: "_", type: "block", position: { x: 0, y: 0 }, data: { blockId: b.id } }, blocks);
      } catch {
        return `- ${b.id}: ${b.name} (broken template chain)`;
      }
      const out = cfg.kind === "condition" ? "true, false" : ioList(cfg.outputs) || "-";
      const env = cfg.env.length ? `; env: ${cfg.env.join(", ")}` : "";
      const tpl = b.isTemplate ? " (template)" : "";
      return `- ${b.id}: ${b.name}${tpl} [${cfg.kind}${cfg.kind === "auto" ? `/${cfg.autoAction}` : ""}; in: ${ioList(cfg.inputs) || "-"}; out: ${out}${env}] ${cfg.description}`;
    })
    .join("\n");
}
