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

  it("saves edits of a pack block (keeping its id and pack) and reverts them", async () => {
    const data = (await (await fetch(`${base}/data`)).json()) as AppData;
    const edited = data.blocks.map((b) => (b.id === "base/plan" ? { ...b, name: "My plan", pack: "evil", modified: true } : b));
    expect((await fetch(`${base}/blocks`, json("PUT", edited))).status).toBe(200);
    let again = (await (await fetch(`${base}/data`)).json()) as AppData;
    expect(again.blocks.find((b) => b.id === "base/plan")).toMatchObject({ name: "My plan", pack: "base", modified: true });
    // A pack block the client sends with no `modified` is just the pack's — the edit is dropped.
    const reverted = again.blocks.map((b) => (b.id === "base/plan" ? { ...b, modified: undefined } : b));
    expect((await fetch(`${base}/blocks`, json("PUT", reverted))).status).toBe(200);
    again = (await (await fetch(`${base}/data`)).json()) as AppData;
    expect(again.blocks.find((b) => b.id === "base/plan")).toMatchObject({ name: "Plan" });
    expect(again.blocks.find((b) => b.id === "base/plan")?.modified).toBeUndefined();
  });

  it("round-trips a flow's colour and drops one outside the palette", async () => {
    const data = (await (await fetch(`${base}/data`)).json()) as AppData;
    const own = data.flows.filter((f) => !f.pack);
    const flows = [{ ...own[0], color: "teal" }, { id: "odd", name: "Odd", nodes: [], edges: [], color: "#ff00ff" }];
    expect((await fetch(`${base}/flows`, json("PUT", flows))).status).toBe(200);
    const again = (await (await fetch(`${base}/data`)).json()) as AppData;
    expect(again.flows.find((f) => f.id === own[0].id)?.color).toBe("teal");
    const odd = again.flows.find((f) => f.id === "odd")!;
    expect(odd).toBeDefined();
    expect("color" in odd).toBe(false);
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

describe("concurrent runs", () => {
  it("runs the same flow twice at once, each with its own state, and warns about a shared BRANCH_NAME", async () => {
    // Nodes hold until the test opens the gate, so both runs are provably in progress at the same time.
    const entered = new Set<string>();
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    const seen: Record<string, string[]> = {};
    await start(async (ctx, node) => {
      (seen[ctx.run.id] ??= []).push(node.id);
      entered.add(ctx.run.id);
      await gate;
      if (node.id === "n-manager") return { outputs: {}, route: "n-create-mr" };
      return { outputs: { artifact: `from ${ctx.run.id}`, steer: "s" } };
    });
    await fetch(`${base}/env`, json("PUT", env));
    await fetch(`${base}/settings`, json("PUT", { startingPrompt: "Do it", sandbox: "none", maxSteps: 40 }));

    const r1 = (await (await fetch(`${base}/runs`, json("POST", { flowId: "feature-pipeline", prompt: "first" }))).json()) as { runId: string; warning?: string };
    const r2 = (await (await fetch(`${base}/runs`, json("POST", { flowId: "feature-pipeline", prompt: "second" }))).json()) as { runId: string; warning?: string };
    expect(r1.runId).not.toBe(r2.runId);
    // Same REPO_PATH + explicit BRANCH_NAME: allowed, but the second run is told it shares the branch.
    expect(r1.warning).toBeUndefined();
    expect(r2.warning).toMatch(/branch b/);
    expect(r2.warning).toContain(r1.runId);

    for (let i = 0; i < 200 && entered.size < 2; i++) await new Promise((r) => setTimeout(r, 5));
    expect([...entered].sort()).toEqual([r1.runId, r2.runId].sort());
    const live = (await (await fetch(`${base}/runs`)).json()) as RunSummary[];
    expect(live.filter((r) => r.flowId === "feature-pipeline" && !r.finishedAt).map((r) => r.id).sort()).toEqual([r1.runId, r2.runId].sort());

    open();
    const finish = async (id: string) => {
      for (let i = 0; i < 200; i++) {
        const s = (await (await fetch(`${base}/runs/${id}`)).json()) as RunState;
        if (s.finishedAt) return s;
        await new Promise((r) => setTimeout(r, 10));
      }
      throw new Error(`run ${id} did not finish`);
    };
    const [s1, s2] = await Promise.all([finish(r1.runId), finish(r2.runId)]);
    for (const [s, other, prompt] of [[s1, s2, "first"], [s2, s1, "second"]] as const) {
      expect(s.status).toBe("done");
      expect(s.prompt).toBe(prompt);
      const outputs = Object.values(s.nodes).map((n) => n.outputs?.artifact).filter(Boolean);
      expect(outputs.length).toBeGreaterThan(0);
      expect(outputs.every((a) => a === `from ${s.id}`)).toBe(true);
      expect(JSON.stringify(s.logs.filter((l) => l.level !== "warn"))).not.toContain(other.id);
    }
    expect(s2.logs.some((l) => l.level === "warn" && /branch b/.test(l.msg))).toBe(true);
    expect(s1.logs.some((l) => l.level === "warn" && /branch b/.test(l.msg))).toBe(false);
    expect(seen[s1.id]).toEqual(seen[s2.id]);
  });
});
