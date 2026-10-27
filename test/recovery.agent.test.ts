// Review before redo: a failed agent continues its own Claude session told how the previous attempt ended; a
// stuck / timed-out one only once, then a fresh session (MEOW SessionAgent recycles a session that keeps failing).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startRun, type NodeRunner, type RunContext } from "../backend/engine";
import type { TriageRunner } from "../backend/recovery";
import { runAi } from "../backend/runners/ai";
import { BUILTIN_BLOCKS } from "../shared/library";
import type { Flow, Settings } from "../shared/types";

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
  nodes: [{ id: "a", type: "block", position: { x: 0, y: 0 }, data: { blockId: "plan", overrides: { skills: [] } } }],
  edges: [],
};

interface Call {
  prompt: string;
  command: string;
  finish(stdout: string): void;
  fail(e: Error): void;
}

function fakeSandbox() {
  const calls: Call[] = [];
  const sandbox = {
    exec: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
    close: async () => ({}),
    run: (opts: any) =>
      new Promise((resolve, reject) => {
        const built = opts.agent.buildPrintCommand({ prompt: opts.prompt, dangerouslySkipPermissions: true });
        calls.push({ prompt: opts.prompt, command: built.command, finish: (s) => resolve({ stdout: s, commits: [], iterations: [{}] }), fail: reject });
        opts.logging?.onAgentStreamEvent?.({ type: "raw", line: JSON.stringify({ type: "system", subtype: "init", session_id: `sess-${calls.length}` }), iteration: 1 });
      }),
  };
  return { sandbox, calls };
}

function start(sandbox: unknown, triage: TriageRunner) {
  const logRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sandflow-recovery-agent-"));
  dirs.push(logRoot);
  const ai: NodeRunner = (ctx: RunContext, node, cfg, inputs) => {
    ctx.sandbox = sandbox;
    return runAi(ctx, node, cfg, inputs);
  };
  return startRun({ flow, blocks: BUILTIN_BLOCKS, env, settings, logRoot, runners: { auto: ai, ai, triage }, sleep: async () => {} });
}

describe("recovery: review before redo (agent)", () => {
  it("a crashed agent continues its own session, told how the previous attempt ended", async () => {
    const { sandbox, calls } = fakeSandbox();
    const h = start(sandbox, async () => "");
    await until(() => calls.length === 1);
    calls[0].fail(new Error("claude exited with code 3221225477"));
    await until(() => calls.length === 2);
    expect(calls[1].command).toContain("--resume 'sess-1'");
    expect(calls[1].prompt).toMatch(/^Your previous attempt crashed: claude exited with code 3221225477\. Check the work in the repo/);
    calls[1].finish("<artifact>plan</artifact>");
    const run = await h.done;
    expect(run.status).toBe("done");
    expect(run.nodes.a.outputs?.artifact).toBe("plan");
  });

  it("a timed-out agent is resumed once, then starts a fresh session with the review note and its task", async () => {
    const { sandbox, calls } = fakeSandbox();
    const h = start(sandbox, async () => "");
    await until(() => calls.length === 1);
    calls[0].fail(new Error("Agent timed out after 1800s"));
    await until(() => calls.length === 2);
    expect(calls[1].command).toContain("--resume 'sess-1'");
    calls[1].fail(new Error("Agent timed out after 1800s"));
    await until(() => calls.length === 3);
    expect(calls[2].command).not.toContain("--resume");
    expect(calls[2].prompt).toMatch(/^Your previous attempt ran out of time/);
    expect(calls[2].prompt).toContain("Add login");
    calls[2].finish("<artifact>plan</artifact>");
    expect((await h.done).status).toBe("done");
  });

  it("triage resume: the agent continues its session with the triage notes", async () => {
    const { sandbox, calls } = fakeSandbox();
    const h = start(sandbox, async () => JSON.stringify({ action: "resume", reason: "close", notes: "Use the existing auth module" }));
    await until(() => calls.length === 1);
    calls[0].fail(new Error("claude exited with code 1: gave up"));
    await until(() => calls.length === 2);
    expect(calls[1].command).toContain("--resume 'sess-1'");
    expect(calls[1].prompt).toMatch(/Triage notes: Use the existing auth module$/);
    calls[1].finish("<artifact>plan</artifact>");
    expect((await h.done).status).toBe("done");
  });
});
