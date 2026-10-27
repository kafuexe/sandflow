// MCP run tools (Claude Code starts and watches runs): start_run, watch_run, answer_question, stop_run, get_run, list_runs.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { createApi, type Api } from "../backend/api";
import type { NodeRunner } from "../backend/engine";
import { createStorage } from "../backend/storage";
import type { Flow, RunState } from "../shared/types";

let dir: string;
let server: Server;
let api: Api;
let base: string;

/** Steps wait for the test to release them (by node id) unless `auto` says otherwise. */
const gates = new Map<string, () => void>();
const runner: NodeRunner = async (ctx, node) => {
  if (node.id === "ask") return { outputs: { artifact: `answer was ${await ctx.ask(node.id, "Which DB?")}` } };
  await new Promise<void>((resolve, reject) => {
    gates.set(node.id, resolve);
    ctx.abort.signal.addEventListener("abort", () => reject(new Error("Run cancelled")), { once: true });
  });
  return { outputs: { artifact: `${node.id} done` } };
};

const flow = (id: string, ids: string[]): Flow => ({
  id,
  name: id,
  nodes: ids.map((n, i) => ({ id: n, type: "block", position: { x: i * 300, y: 0 }, data: { blockId: "base/plan", overrides: { skills: [] } } })),
  edges: ids.slice(1).map((n, i) => ({ id: `e${i}`, source: ids[i], sourceHandle: "artifact", target: n, targetHandle: "artifact" })),
});

const post = (url: string, body: unknown) => fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const put = (url: string, body: unknown) => fetch(url, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

async function start(storageDir?: string) {
  dir = storageDir ?? fs.mkdtempSync(path.join(os.tmpdir(), "sandflow-runtools-"));
  // A short pause grace: stop() (quit) pauses running steps within its own wait.
  api = createApi(createStorage(dir), { auto: runner, ai: runner }, { exec: async () => ({ code: 1, stdout: "", stderr: "" }), pauseGraceMs: 100 });
  server = createServer((req, res) => api(req, res, () => ((res.statusCode = 404), res.end())));
  server.listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
}

async function stop() {
  await api.shutdown(2000);
  server.closeAllConnections();
  server.close();
}

afterEach(async () => {
  gates.clear();
  if (server?.listening) await stop();
  fs.rmSync(dir, { recursive: true, force: true });
});

let rpcId = 0;
async function call(name: string, args: Record<string, unknown>, query = "?client=claude-code&label=webapp") {
  const res = await post(`${base}/mcp${query}`, { jsonrpc: "2.0", id: ++rpcId, method: "tools/call", params: { name, arguments: args } });
  const r = ((await res.json()) as { result: { content: { text: string }[]; isError?: boolean } }).result;
  return { text: r.content[0].text, isError: !!r.isError };
}
const watch = async (args: Record<string, unknown>) => JSON.parse((await call("watch_run", args)).text);

async function until(cond: () => boolean, ms = 3000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 10));
  }
}

async function setup() {
  await start();
  const own = [flow("two", ["a", "b"]), flow("asks", ["ask"])];
  expect((await put(`${base}/flows`, own)).status).toBe(200);
  expect((await put(`${base}/env`, { ANTHROPIC_API_KEY: "k" })).status).toBe(200);
}

