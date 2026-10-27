// Durable runs end to end through the API: the continue pass at start, Continue / Repair, Stop on a paused run,
// and quit → start again.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { createApi, type Api } from "../backend/api";
import { startRun, type NodeRunner } from "../backend/engine";
import { OWN_START } from "../backend/journal";
import { createStorage } from "../backend/storage";
import type { Flow, FlowEdge, RunState, RunSummary } from "../shared/types";

const dirs: string[] = [];
const servers: Server[] = [];
afterEach(() => {
  servers.splice(0).forEach((s) => s.close());
  dirs.splice(0).forEach((d) => fs.rmSync(d, { recursive: true, force: true }));
});
const tmp = (p: string) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), p));
  dirs.push(d);
  return d;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean | Promise<boolean>, ms = 4000) {
  for (const end = Date.now() + ms; !(await cond()); await sleep(10)) if (Date.now() > end) throw new Error("timed out");
}
const never = () => new Promise<never>(() => {});

const n = (id: string) => ({ id, type: "block" as const, position: { x: 0, y: 0 }, data: { blockId: "base/plan", overrides: { skills: [] } } });
const e = (s: string, t: string): FlowEdge => ({ id: `${s}-${t}`, source: s, target: t, sourceHandle: "artifact", targetHandle: "artifact" });
const flow: Flow = { id: "durable", name: "Durable", nodes: [n("a"), n("b"), n("c")], edges: [e("a", "b"), e("b", "c")] };

/** A data folder with a git project, the flow, and inputs. */
function setup(o: { continueAutomatically?: boolean } = {}) {
  const dir = tmp("sandflow-durable-api-");
  const repo = tmp("sandflow-durable-repo-");
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init"], { cwd: repo });
  const storage = createStorage(dir);
  const data = storage.load();
  storage.saveFlows([...data.flows.filter((f) => !f.pack), { ...flow, ...(o.continueAutomatically === false ? { continueAutomatically: false } : {}) }]);
  storage.saveEnv({ REPO_PATH: repo, ANTHROPIC_API_KEY: "k" });
  storage.saveSettings({ ...data.settings, sandbox: "none", startingPrompt: "Build it" });
  return { dir, repo, storage };
}

/** Run the flow until b is going, then "crash": its last journal is on disk with a lock from a dead Sandflow. */
async function crashedRun(storage: ReturnType<typeof createStorage>, edit?: (j: RunState) => void): Promise<RunState> {
  const data = storage.load();
  const f = data.flows.find((x) => x.id === "durable")!;
  let last!: RunState;
  const h = startRun({
    flow: f, blocks: data.blocks, flows: data.flows, env: data.env, settings: data.settings,
    runners: { auto: async () => ({ outputs: {} }), ai: async (_c, node) => (node.id === "b" ? never() : { outputs: { artifact: `${node.id}-1` } }) },
    onJournal: (s) => (last = structuredClone(s)),
  });
  await until(() => !!last?.nodes.b?.startedAt);
  const snap = structuredClone(last);
  h.cancel(); // only ends the abandoned run; the snapshot was taken before
  await h.done;
  edit?.(snap);
  storage.saveRun(snap);
  fs.writeFileSync(path.join(storage.dir, "runs", `${snap.id}.lock`), JSON.stringify({ pid: 2 ** 22 + 4321, startedAt: 1, host: os.hostname(), at: 1 }));
  return snap;
}

