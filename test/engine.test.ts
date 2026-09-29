import { describe, expect, it } from "vitest";
import { startRun, type NodeRunner } from "../backend/engine";
import { BUILTIN_BLOCKS, DEFAULT_FLOW, EXAMPLE_FLOWS } from "../shared/library";
import type { Flow, NodeIO, RunState, Settings, TriggerEvent } from "../shared/types";

const settings: Settings = { startingPrompt: "Add login", sandbox: "none", maxSteps: 40 };
const env = { REPO_PATH: "/r", ANTHROPIC_API_KEY: "k", BRANCH_NAME: "feat/x", BASE_BRANCH: "main", MR_PROVIDER: "github" };

function run(runner: NodeRunner, flow: Flow = DEFAULT_FLOW, s: Settings = settings) {
  const states: RunState[] = [];
  const h = startRun({
    flow,
    blocks: BUILTIN_BLOCKS,
    env,
    settings: s,
    runners: { auto: runner, ai: runner },
    onChange: (st) => states.push(structuredClone(st)),
  });
  return { h, states };
}

describe("engine: triggers and conditions", () => {
  const flow = EXAMPLE_FLOWS.find((f) => f.id === "example-mr-comment-assistant")!;
  const event = (author: string, body: string): TriggerEvent => ({
    source: "gitlab", type: "merge_request.comment", author, body, repo: "grp/app", number: 9, target: "merge_request", firedAt: 1,
  });

  function triggered(ev: TriggerEvent) {
    const seen: Record<string, NodeIO> = {};
    const runner: NodeRunner = async (_c, node, _cfg, inputs) => {
      seen[node.id] = inputs;
      return { outputs: { artifact: `${node.id}-out` } };
    };
    const h = startRun({
      flow, blocks: BUILTIN_BLOCKS, env, settings, runners: { auto: runner, ai: runner }, trigger: ev, startNodeId: "t",
    });
    return { h, seen };
  }

  it("true branch: trigger event reaches the AI block, reply is posted", async () => {
    const { h, seen } = triggered(event("your-username", "hey @sandflow why?"));
    const final = await h.done;
    expect(final.status).toBe("done");
    expect(final.trigger?.author).toBe("your-username");
    expect(final.triggerNodeId).toBe("t");
    expect(final.nodes.if.branch).toBe("true");
    expect(seen.answer.artifact).toContain("@sandflow why?");
    expect(seen.answer.artifact).toContain("Author: your-username");
    expect(seen.post).toEqual({ artifact: "answer-out" });
  });

  it("false branch with nothing connected ends the run cleanly", async () => {
    const { h, seen } = triggered(event("mallory", "hey @sandflow why?"));
    const final = await h.done;
    expect(final.status).toBe("done");
    expect(final.nodes.if.branch).toBe("false");
    expect(seen.answer).toBeUndefined();
    expect(final.logs.some((l) => /nothing connected/.test(l.msg))).toBe(true);
  });

  it("manual runs get a manual event and start from every input-less node", async () => {
    const f: Flow = {
      id: "m", name: "M",
      nodes: [
        { id: "t", type: "block", position: { x: 0, y: 0 }, data: { blockId: "manual-trigger" } },
        { id: "c", type: "block", position: { x: 0, y: 0 }, data: { blockId: "if", overrides: { condition: { match: "all", rules: [{ field: "trigger.type", op: "equals", value: "manual" }] } } } },
        { id: "yes", type: "block", position: { x: 0, y: 0 }, data: { blockId: "shell" } },
        { id: "no", type: "block", position: { x: 0, y: 0 }, data: { blockId: "shell" } },
      ],
      edges: [
        { id: "1", source: "t", target: "c", sourceHandle: "artifact", targetHandle: "artifact" },
        { id: "2", source: "c", target: "yes", sourceHandle: "true", targetHandle: "artifact" },
        { id: "3", source: "c", target: "no", sourceHandle: "false", targetHandle: "artifact" },
      ],
    };
    const ran: string[] = [];
    const final = await run(async (_c, n) => (ran.push(n.id), { outputs: { artifact: "x" } }), f).h.done;
    expect(final.trigger?.source).toBe("manual");
    expect(ran).toEqual(["yes"]);
    expect(final.nodes.yes.inputs?.artifact).toContain("# Manual: manual");
  });
});

