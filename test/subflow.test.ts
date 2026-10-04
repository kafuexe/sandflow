import { describe, expect, it } from "vitest";
import { startRun, type NodeRunner } from "../backend/engine";
import { CORE_BLOCKS, FLOW_INPUT_BLOCK, FLOW_OUTPUT_BLOCK, SCRIPT_BLOCK, SUBFLOW_BLOCK } from "../shared/core";
import { parseEdge, validateFlow } from "../shared/flowOps";
import { BUILTIN_BLOCKS } from "../shared/library";
import { flowRequirements } from "../shared/resolve";
import { flowInterface, resolveNodeIn, runNodeLabel, subflowCycle } from "../shared/subflow";
import type { BlockConfig, Flow, FlowEdge, Settings } from "../shared/types";
import { edgeAllowed } from "../shared/validate";

const blocks = [...CORE_BLOCKS, ...BUILTIN_BLOCKS];
const settings: Settings = { startingPrompt: "Do it", sandbox: "none", maxSteps: 40 };
const n = (id: string, blockId: string, overrides?: BlockConfig, y = 0) => ({ id, type: "block" as const, position: { x: 0, y }, data: { blockId, ...(overrides ? { overrides } : {}) } });
const e = (source: string, target: string, sourceHandle: FlowEdge["sourceHandle"] = "artifact", targetHandle: FlowEdge["targetHandle"] = "artifact"): FlowEdge => ({
  id: `${source}-${sourceHandle}-${target}-${targetHandle}`,
  source,
  target,
  sourceHandle,
  targetHandle,
});

/** Child: input → plan → (If approved) → output "approved" | → output "rejected". */
const child: Flow = {
  id: "review",
  name: "Review",
  nodes: [
    n("in", FLOW_INPUT_BLOCK),
    n("work", "plan"),
    n("check", "if", { condition: { match: "all", rules: [{ field: "text", op: "contains", value: "OK" }] } }),
    n("yes", FLOW_OUTPUT_BLOCK, { flowOutput: { name: "approved" } }, 0),
    n("no", FLOW_OUTPUT_BLOCK, { flowOutput: { name: "rejected" } }, 100),
  ],
  edges: [e("in", "work"), e("in", "work", "steer", "steer"), e("work", "check"), e("check", "yes", "true"), e("check", "no", "false")],
};

const parent: Flow = {
  id: "main",
  name: "Main",
  nodes: [n("task", "create-task"), n("sub", SUBFLOW_BLOCK, { subflow: { flowId: "review" } }), n("mr", "create-mr"), n("fix", "cr-fix")],
  edges: [e("task", "sub"), e("sub", "mr", "exit:approved"), e("sub", "fix", "exit:rejected"), e("sub", "fix", "exit:rejected", "steer")],
};

describe("subflow interface", () => {
  it("takes its inputs from Flow input and its exits from Flow outputs (top to bottom)", () => {
    expect(flowInterface(child, blocks)).toEqual({ inputs: { artifact: true, steer: true }, exits: ["approved", "rejected"], hasInput: true });
    const cfg = resolveNodeIn(parent.nodes[1], blocks, [parent, child]);
    expect(cfg.exits).toEqual(["approved", "rejected"]);
    expect(cfg.inputs).toMatchObject({ artifact: true, steer: true });
    expect(edgeAllowed(cfg, "exit:approved", resolveNodeIn(parent.nodes[2], blocks, [parent, child]), "artifact", cfg.exits)).toBe(true);
    expect(edgeAllowed(cfg, "exit:nope", resolveNodeIn(parent.nodes[2], blocks, [parent, child]), "artifact", cfg.exits)).toBe(false);
    expect(edgeAllowed(cfg, "artifact", resolveNodeIn(parent.nodes[2], blocks, [parent, child]), "artifact", cfg.exits)).toBe(false);
  });

  it("validates subflow edges and finds loops", () => {
    expect(validateFlow(parent, blocks, [parent, child]).errors).toEqual([]);
    const bad = { ...parent, edges: [...parent.edges, e("sub", "mr", "exit:ghost")] };
    expect(validateFlow(bad, blocks, [bad, child]).errors.join()).toMatch(/no exit "ghost"/);
    const loopy: Flow = { ...child, nodes: [...child.nodes, n("again", SUBFLOW_BLOCK, { subflow: { flowId: "main" } })] };
    expect(subflowCycle("main", [parent, loopy], blocks)).toBe("Main › Review › Main");
    expect(validateFlow(parent, blocks, [parent, loopy]).errors.join()).toMatch(/Subflow loop/);
    expect(parseEdge("sub.exit:approved -> mr")).toMatchObject({ sourceHandle: "exit:approved", targetHandle: "artifact" });
  });

  it("asks for what the subflow needs too", () => {
    const req = flowRequirements(parent, blocks, [parent, child]);
    expect(req.env.find((x) => x.name === "ANTHROPIC_API_KEY")!.nodes).toContainEqual({ id: "sub/work", label: "Subflow › Plan" });
    expect(req.startingPromptNodes.map((x) => x.id)).toEqual(["task", "sub/work", "fix"]);
  });
});