async function serve(storage: ReturnType<typeof createStorage>, runner: NodeRunner, o: { pauseGraceMs?: number } = {}) {
  const api: Api = createApi(storage, { auto: runner, ai: runner }, { exec: async () => ({ code: 1, stdout: "", stderr: "" }), ...o });
  const server = createServer((req, res) => api(req, res, () => ((res.statusCode = 404), res.end())));
  servers.push(server);
  server.listen(0);
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  const get = async (id: string) => (await (await fetch(`${base}/runs/${id}`)).json()) as RunState;
  const post = (p: string) => fetch(`${base}${p}`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  return { api, base, get, post };
}

const recorder = () => {
  const ran: string[] = [];
  const runner: NodeRunner = async (_c, node) => (ran.push(node.id), { outputs: { artifact: `${node.id}-2` } });
  return { ran, runner };
};

describe("durable runs: the continue pass at start", () => {
  it("a crashed run is marked interrupted, checked, and continued automatically under the same id", async () => {
    const { storage } = setup();
    const crashed = await crashedRun(storage);
    const { ran, runner } = recorder();
    const { api, get } = await serve(storage, runner);
    await api.ready;
    await until(async () => (await get(crashed.id)).phase === "done");
    const final = await get(crashed.id);
    expect(ran).toEqual(["b", "c"]);
    expect(final).toMatchObject({ id: crashed.id, status: "done", attempt: 2 });
    expect(final.transitions?.map((t) => t.phase)).toEqual(["running", "interrupted", "continuing", "running", "done"]);
    expect(final.nodes.a.executions).toBe(1);
    expect(fs.existsSync(path.join(storage.dir, "runs", `${crashed.id}.lock`))).toBe(false);
  });

  it("a flow edited since: paused with exactly what failed, Continue refuses, Repair adopts it and the run goes on", async () => {
    const { storage } = setup();
    const crashed = await crashedRun(storage, (j) => (j.fingerprints!.flow = "an older flow"));
    const { ran, runner } = recorder();
    const { api, get, post } = await serve(storage, runner);
    await api.ready;
    const held = await get(crashed.id);
    expect(held).toMatchObject({ phase: "interrupted", status: "paused", pauseReason: "crash", hold: { reason: "validation", repairable: true } });
    expect(held.hold?.problems).toEqual(["The flow, or a block or subflow it uses, changed since the run started"]);
    expect(held.flags?.some((f) => f.id === "hold-validation" && /changed since the run started/.test(f.message))).toBe(true);
    expect(ran).toEqual([]);

    const refused = await post(`/runs/${crashed.id}/continue`);
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ problems: [expect.stringMatching(/flow/)], repairable: true });

    const repaired = await post(`/runs/${crashed.id}/repair`);
    expect(repaired.status).toBe(200);
    expect(await repaired.json()).toMatchObject({ runId: crashed.id, changes: ["adopted the flow as it is now"] });
    await until(async () => (await get(crashed.id)).phase === "done");
    const final = await get(crashed.id);
    expect(ran).toEqual(["b", "c"]);
    expect(final.repairs).toEqual([{ at: expect.any(Number), changes: ["adopted the flow as it is now"] }]);
    expect(final.hold).toBeUndefined();
  });

  it("a deleted branch the run worked on is a named problem", async () => {
    const { storage } = setup();
    const crashed = await crashedRun(storage, (j) => (j.branch = "feat/gone"));
    const { api, get } = await serve(storage, recorder().runner);
    await api.ready;
    expect((await get(crashed.id)).hold?.problems.join()).toMatch(/Branch feat\/gone no longer exists/);
  });

  it("with the flow's switch off the run waits for Continue", async () => {
    const { storage } = setup({ continueAutomatically: false });
    const crashed = await crashedRun(storage);
    const { ran, runner } = recorder();
    const { api, get, post } = await serve(storage, runner);
    await api.ready;
    expect(await get(crashed.id)).toMatchObject({ phase: "interrupted", hold: { reason: "manual" } });
    expect(ran).toEqual([]);
    expect((await post(`/runs/${crashed.id}/continue`)).status).toBe(200);
    await until(async () => (await get(crashed.id)).phase === "done");
    expect(ran).toEqual(["b", "c"]);
  });

  it("a run continued maxContinues times without a step finishing isn't continued automatically again", async () => {
    const { storage } = setup();
    const crashed = await crashedRun(storage, (j) => (j.stalls = 5));
    const { ran, runner } = recorder();
    const { api, get } = await serve(storage, runner);
    await api.ready;
    expect(await get(crashed.id)).toMatchObject({ phase: "interrupted", hold: { reason: "loop" } });
    expect(ran).toEqual([]);
  });

  it("a run another live Sandflow drives is left alone", async () => {
    const { storage } = setup();
    const crashed = await crashedRun(storage);
    fs.writeFileSync(path.join(storage.dir, "runs", `${crashed.id}.lock`), JSON.stringify({ pid: process.pid, startedAt: OWN_START, host: os.hostname(), at: 1 }));
    const { ran, runner } = recorder();
    const { api, get, post } = await serve(storage, runner);
    await api.ready;
    expect((await get(crashed.id)).phase).toBe("running");
    expect(ran).toEqual([]);
    const r = await post(`/runs/${crashed.id}/continue`);
    expect(r.status).toBe(409);
    expect(((await r.json()) as { error: string }).error).toMatch(/Another Sandflow/);
  });

  it("a corrupt journal is listed with its path, never continued, and kept byte for byte", async () => {
    const { storage } = setup();
    const id = "2026-10-27T10-00-00-000Z-c0ffee00";
    const file = path.join(storage.dir, "runs", `${id}.json`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{"schemaVersion":1,"phase":"running"');
    const { api, base, post } = await serve(storage, recorder().runner);
    await api.ready;
    const list = (await (await fetch(`${base}/runs`)).json()) as RunSummary[];
    expect(list.find((r) => r.id === id)?.hold?.problems[0]).toContain(file);
    const r = await post(`/runs/${id}/continue`);
    expect(r.status).toBe(409);
    expect(((await r.json()) as { error: string }).error).toMatch(/corrupt.*preserved/);
    expect(fs.readFileSync(file, "utf8")).toBe('{"schemaVersion":1,"phase":"running"');
  });

  it("Stop on a paused run cancels it for good", async () => {
    const { storage } = setup({ continueAutomatically: false });
    const crashed = await crashedRun(storage);
    const { api, get, post } = await serve(storage, recorder().runner);
    await api.ready;
    expect((await post(`/runs/${crashed.id}/cancel`)).status).toBe(200);
    expect(await get(crashed.id)).toMatchObject({ phase: "cancelled", status: "cancelled", finishedAt: expect.any(Number) });
    expect((await post(`/runs/${crashed.id}/continue`)).status).toBe(409);
  });
});

describe("durable runs: quit, then start again", () => {
  it("shutdown pauses the run (not cancels); the next start continues it where it was", async () => {
    const { storage } = setup();
    const first = await serve(storage, async (ctx, node) => {
      if (node.id === "b") await new Promise((_, reject) => ctx.abort.signal.addEventListener("abort", () => reject(new Error("killed"))));
      return { outputs: { artifact: `${node.id}-1` } };
    }, { pauseGraceMs: 20 });
    await first.api.ready;
    const { runId } = (await (await fetch(`${first.base}/runs`, { method: "POST", headers: { "content-type": "application/json" }, body: '{"flowId":"durable"}' })).json()) as { runId: string };
    await until(async () => (await first.get(runId)).nodes.b?.status === "running");
    await first.api.shutdown(5000, "update");
    const paused = storage.loadJournal(runId).run!;
    expect(paused).toMatchObject({ phase: "paused", status: "paused", pauseReason: "update" });
    expect(paused.nodes.b.interrupted).toBe("mutation");
    expect(fs.existsSync(path.join(storage.dir, "runs", `${runId}.lock`))).toBe(false);

    const { ran, runner } = recorder();
    const second = await serve(storage, runner);
    await second.api.ready;
    await until(async () => (await second.get(runId)).phase === "done");
    expect(ran).toEqual(["b", "c"]);
    expect((await second.get(runId)).transitions?.map((t) => t.phase)).toEqual(["running", "pausing", "paused", "continuing", "running", "done"]);
  });
});
