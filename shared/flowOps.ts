// Structured flow editing shared by the MCP tools (agents) and the UI: edge references, validation,
// batched edit operations and auto-layout. Agents never send coordinates or edge ids.

import { configGaps, configProblems, findBlock } from "./blockHelp";
import { nodeLabel, resolveBlock, resolveNode } from "./resolve";
import { runOnProblem } from "./runOn";
import { exitName, flowInterface, isExitHandle, resolveNodeIn, subflowCycle } from "./subflow";
import type { BlockConfig, BlockDef, EdgeInputKind, Flow, FlowEdge, FlowNode, ResolvedConfig, SourceHandle, StackConfig } from "./types";

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
 * Named exits of a Script / subflow: `review.exit:approved -> merge`.
 */
export function parseEdge(ref: string): EdgeRef {
  const m = /^\s*([\w-]+)(?:\.(exit:[\w-]+|[\w]+))?\s*-+>\s*([\w-]+)(?:\.([\w]+))?\s*$/.exec(ref);
  if (!m) throw new Error(`Can't read edge "${ref}". Write it as "source.handle -> target.handle", e.g. "plan.artifact -> implement.artifact"`);
  const sourceHandle = (m[2] ?? "artifact") as SourceHandle;
  const targetHandle = (m[4] ?? "artifact") as EdgeInputKind;
  if (!SOURCE_HANDLES.includes(sourceHandle) && !isExitHandle(sourceHandle)) {
    throw new Error(`"${ref}": "${sourceHandle}" isn't an output handle. Use artifact, steer, true/false out of an If block, or exit:<name>`);
  }
  if (!TARGET_HANDLES.includes(targetHandle)) {
    throw new Error(`"${ref}": "${targetHandle}" isn't an input handle. Use artifact or steer`);
  }
  return { source: m[1], sourceHandle, target: m[3], targetHandle };
}

function tryResolve(node: FlowNode, blocks: BlockDef[], flows: Flow[] = []): (ResolvedConfig & { exits: string[] }) | undefined {
  try {
    return resolveNodeIn(node, blocks, flows);
  } catch {
    return undefined;
  }
}

