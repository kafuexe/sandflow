import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApi } from "../backend/api";
import { createStorage } from "../backend/storage";
import type { NodeRunner } from "../backend/engine";
import type { AppData, RunState, RunSummary } from "../shared/types";

let dir: string;
const execCalls: string[][] = [];
const fakeExec = async (cmd: string, args: string[]) => {
  execCalls.push([cmd, ...args]);
  if (args[0] === "image") return { code: 1, stdout: "", stderr: "No such image" };
  if (args[0] === "load") return { code: 0, stdout: "Loaded image: sandflow-agent:9.9.9\n", stderr: "" };
  return { code: 0, stdout: "27", stderr: "" };
};
let server: Server;
let base: string;

async function start(runner: NodeRunner) {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "sandflow-api-"));
  const api = createApi(createStorage(dir), { auto: runner, ai: runner }, { exec: fakeExec });
  server = createServer((req, res) => api(req, res, () => ((res.statusCode = 404), res.end())));
  server.listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
}
const json = (method: string, body?: unknown) => ({
  method,
  headers: { "content-type": "application/json" },
  body: body === undefined ? undefined : JSON.stringify(body),
});
const env = { REPO_PATH: "/r", ANTHROPIC_API_KEY: "k", BRANCH_NAME: "b", BASE_BRANCH: "main", MR_PROVIDER: "github" };

