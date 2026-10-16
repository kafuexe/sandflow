import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { createApi } from "../backend/api";
import { startRun, type NodeRunner } from "../backend/engine";
import { parseScriptOutput } from "../backend/runners/script";
import { createStorage, dismissFlag, settleInterrupted, summarize } from "../backend/storage";
import { BUILTIN_BLOCKS, DEFAULT_FLOW } from "../shared/library";
import type { RunFlag, RunState, Settings } from "../shared/types";

const settings: Settings = { startingPrompt: "Add login", sandbox: "none", maxSteps: 40 };
const env = { REPO_PATH: "/r", ANTHROPIC_API_KEY: "k", BRANCH_NAME: "feat/x", BASE_BRANCH: "main", MR_PROVIDER: "github" };

function go(runner: NodeRunner) {
  const raised: RunFlag[] = [];
  const h = startRun({
    flow: DEFAULT_FLOW, blocks: BUILTIN_BLOCKS, env, settings, runners: { auto: runner, ai: runner },
    onFlag: (_r, f) => raised.push(f),
  });
  return { h, raised };
}

const flag = (over: Partial<RunFlag> = {}): RunFlag => ({ id: "f1", severity: "warning", message: "m", at: 1, ...over });
const stale = (over: Partial<RunState> = {}): RunState => ({
  id: "2026-01-01T00-00-00-000Z-deadbeef", flowId: "f", flowName: "F", status: "running", startedAt: 1, nodes: {}, logs: [], ...over,
});

describe("run flags: engine", () => {
  it("ctx.flag appends a flag to the run and reports it", async () => {
    let raisedOnce = false;
    const { h, raised } = go(async (ctx, node) => {
      if (!raisedOnce) {
        raisedOnce = true;
        ctx.flag("warning", "tests skipped", { nodeKey: node.id, details: "no runner" });
      }
      return { outputs: { artifact: "a" }, route: "n-create-mr" };
    });
    const final = await h.done;
    expect(final.flags).toEqual([expect.objectContaining({ severity: "warning", message: "tests skipped", details: "no runner", nodeKey: expect.any(String) })]);
    expect(raised).toHaveLength(1);
    expect(raised[0].id).toBe(final.flags![0].id);
  });

  it("a failed top-level run gets one error flag with the run's error", async () => {
    const { h, raised } = go(async () => {
      throw new Error("boom");
    });
    const final = await h.done;
    expect(final.status).toBe("failed");
    expect(final.flags).toHaveLength(1);
    expect(final.flags![0]).toMatchObject({ severity: "error", message: expect.stringContaining("boom") });
    expect(raised).toHaveLength(1);
  });

  it("a finished run without problems has no flags", async () => {
    const final = await go(async () => ({ outputs: { artifact: "a" }, route: "n-create-mr" })).h.done;
    expect(final.flags ?? []).toEqual([]);
  });
});

describe("run flags: scripts", () => {
  it("a script raises flags by listing them in its output", () => {
    const out = JSON.stringify({ artifact: "ok", flags: [{ severity: "error", message: "secrets in diff", details: "AWS key in .env" }, { message: "tests skipped" }, { severity: "warning" }] });
    expect(parseScriptOutput(out, "").flags).toEqual([
      { severity: "error", message: "secrets in diff", details: "AWS key in .env" },
      { severity: "warning", message: "tests skipped" },
    ]);
  });

  it("flags a node hands back are raised on the run, from that node", async () => {
    const { h } = go(async (_c, node) => ({ outputs: { artifact: "a" }, route: "n-create-mr", ...(node.id === "n-plan" ? { flags: [{ severity: "warning" as const, message: "tests skipped" }] } : {}) }));
    const final = await h.done;
    expect(final.flags).toEqual([expect.objectContaining({ message: "tests skipped", nodeKey: "n-plan" })]);
  });
});

describe("run flags: storage", () => {
  it("summaries count only undismissed flags", () => {
    const s = summarize(stale({ finishedAt: 2, status: "done", flags: [flag(), flag({ id: "f2", severity: "error" }), flag({ id: "f3", dismissed: true })] }));
    expect(s.flags).toEqual({ warning: 1, error: 1 });
    expect(summarize(stale({ finishedAt: 2 })).flags).toBeUndefined();
  });

  it("an interrupted run gets an interrupted error flag once", () => {
    const settled = settleInterrupted(stale());
    expect(settled.flags).toEqual([expect.objectContaining({ id: "interrupted", severity: "error" })]);
    const again = settleInterrupted({ ...stale(), flags: [flag({ id: "interrupted", severity: "error", dismissed: true })] });
    expect(again.flags).toEqual([expect.objectContaining({ id: "interrupted", dismissed: true })]);
  });

  it("an interrupted stack task isn't flagged on its own (its top-level run is)", () => {
    const settled = settleInterrupted(stale({ parent: { runId: "p", nodeKey: "s" } }));
    expect(settled.status).toBe("cancelled");
    expect(settled.flags ?? []).toEqual([]);
  });

  it("dismissFlag marks one flag dismissed", () => {
    const r = stale({ flags: [flag(), flag({ id: "f2" })] });
    expect(dismissFlag(r, "f2")).toBe(true);
    expect(dismissFlag(r, "nope")).toBe(false);
    expect(r.flags!.map((f) => !!f.dismissed)).toEqual([false, true]);
  });
});

describe("run flags: api", () => {
  let dir: string;
  let server: Server;
  afterEach(() => {
    server?.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("dismissing an interrupted run's flag persists across reads", async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "sandflow-flags-"));
    const runner: NodeRunner = async () => ({ outputs: {} });
    const api = createApi(createStorage(dir), { auto: runner, ai: runner });
    server = createServer((req, res) => api(req, res, () => ((res.statusCode = 404), res.end())));
    server.listen(0);
    await new Promise((r) => server.once("listening", r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
    const r = stale();
    fs.mkdirSync(path.join(dir, "runs"), { recursive: true });
    fs.writeFileSync(path.join(dir, "runs", `${r.id}.json`), JSON.stringify(r));

    const post = await fetch(`${base}/runs/${r.id}/flags/interrupted/dismiss`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(post.status).toBe(200);
    const got = (await (await fetch(`${base}/runs/${r.id}`)).json()) as RunState;
    expect(got.flags).toEqual([expect.objectContaining({ id: "interrupted", dismissed: true })]);
    const missing = await fetch(`${base}/runs/${r.id}/flags/nope/dismiss`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(missing.status).toBe(404);
  });
});
