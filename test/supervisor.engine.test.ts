// The engine side of the supervisor: stopping one node with a cause (`stopNode`), the failure it records, signs of
// life per node, repeated outputs, and the supervision journal.
import { describe, expect, it } from "vitest";
import { MAX_SUPERVISION, startRun, type NodeRunner, type RunContext, type StartRunOptions } from "../backend/engine";
import { CORE_BLOCKS, FLOW_INPUT_BLOCK, FLOW_OUTPUT_BLOCK, SUBFLOW_BLOCK } from "../shared/core";
import { BUILTIN_BLOCKS } from "../shared/library";
import { resolveBlock } from "../shared/resolve";
import { agentIdleTimeoutSeconds, nodeTimeoutSeconds } from "../shared/supervisor";
import { configProblems } from "../shared/blockHelp";
import type { BlockConfig, Flow, FlowEdge, Settings } from "../shared/types";

const blocks = [...CORE_BLOCKS, ...BUILTIN_BLOCKS];
const settings: Settings = { startingPrompt: "Do it", sandbox: "none", maxSteps: 40 };
const n = (id: string, blockId = "plan", overrides?: BlockConfig) => ({ id, type: "block" as const, position: { x: 0, y: 0 }, data: { blockId, ...(overrides ? { overrides } : {}) } });
const e = (source: string, target: string, sourceHandle: FlowEdge["sourceHandle"] = "artifact"): FlowEdge => ({ id: `${source}-${sourceHandle}-${target}`, source, target, sourceHandle, targetHandle: "artifact" });
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 2000) {
  for (const end = Date.now() + ms; !cond(); ) {
    if (Date.now() > end) throw new Error("timed out");
    await tick();
  }
}
const start = (flow: Flow, runner: NodeRunner, o: Partial<StartRunOptions> = {}) =>
  startRun({ flow, blocks, flows: [flow], env: { REPO_PATH: "/r" }, settings, runners: { auto: runner, ai: runner }, ...o });

/** A runner that works until its node's abort fires (like an agent turn), recording what it saw. */
function blocking(seen: { ctx?: RunContext; node?: string }[] = []): NodeRunner {
  return (ctx, node) =>
    new Promise((_, reject) => {
      seen.push({ ctx, node: node.id });
      ctx.abort.signal.addEventListener("abort", () => reject(new Error("Run cancelled")), { once: true });
    });
}

const chain: Flow = { id: "chain", name: "Chain", nodes: [n("a"), n("b")], edges: [e("a", "b")] };

describe("stopNode", () => {
  it("aborts only that node: it fails with the cause and message, the run's own abort is untouched", async () => {
    const seen: { ctx?: RunContext; node?: string }[] = [];
    const h = start(chain, blocking(seen));
    await until(() => seen.length === 1);
    expect(h.stopNode("a", "stuck", "No sign of life for 30 min")).toBe(true);
    // Already being stopped / not running: nothing to do.
    expect(h.stopNode("a", "stuck", "again")).toBe(false);
    expect(h.stopNode("b", "timeout", "not running")).toBe(false);
    const run = await h.done;
    expect(seen[0].ctx!.abort.signal.aborted).toBe(true);
    expect(seen[0].ctx!.runAbort!.signal.aborted).toBe(false);
    expect(run.status).toBe("failed");
    expect(run.nodes.a).toMatchObject({ status: "failed", error: "No sign of life for 30 min", failure: { cause: "stuck", message: "No sign of life for 30 min", at: expect.any(Number) } });
    expect(run.error).toMatch(/No sign of life for 30 min/);
    expect(run.logs.some((l) => l.nodeId === "a" && /Stopping this step \(stuck\)/.test(l.msg))).toBe(true);
    expect(run.nodes.b.status).not.toBe("running");
  });

  it("a runner that ignores its abort is still cut loose (raced), and fails with the cause", async () => {
    const h = start(chain, () => new Promise(() => {}));
    await until(() => h.state.nodes.a.status === "running");
    h.stopNode("a", "timeout", "Ran longer than its limit of 1 min");
    const run = await h.done;
    expect(run.nodes.a.failure).toMatchObject({ cause: "timeout", message: "Ran longer than its limit of 1 min" });
  });

  it("any other failure is recorded with cause error", async () => {
    const run = await start(chain, async () => {
      throw new Error("exit code 2");
    }).done;
    expect(run.nodes.a.failure).toMatchObject({ cause: "error", message: "exit code 2" });
  });

  it("stopping a node inside a subflow; stopping the subflow node stops what runs in it", async () => {
    const child: Flow = { id: "child", name: "Child", nodes: [n("in", FLOW_INPUT_BLOCK), n("x"), n("out", FLOW_OUTPUT_BLOCK)], edges: [e("in", "x"), e("x", "out")] };
    const parent: Flow = { id: "p", name: "P", nodes: [n("sub", SUBFLOW_BLOCK, { subflow: { flowId: "child" } })], edges: [] };
    for (const [target, cause] of [["sub/x", "sandbox"], ["sub", "timeout"]] as const) {
      const seen: { node?: string }[] = [];
      const h = start(parent, blocking(seen), { flows: [parent, child] });
      await until(() => seen.length === 1);
      expect(h.stopNode(target, cause, "gone")).toBe(true);
      const run = await h.done;
      expect(run.nodes["sub/x"].failure?.cause).toBe(cause);
      expect(run.nodes.sub.status).toBe("failed");
      if (target === "sub") expect(run.nodes.sub.failure?.cause).toBe("timeout");
    }
  });

  it("a node waiting on a question is stopped too (the question goes unanswered)", async () => {
    const h = start(chain, (ctx, node) => ctx.ask(node.id, "Which DB?").then(() => ({ outputs: {} })));
    await until(() => !!h.state.pendingQuestion);
    expect(h.stopNode("a", "stuck", "Nobody answered")).toBe(true);
    const run = await h.done;
    expect(run.nodes.a.failure?.cause).toBe("stuck");
    expect(run.pendingQuestion).toBeUndefined();
  });

  it("is on the run context too (a runner may stop another node of its run)", async () => {
    const seen: { ctx?: RunContext }[] = [];
    const h = start(chain, blocking(seen));
    await until(() => seen.length === 1);
    expect(seen[0].ctx!.stopNode!("a", "stuck", "x")).toBe(true);
    expect((await h.done).nodes.a.failure?.cause).toBe("stuck");
  });
});

