import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startRun, type NodeRunner } from "../backend/engine";
import { createStorage } from "../backend/storage";
import { CORE_BLOCKS, FLOW_INPUT_BLOCK, FLOW_OUTPUT_BLOCK } from "../shared/core";
import { BUILTIN_BLOCKS } from "../shared/library";
import type { BlockConfig, Flow, FlowEdge, RunState, Settings } from "../shared/types";

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

describe("child runs", () => {
  it("a run started with `entry` runs from its Flow input and records the exit it reached", async () => {
    const runner: NodeRunner = async (_c, _n, _cfg, inputs) => ({ outputs: { artifact: `did ${inputs.artifact}` } });
    const h = startRun({
      flow: area, flows: [area], blocks, env: {}, settings, runners: { auto: runner, ai: runner },
      entry: { artifact: "auth" }, parent: { runId: "p", nodeKey: "s" },
    });
    const final = await h.done;
    expect(final.status).toBe("done");
    expect(final.parent).toEqual({ runId: "p", nodeKey: "s" });
    expect(final.result).toEqual({ exit: "done", outputs: { artifact: "did auth" } });
  });
});

describe("storage: listing runs with children", () => {
  let dir: string;
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("the limit counts top-level runs; their children come along", () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "sandflow-stack-"));
    const storage = createStorage(dir);
    const id = (i: number) => `2026-01-01T00-00-${String(i).padStart(2, "0")}-000Z-${String(i).padStart(8, "0")}`;
    const base = (i: number): RunState => ({ id: id(i), flowId: "f", flowName: "F", status: "done", startedAt: i, finishedAt: i, nodes: {}, logs: [] });
    for (let i = 0; i < 3; i++) storage.saveRun(base(i));
    // 20 children of the newest top-level run, all newer than it.
    for (let c = 0; c < 20; c++) storage.saveRun({ ...base(10 + c), parent: { runId: id(2), nodeKey: "s" } });
    const list = storage.listRuns(2);
    expect(list.filter((r) => !r.parent).map((r) => r.id)).toEqual([id(2), id(1)]);
    expect(list.filter((r) => r.parent)).toHaveLength(20);
  });
});
