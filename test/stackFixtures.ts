import { CORE_BLOCKS, FLOW_INPUT_BLOCK, FLOW_OUTPUT_BLOCK, STACK_BLOCK } from "../shared/core";
import { BUILTIN_BLOCKS } from "../shared/library";
import type { BlockConfig, Flow, FlowEdge, Settings } from "../shared/types";

export const blocks = [...CORE_BLOCKS, ...BUILTIN_BLOCKS];
export const settings: Settings = { startingPrompt: "Do it", sandbox: "none", maxSteps: 40 };
export const n = (id: string, blockId: string, overrides?: BlockConfig, y = 0) => ({ id, type: "block" as const, position: { x: 0, y }, data: { blockId, ...(overrides ? { overrides } : {}) } });
export const e = (source: string, target: string, sourceHandle: FlowEdge["sourceHandle"] = "artifact", targetHandle: FlowEdge["targetHandle"] = "artifact"): FlowEdge => ({
  id: `${source}-${sourceHandle}-${target}-${targetHandle}`, source, target, sourceHandle, targetHandle,
});

/** Child: input → work → output "done". */
export const area: Flow = {
  id: "area",
  name: "Area",
  nodes: [n("in", FLOW_INPUT_BLOCK), n("work", "plan"), n("out", FLOW_OUTPUT_BLOCK, { flowOutput: { name: "done" } })],
  edges: [e("in", "work"), e("in", "work", "steer", "steer"), e("work", "out")],
};

export const stackNode = (over: BlockConfig["stack"] = {}) => n("s", STACK_BLOCK, { stack: { flowId: "area", ...over } });

/** plan → Box Stack (area per task) → (done) create MR. */
export const parentWith = (over: BlockConfig["stack"] = {}): Flow => ({
  id: "big", name: "Big", nodes: [n("plan", "plan"), stackNode(over), n("mr", "create-mr")],
  edges: [e("plan", "s"), e("s", "mr", "exit:done")],
});