describe("signs of life, repeats and the supervision journal", () => {
  it("a node's log lines and activity are its lastActivityAt; the supervisor's own flags are not", async () => {
    const seen: { ctx?: RunContext }[] = [];
    const h = start(chain, blocking(seen));
    await until(() => seen.length === 1);
    const ns = h.state.nodes.a;
    ns.lastActivityAt = 1;
    seen[0].ctx!.log("agent", "working", "a");
    expect(ns.lastActivityAt).toBeGreaterThan(1);
    ns.lastActivityAt = 1;
    seen[0].ctx!.activity!("a", [{ kind: "text", text: "thinking" }]);
    expect(ns.lastActivityAt).toBeGreaterThan(1);
    ns.lastActivityAt = 1;
    h.flag("warning", "a has been silent for 10 min", { nodeKey: "a" });
    h.supervise({ at: 5, node: "a", kind: "silent", detail: "a has been silent for 10 min", action: "flagged" });
    expect(ns.lastActivityAt).toBe(1);
    expect(h.state.flags?.at(-1)).toMatchObject({ severity: "warning", nodeKey: "a" });
    expect(h.state.supervision).toEqual([{ at: 5, node: "a", kind: "silent", detail: "a has been silent for 10 min", action: "flagged" }]);
    expect(h.state.logs.some((l) => l.nodeId === "a" && /Supervisor: a has been silent/.test(l.msg))).toBe(true);
    h.cancel();
    await h.done;
  });

  it("supervision is capped; what's cut off the front is counted", async () => {
    const seen: unknown[] = [];
    const h = start(chain, blocking(seen as never));
    await until(() => seen.length === 1);
    for (let i = 0; i < MAX_SUPERVISION + 3; i++) h.supervise({ at: i, kind: "reminder", detail: `r${i}` });
    expect(h.state.supervision).toHaveLength(MAX_SUPERVISION);
    expect(h.state.supervisionDropped).toBe(3);
    expect(h.state.supervision![0].detail).toBe("r3");
    h.cancel();
    await h.done;
  });

  it("counts executions in a row that produced the previous execution's output", async () => {
    const loop: Flow = { id: "l", name: "L", nodes: [n("s"), n("a"), n("b")], edges: [e("s", "a"), e("a", "b"), e("b", "a")] };
    let calls = 0;
    const h = start(loop, async (_c, node) => {
      if (node.id === "a" && ++calls > 3) throw new Error("enough");
      return { outputs: { artifact: node.id === "b" ? "same" : `a${calls}` } };
    });
    const run = await h.done;
    expect(run.nodes.b.executions).toBe(3);
    expect(run.nodes.b.repeats).toBe(2);
    expect(run.nodes.a.repeats).toBe(0);
  });
});

