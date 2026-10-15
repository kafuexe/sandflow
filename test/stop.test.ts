// Stop: a stopped run ends right away as "cancelled", and every process it started dies with it.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startRun, type NodeRunner, type RunContext, type RunPacks } from "../backend/engine";
import { createPackStore } from "../backend/packs";
import { runTree } from "../backend/proc";
import { runAuto } from "../backend/runners/auto";
import { runScript } from "../backend/runners/script";
import { stoppableProvider } from "../backend/sandbox";
import { CORE_BLOCKS, SCRIPT_BLOCK } from "../shared/core";
import { BUILTIN_BLOCKS, DEFAULT_FLOW } from "../shared/library";
import { resolveBlock } from "../shared/resolve";
import type { Flow, Settings } from "../shared/types";

const posix = process.platform !== "win32";
const settings: Settings = { startingPrompt: "Add login", sandbox: "none", maxSteps: 40 };
const env = { REPO_PATH: "/r", ANTHROPIC_API_KEY: "k", BRANCH_NAME: "feat/x", BASE_BRANCH: "main", MR_PROVIDER: "github" };

const dirs: string[] = [];
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "sandflow-stop-"));
  dirs.push(d);
  return d;
};
afterEach(() => dirs.splice(0).forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Alive = exists and isn't a zombie (an orphan nobody reaped yet is dead for our purposes). */
function alive(pid: number): boolean {
  try {
    if (process.platform === "linux") return !/^\d+ \(.*\) Z/.test(fs.readFileSync(`/proc/${pid}/stat`, "utf8"));
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitDead(pid: number, ms = 2000) {
  const end = Date.now() + ms;
  while (alive(pid) && Date.now() < end) await sleep(25);
  return !alive(pid);
}

/** A shell command that starts a background child, prints its pid, then waits for it. */
const TREE = "sleep 30 & echo $!; wait";

describe.runIf(posix)("process trees", () => {
  it("runTree: stop kills the shell and the child it started, within ~1s", async () => {
    const abort = new AbortController();
    let child = 0;
    const t0 = Date.now();
    const p = runTree(TREE, null, { signal: abort.signal, onLine: (l) => (child = Number(l)) });
    while (!child) await sleep(10);
    expect(alive(child)).toBe(true);
    abort.abort();
    const r = await p;
    expect(r.killed).toBe("cancelled");
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(await waitDead(child)).toBe(true);
  });

  it("runTree: an already-stopped run never starts the command", async () => {
    const abort = new AbortController();
    abort.abort();
    await expect(runTree("echo hi", null, { signal: abort.signal })).rejects.toThrow(/cancelled/);
  });

  it("shell block: stop kills the whole tree (not just the shell)", async () => {
    const d = tmp();
    const pidFile = path.join(d, "pid");
    const abort = new AbortController();
    const ctx = {
      settings,
      env: { REPO_PATH: d },
      run: { id: "r", flowId: "f", flowName: "F", status: "running", startedAt: 0, nodes: {}, logs: [] },
      flow: { nodes: [] },
      blocks: BUILTIN_BLOCKS,
      blockEnv: () => ({ REPO_PATH: d }),
      log: () => {},
      abort,
    } as unknown as RunContext;
    const cfg = { ...resolveBlock("shell", BUILTIN_BLOCKS), shellCommand: `sleep 30 & echo $! > ${pidFile}; wait` };
    const t0 = Date.now();
    const p = runAuto(ctx, { id: "n", type: "block", position: { x: 0, y: 0 }, data: { blockId: "shell" } }, cfg, {});
    p.catch(() => {});
    while (!fs.existsSync(pidFile) || !fs.readFileSync(pidFile, "utf8").trim()) await sleep(10);
    const child = Number(fs.readFileSync(pidFile, "utf8"));
    abort.abort();
    await expect(p).rejects.toThrow(/cancelled/i);
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(await waitDead(child)).toBe(true);
  });

  it("script block on this machine: a stopped run ends quickly as cancelled and its child process dies", async () => {
    const d = tmp();
    const pidFile = path.join(d, "pid");
    const flow: Flow = {
      id: "f", name: "F", edges: [],
      nodes: [{ id: "s", type: "block", position: { x: 0, y: 0 }, data: { blockId: SCRIPT_BLOCK, overrides: { script: { run: `sleep 30 & echo $! > ${pidFile}; wait` } } } }],
    };
    const h = startRun({ flow, blocks: CORE_BLOCKS, env: {}, settings, runners: { auto: runAuto, ai: async () => ({ outputs: {} }), script: runScript } });
    while (!fs.existsSync(pidFile) || !fs.readFileSync(pidFile, "utf8").trim()) await sleep(10);
    const child = Number(fs.readFileSync(pidFile, "utf8"));
    const t0 = Date.now();
    h.cancel();
    const final = await h.done;
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(final.status).toBe("cancelled");
    expect(final.error).toBeUndefined();
    expect(await waitDead(child)).toBe(true);
  });

  it("agent on this computer (no sandbox): stop kills the agent's process tree; nothing new starts after", async () => {
    const abort = new AbortController();
    const fake = {
      create: async (_o: { env?: Record<string, string> }) => ({
        worktreePath: os.tmpdir(),
        exec: async (_cmd: string, _o?: { onLine?: (l: string) => void }) => ({ stdout: "", stderr: "", exitCode: 0 }),
        close: async () => ({}),
      }),
    };
    const handle = await stoppableProvider(fake, "none", abort.signal).create({ env: {} });
    let child = 0;
    const p = handle.exec(TREE, { onLine: (l: string) => (child = Number(l)) });
    while (!child) await sleep(10);
    abort.abort();
    const r = await p;
    expect(r.exitCode).not.toBe(0);
    expect(await waitDead(child)).toBe(true);
    await expect(handle.exec("echo again")).rejects.toThrow(/cancelled/);
  });
});

describe("sandbox containers", () => {
  it("docker/podman: stop removes the run's container (killing the agent in it)", async () => {
    const abort = new AbortController();
    const calls: string[][] = [];
    let closed = 0;
    const fake = {
      create: async (_o: { env?: Record<string, string> }) => ({
        worktreePath: "/home/agent/workspace",
        exec: async (cmd: string) => ({ stdout: cmd === "cat /etc/hostname" ? "abc123def456\n" : "", stderr: "", exitCode: 0 }),
        close: async () => void closed++,
      }),
    };
    const exec = async (cmd: string, args: string[]) => {
      calls.push([cmd, ...args]);
      return { code: 0, stdout: "", stderr: "" };
    };
    const handle = await stoppableProvider(fake, "podman", abort.signal, exec).create({ env: {} });
    expect((await handle.exec("echo hi")).exitCode).toBe(0);
    abort.abort();
    await sleep(20);
    expect(calls).toContainEqual(["podman", "rm", "-f", "abc123def456"]);
    await expect(handle.exec("echo again")).rejects.toThrow(/cancelled/);
    await handle.close();
    await handle.close();
    expect(closed).toBe(1);
  });
});

describe("engine stop", () => {
  function run(runner: NodeRunner, flow: Flow = DEFAULT_FLOW, extra: { cleanupTimeoutMs?: number } = {}) {
    return startRun({ flow, blocks: BUILTIN_BLOCKS, env, settings, runners: { auto: runner, ai: runner }, ...extra });
  }

  it("a runner that ignores the signal doesn't hold the run: it ends at once and no further node starts", async () => {
    const started: string[] = [];
    let release!: () => void;
    const runner: NodeRunner = async (_ctx, node) => {
      started.push(node.id);
      if (started.length === 1) await new Promise<void>((r) => (release = r)); // never looks at ctx.abort
      return { outputs: { artifact: "a" }, route: "n-create-mr" };
    };
    const h = run(runner);
    await sleep(20);
    expect(started).toEqual(["n-create-task"]);
    const t0 = Date.now();
    h.cancel();
    expect(h.state.status).toBe("cancelled"); // shown right away
    const final = await h.done;
    expect(Date.now() - t0).toBeLessThan(500);
    expect(final.status).toBe("cancelled");
    expect(final.error).toBeUndefined();
    expect(final.nodes["n-create-task"]).toMatchObject({ status: "idle", error: "Stopped" });
    release();
    await sleep(20);
    expect(started).toEqual(["n-create-task"]);
    expect(final.logs.some((l) => /Stop requested/.test(l.msg))).toBe(true);
    expect(final.logs.some((l) => /Run stopped/.test(l.msg))).toBe(true);
  });

  it("a node waiting on a question is released; Stop twice is fine", async () => {
    const runner: NodeRunner = async (ctx, node) => {
      if (node.id === "n-plan") await ctx.ask(node.id, "Which DB?");
      return { outputs: { artifact: "a" }, route: "n-create-mr" };
    };
    const h = run(runner);
    await sleep(20);
    expect(h.state.pendingQuestion).toBeDefined();
    h.cancel();
    h.cancel();
    expect(h.state.pendingQuestion).toBeUndefined();
    expect(h.answer("x")).toBe(false);
    const final = await h.done;
    expect(final.status).toBe("cancelled");
    expect(final.nodes["n-plan"].status).toBe("idle");
    h.cancel();
    expect(final.logs.filter((l) => /Stop requested/.test(l.msg))).toHaveLength(1);
  });

  it("a cleanup step that hangs can't hang the stop", async () => {
    const runner: NodeRunner = async (ctx) => {
      ctx.cleanup.push(() => new Promise(() => {}));
      await new Promise(() => {});
      return { outputs: {} };
    };
    const h = run(runner, DEFAULT_FLOW, { cleanupTimeoutMs: 100 });
    await sleep(20);
    h.cancel();
    const final = await h.done;
    expect(final.status).toBe("cancelled");
    expect(final.finishedAt).toBeTypeOf("number");
    expect(final.logs.some((l) => /Cleanup step didn't finish/.test(l.msg))).toBe(true);
  });
});

describe.runIf(posix)("shared pack preparation", () => {
  it("stopping one run doesn't fail another run waiting for the same pack setup", async () => {
    const src = tmp();
    const files: Record<string, unknown> = {
      "manifest.json": { id: "tools", name: "Tools", version: "1.0.0", setup: "sleep 1 && echo ready > made.txt" },
      "boxes/report.json": { id: "report", name: "Report", isTemplate: false, config: { kind: "script", outputs: { artifact: true }, script: { run: "cat \"$PACK_DIR/made.txt\"" } } },
    };
    for (const [rel, v] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(src, rel)), { recursive: true });
      fs.writeFileSync(path.join(src, rel), JSON.stringify(v));
    }
    const store = createPackStore(tmp(), { bundledDir: tmp() });
    store.install(store.previewFolder(src, false).token, { trustHost: true });
    const packs: RunPacks = { runtime: (id) => store.runtime(id), dirs: () => store.dirs(), runtimeRoot: tmp() };
    const flow: Flow = { id: "f", name: "F", edges: [], nodes: [{ id: "s", type: "block", position: { x: 0, y: 0 }, data: { blockId: "tools/report" } }] };
    const start = () =>
      startRun({ flow, blocks: [...CORE_BLOCKS, ...store.load().blocks], env: {}, settings, runners: { auto: runAuto, ai: async () => ({ outputs: {} }), script: runScript }, packs });
    const a = start();
    await sleep(100);
    const b = start();
    await sleep(100);
    a.cancel();
    expect((await a.done).status).toBe("cancelled");
    const fb = await b.done;
    expect(fb.error).toBeUndefined();
    expect(fb.status).toBe("done");
    expect(fb.nodes.s.outputs?.artifact).toBe("ready");
  });
});