afterEach(() => {
  server?.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("api", () => {
  beforeEach(async () => {
    await start(async (_c, node) =>
      node.id === "n-manager" ? { outputs: {}, route: "n-create-mr" } : { outputs: { artifact: "a", steer: "s" } },
    );
  });

  it("serves data and persists updates", async () => {
    const data = (await (await fetch(`${base}/data`)).json()) as AppData;
    expect(data.flows[0].id).toBe("feature-pipeline");
    expect((await fetch(`${base}/env`, json("PUT", { "BAD NAME": "x" }))).status).toBe(400);
    expect((await fetch(`${base}/env`, json("PUT", env))).status).toBe(200);
    const bad = [...data.blocks, { id: "x", name: "X", isTemplate: false, extends: "plan", config: {} }];
    expect((await fetch(`${base}/blocks`, json("PUT", bad))).status).toBe(400);
    const again = (await (await fetch(`${base}/data`)).json()) as AppData;
    expect(again.env).toEqual(env);
  });

  it("rejects a run with missing inputs, then runs to completion", async () => {
    const r1 = await fetch(`${base}/runs`, json("POST", { flowId: "feature-pipeline" }));
    expect(r1.status).toBe(400);
    expect(((await r1.json()) as { missing: string[] }).missing).toContain("Starting prompt");

    await fetch(`${base}/env`, json("PUT", env));
    await fetch(`${base}/settings`, json("PUT", { startingPrompt: "Do it", sandbox: "none", maxSteps: 40 }));
    const r2 = await fetch(`${base}/runs`, json("POST", { flowId: "feature-pipeline" }));
    expect(r2.status).toBe(200);
    const { runId } = (await r2.json()) as { runId: string };

    let state: RunState | undefined;
    for (let i = 0; i < 50; i++) {
      state = (await (await fetch(`${base}/runs/${runId}`)).json()) as RunState;
      if (state.finishedAt) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(state?.status).toBe("done");
    expect(fs.existsSync(path.join(dir, "runs", `${runId}.json`))).toBe(true);
    expect((await fetch(`${base}/runs/nope`)).status).toBe(404);
  });

  it("uploads and lists skills", async () => {
    const up = await fetch(`${base}/skills`, json("POST", { name: "mine", files: [{ path: "SKILL.md", content: "---\nname: mine\n---" }] }));
    expect(up.status).toBe(200);
    expect(await up.json()).toMatchObject({ name: "mine", file: { store: "user", dir: "mine" } });
    const bad = await fetch(`${base}/skills`, json("POST", { name: "x", files: [{ path: "../SKILL.md", content: "" }] }));
    expect(bad.status).toBe(400);
    const list = (await (await fetch(`${base}/skills`)).json()) as { name: string }[];
    expect(list.map((s) => s.name)).toEqual(expect.arrayContaining(["mine", "tdd", "writing-plans"]));
  });

  it("validates settings and exposes sandbox image status + import", async () => {
    const bad = await fetch(`${base}/settings`, json("PUT", { startingPrompt: "", sandbox: "docker", maxSteps: 40, sandboxImage: "x; rm -rf /" }));
    expect(bad.status).toBe(400);
    await fetch(`${base}/settings`, json("PUT", { startingPrompt: "", sandbox: "docker", maxSteps: 40, sandboxImage: "acme/agent:1" }));
    const st = await (await fetch(`${base}/sandbox/status`)).json();
    expect(st).toMatchObject({ runtime: "docker", runtimeAvailable: true, image: "acme/agent:1", imagePresent: false });
    const file = path.join(dir, "bundle.tar.gz");
    fs.writeFileSync(file, "x");
    const imp = await fetch(`${base}/sandbox/import`, json("POST", { path: file }));
    expect(await imp.json()).toEqual({ output: "Loaded image: sandflow-agent:9.9.9" });
    expect(execCalls.at(-1)).toEqual(["docker", "load", "-i", file]);
    const missing = await fetch(`${base}/sandbox/import`, json("POST", { path: path.join(dir, "nope.tar") }));
    expect(missing.status).toBe(400);
  });

  it("rejects non-JSON writes (blocks cross-site simple requests)", async () => {
    await fetch(`${base}/env`, json("PUT", env));
    await fetch(`${base}/settings`, json("PUT", { startingPrompt: "Do it", sandbox: "none", maxSteps: 40 }));
    const res = await fetch(`${base}/runs`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: JSON.stringify({ flowId: "feature-pipeline" }),
    });
    expect(res.status).toBe(415);
    expect((await fetch(`${base}/runs/x/cancel`, { method: "POST" })).status).toBe(415);
  });

  it("streams run state over SSE", async () => {
    await fetch(`${base}/env`, json("PUT", env));
    await fetch(`${base}/settings`, json("PUT", { startingPrompt: "Do it", sandbox: "none", maxSteps: 40 }));
    const { runId } = (await (await fetch(`${base}/runs`, json("POST", { flowId: "feature-pipeline" }))).json()) as { runId: string };
    const res = await fetch(`${base}/runs/${runId}/events`);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const reader = res.body!.getReader();
    const { value } = await reader.read();
    expect(new TextDecoder().decode(value)).toContain("event: state");
    await reader.cancel();
  });

  it("starts a run with its own prompt and lists it with the prompt", async () => {
    await fetch(`${base}/env`, json("PUT", env));
    await fetch(`${base}/settings`, json("PUT", { startingPrompt: "", sandbox: "none", maxSteps: 40 }));
    const blank = await fetch(`${base}/runs`, json("POST", { flowId: "feature-pipeline", prompt: "   " }));
    expect(((await blank.json()) as { missing: string[] }).missing).toContain("Starting prompt");
    const r = await fetch(`${base}/runs`, json("POST", { flowId: "feature-pipeline", prompt: "Add dark mode" }));
    expect(r.status).toBe(200);
    const { runId } = (await r.json()) as { runId: string };
    const list = (await (await fetch(`${base}/runs`)).json()) as RunSummary[];
    expect(list.find((x) => x.id === runId)).toMatchObject({ prompt: "Add dark mode", flowName: expect.any(String) });
  });

  it("reports a saved run that never finished as interrupted", async () => {
    const id = "2026-01-01T00-00-00-000Z-deadbeef";
    const stale: RunState = {
      id, flowId: "feature-pipeline", flowName: "Feature pipeline", status: "waiting", startedAt: 1, nodes: {}, logs: [],
      pendingQuestion: { nodeId: "n-plan", question: "?" },
    };
    fs.mkdirSync(path.join(dir, "runs"), { recursive: true });
    fs.writeFileSync(path.join(dir, "runs", `${id}.json`), JSON.stringify(stale));
    const got = (await (await fetch(`${base}/runs/${id}`)).json()) as RunState;
    expect(got).toMatchObject({ status: "cancelled", error: expect.stringMatching(/interrupted/i) });
    expect(got.finishedAt).toBeTypeOf("number");
    expect(got.pendingQuestion).toBeUndefined();
    const list = (await (await fetch(`${base}/runs`)).json()) as RunSummary[];
    expect(list.find((x) => x.id === id)).toMatchObject({ status: "cancelled" });
  });
});
