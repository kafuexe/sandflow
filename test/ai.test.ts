import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { agentEnv, agentFlag, installFileSkill, runAi, sandboxBranch, skillInstallCommand } from "../backend/runners/ai";
import { resolveBlock } from "../shared/resolve";
import { BUILTIN_BLOCKS, DEFAULT_FLOW } from "../shared/library";
import type { RunContext } from "../backend/engine";

function fakeSandbox(outputs: string[]) {
  const calls = { exec: [] as string[], run: [] as any[], resume: [] as string[] };
  const result = (stdout: string): any => ({
    stdout,
    commits: [],
    iterations: [{ usage: { inputTokens: 1, outputTokens: 2, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 } }],
    resume: async (p: string) => {
      calls.resume.push(p);
      return result(outputs.shift() ?? "");
    },
  });
  return {
    calls,
    sandbox: {
      exec: async (cmd: string, _o?: { stdin?: string }) => (calls.exec.push(cmd), { exitCode: 0, stdout: "", stderr: "" }),
      run: async (opts: any) => (calls.run.push(opts), result(outputs.shift() ?? "")),
      close: async () => ({}),
    },
  };
}

function ctx(sandbox: unknown, answers: string[] = []): RunContext {
  const env = { REPO_PATH: "/r", ANTHROPIC_API_KEY: "k" };
  return {
    settings: { startingPrompt: "Build it", sandbox: "docker", maxSteps: 10 },
    env,
    flow: DEFAULT_FLOW,
    blocks: BUILTIN_BLOCKS,
    sandbox,
    run: { id: "r", flowId: "f", flowName: "F", status: "running", startedAt: 0, nodes: {}, logs: [] },
    blockEnv: (cfg: any) => Object.fromEntries(cfg.env.filter((k: string) => k in env).map((k: string) => [k, (env as any)[k]])),
    log: () => {},
    ask: async () => answers.shift() ?? "",
    abort: new AbortController(),
    installedSkills: new Set(),
    cleanup: [],
    loadSkill: async () => [{ path: "SKILL.md", content: "skill" }],
  } as unknown as RunContext;
}

const node = (id: string, blockId: string) => DEFAULT_FLOW.nodes.find((n) => n.id === id) ?? { id, type: "block" as const, position: { x: 0, y: 0 }, data: { blockId } };

describe("ai runner helpers", () => {
  it("maps agent flags", () => {
    expect(agentFlag("claudeCode")).toBe("claude-code");
    expect(agentFlag("copilot")).toBe("github-copilot");
    expect(agentFlag("pi")).toBeUndefined();
  });
  it("builds a safe skill install command and rejects unsafe refs", () => {
    expect(skillInstallCommand({ name: "tdd", source: "mattpocock/skills" }, "claudeCode")).toBe(
      "npx -y skills@latest add mattpocock/skills --skill tdd -g -a claude-code -y",
    );
    expect(skillInstallCommand({ name: "tdd", source: "a/b" }, "pi")).toBe("npx -y skills@latest add a/b --skill tdd -g -y");
    expect(skillInstallCommand({ name: "x; rm -rf /", source: "a/b" }, "claudeCode")).toBeUndefined();
    expect(skillInstallCommand({ name: "x", source: "a/b$(id)" }, "claudeCode")).toBeUndefined();
  });
});

describe("agentEnv", () => {
  const base = resolveBlock("plan", BUILTIN_BLOCKS);
  it("passes block env through unchanged when no endpoint is set", () => {
    expect(agentEnv(base, { A: "1" })).toEqual({ A: "1" });
  });
  it("maps the endpoint to the provider's base-URL variable", () => {
    const claude = { ...base, agent: { ...base.agent, endpoint: "https://llm.corp.local/anthropic" } };
    expect(agentEnv(claude, { A: "1" })).toEqual({ A: "1", ANTHROPIC_BASE_URL: "https://llm.corp.local/anthropic" });
    const codex = { ...base, agent: { ...base.agent, provider: "codex" as const, endpoint: "http://h:8080/v1" } };
    expect(agentEnv(codex, {})).toEqual({ OPENAI_BASE_URL: "http://h:8080/v1" });
  });
  it("uses an explicit env var name, and requires one for providers without a default", () => {
    const custom = { ...base, agent: { ...base.agent, provider: "opencode" as const, endpoint: "http://h", endpointEnv: "MY_URL" } };
    expect(agentEnv(custom, {})).toEqual({ MY_URL: "http://h" });
    const missing = { ...base, agent: { ...base.agent, provider: "opencode" as const, endpoint: "http://h" } };
    expect(() => agentEnv(missing, {})).toThrow(/env var/i);
  });
});

