// Steering a working agent node mid-run: the message interrupts its turn and resumes the same session (agents that
// can resume), or waits for its next turn (agents that can't). Stop still stops everything.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startRun, type NodeRunner, type RunContext } from "../backend/engine";
import { runTree } from "../backend/proc";
import { runAi } from "../backend/runners/ai";
import { resumingAgent, steerPrompt } from "../backend/runners/steer";
import { containerKillScript, pidRecordingCommand, stoppableProvider, withAgentEnv } from "../backend/sandbox";
import { BUILTIN_BLOCKS } from "../shared/library";
import type { BlockConfig, Flow, RunState, Settings } from "../shared/types";

const posix = process.platform !== "win32";
const settings: Settings = { startingPrompt: "Add login", sandbox: "docker", maxSteps: 40 };
const env = { REPO_PATH: "/r", ANTHROPIC_API_KEY: "k", BRANCH_NAME: "feat/x" };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const dirs: string[] = [];
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "sandflow-steer-"));
  dirs.push(d);
  return d;
};
afterEach(() => dirs.splice(0).forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

async function until(cond: () => boolean, ms = 3000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await sleep(5);
  }
}

const flowWith = (overrides: BlockConfig = {}): Flow => ({
  id: "f",
  name: "F",
  nodes: [
    { id: "a", type: "block", position: { x: 0, y: 0 }, data: { blockId: "plan", overrides: { skills: [], ...overrides } } },
    { id: "b", type: "block", position: { x: 300, y: 0 }, data: { blockId: "plan", overrides: { skills: [] } } },
  ],
  edges: [{ id: "e", source: "a", sourceHandle: "artifact", target: "b", targetHandle: "artifact" }],
});

interface Call {
  prompt: string;
  command: string;
  maxIterations?: number;
  signal: AbortSignal;
  finish(stdout: string): void;
}

/** sandcastle's sandbox, faked: every `run` starts its session (stream init line) and waits until the test finishes it or it is aborted. */
function fakeSandbox(o: { session?: (n: number) => string; resumable?: boolean } = {}) {
  const calls: Call[] = [];
  const result = (stdout: string): any => ({
    stdout,
    commits: [],
    iterations: [{}],
    ...(o.resumable === false ? {} : { resume: (p: string, ro: any) => sandbox.run({ agent: lastAgent, prompt: p, maxIterations: 1, ...ro }) }),
  });
  let lastAgent: any;
  const sandbox = {
    exec: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
    close: async () => ({}),
    run: (opts: any) =>
      new Promise((resolve, reject) => {
        lastAgent = opts.agent;
        const built = opts.agent.buildPrintCommand({ prompt: opts.prompt, dangerouslySkipPermissions: true });
        const call: Call = { prompt: opts.prompt, command: built.command, maxIterations: opts.maxIterations, signal: opts.signal, finish: (s) => resolve(result(s)) };
        calls.push(call);
        if (opts.signal?.aborted) return reject(opts.signal.reason);
        opts.signal?.addEventListener("abort", () => reject(opts.signal.reason), { once: true });
        const id = o.session?.(calls.length) ?? "sess-1";
        opts.logging?.onAgentStreamEvent?.({ type: "raw", line: JSON.stringify({ type: "system", subtype: "init", session_id: id }), iteration: 1 });
      }),
  };
  return { sandbox, calls };
}

function start(flow: Flow, sandbox: unknown, runners?: { ai?: NodeRunner; auto?: NodeRunner }) {
  const states: RunState[] = [];
  const ai: NodeRunner = (ctx: RunContext, node, cfg, inputs) => {
    ctx.sandbox = sandbox;
    return runAi(ctx, node, cfg, inputs);
  };
  const h = startRun({
    flow,
    blocks: BUILTIN_BLOCKS,
    env,
    settings,
    logRoot: tmp(),
    runners: { auto: runners?.auto ?? ai, ai: runners?.ai ?? ai },
    onChange: (s) => states.push(s),
  });
  return { h, states };
}

