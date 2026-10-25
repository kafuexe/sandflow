import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { createApi } from "../backend/api";
import { startRun, type NodeRunner, type RunContext } from "../backend/engine";
import { createStorage } from "../backend/storage";
import { BUILTIN_BLOCKS } from "../shared/library";
import { canRestartAt, defaultResumeNodes, planResume, resumeBlocker, type ResumePlan } from "../shared/resume";
import type { Flow, FlowEdge, FlowNode, RunState, Settings } from "../shared/types";

const settings: Settings = { startingPrompt: "Fix the bug", sandbox: "none", maxSteps: 40 };
const env = { REPO_PATH: "/r" };

const node = (id: string, cmd: string, blockId = "shell"): FlowNode => ({
  id, type: "block", position: { x: 0, y: 0 }, data: { blockId, label: id.toUpperCase(), overrides: { shellCommand: cmd } },
});
const edge = (source: string, target: string, sourceHandle: FlowEdge["sourceHandle"] = "artifact"): FlowEdge => ({
  id: `${source}-${target}`, source, target, sourceHandle, targetHandle: "artifact",
});
const chain = (cmdB = "bad-command", blockId = "shell"): Flow => ({
  id: "f", name: "Three steps",
  nodes: [node("a", "echo a", blockId), node("b", cmdB, blockId), node("c", "echo c", blockId)],
  edges: [edge("a", "b"), edge("b", "c")],
});

/** Fake shell runner: "fails" on `bad-command`, otherwise outputs `<id>(<input>)`. Records what ran with what. */
function shellRunner() {
  const ran: { id: string; input?: string; branch?: string }[] = [];
  const runner: NodeRunner = async (ctx, n, cfg, inputs) => {
    ran.push({ id: n.id, input: inputs.artifact, branch: ctx.branch });
    if (cfg.shellCommand === "bad-command") throw new Error("Command exited with code 127: bad-command: not found");
    return { outputs: { artifact: `${n.id}(${inputs.artifact ?? ""})` } };
  };
  return { ran, runner };
}

function go(flow: Flow, runner: NodeRunner, extra: Partial<Parameters<typeof startRun>[0]> = {}) {
  return startRun({ flow, blocks: BUILTIN_BLOCKS, env, settings, runners: { auto: runner, ai: runner }, ...extra }).done;
}

function plan(orig: RunState, flow: Flow, from?: string[]): ResumePlan {
  const r = planResume(orig, flow, BUILTIN_BLOCKS, from);
  if (!r.ok) throw new Error(r.problems.join("; "));
  return r.plan;
}

