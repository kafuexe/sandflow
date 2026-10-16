import { describe, expect, it } from "vitest";
import { startRun, type NodeRunner, type RunHandle } from "../backend/engine";
import { FLOW_OUTPUT_BLOCK } from "../shared/core";
import { SPLIT_PROTOCOL } from "../shared/stack";
import type { BlockConfig, Flow, NodeIO, ResolvedConfig } from "../shared/types";
import { area, blocks, e, n, parentWith, settings } from "./stackFixtures";

interface Script {
  split?: (inputs: NodeIO, call: number) => string;
  combine?: (inputs: NodeIO) => string;
  work?: (inputs: NodeIO, ctx: Parameters<NodeRunner>[0]) => Promise<NodeIO> | NodeIO;
}

function stackRun(over: BlockConfig["stack"], script: Script, child: Flow = area) {
  const calls = { split: 0, combine: [] as NodeIO[] };
  const children: RunHandle[] = [];
  const runner: NodeRunner = async (ctx, node, cfg: ResolvedConfig, inputs) => {
    if (node.id === "s" && cfg.instructions.includes(SPLIT_PROTOCOL)) return { outputs: { artifact: script.split!(inputs, ++calls.split) } };
    if (node.id === "s") {
      calls.combine.push(inputs);
      return { outputs: { artifact: script.combine ? script.combine(inputs) : "combined" } };
    }
    if (node.id === "plan") return { outputs: { artifact: "the plan" } };
    if (node.id === "work") return { outputs: await (script.work ?? ((i) => ({ artifact: `did ${i.artifact}` })))(inputs, ctx) };
    return { outputs: { artifact: `${node.id}-out` } };
  };
  const big = parentWith(over);
  const h = startRun({
    flow: big, flows: [big, child], blocks, env: {}, settings, runners: { auto: runner, ai: runner },
    onSpawn: (c) => children.push(c),
  });
  return { h, calls, children };
}

const tasks = (...names: string[]) => JSON.stringify({ tasks: names.map((x) => ({ name: x, input: x })) });

