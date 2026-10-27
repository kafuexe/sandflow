import { describe, expect, it } from "vitest";
import { startRun, type NodeRunner, type StartRunOptions } from "../backend/engine";
import { decideAfterFailure, type TriageRequest, type TriageRunner } from "../backend/recovery";
import { CORE_BLOCKS, SUBFLOW_BLOCK } from "../shared/core";
import { activeNodeKeys, journalProblem } from "../shared/journal";
import { BUILTIN_BLOCKS } from "../shared/library";
import { recoverySettings } from "../shared/recovery";
import { resolveNode } from "../shared/resolve";
import type { BlockConfig, Flow, FlowEdge, FlowRecovery, RunState, Settings } from "../shared/types";

const blocks = [...CORE_BLOCKS, ...BUILTIN_BLOCKS];
const settings: Settings = { startingPrompt: "Do it", sandbox: "none", maxSteps: 40 };
const env = { REPO_PATH: "/r" };
const n = (id: string, blockId = "plan", overrides?: BlockConfig) => ({ id, type: "block" as const, position: { x: 0, y: 0 }, data: { blockId, ...(overrides ? { overrides } : {}) } });
const e = (source: string, target: string): FlowEdge => ({ id: `${source}-${target}`, source, target, sourceHandle: "artifact", targetHandle: "artifact" });
const flowOf = (recovery?: FlowRecovery, a = "plan", b = "plan"): Flow => ({ id: "f", name: "F", nodes: [n("a", a), n("b", b)], edges: [e("a", "b")], ...(recovery ? { recovery } : {}) });
const crash = () => Object.assign(new Error("claude exited with code -11"), { exitCode: -11 });

/** A fake triage agent answering from a script (a string, or an Error to throw), recording what it was asked. */
function triage(...answers: (string | Error)[]) {
  const asked: TriageRequest[] = [];
  const run: TriageRunner = async (req) => {
    asked.push(req);
    const a = answers.shift();
    if (a === undefined) throw new Error("no more answers");
    if (a instanceof Error) throw a;
    return a;
  };
  return { run, asked };
}
const decide = (o: Record<string, unknown>) => JSON.stringify(o);

function start(flow: Flow, runner: NodeRunner, t: TriageRunner | undefined, o: Partial<StartRunOptions> = {}) {
  const slept: number[] = [];
  const journals: RunState[] = [];
  const h = startRun({
    flow,
    blocks,
    flows: [flow],
    env,
    settings,
    runners: { auto: runner, ai: runner, ...(t ? { triage: t } : {}) },
    sleep: async (ms) => void slept.push(ms),
    onJournal: (s) => journals.push(structuredClone(s)),
    pauseGraceMs: 50,
    ...o,
  });
  return { h, slept, journals };
}

/** A runner that fails node `a` with each error in turn, then succeeds; records what each call of `a` saw. */
function failing(...errors: Error[]) {
  const calls: { inputs: unknown; again: unknown; instructions: string }[] = [];
  const runner: NodeRunner = async (ctx, node, cfg, inputs) => {
    if (node.id === "a") {
      calls.push({ inputs, again: ctx.takeInterrupted?.(node.id), instructions: cfg.instructions });
      if (calls.length === 1) ctx.noteSession?.(node.id, { id: "s1", where: "host" });
      const err = errors.shift();
      if (err) throw err;
    }
    return { outputs: { artifact: `${node.id}-out` } };
  };
  return { runner, calls };
}