describe("resume: engine", () => {
  it("records what a resume needs on every run", async () => {
    const orig = await go(chain(), shellRunner().runner);
    expect(orig.status).toBe("failed");
    expect(orig.workspace).toEqual({ repo: "/r", branch: `sandflow/${orig.id}` });
    expect(orig.nodes.b).toMatchObject({ status: "failed", inputs: { artifact: "a()" } });
    expect(defaultResumeNodes(orig)).toEqual(["b"]);
    expect(resumeBlocker(orig)).toBeUndefined();
    expect(canRestartAt(orig, "a")).toBe(true);
    expect(canRestartAt(orig, "c")).toBe(false);
  });

  it("retries from the failed step with the current config, restoring the steps before it", async () => {
    const first = shellRunner();
    const orig = await go(chain(), first.runner, { prompt: "Original prompt" });
    expect(first.ran.map((r) => r.id)).toEqual(["a", "b"]);

    const fixed = chain("echo b"); // the fix
    const p = plan(orig, fixed);
    const second = shellRunner();
    const resumed = await go(fixed, second.runner, { resume: { from: orig, plan: p }, prompt: orig.prompt, branch: p.branch });

    expect(resumed.status).toBe("done");
    expect(second.ran.map((r) => r.id)).toEqual(["b", "c"]); // a is not run again
    expect(second.ran[0].input).toBe("a()"); // b gets what a produced in the original run
    expect(resumed.nodes.c.outputs?.artifact).toBe("c(b(a()))");
    expect(resumed.nodes.a).toMatchObject({ status: "done", restored: true, outputs: { artifact: "a()" } });
    expect(resumed.resumedFrom).toEqual({ runId: orig.id, nodeIds: ["b"] });
    expect(resumed.prompt).toBe("Original prompt");
    expect(resumed.trigger).toEqual(orig.trigger);
    // Works on the original run's branch.
    expect(second.ran[0].branch).toBe(`sandflow/${orig.id}`);
    expect(resumed.workspace?.branch).toBe(`sandflow/${orig.id}`);
    expect(resumed.id).not.toBe(orig.id);
  });

  it("re-runs from an earlier step: it and everything after it run again", async () => {
    const orig = await go(chain(), shellRunner().runner);
    const fixed = chain("echo b");
    const second = shellRunner();
    const resumed = await go(fixed, second.runner, { resume: { from: orig, plan: plan(orig, fixed, ["a"]) } });
    expect(second.ran.map((r) => r.id)).toEqual(["a", "b", "c"]);
    expect(resumed.nodes.a.restored).toBeUndefined();
  });

  it("refuses a step that's gone, one that never ran, an upstream step added since, and a step inside a subflow", async () => {
    const orig = await go(chain(), shellRunner().runner);
    const gone = { ...chain("echo b"), nodes: chain().nodes.filter((n) => n.id !== "b"), edges: [] };
    expect(planResume(orig, gone, BUILTIN_BLOCKS)).toEqual({ ok: false, problems: ['Step "b" is no longer in the flow'] });
    const r2 = planResume(orig, chain(), BUILTIN_BLOCKS, ["c"]);
    expect(r2.ok).toBe(false);
    expect(!r2.ok && r2.problems[0]).toMatch(/"C" never ran in the original run/);
    const added: Flow = { ...chain(), nodes: [...chain().nodes, node("x", "echo x")], edges: [edge("a", "x"), edge("x", "b"), edge("b", "c")] };
    const r3 = planResume(orig, added, BUILTIN_BLOCKS);
    expect(!r3.ok && r3.problems[0]).toMatch(/"X" \(feeding "B"\) was added after the original run/);
    const r4 = planResume(orig, chain(), BUILTIN_BLOCKS, ["sub/inner"]);
    expect(!r4.ok && r4.problems[0]).toMatch(/inside a subflow/);
  });

  it("a run interrupted by Sandflow stopping retries the step that was going", () => {
    const saved = {
      nodes: { a: { status: "done", executions: 1 }, b: { status: "running", executions: 1, inputs: { artifact: "a()" } }, c: { status: "idle", executions: 0 } },
    } as unknown as RunState;
    expect(defaultResumeNodes(saved)).toEqual(["b"]);
  });

  it("refuses runs from before resuming existed, and stack tasks", async () => {
    const orig = await go(chain(), shellRunner().runner);
    const old = { ...orig, workspace: undefined };
    const r = planResume(old, chain(), BUILTIN_BLOCKS);
    expect(!r.ok && r.problems[0]).toMatch(/older version of Sandflow/);
    expect(resumeBlocker({ ...orig, parent: { runId: "p", nodeKey: "s" } })).toMatch(/Box Stack task/);
  });

  it("restarting inside a loop uses the inputs the step got in its last execution", async () => {
    // a → m (manager) → b → m … ; m routes to b twice, then to c, which fails the first time.
    const flow: Flow = {
      id: "loop", name: "Loop",
      nodes: [node("a", "echo a"), { ...node("m", ""), data: { blockId: "manager", label: "M" } }, node("b", "echo b"), node("c", "bad-command")],
      edges: [edge("a", "m"), edge("m", "b"), edge("b", "m"), edge("m", "c")],
    };
    let visits = 0;
    const runner: NodeRunner = async (_ctx, n, cfg, inputs) => {
      if (n.id === "m") return { outputs: { artifact: inputs.artifact }, route: ++visits <= 2 ? "b" : "c" };
      if (cfg.shellCommand === "bad-command") throw new Error("boom");
      return { outputs: { artifact: `${n.id}(${inputs.artifact ?? ""})` } };
    };
    const orig = await go(flow, runner);
    expect(orig.status).toBe("failed");
    expect(orig.nodes.b.executions).toBe(2);
    const fixed: Flow = { ...flow, nodes: flow.nodes.map((n) => (n.id === "c" ? node("c", "echo c") : n)) };
    const seen: Record<string, string | undefined> = {};
    const resumed = await go(fixed, async (_c, n, _cfg, inputs) => {
      seen[n.id] = inputs.artifact;
      return { outputs: { artifact: `${n.id}!` } };
    }, { resume: { from: orig, plan: plan(orig, fixed) } });
    expect(resumed.status).toBe("done");
    expect(Object.keys(seen)).toEqual(["c"]);
    expect(seen.c).toBe("b(b(a()))"); // what c got in the original run (last trip round the loop)
    // b sits inside the loop: re-running from it re-enters the loop with b's last inputs.
    const p = plan(orig, fixed, ["b"]);
    expect(p.starts).toEqual([{ nodeId: "b", inputs: { artifact: "b(a())" } }]);
    expect(Object.keys(p.restored)).toEqual(["a"]);
  });

  it("a stopped run records the steps still queued, and Retry starts them too", async () => {
    // a fans out to b and c; b hangs until the run is stopped, c never got to start.
    const flow: Flow = { id: "fan", name: "Fan", nodes: [node("a", "echo a"), node("b", "sleep"), node("c", "echo c")], edges: [edge("a", "b"), edge("a", "c")] };
    let release!: () => void;
    const started = new Promise<void>((r) => (release = r));
    const h = startRun({
      flow, blocks: BUILTIN_BLOCKS, env, settings,
      runners: {
        auto: async (_c, n) => {
          if (n.id === "b") {
            release();
            await new Promise(() => {});
          }
          return { outputs: { artifact: n.id } };
        },
        ai: async () => ({ outputs: {} }),
      },
    });
    await started;
    h.cancel();
    const orig = await h.done;
    expect(orig.status).toBe("cancelled");
    expect(orig.unstarted).toEqual([{ nodeId: "c", inputs: { artifact: "a" } }]);
    expect(defaultResumeNodes(orig)).toEqual(["b", "c"]);
    const ran: string[] = [];
    const resumed = await go(flow, async (_c, n) => (ran.push(n.id), { outputs: { artifact: n.id } }), { resume: { from: orig, plan: plan(orig, flow) } });
    expect(resumed.status).toBe("done");
    expect(ran.sort()).toEqual(["b", "c"]);
  });

  it("a scratch-workspace run can be resumed, with a warning that its files are gone", async () => {
    const orig = await startRun({ flow: chain(), blocks: BUILTIN_BLOCKS, env: {}, settings, runners: { auto: shellRunner().runner, ai: shellRunner().runner } }).done;
    expect(orig.workspace).toEqual({ branch: `sandflow/${orig.id}` });
    const p = plan(orig, chain("echo b"));
    expect(p.branch).toBeUndefined();
    expect(p.warnings[0]).toMatch(/scratch workspace was removed/);
  });
});

