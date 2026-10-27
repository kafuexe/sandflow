// Recovery through the API: a held run waits for you (the continue pass at start leaves it alone), Continue runs the
// held step again, and watchers see what recovery did.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { createApi, type Api } from "../backend/api";
import type { NodeRunner } from "../backend/engine";
import type { TriageRunner } from "../backend/recovery";
import { createStorage } from "../backend/storage";
import { runEvents } from "../shared/runEvents";
import type { Flow, FlowEdge, RunState } from "../shared/types";

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

const n = (id: string) => ({ id, type: "block" as const, position: { x: 0, y: 0 }, data: { blockId: "base/plan", overrides: { skills: [] } } });
const e = (s: string, t: string): FlowEdge => ({ id: `${s}-${t}`, source: s, target: t, sourceHandle: "artifact", targetHandle: "artifact" });
const flow: Flow = { id: "rec", name: "Rec", nodes: [n("a"), n("b")], edges: [e("a", "b")] };

function setup() {
  const dir = tmp("sandflow-recovery-api-");
  const repo = tmp("sandflow-recovery-repo-");
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init"], { cwd: repo });
  const storage = createStorage(dir);
  const data = storage.load();
  storage.saveFlows([...data.flows.filter((f) => !f.pack), flow]);
  storage.saveEnv({ REPO_PATH: repo, ANTHROPIC_API_KEY: "k" });
  storage.saveSettings({ ...data.settings, sandbox: "none", startingPrompt: "Build it" });
  return { storage };
}

async function serve(storage: ReturnType<typeof createStorage>, runner: NodeRunner, triage: TriageRunner) {
  const api: Api = createApi(storage, { auto: runner, ai: runner, triage }, { exec: async () => ({ code: 1, stdout: "", stderr: "" }) });
  const server = createServer((req, res) => api(req, res, () => ((res.statusCode = 404), res.end())));
  servers.push(server);
  server.listen(0);
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  const get = async (id: string) => (await (await fetch(`${base}/runs/${id}`)).json()) as RunState;
  const post = (p: string, body = "{}") => fetch(`${base}${p}`, { method: "POST", headers: { "content-type": "application/json" }, body });
  return { api, base, get, post };
}

describe("recovery through the API", () => {
  it("a held run waits for you across a restart; Continue runs the held step again; watchers see the recovery", async () => {
    const { storage } = setup();
    const blocked: TriageRunner = async () => JSON.stringify({ action: "blocked", reason: "Set the API token" });
    const first = await serve(storage, async (_c, node) => {
      if (node.id === "a") throw new Error("401 Unauthorized");
      return { outputs: { artifact: "b" } };
    }, blocked);
    await first.api.ready;
    const { runId } = (await (await first.post("/runs", '{"flowId":"rec"}')).json()) as { runId: string };
    await until(async () => (await first.get(runId)).phase === "paused");
    const held = await first.get(runId);
    expect(held.hold).toMatchObject({ reason: "blocked", guard: "needs-human", nodeKey: "a", problems: ["Set the API token"] });
    expect(held.nodes.a.failure).toMatchObject({ cause: "error", message: "401 Unauthorized" });
    expect(runEvents(held)).toContainEqual({ type: "recovery", node: "a", cause: "error", decision: "blocked", reason: "Set the API token", guard: "needs-human" });
    expect(fs.existsSync(path.join(storage.dir, "runs", `${runId}.lock`))).toBe(false);

    // Sandflow starts again: the continue pass leaves a held run alone.
    const ran: string[] = [];
    const second = await serve(storage, async (_c, node) => (ran.push(node.id), { outputs: { artifact: `${node.id}-2` } }), blocked);
    await second.api.ready;
    expect((await second.get(runId)).phase).toBe("paused");
    expect(ran).toEqual([]);

    const r = await second.post(`/runs/${runId}/continue`);
    expect(r.status).toBe(200);
    await until(async () => (await second.get(runId)).phase === "done");
    const done = await second.get(runId);
    expect(ran).toEqual(["a", "b"]);
    expect(done.hold).toBeUndefined();
    expect(done.flags?.filter((f) => f.id === "hold-blocked" && !f.dismissed)).toEqual([]);
    expect(done.recovery?.a.history).toHaveLength(1);
  });
});
