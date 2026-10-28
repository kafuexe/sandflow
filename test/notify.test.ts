// Run notifications (backend/notify.ts): which transitions notify, once each, what the channels get, and that a
// broken command / webhook ends up in the run's log instead of throwing.
import { describe, expect, it, vi } from "vitest";
import { startRun, type NodeRunner } from "../backend/engine";
import { createNotifier, noticeKey, type NotifierDeps, type RunNotice } from "../backend/notify";
import type { TreeResult } from "../backend/proc";
import { CORE_BLOCKS } from "../shared/core";
import { BUILTIN_BLOCKS } from "../shared/library";
import { validateSettings } from "../shared/settings";
import type { Flow, NotificationSettings, RunState, Settings } from "../shared/types";

const run = (patch: Partial<RunState> = {}): RunState => ({
  id: "r1",
  flowId: "f",
  flowName: "Ship it",
  status: "running",
  startedAt: 1000,
  nodes: {},
  logs: [],
  ...patch,
});

function setup(cfg: NotificationSettings, o: { tree?: Partial<TreeResult> | Error; fetch?: Response | Error } = {}) {
  const os: { n: RunNotice; title: string; body: string }[] = [];
  const logs: string[] = [];
  const tree = vi.fn(async () => {
    if (o.tree instanceof Error) throw o.tree;
    return { code: 0, stdout: "", stderr: "", ...o.tree } as TreeResult;
  });
  const post = vi.fn(async () => {
    if (o.fetch instanceof Error) throw o.fetch;
    return o.fetch ?? new Response(null, { status: 204 });
  });
  const deps: NotifierDeps = {
    settings: () => cfg,
    os: (n, title, body) => os.push({ n, title, body }),
    log: (s, msg) => {
      s.logs.push({ ts: 0, level: "warn", msg });
      logs.push(msg);
    },
    runTree: tree as unknown as NotifierDeps["runTree"],
    fetch: post as unknown as typeof fetch,
  };
  return { notifier: createNotifier(deps), os, logs, tree, post };
}

describe("noticeKey", () => {
  it("maps statuses to events; ignores running, plain pauses and child runs", () => {
    expect(noticeKey(run({ status: "done" }))?.event).toBe("done");
    expect(noticeKey(run({ status: "failed" }))?.event).toBe("failed");
    expect(noticeKey(run({ status: "cancelled" }))?.event).toBe("stopped");
    expect(noticeKey(run({ status: "paused", hold: { reason: "blocked", problems: ["x"], at: 5 } }))?.event).toBe("attention");
    expect(noticeKey(run({ status: "waiting", pendingQuestion: { nodeId: "a", question: "Which?" } as RunState["pendingQuestion"] }))?.event).toBe("attention");
    expect(noticeKey(run({ status: "running" }))).toBeUndefined();
    expect(noticeKey(run({ status: "paused", pauseReason: "quit" }))).toBeUndefined();
    expect(noticeKey(run({ status: "done", parent: { runId: "p", nodeKey: "s" } }))).toBeUndefined();
  });
});

