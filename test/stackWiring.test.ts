import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";

import { createApi } from "../backend/api";
import type { NodeRunner, RunContext } from "../backend/engine";
import { getSandbox } from "../backend/runners/ai";
import { runAuto } from "../backend/runners/auto";
import { withMergeLock } from "../backend/stack";
import { createStorage } from "../backend/storage";
import { CORE_BLOCKS, FLOW_INPUT_BLOCK, FLOW_OUTPUT_BLOCK, MERGE_PARENT_BLOCK, STACK_BLOCK } from "../shared/core";
import { resolveBlock } from "../shared/resolve";
import { SPLIT_PROTOCOL } from "../shared/stack";
import type { Flow, RunState, RunSummary } from "../shared/types";
import { e, n, settings } from "./stackFixtures";

function gitRepo() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "sandflow-repo-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
  git("init", "-q", "-b", "main");
  git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init");
  return { repo, git };
}

describe("shared sandbox", () => {
  const ctxFor = (repo: string, extra: Partial<RunContext> = {}) =>
    ({ run: { id: `r${Math.random().toString(16).slice(2, 8)}` }, env: { REPO_PATH: repo, BASE_BRANCH: "main" }, settings, cleanup: [], log: () => {}, abort: new AbortController(), ...extra }) as unknown as RunContext;

  it("concurrent first uses create the sandbox once", async () => {
    const { repo, git } = gitRepo();
    const ctx = ctxFor(repo);
    const [a, b] = await Promise.all([getSandbox(ctx), getSandbox(ctx)]);
    expect(a).toBe(b);
    expect(git("worktree", "list").split("\n")).toHaveLength(2);
    for (const fn of ctx.cleanup) await fn();
    fs.rmSync(repo, { recursive: true, force: true });
  }, 30_000);

  it("a set base branch wins over BASE_BRANCH", async () => {
    const { repo, git } = gitRepo();
    git("branch", "feat/x");
    git("checkout", "-q", "feat/x");
    git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "on x");
    git("checkout", "-q", "main");
    const ctx = ctxFor(repo, { branch: "feat/x-child", baseBranch: "feat/x" });
    await getSandbox(ctx);
    expect(git("rev-parse", "feat/x-child")).toBe(git("rev-parse", "feat/x"));
    for (const fn of ctx.cleanup) await fn();
    fs.rmSync(repo, { recursive: true, force: true });
  }, 30_000);
});