describe("recovery: automatic retries", () => {
  it("crash is retried with backoff up to maxRetries (the agent reviews in its own session), then triaged", async () => {
    const { runner, calls } = failing(crash(), crash(), crash());
    const t = triage(decide({ action: "retry", reason: "flaky CLI" }));
    const { h, slept } = start(flowOf(), runner, t.run);
    const run = await h.done;
    expect(run.status).toBe("done");
    expect(slept).toEqual([1000, 2000]);
    expect(calls).toHaveLength(4);
    expect(calls[1].again).toEqual({ session: { id: "s1", where: "host" }, prompt: expect.stringMatching(/^Your previous attempt crashed: claude exited with code -11\. Check the work/) });
    expect(calls[3].again).toBeUndefined(); // triage retry: a fresh session
    expect(t.asked).toHaveLength(1);
    expect(run.nodes.a.executions).toBe(1);
    expect(run.nodes.a.failure).toBeUndefined();
    expect(run.steps).toBe(2);
    expect(run.recovery?.a).toMatchObject({
      cycles: 1,
      retries: 0,
      history: [
        { cause: "crash", decision: "retry", by: "auto", delayMs: 1000, session: "resume" },
        { cause: "crash", decision: "retry", by: "auto", delayMs: 2000, session: "resume" },
        { cause: "crash", decision: "retry", by: "triage", reason: "flaky CLI", session: "fresh" },
      ],
    });
  });

  it("transient failures retry by themselves; a failure's cause is journaled while recovery decides", async () => {
    const econn = Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });
    const { runner } = failing(econn);
    const { h, slept, journals } = start(flowOf(), runner, triage().run);
    const run = await h.done;
    expect(run.status).toBe("done");
    expect(slept).toEqual([1000]);
    expect(journals.some((j) => j.nodes.a.failure?.cause === "transient")).toBe(true);
    expect(journals.every((j) => !journalProblem(j))).toBe(true);
  });

  it("a timed-out agent continues its session once, then starts fresh (MEOW recycles the session)", async () => {
    const { runner, calls } = failing(new Error("Command timed out after 60s"), new Error("Command timed out after 60s"));
    const { h } = start(flowOf(), runner, triage().run);
    await h.done;
    expect(calls[1].again).toMatchObject({ session: { id: "s1" }, prompt: expect.stringMatching(/ran out of time/) });
    expect(calls[2].again).toEqual({ prompt: expect.stringMatching(/ran out of time/), fresh: true });
  });

  it("non-agent steps simply run again from their inputs", async () => {
    const { runner, calls } = failing(crash());
    const { h } = start(flowOf({ mode: "triage" }, "shell", "shell"), runner, triage().run);
    expect((await h.done).status).toBe("done");
    expect(calls.map((c) => c.again)).toEqual([undefined, undefined]);
  });

  it("recovery off — or no triage runner — fails the run as before", async () => {
    for (const [flow, t] of [[flowOf({ mode: "off" }), triage().run], [flowOf(), undefined]] as const) {
      const { runner } = failing(crash());
      const { h, slept } = start(flow, runner, t);
      const run = await h.done;
      expect(run.status).toBe("failed");
      expect(run.error).toMatch(/exited with code -11/);
      expect(run.nodes.a.failure).toMatchObject({ cause: "crash" });
      expect(run.recovery).toBeUndefined();
      expect(slept).toEqual([]);
    }
  });

  it("a Stop during the backoff doesn't retry", async () => {
    const { runner, calls } = failing(crash());
    let stop!: () => void;
    const { h } = start(flowOf(), runner, triage().run, { sleep: () => new Promise<void>((r) => (stop = r)) });
    await new Promise((r) => setTimeout(r, 20));
    h.cancel();
    stop();
    const run = await h.done;
    expect(run.status).toBe("cancelled");
    expect(calls).toHaveLength(1);
  });
});

