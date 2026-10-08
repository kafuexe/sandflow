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

// ---------- Task 3: the stack block ----------

import { STACK_BLOCK } from "../shared/core";
import { validateFlow } from "../shared/flowOps";
import { flowRequirements, resolveNode } from "../shared/resolve";
import { DEFAULT_COMBINE, DEFAULT_SPLIT, normaliseTasks, parseSplit } from "../shared/stack";
import { resolveNodeIn, subflowCycle } from "../shared/subflow";

const stackNode = (over: BlockConfig["stack"] = {}) => n("s", STACK_BLOCK, { stack: { flowId: "area", ...over } });
const parentWith = (over: BlockConfig["stack"] = {}): Flow => ({
  id: "big", name: "Big", nodes: [n("plan", "plan"), stackNode(over), n("mr", "create-mr")],
  edges: [e("plan", "s"), e("s", "mr", "exit:done")],
});

describe("stack block", () => {
  it("resolves with the spec's defaults", () => {
    const cfg = resolveNode(stackNode(), blocks);
    expect(cfg.kind).toBe("stack");
    expect(cfg.stack).toEqual({
      flowId: "area", successExits: ["done"], workspace: "isolated", maxConcurrent: 3, maxChildren: 12, maxRetries: 1,
      splitInstructions: DEFAULT_SPLIT, combineInstructions: DEFAULT_COMBINE,
    });
  });

  it("always has the exits done and failed, and takes artifact + steer", () => {
    const cfg = resolveNodeIn(stackNode(), blocks, [area]);
    expect(cfg.exits).toEqual(["done", "failed"]);
    expect(cfg.inputs).toMatchObject({ artifact: true, steer: true });
    expect(validateFlow(parentWith(), blocks, [area]).errors).toEqual([]);
  });

  it("reports each bad setting", () => {
    const errs = (over: BlockConfig["stack"], flows = [area]) => validateFlow(parentWith(over), blocks, flows).errors.join("\n");
    expect(errs({ flowId: "" })).toMatch(/doesn't say which flow/);
    expect(errs({ flowId: "ghost" })).toMatch(/unknown flow "ghost"/);
    const noInput: Flow = { ...area, nodes: area.nodes.filter((x) => x.id !== "in"), edges: [e("work", "out")] };
    expect(errs({}, [noInput])).toMatch(/has no Flow input/);
    expect(errs({ maxConcurrent: 0 })).toMatch(/at least 1 at once/);
    expect(errs({ maxConcurrent: 4, maxChildren: 3 })).toMatch(/max children .* at least max concurrent/i);
    expect(errs({ maxRetries: -1 })).toMatch(/retries can't be negative/);
    expect(errs({ successExits: ["approved"] })).toMatch(/success exit "approved"/);
  });

  it("asks for what its child flow and orchestrator need", () => {
    const req = flowRequirements(parentWith(), blocks, [area]);
    expect(req.env.find((x) => x.name === "ANTHROPIC_API_KEY")!.nodes).toContainEqual({ id: "s/work", label: "Box Stack › Plan" });
    expect(req.env.find((x) => x.name === "REPO_PATH")!.nodes).toContainEqual({ id: "s", label: "Box Stack" });
  });

  it("follows stacks when looking for flow loops", () => {
    const loopy: Flow = { ...area, nodes: [...area.nodes, n("again", STACK_BLOCK, { stack: { flowId: "big" } })] };
    expect(subflowCycle("big", [parentWith(), loopy], blocks)).toBe("Big › Area › Big");
  });
});

describe("parsing the split", () => {
  it("reads a bare or fenced JSON object, anywhere in the text", () => {
    expect(parseSplit('{"tasks":[{"name":"auth","input":"do auth"}]}')).toEqual({ tasks: [{ name: "auth", input: "do auth" }] });
    expect(parseSplit('Here you go:\n```json\n{"tasks": [{"name": "a", "input": "x"}]}\n```\nDone.')).toEqual({ tasks: [{ name: "a", input: "x" }] });
  });

  it("explains what's wrong otherwise", () => {
    expect(parseSplit("no json here")).toEqual({ error: expect.stringMatching(/no JSON object/i) });
    expect(parseSplit('{"tasks": "nope"}')).toEqual({ error: expect.stringMatching(/"tasks" must be a list/) });
    expect(parseSplit('{"tasks": [{"name": "a"}]}')).toEqual({ error: expect.stringMatching(/task 1 has no "input"/) });
  });

  it("normalises names: empty → task-n, duplicates get a suffix, slugs are branch-safe", () => {
    expect(normaliseTasks([{ name: "Auth & Login", input: "1" }, { name: "", input: "2" }, { name: "Auth & Login", input: "3" }])).toEqual([
      { name: "Auth & Login", slug: "auth-login", input: "1" },
      { name: "task-2", slug: "task-2", input: "2" },
      { name: "Auth & Login-2", slug: "auth-login-2", input: "3" },
    ]);
  });
});
