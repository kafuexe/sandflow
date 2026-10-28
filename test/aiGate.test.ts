import { describe, expect, it } from "vitest";
import { runAi } from "../backend/runners/ai";
import { applyConfig, resolveBlock } from "../shared/resolve";
import { BUILTIN_BLOCKS, DEFAULT_FLOW } from "../shared/library";
import type { RunContext } from "../backend/engine";
import type { NodeUsage } from "../shared/types";

function fakeSandbox(outputs: string[], exec: (cmd: string) => { exitCode: number; stdout?: string } = () => ({ exitCode: 0, stdout: "" })) {
  const calls = { exec: [] as string[], run: 0, resume: [] as string[] };
  const result = (stdout: string): any => ({
    stdout,
    commits: [],
    iterations: [{ usage: { inputTokens: 1000, outputTokens: 100, cacheCreationInputTokens: 10, cacheReadInputTokens: 50 } }],
    resume: async (p: string) => (calls.resume.push(p), result(outputs.shift() ?? "")),
  });
  return {
    calls,
    sandbox: {
      exec: async (cmd: string) => (calls.exec.push(cmd), { stderr: "", ...exec(cmd) }),
      run: async () => (calls.run++, result(outputs.shift() ?? "")),
      close: async () => ({}),
    },
  };
}

function ctx(sandbox: unknown, usage: Omit<NodeUsage, "at">[] = [], env: Record<string, string> = {}): RunContext {
  const all = { REPO_PATH: "/r", ANTHROPIC_API_KEY: "k", BASE_BRANCH: "main", ...env };
  return {
    settings: { startingPrompt: "Build it", sandbox: "docker", maxSteps: 10 },
    env: all,
    flow: DEFAULT_FLOW,
    blocks: BUILTIN_BLOCKS,
    sandbox,
    run: { id: "r", flowId: "f", flowName: "F", status: "running", startedAt: 0, nodes: {}, logs: [] },
    blockEnv: (cfg: any) => Object.fromEntries(cfg.env.filter((k: string) => k in all).map((k: string) => [k, (all as any)[k]])),
    log: () => {},
    ask: async () => "",
    abort: new AbortController(),
    installedSkills: new Set(),
    cleanup: [],
    noteUsage: (_n: string, u: Omit<NodeUsage, "at">) => usage.push(u),
    loadSkill: async () => [{ path: "SKILL.md", content: "skill" }],
  } as unknown as RunContext;
}

const node = { id: "t", type: "block" as const, position: { x: 0, y: 0 }, data: { blockId: "cr" } };
const gate = (patch = {}) => applyConfig(resolveBlock("cr", BUILTIN_BLOCKS), { verdict: true, skills: [], ...patch });

describe("agent gates", () => {
  it("leaves through the agent's verdict", async () => {
    const { sandbox } = fakeSandbox(["<artifact>all good</artifact><verdict>PASS</verdict>"]);
    const r = await runAi(ctx(sandbox), node, gate(), { artifact: "plan" });
    expect(r.exit).toBe("pass");
    expect(r.outputs.artifact).toBe("all good");
  });

  it("asks once more for a missing verdict, then counts it as FAIL", async () => {
    const { sandbox, calls } = fakeSandbox(["<artifact>hmm</artifact>", "<artifact>still hmm</artifact>"]);
    const r = await runAi(ctx(sandbox), node, gate(), {});
    expect(calls.resume).toHaveLength(1);
    expect(calls.resume[0]).toMatch(/didn't give a verdict/);
    expect(r.exit).toBe("fail");
    expect(r.outputs.artifact).toMatch(/No valid verdict/);
  });

  it("passes without running the agent when only docs changed", async () => {
    const { sandbox, calls } = fakeSandbox([], (cmd) => (cmd.includes("git diff --name-only") ? { exitCode: 0, stdout: "README.md\ndocs/a.md\n" } : { exitCode: 0, stdout: "" }));
    const r = await runAi(ctx(sandbox), node, gate({ skipDocsOnly: true }), { steer: "s" });
    expect(calls.run).toBe(0);
    expect(r.exit).toBe("pass");
    expect(r.outputs.artifact).toMatch(/only changes documentation/);
  });

  it("runs the agent when code changed", async () => {
    const { sandbox, calls } = fakeSandbox(["<verdict>FAIL</verdict>"], (cmd) => (cmd.includes("git diff --name-only") ? { exitCode: 0, stdout: "src/a.ts\n" } : { exitCode: 0, stdout: "" }));
    const r = await runAi(ctx(sandbox), node, gate({ skipDocsOnly: true }), {});
    expect(calls.run).toBe(1);
    expect(r.exit).toBe("fail");
  });

  it("starts the dev server first and stops it after the agent", async () => {
    const { sandbox, calls } = fakeSandbox(["<verdict>PASS</verdict>"]);
    await runAi(ctx(sandbox), node, gate({ devServer: { command: "npm run dev", readyUrl: "http://127.0.0.1:3000/" } }), {});
    const start = calls.exec.findIndex((c) => c.includes("setsid sh -c 'npm run dev'"));
    const probe = calls.exec.findIndex((c) => c.includes("http://127.0.0.1:3000/"));
    const stop = calls.exec.findIndex((c) => c.startsWith("kill -TERM"));
    expect(start).toBeGreaterThanOrEqual(0);
    expect(probe).toBeGreaterThan(start);
    expect(stop).toBeGreaterThan(probe);
  });

  it("fails when the dev server never gets ready, and stops it", async () => {
    const { sandbox, calls } = fakeSandbox([], (cmd) => (cmd.startsWith("kill -0") || cmd.includes("node -e") ? { exitCode: 1 } : { exitCode: 0, stdout: "" }));
    await expect(runAi(ctx(sandbox), node, gate({ devServer: { command: "npm run dev", readyUrl: "http://x/" } }), {})).rejects.toThrow(/stopped before it was ready/);
    expect(calls.run).toBe(0);
    expect(calls.exec.some((c) => c.startsWith("kill -TERM"))).toBe(true);
  });
});

describe("agent usage", () => {
  it("records cache tokens and the Claude model for pricing", async () => {
    const usage: Omit<NodeUsage, "at">[] = [];
    const { sandbox } = fakeSandbox(["<artifact>x</artifact>"]);
    const cfg = applyConfig(resolveBlock("cr", BUILTIN_BLOCKS), { skills: [], agent: { model: "claude-sonnet-5-5" } });
    await runAi(ctx(sandbox, usage), node, cfg, {});
    expect(usage).toEqual([{ inputTokens: 1000, outputTokens: 100, cacheReadTokens: 50, cacheWriteTokens: 10, model: "claude-sonnet-5-5" }]);
  });
});
