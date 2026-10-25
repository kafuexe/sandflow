// Regression: an agent's own env (Inputs, gateway settings, Claude Code's pinned side models) must reach the agent
// process. sandcastle's `sandbox.run` drops the agent provider's env, so the sandbox's exec hands it over.

import os from "node:os";
import { describe, expect, it } from "vitest";
import { stoppableProvider, takeAgentEnv, withAgentEnv } from "../backend/sandbox";
import { capRunActivity, type AgentActivity } from "../shared/activity";
import { auxModelEnv, isClaudeModel } from "../shared/agents";

const fakeAgent = () => ({
  name: "claude-code",
  buildPrintCommand: ({ prompt }: { prompt: string }) => ({ command: "claude --print --model 'glm-4.6' -p -", stdin: prompt }),
});

describe("agent env reaches the agent process", () => {
  it("on this computer: in the process env, never on the command line", async () => {
    const fake = {
      create: async (_o: { env?: Record<string, string> }) => ({
        worktreePath: os.tmpdir(),
        exec: async (_cmd: string, _o?: unknown) => ({ stdout: "", stderr: "", exitCode: 0 }),
        close: async () => ({}),
      }),
    };
    const handle = await stoppableProvider(fake, "none", new AbortController().signal).create({ env: { FROM_SANDBOX: "s" } });
    const { agent, release } = withAgentEnv(fakeAgent(), { ANTHROPIC_SMALL_FAST_MODEL: "glm-4.6", SECRET: "it's $HOME" });
    const { command, stdin } = agent.buildPrintCommand({ prompt: "hi" });
    expect(stdin).toBe("hi");
    expect(command).not.toContain("glm-4.6'; ");
    expect(command).not.toContain("it's");
    const echo = command.replace(/claude .*$/, 'printf "%s|%s|%s" "$ANTHROPIC_SMALL_FAST_MODEL" "$SECRET" "$FROM_SANDBOX"');
    const r = await handle.exec(echo);
    expect(r.stdout).toBe("glm-4.6|it's $HOME|s");
    release();
    // Released: the marker is still removed, nothing is added.
    expect((await handle.exec(echo)).stdout).toBe("||s");
  });

  it("in a container: through a private file the command sources and removes; values never on a command line", async () => {
    const calls: { cmd: string; stdin?: string }[] = [];
    const fake = {
      create: async (_o: { env?: Record<string, string> }) => ({
        worktreePath: "/home/agent/workspace",
        exec: async (cmd: string, o?: { stdin?: string }) => {
          calls.push({ cmd, stdin: o?.stdin });
          return { stdout: cmd === "cat /etc/hostname" ? "abc123def456\n" : "", stderr: "", exitCode: 0 };
        },
        close: async () => ({}),
      }),
    };
    const handle = await stoppableProvider(fake, "docker", new AbortController().signal, async () => ({ code: 0, stdout: "", stderr: "" })).create({ env: {} });
    const { agent, release } = withAgentEnv(fakeAgent(), { ANTHROPIC_BASE_URL: "http://gw", TOKEN: "a'b" });
    await handle.exec(agent.buildPrintCommand({ prompt: "p" }).command, { stdin: "p" } as never);
    release();
    const [write, run] = calls.slice(-2);
    expect(write.cmd).toMatch(/^umask 077 && cat > \/tmp\/\.sandflow-env-[\w-]+$/);
    expect(write.stdin).toBe(`export ANTHROPIC_BASE_URL='http://gw'\nexport TOKEN='a'\\''b'\n`);
    const file = write.cmd.split("> ")[1];
    // The shell also records its pid, so steering can stop just this agent (see the steer tests).
    expect(run.cmd).toMatch(new RegExp(`^\\. ${file}; rm -f ${file}; echo \\$\\$ > /tmp/\\.sandflow-pid-[\\w-]+; claude --print --model 'glm-4\\.6' -p -$`));
    expect(run.stdin).toBe("p");
    for (const c of calls) expect(c.cmd).not.toContain("http://gw");
  });

  it("other commands are untouched", () => {
    expect(takeAgentEnv("git status")).toEqual({ command: "git status" });
  });
});

describe("which models count as Claude's (no side-model pinning behind a gateway)", () => {
  it("bare Claude names and aliases only; a gateway's provider-prefixed names get pinned", () => {
    for (const m of ["claude-sonnet-4-5", "claude-opus-4-8[1m]", "sonnet", "opus[1m]", "haiku", "opusplan"]) expect(isClaudeModel(m)).toBe(true);
    for (const m of ["glm-4.6", "anthropic/claude-sonnet-4", "bedrock/anthropic.claude-3-haiku", "openrouter/anthropic/claude-3.5-sonnet", "my-claude", "sonnet-ish"]) {
      expect(isClaudeModel(m)).toBe(false);
    }
    expect(auxModelEnv("claudeCode", "anthropic/claude-sonnet-4", {}, true).ANTHROPIC_SMALL_FAST_MODEL).toBe("anthropic/claude-sonnet-4");
  });
});

describe("run-wide activity cap", () => {
  const item = (ts: number, n: number): AgentActivity => ({ ts, kind: "text", text: "x".repeat(n) });
  it("drops the oldest items across nodes; each node keeps its latest", () => {
    const all = { a: [item(1, 50), item(3, 50), item(5, 50)], b: [item(2, 50), item(4, 50)] };
    capRunActivity(all, 120);
    expect(all.a.map((x) => x.ts)).toEqual([5]);
    expect(all.b.map((x) => x.ts)).toEqual([4]);
    const small = { a: [item(1, 10)] };
    capRunActivity(small, 120);
    expect(small.a).toHaveLength(1);
  });
});