describe("engine", () => {
  it("runs the default flow through a CR loop and routes to Create MR", async () => {
    let crCount = 0;
    const order: string[] = [];
    const seen: Record<string, unknown> = {};
    const runner: NodeRunner = async (ctx, node, cfg, inputs) => {
      order.push(node.id);
      seen[node.id] = { inputs, env: ctx.blockEnv(cfg) };
      if (node.id === "n-cr") {
        crCount++;
        return { outputs: { artifact: crCount === 1 ? "VERDICT: CHANGES_REQUESTED" : "VERDICT: APPROVED", steer: "fix x" } };
      }
      if (node.id === "n-manager") {
        const approved = inputs.artifact?.includes("APPROVED") && !inputs.artifact.includes("CHANGES");
        return { outputs: { artifact: inputs.artifact, steer: "go" }, route: approved ? "n-create-mr" : "n-cr-fix" };
      }
      return { outputs: { artifact: `${node.id}-art`, steer: `${node.id}-steer` } };
    };
    const { h } = run(runner);
    const final = await h.done;
    expect(final.status).toBe("done");
    expect(order).toEqual([
      "n-create-task", "n-plan", "n-implement", "n-cr", "n-manager", "n-cr-fix", "n-cr", "n-manager", "n-create-mr",
    ]);
    expect(final.nodes["n-cr"].executions).toBe(2);
    expect(final.nodes["n-manager"].routedTo).toBe("n-create-mr");
    // create-task outputs artifact only → steer dropped
    expect((seen["n-plan"] as any).inputs).toEqual({ artifact: "n-create-task-art" });
    // implement received both handles
    expect((seen["n-implement"] as any).inputs).toEqual({ artifact: "n-plan-art", steer: "n-plan-steer" });
    // create-mr only accepts artifact; wired artifact only
    expect((seen["n-create-mr"] as any).inputs).toEqual({ artifact: "VERDICT: APPROVED" });
    // env limited to what the block declares
    expect(Object.keys((seen["n-plan"] as any).env).sort()).toEqual(["ANTHROPIC_API_KEY", "REPO_PATH"]);
  });

  it("fails when max steps is exceeded", async () => {
    const runner: NodeRunner = async (_c, node) =>
      node.id === "n-manager" ? { outputs: { artifact: "a" }, route: "n-cr-fix" } : { outputs: { artifact: "a", steer: "s" } };
    const final = await run(runner, DEFAULT_FLOW, { ...settings, maxSteps: 10 }).h.done;
    expect(final.status).toBe("failed");
    expect(final.error).toMatch(/max steps/i);
  });

  it("falls back to the first target on an invalid manager route and warns", async () => {
    const runner: NodeRunner = async (_c, node) =>
      node.id === "n-manager" ? { outputs: { artifact: "a" }, route: "bogus" } : { outputs: { artifact: "a", steer: "s" } };
    const final = await run(runner, DEFAULT_FLOW, { ...settings, maxSteps: 12 }).h.done;
    expect(final.logs.some((l) => l.level === "warn" && /route/i.test(l.msg))).toBe(true);
  });

  it("marks the node and run failed when a runner throws", async () => {
    const runner: NodeRunner = async (_c, node) => {
      if (node.id === "n-plan") throw new Error("boom");
      return { outputs: { artifact: "a" } };
    };
    const final = await run(runner).h.done;
    expect(final.status).toBe("failed");
    expect(final.nodes["n-plan"]).toMatchObject({ status: "failed", error: "boom" });
  });

  it("pauses on a question and continues after an answer", async () => {
    const runner: NodeRunner = async (ctx, node) => {
      if (node.id === "n-plan") {
        const a = await ctx.ask(node.id, "Which DB?");
        return { outputs: { artifact: `plan with ${a}` } };
      }
      if (node.id === "n-manager") return { outputs: {}, route: "n-create-mr" };
      return { outputs: { artifact: "a" } };
    };
    const { h, states } = run(runner);
    await new Promise((r) => setTimeout(r, 20));
    expect(h.state.status).toBe("waiting");
    expect(h.state.pendingQuestion).toEqual({ nodeId: "n-plan", question: "Which DB?" });
    expect(h.answer("Postgres")).toBe(true);
    const final = await h.done;
    expect(final.status).toBe("done");
    expect(final.nodes["n-plan"].outputs?.artifact).toBe("plan with Postgres");
    expect(states.some((s) => s.nodes["n-plan"]?.status === "waiting")).toBe(true);
  });

  it("cancels a waiting run", async () => {
    const runner: NodeRunner = async (ctx, node) => {
      if (node.id === "n-plan") await ctx.ask(node.id, "?");
      return { outputs: { artifact: "a" } };
    };
    const { h } = run(runner);
    await new Promise((r) => setTimeout(r, 20));
    h.cancel();
    const final = await h.done;
    expect(final.status).toBe("cancelled");
  });

  it("fails a flow with no start nodes", async () => {
    const flow: Flow = { ...DEFAULT_FLOW, nodes: DEFAULT_FLOW.nodes.slice(0, 2), edges: [
      { id: "1", source: "n-create-task", target: "n-plan", sourceHandle: "artifact", targetHandle: "artifact" },
      { id: "2", source: "n-plan", target: "n-create-task", sourceHandle: "artifact", targetHandle: "artifact" },
    ] };
    const final = await run(async () => ({ outputs: {} }), flow).h.done;
    expect(final.status).toBe("failed");
    expect(final.error).toMatch(/start/i);
  });
});
