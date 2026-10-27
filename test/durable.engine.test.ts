import { describe, expect, it } from "vitest";
import { startRun, type NodeRunner, type StartRunOptions } from "../backend/engine";
import { CORE_BLOCKS, FLOW_INPUT_BLOCK, FLOW_OUTPUT_BLOCK, SUBFLOW_BLOCK } from "../shared/core";
import { activeNodeKeys, journalProblem } from "../shared/journal";
import { BUILTIN_BLOCKS } from "../shared/library";
import type { BlockConfig, Flow, FlowEdge, RunState, Settings } from "../shared/types";

const blocks = [...CORE_BLOCKS, ...BUILTIN_BLOCKS];
const settings: Settings = { startingPrompt: "Do it", sandbox: "none", maxSteps: 40 };
const env = { REPO_PATH: "/r" };
const n = (id: string, blockId = "plan", overrides?: BlockConfig) => ({ id, type: "block" as const, position: { x: 0, y: 0 }, data: { blockId, ...(overrides ? { overrides } : {}) } });
const e = (source: string, target: string, sourceHandle: FlowEdge["sourceHandle"] = "artifact"): FlowEdge => ({
  id: `${source}-${sourceHandle}-${target}`,
  source,
  target,
  sourceHandle,
  targetHandle: "artifact",
});
const never = () => new Promise<never>(() => {});
const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 2000) {
  for (const end = Date.now() + ms; !cond(); ) {
    if (Date.now() > end) throw new Error("timed out");
    await tick(5);
  }
}

/** Starts a run whose journal writes are kept (each a snapshot, as a file would hold it). */
function start(flow: Flow, runner: NodeRunner, o: Partial<StartRunOptions> = {}) {
  const journals: RunState[] = [];
  const h = startRun({
    flow,
    blocks,
    flows: o.flows ?? [flow],
    env,
    settings,
    runners: { auto: runner, ai: runner },
    onJournal: (s) => journals.push(structuredClone(s)),
    pauseGraceMs: 50,
    ...o,
  });
  return { h, journals, last: () => structuredClone(journals.at(-1)!) };
}

const chain: Flow = { id: "chain", name: "Chain", nodes: [n("a"), n("b"), n("c")], edges: [e("a", "b"), e("b", "c")] };