describe("MCP run tools", () => {
  it("are listed for unscoped sessions only", async () => {
    await start();
    const list = async (q = "") =>
      ((await (await post(`${base}/mcp${q}`, { jsonrpc: "2.0", id: 1, method: "tools/list" })).json()) as any).result.tools.map((t: { name: string }) => t.name);
    expect(await list()).toEqual(expect.arrayContaining(["start_run", "watch_run", "answer_question", "steer_run", "stop_run", "get_run", "list_runs"]));
    expect(await list("?flow=feature-pipeline")).not.toContain("start_run");
  });

  it("start_run refuses a flow with missing inputs, like POST /runs", async () => {
    await setup();
    const r = await call("start_run", { flowId: "two" });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/Missing inputs: .*Starting prompt/);
    expect((await call("start_run", { flowId: "nope", prompt: "x" })).text).toMatch(/Flow "nope" not found/);
    expect((await call("start_run", { flowId: "two", prompt: "x", env: { "BAD NAME": "1" } })).isError).toBe(true);
  });

  it("starts a run recorded as started by Claude Code and watches it to the end with a cursor", async () => {
    await setup();
    const started = await call("start_run", { flowId: "two", prompt: "Add login" });
    expect(started.isError).toBe(false);
    const runId = /run id: (\S+)/i.exec(started.text)![1];
    const run = (await (await fetch(`${base}/runs/${runId}`)).json()) as RunState;
    expect(run.startedBy).toEqual({ kind: "claude-code", label: "Claude Code (webapp)" });
    expect(run.prompt).toBe("Add login");

    // Long-poll: nothing yet, so it waits until node a finishes.
    await until(() => gates.has("a"));
    const pending = watch({ runId });
    await new Promise((r) => setTimeout(r, 50));
    gates.get("a")!();
    const first = await pending;
    expect(first.events).toEqual([{ type: "node", node: "a", status: "done", execution: 1 }]);
    expect(first.ended).toBe(false);

    await until(() => gates.has("b"));
    gates.get("b")!();
    const second = await watch({ runId, after: first.cursor });
    const rest = second.ended ? second : await watch({ runId, after: second.cursor });
    expect([...second.events, ...(rest === second ? [] : rest.events)]).toEqual([
      { type: "node", node: "b", status: "done", execution: 1 },
      { type: "end", status: "done" },
    ]);
    expect(rest.ended).toBe(true);
    expect(rest.status).toBe("done");

    // A later watcher from the start still sees everything (events come from the saved run).
    const replay = await watch({ runId });
    expect(replay.events.map((e: { type: string }) => e.type)).toEqual(["node", "node", "end"]);
    // Nothing new after the end: returns at once.
    expect((await watch({ runId, after: rest.cursor })).events).toEqual([]);

    const got = await call("get_run", { runId });
    expect(got.text).toMatch(/Status: done/);
    expect(got.text).toMatch(/Started by: Claude Code \(webapp\)/);
    expect(got.text).toMatch(/- b: done.*\n.*b done/);
    const list = await call("list_runs", { flowId: "two" });
    expect(list.text).toContain(runId);
    expect((await call("list_runs", { flowId: "asks" })).text).not.toContain(runId);
  });

  it("reports a pending question and takes the answer", async () => {
    await setup();
    const runId = /run id: (\S+)/i.exec((await call("start_run", { flowId: "asks", prompt: "go" })).text)![1];
    const asked = await watch({ runId });
    expect(asked.events).toEqual([{ type: "question", node: "ask", question: "Which DB?", pending: true }]);
    expect(asked.status).toBe("waiting");
    expect((await call("answer_question", { runId, answer: "postgres" })).isError).toBe(false);
    expect((await call("answer_question", { runId, answer: "again" })).text).toMatch(/No pending question/);
    const end = await watch({ runId, after: asked.cursor });
    expect(end.events.at(-1)).toEqual({ type: "end", status: "done" });
    expect((await call("get_run", { runId })).text).toContain("answer was postgres");
  });

  it("times out a watch with nothing new, stops a run, and refuses to steer a missing step", async () => {
    await setup();
    const runId = /run id: (\S+)/i.exec((await call("start_run", { flowId: "two", prompt: "go" })).text)![1];
    await until(() => gates.has("a"));
    const quiet = await watch({ runId, timeoutSeconds: 0.2 });
    expect(quiet).toMatchObject({ events: [], ended: false, timedOut: true });
    expect((await call("steer_run", { runId, nodeId: "zzz", message: "hi" })).text).toMatch(/No step "zzz"/);
    expect((await call("stop_run", { runId })).isError).toBe(false);
    const end = await watch({ runId, after: quiet.cursor });
    expect(end.ended).toBe(true);
    expect(end.events.at(-1)).toMatchObject({ type: "end", status: "cancelled" });
  });

  it("a run started over plain MCP (no Claude Code bridge) is recorded as such", async () => {
    await setup();
    const runId = /run id: (\S+)/i.exec((await call("start_run", { flowId: "two", prompt: "go" }, "")).text)![1];
    const run = (await (await fetch(`${base}/runs/${runId}`)).json()) as RunState;
    expect(run.startedBy).toEqual({ kind: "mcp", label: "MCP client" });
    await call("stop_run", { runId }, "");
  });

  it("events survive a restart: a watcher after Sandflow restarts sees the run paused, not ended", async () => {
    await setup();
    const runId = /run id: (\S+)/i.exec((await call("start_run", { flowId: "two", prompt: "go" })).text)![1];
    await until(() => gates.has("a"));
    gates.get("a")!();
    const seen = await watch({ runId });
    expect(seen.events).toHaveLength(1);
    const kept = dir;
    // Quitting pauses the run (it would continue on start; this one has no project, so it waits for Continue).
    await stop();
    dir = kept;
    await start(kept);
    await api.ready;
    const after = await watch({ runId, after: seen.cursor, timeoutSeconds: 0.2 });    expect(after.ended).toBe(false);
    expect(after.events).toContainEqual(expect.objectContaining({ type: "phase", phase: "paused" }));
  });
});
