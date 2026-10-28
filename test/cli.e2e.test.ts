// The CLI against a real Sandflow server in this process (the daemon's own startDaemon), on a temp SANDFLOW_HOME.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import type { Ctx } from "../backend/cli/client";
import { startDaemon, type Daemon } from "../backend/cli/daemon";
import { homePaths, readDaemonInfo } from "../backend/cli/home";
import { main, setScheduleOs } from "../backend/cli/main";
import { mcpProxy } from "../backend/cli/mcp";
import { listRecords, saveRecord, type OsDeps } from "../backend/cli/schedule";
import type { NodeRunner } from "../backend/engine";
import { readHistory } from "../backend/history";
import { startAppServer } from "../backend/server";

const dirs: string[] = [];
let daemon: Daemon | undefined;
afterEach(async () => {
  await daemon?.stop();
  daemon = undefined;
  dirs.splice(0).forEach((d) => fs.rmSync(d, { recursive: true, force: true }));
});

const idle: NodeRunner = async () => ({ outputs: { artifact: "ok" } });

async function setup() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "sandflow-e2e-"));
  dirs.push(home);
  const paths = homePaths(home);
  daemon = await startDaemon(paths, { runners: { auto: idle, ai: idle, script: idle }, fetchBasePack: false, pauseGraceMs: 100 });
  const out: string[] = [];
  const err: string[] = [];
  const ctx: Ctx = {
    paths,
    out: (s) => out.push(s),
    err: (s) => err.push(s),
    env: { SANDFLOW_HOME: home },
    isTTY: false,
    stdin: new PassThrough(),
    fetch,
    spawnDaemon: () => {
      throw new Error("the daemon should already be running");
    },
    openBrowser: (u) => out.push(`opened ${u}`),
    platform: process.platform,
  };
  const take = () => {
    const s = out.join("\n");
    out.length = 0;
    return s;
  };
  return { home, paths, ctx, out, err, take };
}