describe("steering a running agent", () => {
  it("interrupts the turn and resumes the same session with the message; the node goes on (not failed, not stopped)", async () => {
    const { sandbox, calls } = fakeSandbox();
    const { h } = start(flowWith(), sandbox);
    await until(() => calls.length === 1);

    const r = h.steer("a", "Focus on the tests, don't touch the API");
    expect(r.ok).toBe(true);
    await until(() => calls.length === 2);

    // The first turn was aborted by steering — not by Stop.
    expect(calls[0].signal.aborted).toBe(true);
    expect(calls[0].signal.reason).toBe("steered");
    expect(h.state.status).toBe("running");
    expect(h.state.nodes.a.status).toBe("running");
    // Same session, with the message as the next user turn.
    expect(calls[1].command).toContain("--resume 'sess-1'");
    expect(calls[1].maxIterations).toBe(1);
    expect(calls[1].prompt).toBe(steerPrompt(["Focus on the tests, don't touch the API"], true));
    expect(calls[1].prompt).toMatch(/steering message while you were working[\s\S]*Continue the task taking it into account/);

    calls[1].finish("<artifact>plan v2</artifact>");
    await until(() => calls.length === 3);
    calls[2].finish("<artifact>done</artifact>");
    const run = await h.done;

    expect(run.status).toBe("done");
    expect(run.nodes.a.status).toBe("done");
    expect(run.nodes.a.outputs?.artifact).toBe("plan v2");
    expect(run.steers).toEqual([
      expect.objectContaining({ nodeId: "a", message: "Focus on the tests, don't touch the API", status: "applied", how: "interrupt" }),
    ]);
    expect(run.logs.some((l) => l.nodeId === "a" && l.msg === "Steered by user: Focus on the tests, don't touch the API")).toBe(true);
    // A distinct "steer" item in the node's AI activity.
    expect(run.activity?.a).toEqual([expect.objectContaining({ kind: "steer", text: "Focus on the tests, don't touch the API", exec: 1 })]);
    // The next node starts fresh (no resume).
    expect(calls[2].command).not.toContain("--resume");
  });

  it("several steers queue in order; one sent during the resumed turn interrupts that one too", async () => {
    const { sandbox, calls } = fakeSandbox({ session: (n) => (n === 1 ? "s-a" : "s-a") });
    const { h } = start(flowWith(), sandbox);
    await until(() => calls.length === 1);
    expect(h.steer("a", "first").ok).toBe(true);
    expect(h.steer("a", "second").ok).toBe(true);
    await until(() => calls.length === 2);
    expect(calls[1].prompt).toContain("1. first\n2. second");
    expect(h.steer("a", "third").ok).toBe(true);
    await until(() => calls.length === 3);
    expect(calls[1].signal.reason).toBe("steered");
    expect(calls[2].command).toContain("--resume 's-a'");
    expect(calls[2].prompt).toContain("third");
    calls[2].finish("ok");
    await until(() => calls.length === 4);
    calls[3].finish("ok");
    const run = await h.done;
    expect(run.steers?.map((s) => [s.message, s.status])).toEqual([
      ["first", "applied"],
      ["second", "applied"],
      ["third", "applied"],
    ]);
    expect(run.activity?.a?.filter((x) => x.kind === "steer").map((x) => x.text)).toEqual(["first", "second", "third"]);
  });

  it("an agent that can't resume sessions gets the message at its next turn, and the user is told", async () => {
    const { sandbox, calls } = fakeSandbox({ resumable: false });
    const { h } = start(flowWith({ agent: { provider: "opencode" } }), sandbox);
    await until(() => calls.length === 1);
    expect(h.steer("a", "Keep it short").ok).toBe(true);
    await sleep(30);
    // Not interrupted: it waits for the turn to end.
    expect(calls.length).toBe(1);
    expect(calls[0].signal.aborted).toBe(false);
    expect(h.state.steers?.[0]).toMatchObject({ status: "pending", note: expect.stringMatching(/when its current turn ends/) });
    expect(h.state.logs.some((l) => /queued for its next turn/.test(l.msg))).toBe(true);

    calls[0].finish("<artifact>long plan</artifact>");
    await until(() => calls.length === 2);
    // No session to resume: a fresh turn whose prompt carries the message.
    expect(calls[1].command).not.toContain("--resume");
    expect(calls[1].prompt).toContain("# Steering from the user");
    expect(calls[1].prompt).toContain("- Keep it short");
    calls[1].finish("<artifact>short plan</artifact>");
    await until(() => calls.length === 3);
    calls[2].finish("ok");
    const run = await h.done;
    expect(run.nodes.a.outputs?.artifact).toBe("short plan");
    expect(run.steers?.[0]).toMatchObject({ status: "applied", how: "next-turn" });
  });

  it("409 for a step that isn't running, a non-agent step or an ended run; 404 for an unknown step; 400 for an empty message", async () => {
    const { sandbox, calls } = fakeSandbox();
    let release!: () => void;
    const auto: NodeRunner = () => new Promise((r) => (release = () => r({ outputs: { artifact: "x" } })));
    const flow = flowWith();
    flow.nodes[0].data.blockId = "tpl-auto-git";
    const { h } = start(flow, sandbox, { auto });
    await until(() => !!release);
    expect(h.state.nodes.a.status).toBe("running");
    expect(h.steer("a", "hi")).toMatchObject({ ok: false, status: 409, error: expect.stringMatching(/Only AI agent and manager blocks/) });
    expect(h.steer("b", "hi")).toMatchObject({ ok: false, status: 409, error: expect.stringMatching(/isn't running \(it's idle\)/) });
    expect(h.steer("nope", "hi")).toMatchObject({ ok: false, status: 404 });
    expect(h.steer("a", "   ")).toMatchObject({ ok: false, status: 400 });
    release();
    await until(() => calls.length === 1);
    expect(h.steer("a", "hi")).toMatchObject({ ok: false, status: 409, error: expect.stringMatching(/it's done/) });
    calls[0].finish("ok");
    await h.done;
    expect(h.steer("b", "hi")).toMatchObject({ ok: false, status: 409, error: expect.stringMatching(/run has ended/) });
  });

  it("a steer that lands just as the turn ends isn't lost and doesn't fail the node: it's the agent's next turn", async () => {
    const { sandbox, calls } = fakeSandbox();
    const { h } = start(flowWith(), sandbox);
    await until(() => calls.length === 1);
    calls[0].finish("<artifact>plan v1</artifact>");
    expect(h.steer("a", "also cover logout").ok).toBe(true); // same tick: the turn already ended
    await until(() => calls.length === 2);
    // The finished turn's session is followed up (sandcastle's `resume`) with the message.
    expect(calls[1].prompt).toBe(steerPrompt(["also cover logout"], false));
    calls[1].finish("<artifact>plan v2</artifact>");
    await until(() => calls.length === 3);
    calls[2].finish("<artifact>done</artifact>");
    const run = await h.done;
    expect(run.status).toBe("done");
    expect(run.nodes.a.outputs?.artifact).toBe("plan v2");
    expect(run.steers?.[0]).toMatchObject({ status: "applied", how: "next-turn" });
  });

  it("caps how many messages may wait for one agent (they're saved with the run)", async () => {
    const ai: NodeRunner = (ctx, node) => {
      ctx.steerable!(node.id, () => {}); // never reads them
      return new Promise((_r, reject) => ctx.abort.signal.addEventListener("abort", () => reject(new Error("Run cancelled"))));
    };
    const { h } = start(flowWith(), undefined, { ai });
    await until(() => h.state.nodes.a.status === "running");
    for (let i = 0; i < 20; i++) expect(h.steer("a", `m${i}`).ok).toBe(true);
    expect(h.steer("a", "one more")).toMatchObject({ ok: false, status: 409, error: expect.stringMatching(/already waiting/) });
    h.cancel();
    await h.done;
    expect(h.state.steers).toHaveLength(20);
    expect(h.state.steers!.every((s) => s.status === "dropped")).toBe(true);
  });

  it("Stop during a steer still stops everything: no resumed turn keeps going, the run ends cancelled", async () => {
    const { sandbox, calls } = fakeSandbox();
    const { h } = start(flowWith(), sandbox);
    await until(() => calls.length === 1);
    h.steer("a", "change course");
    await until(() => calls.length === 2);
    h.cancel();
    const run = await h.done;
    expect(run.status).toBe("cancelled");
    expect(calls.every((c) => c.signal.aborted)).toBe(true);
    expect(calls[1].signal.reason).not.toBe("steered");
    expect(run.nodes.b.status).toBe("idle");
    await sleep(20);
    expect(calls.length).toBe(2);
  });

  it("Stop right after a steer (before the resumed turn starts) never starts it", async () => {
    const { sandbox, calls } = fakeSandbox();
    const { h } = start(flowWith(), sandbox);
    await until(() => calls.length === 1);
    h.steer("a", "change course");
    h.cancel();
    const run = await h.done;
    await sleep(20);
    expect(run.status).toBe("cancelled");
    expect(calls.length).toBe(1);
    expect(h.steer("a", "again")).toMatchObject({ ok: false, status: 409 });
  });

  it("a steer sent before the agent's session started is delivered once the session id arrives", async () => {
    const { sandbox, calls } = fakeSandbox();
    // No init line on the first call until the test sends it.
    let emit!: () => void;
    const run0 = sandbox.run;
    sandbox.run = (opts: any) => {
      if (calls.length) return run0(opts);
      const log = opts.logging;
      emit = () => log.onAgentStreamEvent({ type: "raw", line: JSON.stringify({ type: "system", subtype: "init", session_id: "late" }) });
      return run0({ ...opts, logging: undefined });
    };
    const { h } = start(flowWith(), sandbox);
    await until(() => calls.length === 1);
    h.steer("a", "wait for me");
    await sleep(20);
    expect(calls.length).toBe(1);
    expect(h.state.steers?.[0].note).toMatch(/session to start/);
    emit();
    await until(() => calls.length === 2);
    expect(calls[1].command).toContain("--resume 'late'");
    h.cancel();
    await h.done;
  });
});

describe("resumingAgent", () => {
  it("adds the session to every command, unless the call resumes one itself", () => {
    const agent = { buildPrintCommand: (o: { resumeSession?: string }) => ({ command: `run ${o.resumeSession ?? "-"}` }) };
    const r = resumingAgent(agent, "s1");
    expect(r.buildPrintCommand({}).command).toBe("run s1");
    expect(r.buildPrintCommand({ resumeSession: "s2" }).command).toBe("run s2");
  });
});

describe.runIf(posix)("interrupting one agent's command (not the run)", () => {
  const TREE = "sleep 30 & echo $!; wait";
  const alive = (pid: number) => {
    try {
      if (process.platform === "linux") return !/^\d+ \(.*\) Z/.test(fs.readFileSync(`/proc/${pid}/stat`, "utf8"));
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const agentRunning = (cmd: string) => ({ buildPrintCommand: () => ({ command: cmd }) });

  it("on this computer: kills the agent's process tree; the run's sandbox keeps working", async () => {
    const runAbort = new AbortController();
    const fake = {
      create: async (_o?: unknown) => ({ worktreePath: os.tmpdir(), exec: async (_c: string, _o?: unknown) => ({ stdout: "", stderr: "", exitCode: 0 }), close: async () => ({}) }),
    };
    const handle = await stoppableProvider(fake, "none", runAbort.signal).create({});
    const { agent, interrupt, release } = withAgentEnv(agentRunning(TREE), {});
    let child = 0;
    const p = handle.exec(agent.buildPrintCommand().command, { onLine: (l: string) => (child = Number(l)) });
    await until(() => child > 0);
    expect(await interrupt()).toBe(true);
    expect((await p).exitCode).toBe(137);
    await until(() => !alive(child));
    expect(runAbort.signal.aborted).toBe(false);
    expect((await handle.exec("echo still here")).stdout.trim()).toBe("still here");
    // Nothing running any more: nothing to interrupt.
    expect(await interrupt()).toBe(false);
    release();
  });

  it("in a container: kills the tree the command started there (by the pid it recorded), not the container", async () => {
    const runAbort = new AbortController();
    const removed: string[][] = [];
    const seen: string[] = [];
    // Stands in for `docker exec <container> sh -c <command>`: runs it with sh, here.
    const fake = {
      create: async (_o?: unknown) => ({
        worktreePath: "/home/agent/workspace",
        exec: async (cmd: string, o?: { onLine?: (l: string) => void; stdin?: string }) => {
          seen.push(cmd);
          if (cmd === "cat /etc/hostname") return { stdout: "abc123def456\n", stderr: "", exitCode: 0 };
          const r = await runTree("sh", ["-c", cmd], { onLine: o?.onLine, stdin: o?.stdin });
          return { stdout: r.stdout, stderr: r.stderr, exitCode: r.code };
        },
        close: async () => ({}),
      }),
    };
    const handle = await stoppableProvider(fake, "docker", runAbort.signal, async (_c, args) => (removed.push(args), { code: 0, stdout: "", stderr: "" })).create({});
    const { agent, interrupt, release } = withAgentEnv(agentRunning(TREE), {});
    let child = 0;
    const p = handle.exec(agent.buildPrintCommand().command, { onLine: (l: string) => (child = Number(l)) });
    await until(() => child > 0);
    const pidFile = /echo \$\$ > (\S+);/.exec(seen.at(-1)!)![1];
    expect(await interrupt()).toBe(true);
    await p;
    await until(() => !alive(child));
    expect(seen.at(-1)).toBe(containerKillScript(pidFile));
    expect(removed).toEqual([]); // the container stays
    expect(runAbort.signal.aborted).toBe(false);
    release();
  }, 10_000);

  it("container kill script: a kill that comes before the command recorded its pid stops it from starting", async () => {
    const pid = path.join(tmp(), "pid");
    expect((await runTree("sh", ["-c", containerKillScript(pid)])).code).toBe(0);
    const r = await runTree("sh", ["-c", pidRecordingCommand(pid, "echo started")]);
    expect(r.stdout).not.toContain("started");
    expect(r.code).toBe(143);
    expect(fs.existsSync(pid) || fs.existsSync(`${pid}.stop`)).toBe(false);
  });

  it("container command: removes its pid file when it ends and keeps the command's exit code", async () => {
    const pid = path.join(tmp(), "pid");
    const r = await runTree("sh", ["-c", pidRecordingCommand(pid, "echo hi; exit 3")]);
    expect(r.stdout.trim()).toBe("hi");
    expect(r.code).toBe(3);
    expect(fs.existsSync(pid)).toBe(false);
  });

  it.runIf(process.platform === "linux")("container kill script: finds the tree through /proc when the image has no pgrep", async () => {
    const d = tmp();
    const bin = path.join(d, "bin");
    fs.mkdirSync(bin);
    // Just what the scripts need — no pgrep.
    for (const t of ["sh", "cat", "sleep", "rm", "touch"]) {
      const real = ["/usr/bin", "/bin"].map((b) => path.join(b, t)).find((f) => fs.existsSync(f))!;
      fs.symlinkSync(real, path.join(bin, t));
    }
    const pid = path.join(d, "pid");
    let child = 0;
    const p = runTree(path.join(bin, "sh"), ["-c", pidRecordingCommand(pid, TREE)], { env: { PATH: bin }, onLine: (l) => (child = Number(l)) });
    await until(() => child > 0 && fs.existsSync(pid));
    await runTree(path.join(bin, "sh"), ["-c", containerKillScript(pid)], { env: { PATH: bin } });
    await p;
    await until(() => !alive(child));
  }, 10_000);
});

describe("steerability (UI)", () => {
  const claude = { kind: "ai" as const, agent: { provider: "claudeCode" as const, model: "", effort: "high" as const } };
  const run = (status: string, finishedAt?: number) => ({ finishedAt, nodes: { a: { status, executions: 1 } } }) as any;
  it("only a working agent / manager block of a live run takes messages, and says how they arrive", async () => {
    const { steerability, offersSteer } = await import("../src/lib/steer");
    expect(steerability(run("running"), "a", claude)).toMatchObject({ can: true, hint: expect.stringMatching(/continues the same session/) });
    expect(steerability(run("running"), "a", { ...claude, agent: { ...claude.agent, provider: "opencode" } })).toMatchObject({ can: true, hint: expect.stringMatching(/current turn ends/) });
    expect(steerability(run("waiting"), "a", { ...claude, kind: "manager" }).can).toBe(true);
    expect(steerability(run("done"), "a", claude)).toMatchObject({ can: false, agent: true, hint: expect.stringMatching(/finished/) });
    expect(steerability(run("queued"), "a", claude)).toMatchObject({ can: false, hint: expect.stringMatching(/hasn't started/) });
    expect(steerability(run("running", 5), "a", claude)).toMatchObject({ can: false, hint: expect.stringMatching(/run has ended/) });
    expect(steerability(run("running"), "a", { ...claude, kind: "script" })).toMatchObject({ can: false, agent: false, hint: expect.stringMatching(/Only AI agent/) });
    expect(offersSteer(run("running"), "a", "ai")).toBe(true);
    expect(offersSteer(run("waiting"), "a", "ai")).toBe(false);
    expect(offersSteer(run("running", 1), "a", "manager")).toBe(false);
  });
});