describe("running subflows", () => {
  function go(verdict: string, flows: Flow[] = [parent, child], s = settings) {
    const seen: Record<string, unknown> = {};
    const runner: NodeRunner = async (ctx, node, _cfg, inputs) => {
      seen[`${ctx.flow.id}:${node.id}`] = inputs;
      return { outputs: { artifact: node.id === "work" ? verdict : `${node.id}-art`, steer: `${node.id}-steer` } };
    };
    return { h: startRun({ flow: flows[0], flows, blocks, env: {}, settings: s, runners: { auto: runner, ai: runner } }), seen };
  }

  it("runs the child with the parent's inputs and continues out of the exit it reached", async () => {
    const { h, seen } = go("looks OK");
    const final = await h.done;
    expect(final.status).toBe("done");
    expect(seen["review:work"]).toEqual({ artifact: "task-art" });
    expect(final.nodes.sub).toMatchObject({ status: "done", exit: "approved", outputs: { artifact: "looks OK" } });
    expect(final.nodes["sub/yes"]).toMatchObject({ status: "done", exit: "approved" });
    expect(final.nodes["sub/no"].executions).toBe(0);
    expect(seen["main:mr"]).toEqual({ artifact: "looks OK" });
    expect(seen["main:fix"]).toBeUndefined();
    expect(runNodeLabel("sub/work", parent, [parent, child], blocks)).toBe("Subflow › Plan");
  });

  it("follows the other exit with both artifact and steer", async () => {
    const { h, seen } = go("not good");
    const final = await h.done;
    expect(final.nodes.sub.exit).toBe("rejected");
    expect(seen["main:fix"]).toEqual({ artifact: "not good" });
    expect(seen["main:mr"]).toBeUndefined();
  });

  it("logs a child's node under the subflow node", async () => {
    const final = await go("OK").h.done;
    expect(final.logs.some((l) => l.nodeId === "sub/work" && /▶ Plan/.test(l.msg))).toBe(true);
  });

  it("stops a flow that contains itself", async () => {
    const self: Flow = { id: "self", name: "Self", nodes: [n("in", FLOW_INPUT_BLOCK), n("again", SUBFLOW_BLOCK, { subflow: { flowId: "self" } })], edges: [e("in", "again")] };
    const final = await go("x", [self], { ...settings, maxSteps: 500 }).h.done;
    expect(final.status).toBe("failed");
    expect(final.error).toMatch(/nested more than/);
  });

  it("on its own, a Flow input hands on the starting prompt and a Flow output just ends the path", async () => {
    const { h, seen } = go("OK", [child]);
    const final = await h.done;
    expect(final.status).toBe("done");
    expect(seen["review:work"]).toEqual({ artifact: "Do it" });
    expect(final.logs.some((l) => /isn't running as a subflow/.test(l.msg))).toBe(true);
  });
});

describe("script exits", () => {
  it("routes out of the exit the script picked, falling back to the first with a warning", async () => {
    const f: Flow = {
      id: "s",
      name: "S",
      nodes: [n("sc", SCRIPT_BLOCK, { script: { run: "x", exits: ["pass", "fail"] } }), n("a", "shell"), n("b", "shell")],
      edges: [e("sc", "a", "exit:pass"), e("sc", "b", "exit:fail", "artifact")],
    };
    const ran: string[] = [];
    const runAll = (exit: string | undefined) =>
      startRun({
        flow: f,
        blocks,
        env: {},
        settings,
        runners: {
          auto: async (_c, node) => (ran.push(node.id), { outputs: { artifact: "ok" } }),
          ai: async () => ({ outputs: {} }),
          script: async () => ({ outputs: { artifact: "report", steer: "hint" }, exit }),
        },
      }).done;
    let final = await runAll("fail");
    expect(ran).toEqual(["b"]);
    expect(final.nodes.b.inputs).toEqual({ artifact: "report" });
    ran.length = 0;
    final = await runAll("bogus");
    expect(ran).toEqual(["a"]);
    expect(final.logs.some((l) => l.level === "warn" && /isn't one of pass, fail/.test(l.msg))).toBe(true);
  });
});