describe("resume: API", () => {
  let dir: string;
  let server: Server | undefined;
  let base: string;
  const json = (method: string, body?: unknown) => ({ method, headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) });

  afterEach(() => {
    server?.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  async function setup(runner: NodeRunner) {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "sandflow-resume-"));
    const repo = path.join(dir, "repo");
    fs.mkdirSync(repo);
    const git = (...a: string[]) => execFileSync("git", a, { cwd: repo, stdio: "pipe" });
    git("init", "-q", "-b", "main");
    git("-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", "init");
    const api = createApi(createStorage(path.join(dir, "data")), { auto: runner, ai: runner }, { exec: async () => ({ code: 0, stdout: "", stderr: "" }) });
    server = createServer((req, res) => api(req, res, () => ((res.statusCode = 404), res.end())));
    server.listen(0);
    await new Promise((r) => server!.once("listening", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
    await fetch(`${base}/env`, json("PUT", { REPO_PATH: repo }));
    await fetch(`${base}/settings`, json("PUT", settings));
    return { repo, git };
  }
  const saveFlow = async (f: Flow) => {
    const data = (await (await fetch(`${base}/data`)).json()) as { flows: Flow[] };
    const res = await fetch(`${base}/flows`, json("PUT", [...data.flows.filter((x) => !x.pack && x.id !== f.id), f]));
    expect(res.status).toBe(200);
  };
  const finished = async (id: string) => {
    for (let i = 0; i < 100; i++) {
      const s = (await (await fetch(`${base}/runs/${id}`)).json()) as RunState;
      if (s.finishedAt) return s;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error("run didn't finish");
  };

  it("POST /runs/:id/resume continues on the original branch from the failed step, and needs that branch", async () => {
    const ran: { id: string; branch?: string }[] = [];
    const runner: NodeRunner = async (ctx: RunContext, n, cfg, inputs) => {
      ran.push({ id: n.id, branch: ctx.branch });
      ctx.run.branch ??= ctx.branch ?? `sandflow/${ctx.run.id}`; // what a sandbox does
      if (cfg.shellCommand === "bad-command") throw new Error("not found");
      return { outputs: { artifact: `${n.id}(${inputs.artifact ?? ""})` } };
    };
    const { git } = await setup(runner);
    await saveFlow(chain(undefined, "base/shell"));
    const { runId } = (await (await fetch(`${base}/runs`, json("POST", { flowId: "f" }))).json()) as { runId: string };
    const orig = await finished(runId);
    expect(orig.status).toBe("failed");
    expect(orig.branch).toBe(`sandflow/${runId}`);

    // The branch the run worked on is gone: explained, nothing started.
    await saveFlow(chain("echo b", "base/shell"));
    const gone = await fetch(`${base}/runs/${runId}/resume`, json("POST", {}));
    expect(gone.status).toBe(409);
    expect(((await gone.json()) as { error: string }).error).toMatch(/Branch sandflow\/.* no longer exists/);

    git("branch", `sandflow/${runId}`);
    ran.length = 0;
    const res = await fetch(`${base}/runs/${runId}/resume`, json("POST", {}));
    expect(res.status).toBe(200);
    const resumed = await finished(((await res.json()) as { runId: string }).runId);
    expect(resumed.status).toBe("done");
    expect(resumed.resumedFrom).toEqual({ runId, nodeIds: ["b"] });
    expect(ran.map((r) => r.id)).toEqual(["b", "c"]);
    expect(ran.every((r) => r.branch === `sandflow/${runId}`)).toBe(true);
    expect(resumed.nodes.c.outputs?.artifact).toBe("c(b(a()))");
    // The original stays as it was.
    expect((await finished(runId)).status).toBe("failed");
    const list = (await (await fetch(`${base}/runs`)).json()) as { id: string; resumedFrom?: unknown }[];
    expect(list.find((r) => r.id === resumed.id)?.resumedFrom).toEqual({ runId, nodeIds: ["b"] });
  });

  it("explains what's wrong instead of starting a run", async () => {
    const { runner } = shellRunner();
    await setup(runner);
    await saveFlow(chain(undefined, "base/shell"));
    const { runId } = (await (await fetch(`${base}/runs`, json("POST", { flowId: "f" }))).json()) as { runId: string };
    await finished(runId);
    const bad = await fetch(`${base}/runs/${runId}/resume`, json("POST", { fromNodeIds: ["nope"] }));
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { problems: string[] }).problems).toEqual(['Step "nope" is no longer in the flow']);
    expect((await fetch(`${base}/runs/${runId}/resume`, json("POST", { fromNodeIds: "b" }))).status).toBe(400);
    expect((await fetch(`${base}/runs/missing-run/resume`, json("POST", {}))).status).toBe(404);
    // No branch was ever created (no sandbox): resuming just carries on.
    await saveFlow(chain("echo b", "base/shell"));
    const ok = await fetch(`${base}/runs/${runId}/resume`, json("POST", { fromNodeIds: ["a"] }));
    expect(ok.status).toBe(200);
    expect((await finished(((await ok.json()) as { runId: string }).runId)).status).toBe("done");
  });

  it("one resume at a time: two at once start one run; a run still on the branch blocks another resume; BRANCH_NAME follows the branch", async () => {
    let release = () => {};
    const gate = new Promise<void>((r) => (release = r));
    let block = false;
    const seenEnv: (string | undefined)[] = [];
    const runner: NodeRunner = async (ctx: RunContext, n, cfg, inputs) => {
      ctx.run.branch ??= ctx.branch ?? `sandflow/${ctx.run.id}`;
      seenEnv.push(ctx.env.BRANCH_NAME);
      if (cfg.shellCommand === "bad-command") throw new Error("not found");
      if (block && n.id === "b") await gate;
      return { outputs: { artifact: `${n.id}(${inputs.artifact ?? ""})` } };
    };
    const { git } = await setup(runner);
    await saveFlow(chain(undefined, "base/shell"));
    const { runId } = (await (await fetch(`${base}/runs`, json("POST", { flowId: "f" }))).json()) as { runId: string };
    await finished(runId);
    git("branch", `sandflow/${runId}`);
    // A resume that fails again (b still broken), so it can be resumed in turn.
    const r2 = (await (await fetch(`${base}/runs/${runId}/resume`, json("POST", {}))).json()) as { runId: string };
    expect((await finished(r2.runId)).status).toBe("failed");

    await saveFlow(chain("echo b", "base/shell"));
    block = true;
    // BRANCH_NAME changed since: the resumed steps still see the branch they continue.
    await fetch(`${base}/env`, json("PUT", { REPO_PATH: path.join(dir, "repo"), BRANCH_NAME: "other" }));
    seenEnv.length = 0;
    const both = await Promise.all([1, 2].map(() => fetch(`${base}/runs/${r2.runId}/resume`, json("POST", {}))));
    expect(both.map((r) => r.status).sort()).toEqual([200, 409]);
    const r3 = (await both.find((r) => r.status === 200)!.json()) as { runId: string; warning?: string };
    expect(r3.warning).toMatch(/BRANCH_NAME is now other/);

    // The first run, resumed again while r3 works on the same branch: refused.
    const busy = await fetch(`${base}/runs/${runId}/resume`, json("POST", {}));
    expect(busy.status).toBe(409);
    expect(((await busy.json()) as { error: string }).error).toMatch(/still working on branch sandflow\//);

    release();
    expect((await finished(r3.runId)).status).toBe("done");
    expect(seenEnv.length).toBeGreaterThan(0);
    expect(seenEnv.every((b) => b === `sandflow/${runId}`)).toBe(true);
  });
});