describe("recovery: triage", () => {
  it("error goes straight to triage, which gets the task, the failure, the flow around it and the history", async () => {
    const { runner } = failing(new Error("tests failed: 3"));
    const t = triage(decide({ action: "retry", reason: "try again" }));
    const { h, slept } = start(flowOf({ agent: { provider: "claudeCode", model: "haiku" } }), runner, t.run);
    expect((await h.done).status).toBe("done");
    expect(slept).toEqual([]);
    const req = t.asked[0];
    expect(req).toMatchObject({ nodeKey: "a", model: "haiku", cwd: "/r" });
    expect(req.prompt).toMatch(/Cause: error/);
    expect(req.prompt).toMatch(/Message: tests failed: 3/);
    expect(req.prompt).toMatch(/Feeds: .*\(b\)/);
    expect(req.prompt).toMatch(/"action": "retry" \| "resume"/);
  });

  it("resume: the notes reach the agent (its session continues with them; its instructions carry them)", async () => {
    const { runner, calls } = failing(new Error("half done"));
    const t = triage(decide({ action: "resume", reason: "almost there", notes: "Run npm test before finishing" }));
    const { h } = start(flowOf(), runner, t.run);
    expect((await h.done).status).toBe("done");
    expect(calls[1].again).toEqual({ session: { id: "s1", where: "host" }, prompt: expect.stringMatching(/Triage notes: Run npm test before finishing$/) });
    expect(calls[1].instructions).toMatch(/## Triage notes[\s\S]*Run npm test before finishing/);
  });

  it("rescope: the task replaces the step's input for the retry", async () => {
    const { runner, calls } = failing(new Error("too big"));
    const t = triage(decide({ action: "rescope", reason: "split", task: "Only the parser" }));
    const { h } = start(flowOf(), runner, t.run);
    expect((await h.done).status).toBe("done");
    expect(calls[1].inputs).toEqual({ artifact: "Only the parser" });
  });

  it("skip: the flow goes on with triage's output", async () => {
    const seen: unknown[] = [];
    const runner: NodeRunner = async (_c, node, _cfg, inputs) => {
      if (node.id === "a") throw new Error("lint broke");
      seen.push(inputs);
      return { outputs: { artifact: "b" } };
    };
    const t = triage(decide({ action: "skip", reason: "optional", output: "nothing to lint" }));
    const { h } = start(flowOf(), runner, t.run);
    const run = await h.done;
    expect(run.status).toBe("done");
    expect(seen).toEqual([{ artifact: "nothing to lint" }]);
    expect(run.nodes.a).toMatchObject({ status: "done", outputs: { artifact: "nothing to lint" } });
    expect(run.recovery?.a.history.at(-1)).toMatchObject({ decision: "skip", by: "triage" });
  });

  it("skip is refused on a delivery step (Create MR) — the run is held", async () => {
    const runner: NodeRunner = async (_c, node) => {
      if (node.id === "b") throw new Error("gh pr create failed");
      return { outputs: { artifact: "x" } };
    };
    const t = triage(decide({ action: "skip", reason: "whatever" }));
    const { h } = start(flowOf({ mode: "triage" }, "plan", "create-mr"), runner, t.run);
    const run = await h.done;
    expect(run.phase).toBe("paused");
    expect(run.hold).toMatchObject({ reason: "blocked", guard: "invalid-decision", nodeKey: "b", problems: [expect.stringMatching(/never skipped/)] });
  });

  it("blocked holds the run (paused for a human); Continue runs the step again reviewing its failure, budget kept", async () => {
    const { runner } = failing(new Error("missing token"));
    const t = triage(decide({ action: "blocked", reason: "Set GITHUB_TOKEN" }));
    const first = start(flowOf(), runner, t.run);
    const held = await first.h.done;
    expect(held.phase).toBe("paused");
    expect(held.status).toBe("paused");
    expect(held.pauseReason).toBe("blocked");
    expect(held.hold).toMatchObject({ reason: "blocked", guard: "needs-human", nodeKey: "a", problems: ["Set GITHUB_TOKEN"] });
    expect(held.finishedAt).toBeUndefined();
    expect(activeNodeKeys(held)).toEqual(["a"]);
    expect(held.flags?.some((f) => /Held at .*needs you: Set GITHUB_TOKEN/.test(f.message))).toBe(true);
    expect(held.logs.some((l) => /⏸ Held — Set GITHUB_TOKEN/.test(l.msg))).toBe(true);
    expect(held.recovery?.a.history.at(-1)).toMatchObject({ decision: "blocked", guard: "needs-human" });

    // Continued (part 1): the held step runs again, reviewing against the failure; the recovery journal is kept.
    const journal = structuredClone(held);
    const seen: unknown[] = [];
    const second = start(
      flowOf(),
      async (ctx, node) => {
        if (node.id === "a") seen.push(ctx.takeInterrupted?.(node.id));
        return { outputs: { artifact: "ok" } };
      },
      triage().run,
      { continueFrom: journal },
    );
    const done = await second.h.done;
    expect(done.status).toBe("done");
    expect(done.hold).toBeUndefined();
    expect(seen).toEqual([{ session: { id: "s1", where: "host" }, prompt: expect.stringMatching(/^Your previous attempt failed: missing token\./) }]);
    expect(done.recovery?.a.history).toHaveLength(1);
  });

  it("the budget is per node per run and survives a continue: exhausted → held", async () => {
    const { runner } = failing(new Error("e1"), new Error("e2"));
    const t = triage(decide({ action: "retry", reason: "r1" }));
    const first = start(flowOf({ maxRecoveryCycles: 1 }), runner, t.run);
    const held = await first.h.done;
    expect(held.hold).toMatchObject({ reason: "blocked", guard: "recovery-exhausted" });
    expect(held.recovery?.a.cycles).toBe(1);
    expect(t.asked).toHaveLength(1);

    const again = failing(new Error("e3"));
    const second = start(flowOf({ maxRecoveryCycles: 1 }), again.runner, triage().run, { continueFrom: structuredClone(held) });
    const run = await second.h.done;
    expect(run.hold).toMatchObject({ guard: "recovery-exhausted" });
    expect(run.recovery?.a.cycles).toBe(1);
    expect(run.attempt).toBe(2);
  });

  it("a decision identical to the previous one is held as repeated-decision", async () => {
    const { runner } = failing(new Error("e1"), new Error("e2"));
    const d = decide({ action: "resume", reason: "go", notes: "same" });
    const { h } = start(flowOf(), runner, triage(d, d).run);
    const run = await h.done;
    expect(run.hold).toMatchObject({ guard: "repeated-decision" });
    expect(run.recovery?.a.cycles).toBe(1);
  });

  it("an invalid decision → invalid-decision; a triage crash → triage-failed", async () => {
    const a = start(flowOf(), failing(new Error("x")).runner, triage("I think you should retry").run);
    expect((await a.h.done).hold).toMatchObject({ guard: "invalid-decision", problems: [expect.stringMatching(/no decision JSON/)] });
    const b = start(flowOf(), failing(new Error("x")).runner, triage(new Error("claude not found")).run);
    expect((await b.h.done).hold).toMatchObject({ guard: "triage-failed", problems: [expect.stringMatching(/claude not found/)] });
  });

  it("a failure inside a subflow is decided once, for the inner step", async () => {
    const inner: Flow = { id: "in", name: "In", nodes: [n("x", "plan")], edges: [] };
    const outer: Flow = { id: "out", name: "Out", nodes: [n("sub", SUBFLOW_BLOCK, { subflow: { flowId: "in" } })], edges: [] };
    const t = triage(decide({ action: "blocked", reason: "human" }));
    const { h } = start(outer, async () => {
      throw new Error("inner broke");
    }, t.run, { flows: [outer, inner] });
    const run = await h.done;
    expect(run.hold).toMatchObject({ nodeKey: "sub/x", guard: "needs-human" });
    expect(Object.keys(run.recovery ?? {})).toEqual(["sub/x"]);
    expect(activeNodeKeys(run).sort()).toEqual(["sub", "sub/x"]);
  });
});

describe("decideAfterFailure", () => {
  it("in a Box Stack task a hold fails the step instead (its stack retries it)", async () => {
    const flow = flowOf();
    const run = { id: "r", nodes: { a: { status: "running", executions: 1 } }, logs: [] } as unknown as RunState;
    const history = { cycles: 0, history: [] };
    const node = flow.nodes[0];
    const r = await decideAfterFailure(
      {
        settings: recoverySettings(flow, [flow], blocks),
        triage: triage(decide({ action: "blocked", reason: "human" })).run,
        signal: new AbortController().signal,
        run,
        nodeKey: "a",
        flow,
        blocks,
        inputs: {},
        canHold: false,
        log: () => {},
      },
      node,
      resolveNode(node, blocks),
      { cause: "error", message: "x", at: 1 },
      history,
    );
    expect(r).toEqual({ kind: "fail" });
    expect(history.history).toMatchObject([{ decision: "fail", guard: "needs-human" }]);
  });
});