describe("timeoutSeconds config", () => {
  it("is inherited like other config, overridable per node, and validated as an override", () => {
    const tpl = { id: "t", name: "T", isTemplate: true, config: { kind: "ai" as const, timeoutSeconds: 600 } };
    const block = { id: "b", name: "B", isTemplate: false, extends: "t", config: {} };
    expect(resolveBlock("b", [tpl, block]).timeoutSeconds).toBe(600);
    expect(resolveBlock("b", [tpl, block], { timeoutSeconds: 60 }).timeoutSeconds).toBe(60);
    expect(configProblems({ timeoutSeconds: 60 }, "auto")).toEqual([]);
    expect(configProblems({ timeoutSeconds: -1 }, "ai").join()).toMatch(/seconds/);
  });

  it("no limit by default, except Shell command (30 min); 0 turns a limit off", () => {
    const shell = resolveBlock("shell", blocks);
    expect(shell.kind === "auto" && shell.autoAction === "shell").toBe(true);
    expect(nodeTimeoutSeconds(shell)).toBe(1800);
    expect(nodeTimeoutSeconds({ ...shell, timeoutSeconds: 0 })).toBeUndefined();
    expect(nodeTimeoutSeconds({ ...shell, timeoutSeconds: 90 })).toBe(90);
    expect(nodeTimeoutSeconds(resolveBlock("plan", blocks))).toBeUndefined();
  });

  it("sandcastle's idle timeout sits above stuckAfterSeconds while the supervisor is on", () => {
    expect(agentIdleTimeoutSeconds({})).toBeGreaterThan(1800);
    expect(agentIdleTimeoutSeconds({ supervisor: { stuckAfterSeconds: 3600 } })).toBeGreaterThan(3600);
    expect(agentIdleTimeoutSeconds({ supervisor: { enabled: false } })).toBeUndefined();
  });
});

describe("stopNode on an agent node (runAi)", () => {
  it("aborts the agent's turn (not the run), the node fails with the cause; sandcastle's idle timeout is above stuck", async () => {
    const { runAi } = await import("../backend/runners/ai");
    const runs: { signal: AbortSignal; idleTimeoutSeconds?: number }[] = [];
    let closed = false;
    const sandbox = {
      exec: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
      close: async () => ((closed = true), {}),
      run: (o: { signal: AbortSignal; idleTimeoutSeconds?: number }) =>
        new Promise((_, reject) => {
          runs.push(o);
          o.signal.addEventListener("abort", () => reject(o.signal.reason), { once: true });
        }),
    };
    const ai: NodeRunner = (ctx, node, cfg, inputs) => {
      ctx.sandbox = sandbox;
      return runAi(ctx, node, cfg, inputs);
    };
    const flow: Flow = { id: "f", name: "F", nodes: [n("a", "plan", { skills: [] })], edges: [] };
    const h = start(flow, ai, { settings: { ...settings, sandbox: "docker" }, env: { REPO_PATH: "/r", ANTHROPIC_API_KEY: "k" } });
    await until(() => runs.length === 1);
    expect(runs[0].idleTimeoutSeconds).toBeGreaterThan(1800);
    h.stopNode("a", "stuck", "No sign of life for 30 min");
    const run = await h.done;
    expect(runs[0].signal.aborted).toBe(true);
    expect(run.nodes.a.failure).toMatchObject({ cause: "stuck", message: "No sign of life for 30 min" });
    expect(closed).toBe(false);
  });
});

describe("Settings → Supervisor and the flow's overseer", () => {
  it("validateSettings keeps supervisor settings in range and drops unset ones", async () => {
    const { validateSettings } = await import("../shared/settings");
    const { validateOverseer } = await import("../shared/supervisor");
    expect(validateSettings({ ...settings, supervisor: { enabled: false, pollSeconds: 0, stuckAfterSeconds: 3600 } }).supervisor).toEqual({ enabled: false, pollSeconds: 1, stuckAfterSeconds: 3600 });
    expect(validateSettings({ ...settings, supervisor: {} }).supervisor).toBeUndefined();
    expect(() => validateSettings({ ...settings, supervisor: { remindAfterSeconds: "soon" as never } })).toThrow(/remindAfterSeconds/);
    expect(validateOverseer({ enabled: false, model: "x" })).toBeUndefined();
    expect(validateOverseer({ enabled: true, model: " haiku ", everySeconds: 5 })).toEqual({ enabled: true, model: "haiku", everySeconds: 30 });
    expect(() => validateOverseer({ enabled: true, model: "rm -rf" })).toThrow(/model/);
  });
});
