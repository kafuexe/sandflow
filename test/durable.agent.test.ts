// An interrupted agent continues its own Claude session on its first call only; when that can't work it starts
// fresh with a recap and its task (MEOW agents/base.py + resume --repair).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startRun, type NodeRunner, type RunContext, type StartRunOptions } from "../backend/engine";
import { runAi } from "../backend/runners/ai";
import { INTERRUPTED_PROMPT } from "../shared/journal";
import { BUILTIN_BLOCKS } from "../shared/library";
import type { Flow, RunState, Settings } from "../shared/types";

const settings: Settings = { startingPrompt: "Add login", sandbox: "docker", maxSteps: 40 };
const env = { REPO_PATH: "/r", ANTHROPIC_API_KEY: "k", BRANCH_NAME: "feat/x" };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => fs.rmSync(d, { recursive: true, force: true })));
async function until(cond: () => boolean, ms = 3000) {
  for (const end = Date.now() + ms; !cond(); await sleep(5)) if (Date.now() > end) throw new Error("timed out");
}

const flow: Flow = {
  id: "f",
  name: "F",
  nodes: [
    { id: "a", type: "block", position: { x: 0, y: 0 }, data: { blockId: "plan", overrides: { skills: [] } } },
    { id: "b", type: "block", position: { x: 300, y: 0 }, data: { blockId: "plan", overrides: { skills: [] } } },
  ],
  edges: [{ id: "e", source: "a", sourceHandle: "artifact", target: "b", targetHandle: "artifact" }],
};

interface Call {
  prompt: string;
  command: string;
  finish(stdout: string): void;
  fail(e: Error): void;
}

/** sandcastle's sandbox, faked: each `run` reports a session id and waits for the test to finish (or fail) it. */
function fakeSandbox(session = "sess-1") {
  const calls: Call[] = [];
  const sandbox = {
    exec: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
    close: async () => ({}),
    run: (opts: any) =>
      new Promise((resolve, reject) => {
        const built = opts.agent.buildPrintCommand({ prompt: opts.prompt, dangerouslySkipPermissions: true });
        calls.push({ prompt: opts.prompt, command: built.command, finish: (s) => resolve({ stdout: s, commits: [], iterations: [{}] }), fail: reject });
        opts.signal?.addEventListener("abort", () => reject(opts.signal.reason), { once: true });
        opts.logging?.onAgentStreamEvent?.({ type: "raw", line: JSON.stringify({ type: "system", subtype: "init", session_id: session }), iteration: 1 });
      }),
  };
  return { sandbox, calls };
}

function start(sandbox: unknown, o: Partial<StartRunOptions> = {}) {
  const journals: RunState[] = [];
  const logRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sandflow-durable-agent-"));
  dirs.push(logRoot);
  const ai: NodeRunner = (ctx: RunContext, node, cfg, inputs) => {
    ctx.sandbox = sandbox;
    return runAi(ctx, node, cfg, inputs);
  };
  const h = startRun({ flow, blocks: BUILTIN_BLOCKS, env, settings, logRoot, runners: { auto: ai, ai }, onJournal: (s) => journals.push(structuredClone(s)), ...o });
  return { h, journals, last: () => structuredClone(journals.at(-1)!) };
}

/** Run until node a's agent has started its session, then "crash": the last journal is what's left. */
async function crashDuringA() {
  const { sandbox } = fakeSandbox("sess-1");
  const first = start(sandbox);
  await until(() => first.journals.some((j) => j.nodes.a?.session));
  const crashed = first.last();
  first.h.cancel(); // only to end the abandoned test run; the snapshot was taken before
  expect(crashed.nodes.a.session).toEqual({ id: "sess-1", where: "docker" });
  return crashed;
}

describe("durable runs: an interrupted agent", () => {
  it("continues its own session on its first call only, told it was interrupted", async () => {
    const crashed = await crashDuringA();
    const { sandbox, calls } = fakeSandbox("sess-1");
    const second = start(sandbox, { continueFrom: crashed });
    await until(() => calls.length === 1);
    expect(calls[0].command).toContain("--resume 'sess-1'");
    expect(calls[0].prompt).toBe(INTERRUPTED_PROMPT);
    calls[0].finish("<artifact>plan</artifact>");
    await until(() => calls.length === 2);
    // The next step is a new agent: a fresh session.
    expect(calls[1].command).not.toContain("--resume");
    calls[1].finish("<artifact>done</artifact>");
    const final = await second.h.done;
    expect(final.status).toBe("done");
    expect(final.nodes.a.outputs?.artifact).toBe("plan");
  });

  it("when the session can't be continued, starts fresh with the recap and its original task (logged)", async () => {
    const crashed = await crashDuringA();
    const { sandbox, calls } = fakeSandbox("sess-2");
    const second = start(sandbox, { continueFrom: crashed });
    await until(() => calls.length === 1);
    calls[0].fail(new Error("No conversation found with session ID: sess-1"));
    await until(() => calls.length === 2);
    expect(calls[1].command).not.toContain("--resume");
    expect(calls[1].prompt.startsWith(INTERRUPTED_PROMPT)).toBe(true);
    expect(calls[1].prompt).toContain("Add login");
    calls[1].finish("<artifact>plan</artifact>");
    await until(() => calls.length === 3);
    calls[2].finish("<artifact>done</artifact>");
    const final = await second.h.done;
    expect(final.status).toBe("done");
    expect(final.logs.some((l) => /Couldn't continue the agent's session sess-1/.test(l.msg))).toBe(true);
  });

  it("a session from a container that's gone isn't tried: fresh with the recap", async () => {
    const crashed = await crashDuringA();
    crashed.nodes.a.session = { id: "sess-1", where: "aaaaaaaaaaaa" };
    const { sandbox, calls } = fakeSandbox("sess-3");
    const second = start(sandbox, { continueFrom: crashed });
    await until(() => calls.length === 1);
    expect(calls[0].command).not.toContain("--resume");
    expect(calls[0].prompt.startsWith(INTERRUPTED_PROMPT)).toBe(true);
    expect(second.h.state.logs.some((l) => /container is gone/.test(l.msg))).toBe(true);
    second.h.cancel();
    await second.h.done;
  });
});