describe("notifier", () => {
  it("only the events asked for", async () => {
    const { notifier, os } = setup({ events: ["failed"], os: true });
    await notifier.onChange(run({ id: "a", status: "done" }));
    await notifier.onChange(run({ id: "b", status: "failed", error: "boom" }));
    expect(os.map((o) => o.n.runId)).toEqual(["b"]);
    expect(os[0].title).toBe("Run failed: Ship it");
    expect(os[0].body).toBe("boom");
  });

  it("once per transition, again for a new one", async () => {
    const { notifier, os } = setup({ events: ["done", "attention"], os: true });
    const held = run({ status: "paused", hold: { reason: "blocked", problems: ["needs you"], at: 5 } });
    await notifier.onChange(held);
    await notifier.onChange(held);
    await notifier.onChange({ ...held, status: "running", hold: undefined });
    const done = run({ status: "done", finishedAt: 2000 });
    await notifier.onChange(done);
    await notifier.onChange(done);
    expect(os.map((o) => o.n.event)).toEqual(["attention", "done"]);
  });

  it("skips child runs", async () => {
    const { notifier, os, tree } = setup({ events: ["done"], os: true, command: "echo hi" });
    await notifier.onChange(run({ status: "done", parent: { runId: "p", nodeKey: "stack" } }));
    expect(os).toEqual([]);
    expect(tree).not.toHaveBeenCalled();
  });

  it("webhook payload and command env", async () => {
    const { notifier, tree, post } = setup({ events: ["failed"], command: "say done", webhookUrl: "https://hooks.test/x" });
    await notifier.onChange(run({ status: "failed", error: "tests failed", costUsd: 1.5, finishedAt: 3000 }));
    const [url, init] = post.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://hooks.test/x");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({
      event: "failed",
      runId: "r1",
      flowId: "f",
      flowName: "Ship it",
      status: "failed",
      error: "tests failed",
      costUsd: 1.5,
      startedAt: 1000,
      endedAt: 3000,
    });
    const [cmd, args, opts] = tree.mock.calls[0] as unknown as [string, null, { env: Record<string, string>; timeoutMs: number }];
    expect(cmd).toBe("say done");
    expect(args).toBeNull();
    expect(opts.timeoutMs).toBeGreaterThan(0);
    expect(opts.env).toMatchObject({ SANDFLOW_RUN_ID: "r1", SANDFLOW_FLOW: "Ship it", SANDFLOW_STATUS: "failed", SANDFLOW_COST_USD: "1.5000", SANDFLOW_ERROR: "tests failed", SANDFLOW_EVENT: "failed" });
  });

  it("a failing command or webhook is logged on the run, never thrown", async () => {
    const cases: Parameters<typeof setup>[1][] = [
      { tree: { code: 3, stderr: "nope" } },
      { tree: { code: 1, killed: "timed out after 30s" } },
      { tree: new Error("spawn ENOENT") },
      { fetch: new Response(null, { status: 500 }) },
      { fetch: new Error("connect ECONNREFUSED") },
    ];
    const seen: string[] = [];
    for (const c of cases) {
      const { notifier, logs } = setup({ events: ["done"], command: "x", webhookUrl: "https://hooks.test/x" }, c);
      const s = run({ status: "done" });
      await expect(notifier.onChange(s)).resolves.toBeUndefined();
      expect(s.logs).toHaveLength(1);
      seen.push(logs[0]);
    }
    expect(seen).toEqual([
      "Notification command exited with code 3: nope",
      "Notification command timed out after 30s",
      "Notification command couldn't start: spawn ENOENT",
      "Notification webhook answered 500",
      "Notification webhook failed: connect ECONNREFUSED",
    ]);
  });

  it("nothing configured: nothing happens", async () => {
    const { notifier, os, tree, post } = setup({});
    expect(notifier.onChange(run({ status: "done" }))).toBeUndefined();
    expect([os.length, tree.mock.calls.length, post.mock.calls.length]).toEqual([0, 0, 0]);
  });

  it("Send test: a sample through every channel, problems returned", async () => {
    const { notifier, os, post } = setup({ os: true, webhookUrl: "https://hooks.test/x", command: "x" }, { tree: { code: 2 } });
    expect(await notifier.test()).toEqual(["Notification command exited with code 2"]);
    expect(os[0].n.runId).toBe("test");
    expect(post).toHaveBeenCalledOnce();
  });
});

describe("settings", () => {
  const base: Settings = { startingPrompt: "", sandbox: "none", maxSteps: 40 };
  it("normalises notifications and refuses a bad webhook URL", () => {
    expect(validateSettings({ ...base, notifications: { events: ["failed", "bogus" as never, "done"], os: true, command: "  say hi ", webhookUrl: "" } }).notifications).toEqual({
      events: ["done", "failed"],
      os: true,
      command: "say hi",
    });
    expect(validateSettings({ ...base, notifications: {} }).notifications).toBeUndefined();
    expect(() => validateSettings({ ...base, notifications: { webhookUrl: "ftp://x" } })).toThrow(/http\(s\)/);
  });
});

describe("on a real run", () => {
  it("one notice when a run finishes, however many changes it saw", async () => {
    const blocks = [...CORE_BLOCKS, ...BUILTIN_BLOCKS];
    const flow: Flow = { id: "f", name: "F", nodes: [{ id: "a", type: "block", position: { x: 0, y: 0 }, data: { blockId: "plan" } }], edges: [] };
    const ok: NodeRunner = async () => ({ outputs: { artifact: "done" } });
    const { notifier, os } = setup({ events: ["done", "failed", "stopped"], os: true });
    const h = startRun({ flow, blocks, flows: [flow], env: { REPO_PATH: "/r" }, settings: { startingPrompt: "Do it", sandbox: "docker", maxSteps: 40 }, runners: { auto: ok, ai: ok }, onChange: (s) => void notifier.onChange(s) });
    const s = await h.done;
    await notifier.onChange(s);
    expect(s.status).toBe("done");
    expect(os.map((o) => o.n.event)).toEqual(["done"]);
  });
});