describe("file skills", () => {
  const files = [
    { path: "SKILL.md", content: "---\nname: pack\n---\nbody" },
    { path: "scripts/run.sh", content: "#!/bin/sh\necho hi" },
  ];

  it("copies files into ~/.claude/skills inside a container sandbox via stdin", async () => {
    const execs: { cmd: string; stdin?: string }[] = [];
    const sandbox = { exec: async (cmd: string, o?: { stdin?: string }) => (execs.push({ cmd, stdin: o?.stdin }), { exitCode: 0 }) };
    const c = ctx(sandbox);
    c.settings = { ...c.settings, sandbox: "docker" };
    await installFileSkill(c, sandbox as never, "claudeCode", { name: "pack", file: { store: "user", dir: "pack" } }, files, "n");
    expect(execs.find((e) => e.stdin === "---\nname: pack\n---\nbody")?.cmd).toContain('"$HOME/.claude/skills/pack/SKILL.md"');
    expect(execs.find((e) => e.stdin?.startsWith("#!"))?.cmd).toContain("mkdir -p \"$HOME/.claude/skills/pack/scripts\"");
    expect(execs.some((e) => e.cmd.includes("chmod +x") && e.cmd.includes("scripts/run.sh"))).toBe(true);
  });

  it("writes to the host home dir when there is no sandbox", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "sandflow-home-"));
    try {
      const c = ctx({});
      c.settings = { ...c.settings, sandbox: "none" };
      await installFileSkill(c, {} as never, "claudeCode", { name: "pack", file: { store: "user", dir: "pack" } }, files, "n", home);
      expect(fs.readFileSync(path.join(home, ".claude", "skills", "pack", "scripts", "run.sh"), "utf8")).toBe("#!/bin/sh\necho hi");
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("skips file skills for agents without a known skills dir", async () => {
    const logs: string[] = [];
    const c = ctx({});
    c.log = (_l, m) => void logs.push(m);
    await installFileSkill(c, {} as never, "codex", { name: "pack", file: { store: "user", dir: "pack" } }, files, "n");
    expect(logs.join()).toMatch(/only supported for claudeCode/i);
  });

  it("runAi installs file skills through the context loader instead of npx", async () => {
    const { sandbox, calls } = fakeSandbox(["<artifact>A</artifact>"]);
    const c = ctx(sandbox);
    c.settings = { ...c.settings, sandbox: "docker" };
    c.loadSkill = async () => files;
    const cfg = resolveBlock("plan", BUILTIN_BLOCKS);
    await runAi(c, node("n-plan", "plan"), cfg, {});
    expect(calls.exec.some((cmd) => cmd.includes("npx"))).toBe(false);
    expect(calls.exec.some((cmd) => cmd.includes(".claude/skills/writing-plans/SKILL.md"))).toBe(true);
  });
});

describe("sandboxBranch", () => {
  it("falls back when BRANCH_NAME is blank", () => {
    const c = ctx(undefined);
    c.env = { BRANCH_NAME: "  " };
    expect(sandboxBranch(c)).toBe("sandflow/r");
    c.env = { BRANCH_NAME: "feat/x" };
    expect(sandboxBranch(c)).toBe("feat/x");
    c.branch = "from-task";
    expect(sandboxBranch(c)).toBe("from-task");
  });
});

describe("runAi", () => {
  it("installs skills once, runs an inline prompt and parses outputs", async () => {
    const { sandbox, calls } = fakeSandbox(["<artifact>PLAN</artifact><steer>S</steer>", "<artifact>P2</artifact>"]);
    const c = ctx(sandbox);
    const cfg = resolveBlock("plan", BUILTIN_BLOCKS);
    const res = await runAi(c, node("n-plan", "plan"), cfg, { artifact: "task" });
    expect(res.outputs).toEqual({ artifact: "PLAN", steer: "S" });
    const installs = calls.exec.length;
    expect(installs).toBeGreaterThanOrEqual(2);
    expect(calls.run[0].prompt).toContain("# Input artifact\ntask");
    expect(calls.run[0].promptFile).toBeUndefined();
    expect(calls.run[0].promptArgs).toBeUndefined();
    await runAi(c, node("n-plan", "plan"), cfg, {});
    expect(calls.exec).toHaveLength(installs);
  });

  it("falls back to stdout tail when no artifact tag", async () => {
    const { sandbox } = fakeSandbox(["just text"]);
    const res = await runAi(ctx(sandbox), node("n-plan", "plan"), resolveBlock("plan", BUILTIN_BLOCKS), {});
    expect(res.outputs.artifact).toBe("just text");
  });

  it("asks the user and resumes when questions are allowed", async () => {
    const { sandbox, calls } = fakeSandbox(["<question>Which DB?</question>", "<artifact>use pg</artifact>"]);
    const cfg = { ...resolveBlock("plan", BUILTIN_BLOCKS), allowQuestions: true };
    const res = await runAi(ctx(sandbox, ["Postgres"]), node("n-plan", "plan"), cfg, {});
    expect(res.outputs.artifact).toBe("use pg");
    expect(calls.resume[0]).toContain("Postgres");
  });

  it("ignores questions when not allowed", async () => {
    const { sandbox, calls } = fakeSandbox(["<question>Which DB?</question><artifact>A</artifact>"]);
    const res = await runAi(ctx(sandbox), node("n-plan", "plan"), resolveBlock("plan", BUILTIN_BLOCKS), {});
    expect(res.outputs.artifact).toBe("A");
    expect(calls.resume).toHaveLength(0);
  });

  it("manager: lists routes, retries once on invalid route, passes artifact through", async () => {
    const { sandbox, calls } = fakeSandbox(["<route>nope</route>", "<route>n-create-mr</route>"]);
    const cfg = resolveBlock("manager", BUILTIN_BLOCKS);
    const res = await runAi(ctx(sandbox), node("n-manager", "manager"), cfg, { artifact: "REVIEW", steer: "fix" });
    expect(calls.run[0].prompt).toContain("n-cr-fix");
    expect(calls.run[0].prompt).toContain("n-create-mr");
    expect(res.route).toBe("n-create-mr");
    expect(res.outputs).toEqual({ artifact: "REVIEW", steer: "fix" });
  });
});