describe("durable runs: journal while running", () => {
  it("journals a step as active before its runner returns, and completed with its outputs after", async () => {
    let release!: () => void;
    const { h, journals, last } = start(chain, async (_c, node) => {
      if (node.id === "b") await new Promise<void>((r) => (release = r));
      return { outputs: { artifact: `${node.id}-out` } };
    });
    await until(() => journals.some((j) => j.nodes.b?.startedAt));
    const mid = last();
    expect(journalProblem(mid)).toBeUndefined();
    expect(mid.nodes.a).toMatchObject({ status: "done", outputs: { artifact: "a-out" }, finishedAt: expect.any(Number) });
    expect(activeNodeKeys(mid)).toEqual(["b"]);
    expect(mid.steps).toBe(2);
    expect(mid.queues).toEqual({ "": [] });
    release();
    const final = await h.done;
    expect(final.phase).toBe("done");
    expect(final.transitions?.map((t) => t.phase)).toEqual(["running", "done"]);
    expect(final.queues).toBeUndefined();
  });

  it("a failing journal write is logged once and the run goes on", async () => {
    const { h } = start(chain, async () => ({ outputs: { artifact: "x" } }), {
      onJournal: () => {
        throw new Error("disk full");
      },
    });
    const final = await h.done;
    expect(final.status).toBe("done");
    expect(final.logs.filter((l) => /Couldn't write the run journal.*disk full/.test(l.msg))).toHaveLength(1);
  });
});

describe("durable runs: continue after a crash", () => {
  it("skips finished steps, re-runs the interrupted one (its session continued once), runs what was queued, keeps counting steps", async () => {
    const fan: Flow = { id: "fan", name: "Fan", nodes: [n("a"), n("b"), n("c"), n("d")], edges: [e("a", "b"), e("a", "c"), e("c", "d")] };
    const first = start(fan, async (ctx, node) => {
      if (node.id === "b") {
        ctx.noteSession?.(node.id, { id: "sess-1", where: "host" });
        return never();
      }
      return { outputs: { artifact: `${node.id}-1` } };
    });
    await until(() => first.journals.some((j) => j.nodes.b?.session));
    // Sandflow dies here: nothing more is written; the journal on disk is all that's left.
    const crashed = first.last();
    expect(crashed.queues?.[""]).toEqual([{ nodeId: "c", inputs: { artifact: "a-1" } }]);

    const ran: string[] = [];
    const taken: unknown[] = [];
    const second = start(
      fan,
      async (ctx, node, _cfg, inputs) => {
        ran.push(node.id);
        if (node.id === "b") {
          taken.push(ctx.takeInterrupted?.(node.id), ctx.takeInterrupted?.(node.id));
          expect(inputs).toEqual({ artifact: "a-1" });
        }
        return { outputs: { artifact: `${node.id}-2` } };
      },
      { continueFrom: crashed },
    );
    const final = await second.h.done;
    expect(final.id).toBe(crashed.id);
    expect(final.status).toBe("done");
    expect(ran).toEqual(["b", "c", "d"]);
    expect(taken).toEqual([{ session: { id: "sess-1", where: "host" } }, undefined]);
    expect(final.nodes.a.executions).toBe(1);
    expect(final.nodes.b.executions).toBe(1); // the same attempt, carried on
    expect(final.steps).toBe(4);
    expect(final.attempt).toBe(2);
    expect(final.transitions?.map((t) => t.phase)).toEqual(["running", "continuing", "running", "done"]);
    expect(final.logs.some((l) => /Continuing this run \(attempt 2\)/.test(l.msg))).toBe(true);
  });

  it("continues inside a subflow from its own queue", async () => {
    const inner: Flow = {
      id: "inner",
      name: "Inner",
      nodes: [n("in", FLOW_INPUT_BLOCK), n("x"), n("y"), n("out", FLOW_OUTPUT_BLOCK, { flowOutput: { name: "ok" } })],
      edges: [e("in", "x"), e("x", "y"), e("y", "out")],
    };
    const outer: Flow = { id: "outer", name: "Outer", nodes: [n("pre"), n("s", SUBFLOW_BLOCK, { subflow: { flowId: "inner" } }), n("post")], edges: [e("pre", "s"), e("s", "post", "exit:ok")] };
    const first = start(outer, async (_c, node) => (node.id === "y" ? never() : { outputs: { artifact: `${node.id}-1` } }), { flows: [outer, inner] });
    await until(() => first.journals.some((j) => j.nodes["s/y"]?.startedAt));
    const crashed = first.last();
    expect(activeNodeKeys(crashed).sort()).toEqual(["s", "s/y"]);

    const ran: string[] = [];
    const final = await start(outer, async (_c, node, _cfg, inputs) => {
      ran.push(node.id);
      if (node.id === "y") expect(inputs).toEqual({ artifact: "x-1" });
      return { outputs: { artifact: `${node.id}-2` } };
    }, { flows: [outer, inner], continueFrom: crashed }).h.done;
    expect(final.status).toBe("done");
    expect(ran).toEqual(["y", "post"]);
    expect(final.nodes.post.inputs).toEqual({ artifact: "y-2" });
  });
});

describe("durable runs: pause", () => {
  it("pausing stops the running step after the grace period, marks it interrupted (mutation), and the run continues later", async () => {
    const first = start(chain, async (ctx, node) => {
      if (node.id === "b") {
        await new Promise((_, reject) => ctx.abort.signal.addEventListener("abort", () => reject(new Error("killed"))));
      }
      return { outputs: { artifact: `${node.id}-1` } };
    });
    await until(() => first.h.state.nodes.b.status === "running");
    const paused = await first.h.pause("quit");
    expect(paused).toMatchObject({ phase: "paused", status: "paused", pauseReason: "quit" });
    expect(paused.finishedAt).toBeUndefined();
    expect(paused.nodes.b).toMatchObject({ interrupted: "mutation", error: undefined });
    expect(first.last().phase).toBe("paused");
    expect(first.last().transitions?.map((t) => t.phase)).toEqual(["running", "pausing", "paused"]);

    const ran: string[] = [];
    const final = await start(chain, async (_c, node) => (ran.push(node.id), { outputs: { artifact: "2" } }), { continueFrom: first.last() }).h.done;
    expect(ran).toEqual(["b", "c"]);
    expect(final.phase).toBe("done");
  });

  it("a step that finishes within the grace period completes; the next one doesn't start", async () => {
    const first = start(chain, async (_c, node) => {
      if (node.id === "b") await tick(20);
      return { outputs: { artifact: node.id } };
    });
    await until(() => first.h.state.nodes.b.status === "running");
    const paused = await first.h.pause("update");
    expect(paused.nodes.b).toMatchObject({ status: "done" });
    expect(paused.nodes.b.interrupted).toBeUndefined();
    expect(paused.nodes.c.executions).toBe(0);
    expect(first.last().queues?.[""]).toEqual([{ nodeId: "c", inputs: { artifact: "b" } }]);
    expect(paused.pauseReason).toBe("update");
  });

  it("an irreversible step isn't cut in half: pause waits for it", async () => {
    const delivered: string[] = [];
    const first = start(chain, async (ctx, node) => {
      if (node.id === "b") {
        await ctx.deliver!(async () => {
          await tick(150); // longer than the grace period
          if (ctx.abort.signal.aborted) throw new Error("cut in half");
          delivered.push("mr");
        });
      }
      return { outputs: { artifact: node.id } };
    });
    await until(() => first.h.state.nodes.b.status === "running");
    const paused = await first.h.pause("quit");
    expect(delivered).toEqual(["mr"]);
    expect(paused.nodes.b.status).toBe("done");
    expect(paused.phase).toBe("paused");
  });

  it("Stop still cancels (a terminal phase); it too waits for a delivery in flight", async () => {
    const delivered: string[] = [];
    const first = start(chain, async (ctx, node) => {
      if (node.id === "b") await ctx.deliver!(async () => (await tick(50), delivered.push("comment")));
      return { outputs: { artifact: node.id } };
    });
    await until(() => first.h.state.nodes.b.status === "running");
    first.h.cancel();
    expect(first.h.state.status).toBe("cancelled");
    const final = await first.h.done;
    expect(delivered).toEqual(["comment"]);
    expect(final).toMatchObject({ phase: "cancelled", status: "cancelled", finishedAt: expect.any(Number) });
    expect(final.nodes.c.executions).toBe(0);
  });
});

describe("durable runs: Box Stack", () => {
  it("continuing doesn't redo finished tasks; the interrupted task's run continues as itself; pending tasks start", async () => {
    const { parentWith, area } = await import("./stackFixtures");
    const { SPLIT_PROTOCOL } = await import("../shared/stack");
    const big = parentWith({ maxConcurrent: 1 });
    const journals = new Map<string, RunState>();
    const calls: string[] = [];
    const runner = (hang: boolean): NodeRunner => async (_ctx, node, cfg, inputs) => {
      if (node.id === "s" && cfg.instructions.includes(SPLIT_PROTOCOL)) {
        calls.push("split");
        return { outputs: { artifact: JSON.stringify({ tasks: ["a", "b", "c"].map((x) => ({ name: x, input: x })) }) } };
      }
      if (node.id === "s") return calls.push(`combine:${inputs.artifact}`), { outputs: { artifact: "combined" } };
      if (node.id === "work") {
        calls.push(`work:${inputs.artifact}`);
        if (hang && inputs.artifact === "b") return never();
        return { outputs: { artifact: `did ${inputs.artifact}` } };
      }
      return { outputs: { artifact: `${node.id}-out` } };
    };
    const go = (hang: boolean, o: Partial<StartRunOptions> = {}) =>
      startRun({
        flow: big, flows: [big, area], blocks, env: {}, settings, runners: { auto: runner(hang), ai: runner(hang) },
        onJournal: (s) => journals.set(s.id, structuredClone(s)),
        loadRun: (id) => structuredClone(journals.get(id)),
        ...o,
      });
    const first = go(true);
    await until(() => calls.includes("work:b"));
    const crashed = structuredClone(journals.get(first.state.id)!);
    expect(crashed.nodes.s.stack?.tasks.map((t) => t.status)).toEqual(["done", "running", "pending"]);
    const bRun = crashed.nodes.s.stack!.tasks[1].runId!;

    calls.length = 0;
    const children: string[] = [];
    const final = await go(false, { continueFrom: crashed, onSpawn: (h) => children.push(h.state.id) }).done;
    expect(final.status).toBe("done");
    expect(calls.filter((c) => c.startsWith("work:"))).toEqual(["work:b", "work:c"]);
    expect(calls).not.toContain("split");
    expect(children[0]).toBe(bRun); // the same run, continued
    expect(journals.get(bRun)?.attempt).toBe(2);
    expect(calls.find((c) => c.startsWith("combine:"))).toMatch(/did a[\s\S]*did b[\s\S]*did c/);
  });
});