describe("running a stack", () => {
  it("splits, runs one child run per task, combines their outputs and leaves through done", async () => {
    const { h, calls, children } = stackRun({}, { split: () => tasks("auth", "billing", "search") });
    const final = await h.done;
    expect(final.status).toBe("done");
    expect(final.nodes.s.exit).toBe("done");
    expect(final.nodes.mr.inputs?.artifact).toBe("combined");
    expect(children).toHaveLength(3);
    const states = await Promise.all(children.map((c) => c.done));
    expect(states.map((s) => s.stack?.task).sort()).toEqual(["auth", "billing", "search"]);
    for (const s of states) {
      expect(s.parent).toEqual({ runId: final.id, nodeKey: "s" });
      expect(s.stack).toMatchObject({ total: 3, attempt: 1, outcome: "succeeded", name: "Box Stack" });
    }
    expect(new Set(states.map((s) => s.stack!.groupId)).size).toBe(1);
    expect(calls.combine[0].artifact).toContain("the plan");
    expect(calls.combine[0].artifact).toMatch(/## auth[\s\S]*did auth/);
    expect(final.flags ?? []).toEqual([]);
  });

  it("never runs more than maxConcurrent children at once", async () => {
    let active = 0;
    let peak = 0;
    const { h } = stackRun({ maxConcurrent: 2 }, {
      split: () => tasks("a", "b", "c", "d", "e"),
      work: async (i) => {
        peak = Math.max(peak, ++active);
        await new Promise((r) => setTimeout(r, 5));
        active--;
        return { artifact: `did ${i.artifact}` };
      },
    });
    expect((await h.done).status).toBe("done");
    expect(peak).toBe(2);
  });

  it("retries a rejected task with the previous reason, then drops it and flags the parent", async () => {
    const seen: string[] = [];
    const { h, calls, children } = stackRun({ maxRetries: 1 }, {
      split: () => tasks("ok", "bad"),
      work: (i) => {
        seen.push(i.artifact!);
        if (i.artifact!.includes("bad")) throw new Error("tests fail in bad");
        return { artifact: "fine" };
      },
    });
    const final = await h.done;
    expect(final.nodes.s.exit).toBe("done");
    const bad = seen.filter((x) => x.includes("bad"));
    expect(bad).toHaveLength(2);
    expect(bad[1]).toMatch(/previous attempt[\s\S]*tests fail in bad/i);
    expect(calls.combine[0].artifact).toContain("## ok");
    expect(calls.combine[0].artifact).not.toContain("## bad");
    expect(calls.combine[0].artifact).toMatch(/dropped[\s\S]*bad/i);
    expect(final.flags).toEqual([expect.objectContaining({ severity: "warning", message: "1 of 2 tasks dropped after retries: bad", nodeKey: "s" })]);
    const badRuns = (await Promise.all(children.map((c) => c.done))).filter((s) => s.stack?.task === "bad");
    expect(badRuns.map((s) => [s.stack!.attempt, s.stack!.outcome])).toEqual([[1, "rejected"], [2, "dropped"]]);
  });

  it("an exit that isn't a success exit rejects the attempt", async () => {
    const checked: Flow = {
      ...area,
      nodes: [
        ...area.nodes.filter((x) => x.id !== "out"),
        n("chk", "if", { condition: { match: "all", rules: [{ field: "text", op: "contains", value: "OK" }] } }),
        n("yes", FLOW_OUTPUT_BLOCK, { flowOutput: { name: "done" } }, 0),
        n("no", FLOW_OUTPUT_BLOCK, { flowOutput: { name: "rejected" } }, 100),
      ],
      edges: [e("in", "work"), e("work", "chk"), e("chk", "yes", "true"), e("chk", "no", "false")],
    };
    const { h } = stackRun({ maxRetries: 0 }, { split: () => tasks("a"), work: () => ({ artifact: "nope" }) }, checked);
    const final = await h.done;
    expect(final.nodes.s.exit).toBe("failed");
    expect(final.flags).toEqual([expect.objectContaining({ severity: "error", message: expect.stringMatching(/no task succeeded/i) })]);
    expect(final.flags![0].details).toMatch(/a.*exit "rejected"/);
  });

  it("asks the orchestrator again when the split can't be read or has too many tasks", async () => {
    const answers = ["not json", tasks("a", "b", "c"), tasks("a", "b")];
    const prompts: string[] = [];
    const { h, children } = stackRun({ maxConcurrent: 1, maxChildren: 2 }, {
      split: (i, call) => (prompts.push(i.artifact ?? ""), answers[call - 1]),
    });
    const final = await h.done;
    expect(final.nodes.s.exit).toBe("done");
    expect(children).toHaveLength(2);
    expect(prompts[1]).toMatch(/no JSON object/i);
    expect(prompts[2]).toMatch(/3 tasks.*at most 2/);
  });

  it("leaves through failed when the split never works", async () => {
    const { h } = stackRun({}, { split: () => "no" });
    const final = await h.done;
    expect(final.nodes.s.exit).toBe("failed");
    expect(final.flags?.[0]).toMatchObject({ severity: "error", message: expect.stringMatching(/couldn't split/i) });
  });

  it("cancelling the parent cancels running children and starts no more", async () => {
    let started = 0;
    const { h, children } = stackRun({ maxConcurrent: 1 }, {
      split: () => tasks("a", "b", "c"),
      work: (_i, ctx) => {
        started++;
        return new Promise((_r, rej) => ctx.abort.signal.addEventListener("abort", () => rej(new Error("Run cancelled"))));
      },
    });
    while (!started) await new Promise((r) => setTimeout(r, 1));
    h.cancel();
    const final = await h.done;
    expect(final.status).toBe("cancelled");
    expect(started).toBe(1);
    expect((await children[0].done).status).toBe("cancelled");
  });

  it("a child waiting for an answer doesn't hold up its siblings", async () => {
    const { h, children } = stackRun({}, {
      split: () => tasks("a", "b", "c"),
      work: async (i, ctx) => ({ artifact: i.artifact === "b" ? await ctx.ask("work", "Which DB?") : "fine" }),
    });
    while (children.length < 3 || !children.some((c) => c.state.pendingQuestion)) await new Promise((r) => setTimeout(r, 1));
    const asking = children.find((c) => c.state.pendingQuestion)!;
    const others = children.filter((c) => c !== asking);
    expect((await Promise.all(others.map((c) => c.done))).map((s) => s.status)).toEqual(["done", "done"]);
    expect(h.state.finishedAt).toBeUndefined();
    asking.answer("postgres");
    expect((await h.done).nodes.s.exit).toBe("done");
  });

  it("isolated children get their own branch next to the run's branch; shared ones don't", async () => {
    const iso = stackRun({ workspace: "isolated" }, { split: () => tasks("Auth & Login") });
    const isoState = await iso.h.done;
    const child = await iso.children[0].done;
    expect(child.stack!.branch).toMatch(new RegExp(`^sandflow/${isoState.id}-[0-9a-f]{4}-1-auth-login$`));
    const shared = stackRun({ workspace: "shared" }, { split: () => tasks("a") });
    await shared.h.done;
    expect((await shared.children[0].done).stack!.branch).toBeUndefined();
  });

  it("a flag raised inside a child is copied to the parent, pointing back at the child", async () => {
    const { h, children } = stackRun({}, {
      split: () => tasks("a"),
      work: (_i, ctx) => (ctx.flag("warning", "tests skipped"), { artifact: "ok" }),
    });
    const final = await h.done;
    const child = await children[0].done;
    expect(child.flags).toEqual([expect.objectContaining({ message: "tests skipped" })]);
    expect(final.flags).toEqual([expect.objectContaining({ message: "tests skipped", fromRunId: child.id })]);
  });

  it("stopping a task's run by hand drops that task instead of retrying it", async () => {
    let started = 0;
    const { h, children, calls } = stackRun({ maxRetries: 2 }, {
      split: () => tasks("a", "b"),
      work: (i, ctx) => {
        started++;
        if (i.artifact === "b") return { artifact: "fine" };
        return new Promise((_r, rej) => ctx.abort.signal.addEventListener("abort", () => rej(new Error("Run cancelled"))));
      },
    });
    while (children.length < 2) await new Promise((r) => setTimeout(r, 1));
    children.find((c) => c.state.stack?.task === "a")!.cancel();
    const final = await h.done;
    expect(started).toBe(2);
    expect(final.nodes.s.exit).toBe("done");
    expect(calls.combine[0].artifact).toMatch(/a \(1 attempt\): stopped by you/);
    expect(final.flags).toEqual([expect.objectContaining({ message: "1 of 2 tasks dropped after retries: a" })]);
  });
});