describe("sandflow CLI against a live server", () => {
  it("flows, run (followed and detached), runs, status, logs, resume and --ui", async () => {
    const { paths, ctx, take, err } = await setup();
    expect(readDaemonInfo(paths.daemon)).toMatchObject({ url: daemon!.info.url, pid: process.pid });

    expect(await main(["flows", "--json"], ctx)).toBe(0);
    const flows = JSON.parse(take());
    const report = flows.find((f: { id: string }) => f.id === "base/daily-repo-report");
    expect(report).toMatchObject({ name: "Daily repo report", inputs: [{ name: "REPO_PATH", optional: false, set: false }], prompt: "unused" });
    expect(await main(["flows"], ctx)).toBe(0);
    expect(take()).toMatch(/base\/daily-repo-report\s+Daily repo report\s+REPO_PATH/);

    // Missing input → usage error naming it.
    expect(await main(["run", "Daily repo report"], ctx)).toBe(2);
    expect(err.join("\n")).toMatch(/needs: REPO_PATH — pass --env REPO_PATH=…/);
    expect(await main(["run", "no-such-flow"], ctx)).toBe(2);

    // Followed to the end (by name, --repo sets REPO_PATH for this run only).
    expect(await main(["run", "Daily repo report", "--repo", process.cwd(), "--json"], ctx)).toBe(0);
    const done = JSON.parse(take());
    expect(done).toMatchObject({ flowId: "base/daily-repo-report", status: "done" });
    expect(err.join("\n")).toMatch(/✓ Shell command/);

    expect(await main(["run", "base/daily-repo-report", "--env", `REPO_PATH=${process.cwd()}`, "--detach", "--json"], ctx)).toBe(0);
    const detached = JSON.parse(take());
    expect(detached).toMatchObject({ runId: expect.any(String), status: "running" });

    // Both are in history.jsonl, marked as the CLI's.
    await new Promise((r) => setTimeout(r, 300));
    const hist = readHistory(paths.history);
    expect(hist.map((h) => h.runId)).toEqual(expect.arrayContaining([done.runId, detached.runId]));
    expect(hist.find((h) => h.runId === done.runId)).toMatchObject({ status: "done", source: "cli", repo: process.cwd(), endedAt: expect.any(Number) });
    expect(await main(["runs", "--json"], ctx)).toBe(0);
    expect(JSON.parse(take()).length).toBe(2);
    expect(await main(["runs"], ctx)).toBe(0);
    expect(take()).toMatch(/RUN\s+STATUS\s+STARTED\s+FLOW/);

    expect(await main(["status", done.runId, "--json"], ctx)).toBe(0);
    expect(JSON.parse(take())).toMatchObject({ runId: done.runId, status: "done", nodes: { sh: { status: "done" } } });
    expect(await main(["status", done.runId], ctx)).toBe(0);
    expect(take()).toMatch(/Status: done[\s\S]*✓ sh — done/);
    expect(await main(["logs", done.runId], ctx)).toBe(0);
    expect(take()).toMatch(/▶ Shell command/);
    expect(await main(["status", "nope"], ctx)).toBe(1);

    // Finished: nothing to continue; no id off a TTY is a usage error.
    expect(await main(["resume", done.runId], ctx)).toBe(0);
    expect(take()).toMatch(/already finished/);
    expect(await main(["-r"], ctx)).toBe(2);
    expect(err.at(-1)).toMatch(/Pass a run id/);

    expect(await main(["resume", "--paused", "--json"], ctx)).toBe(0);
    expect(JSON.parse(take())).toEqual({ continued: [], skipped: [] });

    expect(await main(["--ui"], ctx)).toBe(0);
    expect(take()).toContain(`opened ${daemon!.info.url}/`);
  }, 30_000);

  it("a scheduled run fires: started detached, recorded, its trigger removed", async () => {
    const { ctx, paths } = await setup();
    const calls: string[][] = [];
    const osd: OsDeps = { platform: "linux", exec: async (c, a) => (calls.push([c, ...a]), { code: 0, stdout: "", stderr: "" }), writeFile: () => {}, rm: () => {}, unitDir: "/x" };
    setScheduleOs(ctx, osd);
    saveRecord(paths, { id: "abcd1234", at: new Date().toISOString(), state: "scheduled", args: ["run", "base/daily-repo-report", "--repo", process.cwd()], createdAt: new Date().toISOString() });
    expect(await main(["schedule", "fire", "abcd1234"], ctx)).toBe(0);
    const [rec] = listRecords(paths);
    expect(rec).toMatchObject({ state: "started", runId: expect.any(String), firedAt: expect.any(String) });
    expect(fs.readFileSync(path.join(paths.schedules, "abcd1234.log"), "utf8")).toContain(rec.runId!);
    expect(calls).toContainEqual(["systemctl", "--user", "disable", "--now", "sandflow-abcd1234.timer"]);
    // Firing again (a late duplicate trigger) does nothing.
    expect(await main(["schedule", "fire", "abcd1234"], ctx)).toBe(0);
    expect(listRecords(paths)[0].runId).toBe(rec.runId);
  }, 30_000);

  it("mcp proxies JSON-RPC lines to the daemon's /api/mcp", async () => {
    const { ctx, out } = await setup();
    const input = new PassThrough();
    const done = mcpProxy(ctx, input);
    input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "1" } } })}\n`);
    input.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
    input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })}\n`);
    input.end();
    expect(await done).toBe(0);
    const msgs = out.map((l) => JSON.parse(l));
    expect(msgs).toHaveLength(2); // the notification gets no reply
    expect(msgs.find((m) => m.id === 1).result.serverInfo.name).toBe("sandflow");
    const tools = msgs.find((m) => m.id === 2).result.tools.map((t: { name: string }) => t.name);
    expect(tools).toEqual(expect.arrayContaining(["list_flows", "flow_requirements", "start_run", "watch_run", "get_run", "answer_question", "steer_run", "stop_run", "list_runs"]));
  }, 30_000);

  it("a desktop app's run (its own data dir, same history) goes through that app while it runs", async () => {
    const { ctx, take, err, paths } = await setup();
    const desktopData = fs.mkdtempSync(path.join(os.tmpdir(), "sandflow-desktop-"));
    dirs.push(desktopData);
    const web = path.join(desktopData, "web");
    fs.mkdirSync(web);
    const desktop = await startAppServer({ dataDir: desktopData, webRoot: web, runners: { auto: idle, ai: idle }, fetchBasePack: false, history: { file: paths.history, source: "desktop" } });
    try {
      const r = await fetch(`${desktop.url}/api/runs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ flowId: "base/daily-repo-report", env: { REPO_PATH: process.cwd() } }),
      });
      const { runId } = (await r.json()) as { runId: string };
      await new Promise((res) => setTimeout(res, 300));
      expect(readHistory(paths.history).find((h) => h.runId === runId)).toMatchObject({ source: "desktop", dataDir: desktopData });
      expect(await main(["status", runId, "--json"], ctx)).toBe(0);
      expect(JSON.parse(take())).toMatchObject({ runId, status: "done" });
      await desktop.close();
      expect(await main(["status", runId], ctx)).toBe(1);
      expect(err.at(-1)).toMatch(/belongs to the Sandflow desktop app .* isn't running/);
    } finally {
      await desktop.close().catch(() => {});
    }
  }, 30_000);

  it("keeps a run's own inputs (not secret ones) for continuing it", async () => {
    const { ctx, take, paths } = await setup();
    expect(await main(["run", "base/daily-repo-report", "--repo", process.cwd(), "--env", "FOO=1", "--env", "MY_TOKEN=supersecret", "--json"], ctx)).toBe(0);
    const { runId } = JSON.parse(take());
    const journal = JSON.parse(fs.readFileSync(path.join(paths.data, "runs", `${runId}.json`), "utf8"));
    expect(journal.envOverrides).toEqual({ REPO_PATH: process.cwd(), FOO: "1" });
  }, 30_000);
});