describe("merge lock", () => {
  it("runs merges of one stack group one at a time", async () => {
    let active = 0;
    let peak = 0;
    const merge = () => withMergeLock("g1", async () => {
      peak = Math.max(peak, ++active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
    });
    await Promise.all([merge(), merge(), merge()]);
    expect(peak).toBe(1);
  });

  it("a failed merge doesn't block the next one", async () => {
    await expect(withMergeLock("g2", async () => { throw new Error("conflict"); })).rejects.toThrow("conflict");
    await expect(withMergeLock("g2", async () => "ok")).resolves.toBe("ok");
  });
});

describe("merge into parent branch", () => {
  const commit = (git: (...a: string[]) => string, file: string, text: string, repo: string) => {
    fs.writeFileSync(path.join(repo, file), text);
    git("add", file);
    git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", `${file}: ${text}`);
  };
  function setup(conflict: boolean) {
    const { repo, git } = gitRepo();
    commit(git, "shared.txt", "base", repo);
    git("checkout", "-q", "-b", "child");
    commit(git, conflict ? "shared.txt" : "child.txt", "from child", repo);
    git("checkout", "-q", "main");
    if (conflict) commit(git, "shared.txt", "from parent", repo);
    const parent = { sandbox: { worktreePath: repo }, run: { branch: "main" } } as unknown as RunContext;
    const ctx = {
      run: { id: "c1", stack: { groupId: "g", branch: "child" } }, env: { REPO_PATH: repo }, settings, abort: new AbortController(),
      parentContext: parent, blockEnv: () => ({ REPO_PATH: repo }), log: () => {},
    } as unknown as RunContext;
    const node = n("m", MERGE_PARENT_BLOCK);
    return { repo, git, ctx, node, cfg: resolveBlock(MERGE_PARENT_BLOCK, CORE_BLOCKS) };
  }

  it("merges the task's branch into the branch the stack was cut from", async () => {
    const { repo, git, ctx, node, cfg } = setup(false);
    const r = await runAuto(ctx, node, cfg, { artifact: "Ported the auth screens", steer: "watch the tests" });
    expect(r.outputs.artifact).toMatch(/^Ported the auth screens[\s\S]*Merged child into main/);
    expect(r.outputs.steer).toBe("watch the tests");
    expect(git("log", "--format=%s", "main")).toContain("child.txt: from child");
    fs.rmSync(repo, { recursive: true, force: true });
  }, 30_000);

  it("a conflict fails the step and leaves the parent worktree clean", async () => {
    const { repo, git, ctx, node, cfg } = setup(true);
    await expect(runAuto(ctx, node, cfg, {})).rejects.toThrow(/conflict/i);
    expect(git("status", "--porcelain")).toBe("");
    fs.rmSync(repo, { recursive: true, force: true });
  }, 30_000);

  it("only works inside an isolated Box Stack task", async () => {
    const { repo, ctx, node, cfg } = setup(false);
    const loose = { ...ctx, run: { id: "x" } } as unknown as RunContext;
    await expect(runAuto(loose, node, cfg, {})).rejects.toThrow(/isolated Box Stack task/);
    fs.rmSync(repo, { recursive: true, force: true });
  });
});

describe("api with a stack", () => {
  let dir: string;
  let server: Server;
  afterEach(() => {
    server?.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("lists child runs under their parent and announces a child's flag once", async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "sandflow-stackapi-"));
    const storage = createStorage(dir);
    const all = storage.load().blocks;
    const ai = all.find((b) => !b.isTemplate && resolveBlock(b.id, all).kind === "ai")!.id;
    const area: Flow = {
      id: "area", name: "Area",
      nodes: [n("in", FLOW_INPUT_BLOCK), n("work", ai, { env: [] }), n("out", FLOW_OUTPUT_BLOCK)],
      edges: [e("in", "work"), e("work", "out")],
    };
    const big: Flow = { id: "big", name: "Big", nodes: [n("s", STACK_BLOCK, { stack: { flowId: "area", workspace: "shared" } })], edges: [] };
    storage.saveFlows([big, area]);
    storage.saveEnv({ REPO_PATH: "/r", ANTHROPIC_API_KEY: "k" });
    storage.saveSettings({ ...settings, startingPrompt: "Do it" });
    const runner: NodeRunner = async (ctx, node, cfg) => {
      if (node.id === "s" && cfg.instructions.includes(SPLIT_PROTOCOL)) return { outputs: { artifact: JSON.stringify({ tasks: [{ name: "a", input: "a" }, { name: "b", input: "b" }] }) } };
      if (node.id === "work") ctx.flag("warning", `skipped tests in ${ctx.run.stack?.task}`);
      return { outputs: { artifact: "ok" } };
    };
    const api = createApi(storage, { auto: runner, ai: runner });
    server = createServer((req, res) => api(req, res, () => ((res.statusCode = 404), res.end())));
    server.listen(0);
    await new Promise((r) => server.once("listening", r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;

    const events: string[] = [];
    const ac = new AbortController();
    const stream = fetch(`${base}/data/events`, { signal: ac.signal }).then(async (res) => {
      const reader = res.body!.getReader();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        events.push(new TextDecoder().decode(value));
      }
    }).catch(() => {});
    await new Promise((r) => setTimeout(r, 20));

    const { runId } = (await (await fetch(`${base}/runs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ flowId: "big" }) })).json()) as { runId: string };
    let state: RunState | undefined;
    for (let i = 0; i < 100 && !state?.finishedAt; i++) {
      await new Promise((r) => setTimeout(r, 10));
      state = (await (await fetch(`${base}/runs/${runId}`)).json()) as RunState;
    }
    expect(state?.status).toBe("done");
    const list = (await (await fetch(`${base}/runs`)).json()) as RunSummary[];
    const kids = list.filter((r) => r.parent?.runId === runId);
    expect(kids.map((k) => k.stack?.task).sort()).toEqual(["a", "b"]);
    expect(kids.every((k) => k.stack?.outcome === "succeeded")).toBe(true);
    for (const k of kids) expect(fs.existsSync(path.join(dir, "runs", `${k.id}.json`))).toBe(true);
    await new Promise((r) => setTimeout(r, 20));
    ac.abort();
    await stream;
    const flagEvents = events.join("").split("\n\n").filter((x) => x.startsWith("event: flag\n"));
    expect(flagEvents).toHaveLength(2);
    expect(flagEvents.every((x) => x.includes(`"runId":"${runId}"`))).toBe(true);
  });

  it("a stack child's question can be answered through the API", async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "sandflow-stackapi-"));
    const storage = createStorage(dir);
    const all = storage.load().blocks;
    const ai = all.find((b) => !b.isTemplate && resolveBlock(b.id, all).kind === "ai")!.id;
    const area: Flow = { id: "area", name: "Area", nodes: [n("in", FLOW_INPUT_BLOCK), n("work", ai), n("out", FLOW_OUTPUT_BLOCK)], edges: [e("in", "work"), e("work", "out")] };
    const big: Flow = { id: "big", name: "Big", nodes: [n("s", STACK_BLOCK, { stack: { flowId: "area", workspace: "shared" } })], edges: [] };
    storage.saveFlows([big, area]);
    storage.saveEnv({ REPO_PATH: "/r", ANTHROPIC_API_KEY: "k" });
    storage.saveSettings({ ...settings, startingPrompt: "Do it" });
    const runner: NodeRunner = async (ctx, node, cfg) => {
      if (node.id === "s" && cfg.instructions.includes(SPLIT_PROTOCOL)) return { outputs: { artifact: JSON.stringify({ tasks: [{ name: "a", input: "a" }] }) } };
      if (node.id === "work") return { outputs: { artifact: await ctx.ask("work", "Which DB?") } };
      return { outputs: { artifact: "ok" } };
    };
    const api = createApi(storage, { auto: runner, ai: runner });
    server = createServer((req, res) => api(req, res, () => ((res.statusCode = 404), res.end())));
    server.listen(0);
    await new Promise((r) => server.once("listening", r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
    const post = (url: string, body: unknown) => fetch(`${base}${url}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

    const { runId } = (await (await post("/runs", { flowId: "big" })).json()) as { runId: string };
    let kid: RunSummary | undefined;
    for (let i = 0; i < 100 && !kid?.pendingQuestion; i++) {
      await new Promise((r) => setTimeout(r, 10));
      kid = ((await (await fetch(`${base}/runs`)).json()) as RunSummary[]).find((r) => r.parent?.runId === runId);
    }
    expect(kid?.pendingQuestion?.question).toBe("Which DB?");
    expect((await post(`/runs/${kid!.id}/answer`, { answer: "postgres" })).status).toBe(200);
    let state: RunState | undefined;
    for (let i = 0; i < 100 && !state?.finishedAt; i++) {
      await new Promise((r) => setTimeout(r, 10));
      state = (await (await fetch(`${base}/runs/${runId}`)).json()) as RunState;
    }
    expect(state?.nodes.s.exit).toBe("done");
  });
});