/** Why this edge can't exist in `flow` (undefined = fine). Pass `flows` so subflow exits/inputs are known. */
export function edgeProblem(flow: Flow, blocks: BlockDef[], e: EdgeRef, flows: Flow[] = []): string | undefined {
  const src = flow.nodes.find((n) => n.id === e.source);
  const dst = flow.nodes.find((n) => n.id === e.target);
  if (!src) return `No node "${e.source}" in this flow`;
  if (!dst) return `No node "${e.target}" in this flow`;
  if (e.source === e.target) return `A node can't connect to itself ("${e.source}")`;
  const s = tryResolve(src, blocks, flows);
  const t = tryResolve(dst, blocks, flows);
  if (!s) return `Node "${e.source}" uses unknown block "${src.data.blockId}"`;
  if (!t) return `Node "${e.target}" uses unknown block "${dst.data.blockId}"`;
  const exitList = s.exits.map((x) => `${e.source}.exit:${x}`).join(", ");
  if (s.kind === "condition") {
    if (e.sourceHandle !== "true" && e.sourceHandle !== "false") {
      return `"${e.source}" is an If block — connect from "${e.source}.true" or "${e.source}.false"`;
    }
  } else if (e.sourceHandle === "true" || e.sourceHandle === "false") {
    return `"${e.source}" isn't an If block, so it has no ${e.sourceHandle} output`;
  } else if (isExitHandle(e.sourceHandle)) {
    if (!s.exits.includes(exitName(e.sourceHandle))) {
      return `"${e.source}" has no exit "${exitName(e.sourceHandle)}". Exits: ${exitList || "none"}`;
    }
  } else if (s.exits.length) {
    return `"${e.source}" leaves through its named exits — connect from one of: ${exitList}`;
  } else if (!s.outputs[e.sourceHandle]) {
    const valid = (["artifact", "steer"] as const).filter((k) => s.outputs[k]);
    return `"${e.source}" doesn't output ${e.sourceHandle}. Valid: ${valid.join(", ") || "none (it has no outputs)"}`;
  }
  if (t.kind === "trigger") return `"${e.target}" is a trigger — triggers start a flow and take no inputs`;
  if (t.kind === "flow-input") return `"${e.target}" is a Flow input — it starts the flow and takes no edge inputs`;
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
export function validateFlow(flow: Flow, blocks: BlockDef[], flows: Flow[] = []): FlowReport {
  const errors: string[] = [];
  const warnings: string[] = [];
  const ids = new Set<string>();
  for (const n of flow.nodes) {
    if (ids.has(n.id)) errors.push(`Duplicate node id "${n.id}"`);
    ids.add(n.id);
    if (!blocks.some((b) => b.id === n.data.blockId)) errors.push(`Node "${n.id}" uses unknown block "${n.data.blockId}"`);
    const runOn = runOnProblem(n.data.overrides?.runOn);
    if (runOn) errors.push(`Node "${n.id}": ${runOn}`);
  }
  const flowRunOn = runOnProblem(flow.runOn, false);
  if (flowRunOn) errors.push(`Flow: ${flowRunOn}`);
  const seen = new Set<string>();
  for (const e of flow.edges) {
    const problem = edgeProblem(flow, blocks, e, flows);
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
  const cycle = subflowCycle(flow.id, flows.some((f) => f.id === flow.id) ? flows.map((f) => (f.id === flow.id ? flow : f)) : [...flows, flow], blocks);
  if (cycle) errors.push(`Subflow loop: ${cycle} — a flow can't contain itself`);
  for (const n of flow.nodes) {
    const cfg = tryResolve(n, blocks, flows);
    if (!cfg) continue;
    if (cfg.kind === "subflow") {
      if (!cfg.subflow.flowId) errors.push(`Subflow "${n.id}" doesn't say which flow to run (set overrides.subflow.flowId)`);
      else if (!flows.some((f) => f.id === cfg.subflow.flowId)) errors.push(`Subflow "${n.id}" runs unknown flow "${cfg.subflow.flowId}"`);
      else if (!cfg.exits.length) warnings.push(`Subflow "${n.id}": its flow has no Flow output block, so nothing continues after it`);
    }
    if (cfg.kind === "stack") errors.push(...stackProblems(n.id, cfg.stack, flows, blocks));
    const out = flow.edges.filter((e) => e.source === n.id);
    const targets = new Set(out.map((e) => e.target));
    if (cfg.kind === "manager" && targets.size < 2) {
      warnings.push(`Manager "${n.id}" routes to ${targets.size} node(s); a manager should have 2+ outgoing targets to choose between`);
    }
    if (cfg.kind === "condition" && !out.length) warnings.push(`If "${n.id}" has no outgoing branch`);
    for (const g of configGaps(cfg)) warnings.push(`Node "${n.id}" has ${g}`);
    for (const p of configProblems(n.data.overrides, cfg.kind)) warnings.push(`Node "${n.id}": ${p}`);
    if (flow.nodes.length > 1 && !out.length && !incoming.has(n.id)) warnings.push(`Node "${n.id}" isn't connected to anything`);
  }
  return { errors, warnings };
}

function stackProblems(id: string, s: StackConfig, flows: Flow[], blocks: BlockDef[]): string[] {
  const out: string[] = [];
  const child = flows.find((f) => f.id === s.flowId);
  if (!s.flowId) out.push(`Box Stack "${id}" doesn't say which flow to run for each task (set overrides.stack.flowId)`);
  else if (!child) out.push(`Box Stack "${id}" runs unknown flow "${s.flowId}"`);
  else {
    const fi = flowInterface(child, blocks);
    if (!fi.hasInput) out.push(`Box Stack "${id}": flow "${child.name}" has no Flow input, so tasks can't be handed to it`);
    if (!s.successExits.length) out.push(`Box Stack "${id}" needs at least one success exit, or every task is rejected`);
    for (const x of s.successExits) if (!fi.exits.includes(x)) out.push(`Box Stack "${id}": success exit "${x}" isn't one of "${child.name}"'s outputs (${fi.exits.join(", ") || "none"})`);
  }
  if (!(s.maxConcurrent >= 1)) out.push(`Box Stack "${id}" must run at least 1 at once`);
  if (!(s.maxChildren >= s.maxConcurrent)) out.push(`Box Stack "${id}": max children (${s.maxChildren}) must be at least max concurrent (${s.maxConcurrent})`);
  if (!(s.maxRetries >= 0)) out.push(`Box Stack "${id}": retries can't be negative`);
  return out;
}

// ---------- operations ----------

/** One node (`plan`) or a node's handle (`plan.steer`, `check.true`, `review.exit:approved`), or a list of them. */
export type NodeRefs = string | string[];

export type FlowOp =
  /**
   * Place a block. `id` defaults to the block id without its pack (`base/plan` → `plan`, `plan-2`, …). `block` may be
   * the full id, the id without the pack prefix, or the block's name. `from` / `to` wire it up in the same op: each
   * entry is a node (every compatible handle is wired, e.g. artifact and steer) or `node.handle` for just one.
   */
  | { op: "add_node"; id?: string; block: string; label?: string; overrides?: BlockConfig; from?: NodeRefs; to?: NodeRefs }
  | { op: "update_node"; id: string; block?: string; label?: string | null; overrides?: Record<string, unknown> | null }
  | { op: "remove_node"; id: string }
  /** `edge: "a.steer -> b.steer"` (handles default to artifact), or `from: "a", to: "b"` to wire every compatible handle. */
  | { op: "connect"; edge?: string; from?: string; to?: string }
  | { op: "disconnect"; edge?: string; from?: string; to?: string }
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
export function applyOps(flow: Flow, blocks: BlockDef[], ops: FlowOp[], flows: Flow[] = []): OpsResult {
  let f: Flow = structuredClone(flow);
  const changes: string[] = [];
  const touched = new Set<string>();
  const added = new Set<string>();
  let relayout = false;
  const checkOverrides = (blockId: string, overrides: unknown) => {
    const problems = configProblems(overrides, resolveBlock(blockId, blocks).kind);
    if (problems.length) throw new Error(problems.join("; "));
  };
  const addEdge = (e: EdgeRef) => {
    const problem = edgeProblem(f, blocks, e, flows);
    if (problem) throw new Error(`${formatEdge(e)}: ${problem}`);
    const id = edgeId(e);
    if (!f.edges.some((x) => x.id === id)) {
      f.edges.push({ id, ...e } as FlowEdge);
      changes.push(`+ edge ${formatEdge(e)}`);
    }
  };
  const nodeOf = (ref: string) => ref.split(".")[0].trim();
  /** add_node wiring that names a node added later in the same batch — applied after the other ops. */
  const pending: { i: number; op: string; from: string; to: string }[] = [];

  ops.forEach((op, i) => {
    try {
      switch (op.op) {
        case "add_node": {
          const block = findBlock(op.block, blocks);
          const id = op.id === undefined || op.id === null || op.id === "" ? freeId(f, block.id) : op.id;
          if (!NODE_ID_RE.test(id)) {
            throw new Error(`Node id "${id}" is invalid: start with a letter, then letters, digits, _ or - (max 64), e.g. "plan" or "check-author". Or leave id out to get one`);
          }
          if (f.nodes.some((n) => n.id === id)) throw new Error(`Node "${id}" already exists — pick another id, or use update_node to change it`);
          checkOverrides(block.id, op.overrides);
          const data: FlowNode["data"] = { blockId: block.id };
          if (op.label?.trim()) data.label = op.label.trim();
          if (op.overrides && Object.keys(op.overrides).length) data.overrides = op.overrides;
          f.nodes.push({ id, type: "block", position: { x: 0, y: 0 }, data });
          added.add(id);
          touched.add(id);
          changes.push(`+ node ${id} (${block.name}${block.id !== op.block ? `, block ${block.id}` : ""})`);
          const refs = (r: NodeRefs | undefined) => (r === undefined ? [] : Array.isArray(r) ? r : [r]).map(String);
          const wires = [...refs(op.from).map((from) => ({ from, to: id })), ...refs(op.to).map((to) => ({ from: id, to }))];
          for (const w of wires) {
            const other = w.from === id ? w.to : w.from;
            if (f.nodes.some((n) => n.id === nodeOf(other))) autoEdges(f, blocks, w.from, w.to, flows).forEach(addEdge);
            else pending.push({ i, op: op.op, ...w });
          }
          break;
        }
        case "update_node": {
          const n = f.nodes.find((x) => x.id === op.id);
          if (!n) throw new Error(`No node "${op.id}" in this flow`);
          const what: string[] = [];
          if (op.block !== undefined && op.block !== n.data.blockId) {
            const block = findBlock(op.block, blocks);
            n.data.blockId = block.id;
            what.push(`block → ${block.name}`);
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
            if (typeof op.overrides !== "object" || Array.isArray(op.overrides)) throw new Error('overrides must be an object, e.g. {"extraInstructions": "…"}');
            const o = mergeOverrides(n.data.overrides ?? {}, op.overrides);
            checkOverrides(n.data.blockId, Object.fromEntries(Object.keys(op.overrides).filter((k) => k in o).map((k) => [k, o[k]])));
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
          if (op.edge === undefined) {
            if (!op.from || !op.to) throw new Error('connect needs "edge" ("a.artifact -> b.artifact") or "from" and "to" node ids');
            autoEdges(f, blocks, op.from, op.to, flows).forEach(addEdge);
            break;
          }
          const e = parseEdge(op.edge);
          const problem = edgeProblem(f, blocks, e, flows);
          if (problem) throw new Error(problem);
          const id = edgeId(e);
          if (!f.edges.some((x) => x.id === id)) {
            f.edges.push({ id, ...e } as FlowEdge);
            changes.push(`+ edge ${formatEdge(e)}`);
          }
          break;
        }
        case "disconnect": {
          if (op.edge === undefined) {
            if (!op.from || !op.to) throw new Error('disconnect needs "edge" or "from" and "to"');
            const [s, sh] = splitRef(op.from);
            const [t, th] = splitRef(op.to);
            const gone = f.edges.filter((x) => x.source === s && x.target === t && (!sh || x.sourceHandle === sh) && (!th || x.targetHandle === th));
            if (!gone.length) throw new Error(`There is no edge from ${op.from} to ${op.to}`);
            f.edges = f.edges.filter((x) => !gone.includes(x));
            gone.forEach((x) => changes.push(`- edge ${formatEdge(x)}`));
            break;
          }
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
  for (const w of pending) {
    try {
      autoEdges(f, blocks, w.from, w.to, flows).forEach(addEdge);
    } catch (e) {
      throw new Error(`Op ${w.i + 1} (${w.op}): ${(e as Error).message}`);
    }
  }

  f = relayout ? autoLayout(f) : placeNew(f, added);
  return { flow: f, changes, touched: [...touched].filter((id) => f.nodes.some((n) => n.id === id)) };
}

/** First free node id for a block: `base/plan` → `plan`, then `plan-2`, `plan-3`, … */
export function freeId(flow: Flow, blockId: string): string {
  const base =
    blockId
      .slice(blockId.lastIndexOf("/") + 1)
      .replace(/^tpl-/, "")
      .replace(/[^\w-]+/g, "-")
      .replace(/^[^A-Za-z]+/, "") || "node";
  const stem = base.slice(0, 60);
  if (!flow.nodes.some((n) => n.id === stem)) return stem;
  for (let k = 2; ; k++) if (!flow.nodes.some((n) => n.id === `${stem}-${k}`)) return `${stem}-${k}`;
}

/** Merge an update into node overrides: null deletes a key; settings objects (trigger, agent, …) merge one level deep. */
export function mergeOverrides(base: BlockConfig, patch: Record<string, unknown>): Record<string, unknown> {
  const o: Record<string, unknown> = { ...base };
  const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete o[k];
    else if (k !== "condition" && isObj(v) && isObj(o[k])) {
      const inner: Record<string, unknown> = { ...(o[k] as Record<string, unknown>) };
      for (const [ik, iv] of Object.entries(v)) {
        if (iv === null) delete inner[ik];
        else inner[ik] = iv;
      }
      o[k] = inner;
    } else o[k] = v;
  }
  return o;
}

function splitRef(ref: string): [string, string | undefined] {
  const m = /^\s*([\w-]+)(?:\.(exit:[\w-]+|\w+))?\s*$/.exec(ref ?? "");
  if (!m) throw new Error(`Can't read "${ref}". Use a node id ("plan") or node.handle ("plan.steer", "check.true")`);
  return [m[1], m[2]];
}

/**
 * The edges `from -> to` means. With explicit handles on both ends it's one edge; otherwise every compatible pair
 * (artifact → artifact, steer → steer). A bare If node means its `true` branch; named exits need `node.exit:<name>`.
 */
export function autoEdges(flow: Flow, blocks: BlockDef[], from: string, to: string, flows: Flow[] = []): EdgeRef[] {
  const [s, shRaw] = splitRef(from);
  const [t, thRaw] = splitRef(to);
  const sh = shRaw as SourceHandle | undefined;
  const th = thRaw as EdgeInputKind | undefined;
  if (sh && !SOURCE_HANDLES.includes(sh) && !isExitHandle(sh)) throw new Error(`"${sh}" isn't an output handle. Use artifact, steer, true/false out of an If block, or exit:<name>`);
  if (th && !TARGET_HANDLES.includes(th)) throw new Error(`"${th}" isn't an input handle. Use artifact or steer`);
  const src = flow.nodes.find((n) => n.id === s);
  const dst = flow.nodes.find((n) => n.id === t);
  const ids = flow.nodes.map((n) => n.id).join(", ") || "none";
  if (!src) throw new Error(`No node "${s}" in this flow. Nodes: ${ids}`);
  if (!dst) throw new Error(`No node "${t}" in this flow. Nodes: ${ids}`);
  const sc = tryResolve(src, blocks, flows);
  const tc = tryResolve(dst, blocks, flows);
  if (!sc || !tc) return [{ source: s, sourceHandle: sh ?? "artifact", target: t, targetHandle: th ?? "artifact" }]; // edgeProblem explains
  const accepts = (["artifact", "steer"] as const).filter((k) => tc.inputs[k]);
  const emits = (["artifact", "steer"] as const).filter((k) => sc.outputs[k]);
  if (!sh) {
    // An If node continues out of `true` unless told otherwise (the change list shows `check.true -> …`).
    if (sc.kind === "condition") return [{ source: s, sourceHandle: "true", target: t, targetHandle: th ?? (tc.inputs.artifact ? "artifact" : "steer") }];
    if (sc.exits.length) throw new Error(`"${s}" leaves through named exits — use one of: ${sc.exits.map((x) => `${s}.exit:${x}`).join(", ")}`);
  }
  const one = (a: SourceHandle, b: EdgeInputKind): EdgeRef[] => [{ source: s, sourceHandle: a, target: t, targetHandle: b }];
  if (sh && th) return one(sh, th);
  if (sh) return one(sh, (accepts as string[]).includes(sh) ? (sh as EdgeInputKind) : (accepts[0] ?? "artifact"));
  if (th) return one((emits as string[]).includes(th) ? th : (emits[0] ?? "artifact"), th);
  const pairs = emits.filter((k) => accepts.includes(k));
  if (pairs.length) return pairs.map((k) => one(k, k)[0]);
  if (emits.length && accepts.length) return one(emits[0], accepts[0]);
  return one(emits[0] ?? "artifact", accepts[0] ?? "artifact"); // edgeProblem explains why it can't connect
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
export function describeFlow(flow: Flow, blocks: BlockDef[], flows: Flow[] = []): string {
  const lines = [`Flow "${flow.name}" (id: ${flow.id})${flow.active ? " — triggers active" : ""}${flow.runOn ? ` — agents run on: ${flow.runOn}` : ""}${flow.pack ? ` — from pack ${flow.pack}, read-only` : ""}`];
  if (!flow.nodes.length) return `${lines[0]}\n(empty — no nodes yet)`;
  lines.push("", "Nodes:");
  for (const n of flow.nodes) {
    const cfg = tryResolve(n, blocks, flows);
    const outs = cfg?.kind === "condition" ? "true, false" : cfg?.exits.length ? cfg.exits.map((x) => `exit:${x}`).join(", ") : cfg ? ioList(cfg.outputs) : "";
    const io = cfg ? ` [${cfg.kind}; in: ${ioList(cfg.inputs) || "-"}; out: ${outs || "-"}]` : " [unknown block]";
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

/** One entry per usable block (templates included — they can be placed too). `only` limits the list (resolved against all `blocks`). */
export function describeBlocks(blocks: BlockDef[], only?: BlockDef[]): string {
  return (only ?? blocks)
    .map((b) => {
      let cfg: ResolvedConfig | undefined;
      try {
        cfg = resolveNode({ id: "_", type: "block", position: { x: 0, y: 0 }, data: { blockId: b.id } }, blocks);
      } catch {
        return `- ${b.id}: ${b.name} (broken template chain)`;
      }
      const out =
        cfg.kind === "condition" ? "true, false"
        : cfg.kind === "subflow" ? "exit:<name> per Flow output of the flow it runs (set overrides.subflow.flowId)"
        : cfg.kind === "stack" ? "exit:done, exit:failed (set overrides.stack.flowId: the flow run once per task)"
        : cfg.kind === "script" && cfg.script.exits.length ? cfg.script.exits.map((x) => `exit:${x}`).join(", ")
        : ioList(cfg.outputs) || "-";
      const env = cfg.env.length ? `; env: ${cfg.env.join(", ")}` : "";
      const tpl = `${b.isTemplate ? " (template)" : ""}${b.pack ? ` (pack ${b.pack})` : ""}`;
      return `- ${b.id}: ${b.name}${tpl} [${cfg.kind}${cfg.kind === "auto" ? `/${cfg.autoAction}` : ""}; in: ${ioList(cfg.inputs) || "-"}; out: ${out}${env}] ${cfg.description}`;
    })
    .join("\n");
}
