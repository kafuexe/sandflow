// The supervisor tick (backend/supervisor.ts) on real engine runs, with a fake clock and a fake overseer: silent /
// stuck / time limits / loops / reminders / vanished containers / the driver lock heartbeat / the overseer's verdicts.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startRun, type NodeRunner, type RunHandle } from "../backend/engine";
import { acquireRunLock, OWN_START, readLock, releaseRunLock, touchRunLock } from "../backend/journal";
import { createSupervisor, MAX_OVERSEER_STEERS, parseVerdict, type OverseerRunner, type SupervisorDeps } from "../backend/supervisor";
import { CORE_BLOCKS } from "../shared/core";
import { BUILTIN_BLOCKS } from "../shared/library";
import { eventsAfter } from "../shared/runEvents";
import type { BlockConfig, Flow, FlowEdge, OverseerSettings, Settings } from "../shared/types";

const blocks = [...CORE_BLOCKS, ...BUILTIN_BLOCKS];
const settings: Settings = { startingPrompt: "Do it", sandbox: "docker", maxSteps: 40 };
const n = (id: string, blockId = "plan", overrides?: BlockConfig) => ({ id, type: "block" as const, position: { x: 0, y: 0 }, data: { blockId, ...(overrides ? { overrides } : {}) } });
const e = (source: string, target: string): FlowEdge => ({ id: `${source}-${target}`, source, target, sourceHandle: "artifact", targetHandle: "artifact" });
const MIN = 60;
async function until(cond: () => boolean, ms = 2000) {
  for (const end = Date.now() + ms; !cond(); ) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** Works until stopped; takes steering messages (like an agent); records them. */
const steered: string[] = [];
const working: NodeRunner = (ctx, node) =>
  new Promise((_, reject) => {
    const inbox = ctx.steerable?.(node.id, () => {
      const p = inbox!.pending();
      steered.push(...p.map((s) => s.message));
      inbox!.applied(p, "interrupt");
    });
    ctx.abort.signal.addEventListener("abort", () => (inbox?.close(), reject(new Error("Run cancelled"))), { once: true });
  });

const handles: RunHandle[] = [];
afterEach(async () => {
  steered.length = 0;
  for (const h of handles.splice(0)) {
    h.cancel();
    await h.done;
  }
});

/** A run of `flow` plus a supervisor over it with a clock the test moves (`advance`, in seconds). */
function supervised(flow: Flow, runner: NodeRunner = working, o: Partial<SupervisorDeps> & { settings?: Settings } = {}) {
  let offset = 0;
  const s = o.settings ?? settings;
  const h = startRun({ flow, blocks, flows: [flow], env: { REPO_PATH: "/r" }, settings: s, runners: { auto: runner, ai: runner } });
  handles.push(h);
  const sup = createSupervisor({ runs: () => [h], load: () => ({ flows: [flow], blocks, settings: s }), now: () => Date.now() + offset, ...o });
  return { h, sup, advance: (secs: number) => (offset += secs * 1000) };
}
const one = (overrides?: BlockConfig, blockId = "plan", overseer?: OverseerSettings): Flow => ({ id: "f", name: "F", nodes: [n("a", blockId, overrides)], edges: [], ...(overseer ? { overseer } : {}) });
const kinds = (h: RunHandle) => (h.state.supervision ?? []).map((x) => `${x.kind}:${x.action ?? ""}`);

describe("supervisor: signs of life", () => {
  it("a silent agent gets one warning flag per silence; stuck → stopNode → failure cause stuck", async () => {
    const { h, sup, advance } = supervised(one());
    await until(() => h.state.nodes.a.status === "running");
    advance(9 * MIN);
    await sup.tick();
    expect(h.state.supervision ?? []).toEqual([]);
    advance(2 * MIN);
    await sup.tick();
    await sup.tick();
    expect(kinds(h)).toEqual(["silent:flagged"]);
    expect(h.state.flags?.filter((f) => /silent for 11 min/.test(f.message))).toHaveLength(1);
    expect(h.state.status).toBe("running");
    advance(20 * MIN);
    await sup.tick();
    const run = await h.done;
    expect(kinds(h)).toEqual(["silent:flagged", "stuck:stopped"]);
    expect(run.nodes.a.failure).toMatchObject({ cause: "stuck", message: expect.stringMatching(/no sign of life for 31 min/) });
  });

  it("a sign of life ends the silence: a later one is flagged again", async () => {
    let ctxLog!: (m: string) => void;
    const { h, sup, advance } = supervised(one(), (ctx, node) => {
      ctxLog = (m) => ctx.log("agent", m, node.id);
      return working(ctx, node, undefined as never, {});
    });
    await until(() => !!ctxLog);
    advance(11 * MIN);
    await sup.tick();
    // Activity "now" by the fake clock: the engine stamps real time, so move its stamp along with the clock.
    ctxLog("still working");
    h.state.nodes.a.lastActivityAt = Date.now() + 11 * MIN * 1000;
    advance(5 * MIN);
    await sup.tick();
    expect(kinds(h)).toEqual(["silent:flagged"]);
    advance(6 * MIN);
    await sup.tick();
    expect(kinds(h)).toEqual(["silent:flagged", "silent:flagged"]);
  });

  it("Settings → Supervisor: custom thresholds; enabled: false checks nothing", async () => {
    const custom = { ...settings, supervisor: { silentAfterSeconds: 60, stuckAfterSeconds: 120 } };
    const a = supervised(one(), working, { settings: custom });
    await until(() => a.h.state.nodes.a.status === "running");
    a.advance(61);
    await a.sup.tick();
    expect(kinds(a.h)).toEqual(["silent:flagged"]);
    a.advance(60);
    await a.sup.tick();
    expect((await a.h.done).nodes.a.failure?.cause).toBe("stuck");

    const b = supervised(one(), working, { settings: { ...settings, supervisor: { enabled: false } } });
    await until(() => b.h.state.nodes.a.status === "running");
    b.advance(5 * 60 * MIN);
    await b.sup.tick();
    expect(b.h.state.supervision).toBeUndefined();
  });
});

describe("supervisor: time limits", () => {
  it("timeoutSeconds on the block, overridden on the node", async () => {
    const tpl = { id: "slow", name: "Slow", isTemplate: false, extends: "plan", config: { timeoutSeconds: 60 } };
    const flow: Flow = { id: "f", name: "F", nodes: [n("a", "slow", { timeoutSeconds: 120 })], edges: [] };
    let offset = 0;
    const h = startRun({ flow, blocks: [...blocks, tpl], flows: [flow], env: {}, settings, runners: { auto: working, ai: working } });
    handles.push(h);
    const sup = createSupervisor({ runs: () => [h], load: () => ({ flows: [flow], blocks: [...blocks, tpl], settings }), now: () => Date.now() + offset });
    await until(() => h.state.nodes.a.status === "running");
    offset = 61_000;
    await sup.tick();
    expect(h.state.nodes.a.status).toBe("running");
    offset = 121_000;
    await sup.tick();
    const run = await h.done;
    expect(run.nodes.a.failure).toMatchObject({ cause: "timeout", message: expect.stringMatching(/time limit of 2 min/) });
    expect(kinds(h)).toEqual(["timeout:stopped"]);
  });

  it("a Shell command stops after 30 min by default (and isn't judged by silence)", async () => {
    const { h, sup, advance } = supervised(one(undefined, "shell"));
    await until(() => h.state.nodes.a.status === "running");
    advance(29 * MIN);
    await sup.tick();
    expect(h.state.supervision ?? []).toEqual([]);
    advance(2 * MIN);
    await sup.tick();
    expect((await h.done).nodes.a.failure?.cause).toBe("timeout");
  });

  it("time spent waiting on a question doesn't count", async () => {
    let offset = 0;
    const flow = one({ timeoutSeconds: 600 });
    const h = startRun({
      flow, blocks, flows: [flow], env: {}, settings,
      runners: { auto: working, ai: async (ctx, node) => (await ctx.ask(node.id, "Which DB?"), working(ctx, node, undefined as never, {})) },
    });
    handles.push(h);
    const sup = createSupervisor({ runs: () => [h], load: () => ({ flows: [flow], blocks, settings }), now: () => Date.now() + offset });
    await until(() => !!h.state.pendingQuestion);
    offset = 3600_000;
    await sup.tick();
    expect(h.state.nodes.a.status).toBe("waiting");
    // Answered an hour later (by the fake clock): the node has used almost none of its 10 minutes.
    const q = h.state.questions![0];
    h.answer("Postgres");
    q.answeredAt = q.askedAt + 3600_000;
    await sup.tick();
    expect(h.state.nodes.a.status).toBe("running");
    offset += 11 * MIN * 1000;
    await sup.tick();
    expect((await h.done).nodes.a.failure?.cause).toBe("timeout");
  });
});

describe("supervisor: loops, reminders, containers", () => {
  it("a node that ran ≥ 5 times with an unchanged output gets one warning", async () => {
    const flow: Flow = { id: "f", name: "F", nodes: [n("s"), n("a"), n("b")], edges: [e("s", "a"), e("a", "b"), e("b", "a")] };
    let runsOfA = 0;
    const { h, sup } = supervised(flow, (ctx, node) => (node.id === "a" && ++runsOfA > 5 ? working(ctx, node, undefined as never, {}) : Promise.resolve({ outputs: { artifact: node.id === "a" ? "same" : `b${runsOfA}` } })));
    await until(() => runsOfA === 6);
    await sup.tick();
    await sup.tick();
    expect(kinds(h)).toEqual(["loop:flagged"]);
    expect(h.state.supervision![0]).toMatchObject({ node: "a", detail: expect.stringMatching(/ran 6 times and produced the same output/) });
    expect(h.state.status).toBe("running");
  });

  it("an unanswered question gets a reminder after 30 min, then at most hourly", async () => {
    const { h, sup, advance } = supervised(one({ allowQuestions: true }), async (ctx, node) => ({ outputs: { artifact: await ctx.ask(node.id, "Which DB?") } }));
    await until(() => !!h.state.pendingQuestion);
    advance(29 * MIN);
    await sup.tick();
    advance(2 * MIN);
    await sup.tick();
    advance(30 * MIN);
    await sup.tick();
    expect(kinds(h)).toEqual(["reminder:reminded"]);
    advance(31 * MIN);
    await sup.tick();
    expect(kinds(h)).toEqual(["reminder:reminded", "reminder:reminded"]);
    expect(h.state.supervision![0].detail).toMatch(/waited 31 min for your answer: Which DB\?/);
  });

  it("a vanished container stops its node (cause sandbox); looked up at most every 60 s; 'can't tell' does nothing", async () => {
    const id = "abcdef123456";
    let exists: boolean | undefined;
    const lookups: string[] = [];
    const { h, sup, advance } = supervised(one(), (ctx, node) => (ctx.noteContainer?.("docker", id), ctx.noteSession?.(node.id, { id: "s1", where: id }), working(ctx, node, undefined as never, {})), {
      containerExists: async (kind, c) => (lookups.push(`${kind}:${c}`), exists),
    });
    await until(() => !!h.state.nodes.a.session);
    await sup.tick();
    expect(lookups).toEqual([`docker:${id}`]);
    exists = false;
    advance(30);
    await sup.tick();
    expect(lookups).toHaveLength(1);
    expect(h.state.status).toBe("running");
    advance(31);
    await sup.tick();
    expect((await h.done).nodes.a.failure).toMatchObject({ cause: "sandbox", message: "its container is gone" });
    expect(kinds(h)).toEqual(["sandbox:stopped"]);
  });

  it("refreshes the driver lock of every live top-level run each tick", async () => {
    const beats: string[] = [];
    const { h, sup } = supervised(one(), working, { heartbeat: (id) => beats.push(id) });
    await sup.tick();
    await sup.tick();
    expect(beats).toEqual([h.state.id, h.state.id]);
  });
});

describe("supervisor: the overseer", () => {
  const flow = one(undefined, "plan", { enabled: true, everySeconds: 60 });
  function withOverseer(answers: (string | Error)[]) {
    const prompts: { prompt: string; model: string }[] = [];
    const overseer: OverseerRunner = async ({ prompt, model }) => {
      prompts.push({ prompt, model });
      const a = answers.shift() ?? '{"verdict":"ok","node":"a","message":"fine","action":"none"}';
      if (a instanceof Error) throw a;
      return a;
    };
    const s = supervised(flow, working, { overseer });
    const turn = async () => {
      s.advance(61);
      await s.sup.tick();
      await s.sup.drain();
    };
    return { ...s, prompts, turn };
  }
  const v = (verdict: string, action: string, message = "x") => JSON.stringify({ verdict, node: "a", message, action });

  it("looks every everySeconds while an agent runs, with its task and activity; ok is only journaled", async () => {
    const { h, sup, prompts, turn } = withOverseer([v("ok", "none", "making progress")]);
    await until(() => h.state.nodes.a.status === "running");
    await sup.tick();
    expect(prompts).toHaveLength(0);
    h.state.activity = { a: [{ ts: Date.now(), kind: "tool", name: "Edit", text: "src/login.ts", exec: 1 }] };
    await turn();
    expect(prompts).toHaveLength(1);
    expect(prompts[0].model).toBe("haiku");
    expect(prompts[0].prompt).toMatch(/## Node "a" \(Plan\)/);
    expect(prompts[0].prompt).toMatch(/tool Edit: src\/login\.ts/);
    expect(prompts[0].prompt).toMatch(/"verdict": "ok" \| "concern" \| "stuck"/);
    expect(h.state.supervision).toEqual([expect.objectContaining({ kind: "overseer", node: "a", exec: 1, detail: "ok: making progress", action: "none" })]);
    expect(h.state.status).toBe("running");
    // Its earlier verdicts go along next time.
    await turn();
    expect(prompts[1].prompt).toMatch(/earlier verdicts on it\n- ok: making progress/);
  });

  it("concern + steer sends the message to the agent; an identical steer isn't sent again; at most 3 per execution", async () => {
    const { h, turn } = withOverseer([v("concern", "steer", "Focus on the tests"), v("concern", "steer", "Focus on the tests"), v("concern", "steer", "two"), v("concern", "steer", "three"), v("concern", "steer", "four")]);
    await until(() => h.state.nodes.a.status === "running");
    for (let i = 0; i < 5; i++) await turn();
    expect(steered).toEqual(["Focus on the tests", "two", "three"]);
    expect(MAX_OVERSEER_STEERS).toBe(3);
    expect(kinds(h)).toEqual(["overseer:steered", "overseer:ignored", "overseer:steered", "overseer:steered", "overseer:ignored"]);
    expect(h.state.status).toBe("running");
  });

  it("stuck / restart stops the node with cause stuck", async () => {
    const { h, turn } = withOverseer([v("concern", "restart", "It keeps rewriting the same file")]);
    await until(() => h.state.nodes.a.status === "running");
    await turn();
    const run = await h.done;
    expect(run.nodes.a.failure).toMatchObject({ cause: "stuck", message: expect.stringMatching(/overseer judged it stuck: It keeps rewriting/) });
    expect(kinds(h)).toEqual(["overseer:stopped"]);
  });

  it("invalid or missing JSON and overseer failures are ignored and logged; the run goes on", async () => {
    const { h, turn } = withOverseer(["I think it's fine", '{"verdict":"ok","node":"nope"}', new Error("claude exited with code 1")]);
    await until(() => h.state.nodes.a.status === "running");
    await turn();
    await turn();
    await turn();
    expect(kinds(h)).toEqual(["overseer:ignored", "overseer:ignored", "overseer:ignored"]);
    expect(h.state.supervision!.map((x) => x.detail)).toEqual([
      expect.stringMatching(/no JSON object/),
      expect.stringMatching(/"node" must be one of a/),
      expect.stringMatching(/overseer failed: claude exited with code 1/),
    ]);
    expect(h.state.status).toBe("running");
  });

  it("off unless the flow turns it on", async () => {
    const prompts: string[] = [];
    const s = supervised(one(), working, { overseer: async ({ prompt }) => (prompts.push(prompt), "{}") });
    await until(() => s.h.state.nodes.a.status === "running");
    s.advance(3600);
    await s.sup.tick();
    await s.sup.drain();
    expect(prompts).toEqual([]);
  });

  it("parseVerdict: accepts JSON in prose / fences, validates every field", () => {
    expect(parseVerdict('Sure:\n```json\n{"verdict":"concern","node":"a","message":"m","action":"steer"}\n```', ["a"])).toEqual({ verdict: "concern", node: "a", message: "m", action: "steer" });
    expect(parseVerdict('{"verdict":"meh","node":"a"}', ["a"])).toEqual({ error: expect.stringMatching(/verdict/) });
    expect(parseVerdict('{"verdict":"ok","node":"a","action":"reboot"}', ["a"])).toEqual({ error: expect.stringMatching(/action/) });
    expect(parseVerdict('{"verdict":"concern","node":"a","action":"steer"}', ["a"])).toEqual({ error: expect.stringMatching(/message/) });
  });
});

describe("supervision events and the driver lock", () => {
  it("watchers get supervisor events after their cursor", async () => {
    const { h, sup, advance } = supervised(one());
    await until(() => h.state.nodes.a.status === "running");
    const first = eventsAfter(h.state);
    advance(11 * MIN);
    await sup.tick();
    const next = eventsAfter(h.state, first.cursor);
    expect(next.events).toContainEqual({ type: "supervisor", kind: "silent", node: "a", detail: expect.stringMatching(/silent for 11 min/), at: expect.any(Number), action: "flagged" });
    expect(eventsAfter(h.state, next.cursor).events).toEqual([]);
  });

  it("touchRunLock refreshes our lock only; a lock not refreshed for staleMs is reclaimed when its owner can't be checked", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sandflow-lock-"));
    try {
      expect(acquireRunLock(dir, "r1").ok).toBe(true);
      expect(touchRunLock(dir, "r1", 12345)).toBe(true);
      expect(readLock(dir, "r1")?.at).toBe(12345);
      // Another machine's lock (its owner can't be checked from here).
      const theirs = { pid: 1, startedAt: OWN_START, host: "elsewhere", at: Date.now() };
      fs.writeFileSync(path.join(dir, "r2.lock"), JSON.stringify(theirs));
      expect(touchRunLock(dir, "r2")).toBe(false);
      expect(acquireRunLock(dir, "r2").ok).toBe(false);
      expect(acquireRunLock(dir, "r2", 100_000).ok).toBe(false);
      fs.writeFileSync(path.join(dir, "r2.lock"), JSON.stringify({ ...theirs, at: Date.now() - 200_000 }));
      expect(acquireRunLock(dir, "r2").ok).toBe(false);
      expect(acquireRunLock(dir, "r2", 100_000).ok).toBe(true);
      releaseRunLock(dir, "r2");
      releaseRunLock(dir, "r1");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("supervisor in the API", () => {
  it("ticks over live runs: watch_run sees its events, and the run's lock heartbeat is refreshed", async () => {
    const { createApi } = await import("../backend/api");
    const { createStorage } = await import("../backend/storage");
    const { createServer } = await import("node:http");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sandflow-sup-api-"));
    let offset = 0;
    const api = createApi(createStorage(dir), { auto: working, ai: working }, {
      exec: async () => ({ code: 1, stdout: "", stderr: "" }),
      pauseGraceMs: 50,
      noContinuePass: true,
      supervisor: { manual: true, now: () => Date.now() + offset },
    });
    const server = createServer((req, res) => api(req, res, () => ((res.statusCode = 404), res.end())));
    server.listen(0);
    await new Promise((r) => server.once("listening", r));
    const base = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}/api`;
    const send = (method: string, url: string, body: unknown) => fetch(`${base}${url}`, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    try {
      const flow: Flow = { id: "f", name: "F", nodes: [n("a", "base/plan", { skills: [] })], edges: [] };
      expect((await send("PUT", "/flows", [flow])).status).toBe(200);
      expect((await send("PUT", "/env", { ANTHROPIC_API_KEY: "k" })).status).toBe(200);
      const text = async (name: string, args: object) =>
        (((await (await send("POST", "/mcp?client=claude-code&label=x", { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } })).json()) as { result: { content: { text: string }[] } }).result.content[0].text);
      const call = async (name: string, args: object) => JSON.parse(await text(name, args));
      const runId = /run id: (\S+)/i.exec(await text("start_run", { flowId: "f", prompt: "Add login" }))![1];
      const lockFile = path.join(dir, "runs", `${runId}.lock`);
      const first = await call("watch_run", { runId, timeoutSeconds: 0 });
      const before = JSON.parse(fs.readFileSync(lockFile, "utf8")).at;
      await new Promise((r) => setTimeout(r, 20));
      offset = 11 * MIN * 1000;
      await api.supervisor.tick();
      expect(JSON.parse(fs.readFileSync(lockFile, "utf8")).at).toBeGreaterThan(before);
      const next = await call("watch_run", { runId, after: first.cursor, timeoutSeconds: 0 });
      expect(next.events).toContainEqual(expect.objectContaining({ type: "supervisor", kind: "silent", node: "a", action: "flagged" }));
    } finally {
      await api.shutdown(2000);
      server.closeAllConnections();
      server.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
