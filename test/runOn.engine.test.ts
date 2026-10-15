// The engine running a real AI runner with sandcastle mocked: where does each agent end up?

import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const created: { tag: string; cwd: string; branch: string; baseBranch?: string }[] = [];
const dockerOpts: unknown[] = [];

vi.mock("@ai-hero/sandcastle", () => ({
  claudeCode: (model: string, opts: unknown) => ({ name: "claude-code", model, opts }),
  createSandbox: async (o: { sandbox: { tag: string }; cwd: string; branch: string; baseBranch?: string }) => {
    created.push({ tag: o.sandbox.tag, cwd: o.cwd, branch: o.branch, baseBranch: o.baseBranch });
    return {
      worktreePath: `${o.cwd}/.sandcastle/worktrees/x`,
      exec: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
      run: async () => ({ stdout: `<artifact>${o.sandbox.tag}</artifact>`, commits: [], iterations: [] }),
      close: async () => ({}),
    };
  },
}));
vi.mock("@ai-hero/sandcastle/sandboxes/no-sandbox", () => ({ noSandbox: () => ({ tag: "none" }) }));
vi.mock("@ai-hero/sandcastle/sandboxes/docker", () => ({ docker: (o: unknown) => (dockerOpts.push(o), { tag: "bind-mount" }) }));
// Docker "is running and has the image" — only container agents may ask.
const execCalls: string[][] = [];
vi.mock("../backend/sandbox", async (orig) => {
  const real = await orig<typeof import("../backend/sandbox")>();
  return {
    ...real,
    ensureSandboxReady: async (s: { sandbox: string }) => {
      if (s.sandbox !== "none") execCalls.push(["preflight", s.sandbox]);
    },
  };
});

const { startRun } = await import("../backend/engine");
const { runAi } = await import("../backend/runners/ai");
const { BUILTIN_BLOCKS } = await import("../shared/library");
type Flow = import("../shared/types").Flow;
type Settings = import("../shared/types").Settings;

const flow = (runOn?: "host" | "sandbox", nodeRunOn?: "host" | "sandbox"): Flow => ({
  id: "f",
  name: "F",
  ...(runOn ? { runOn } : {}),
  nodes: [
    { id: "plan", type: "block", position: { x: 0, y: 0 }, data: { blockId: "plan", ...(nodeRunOn ? { overrides: { runOn: nodeRunOn } } : {}) } },
    { id: "impl", type: "block", position: { x: 0, y: 0 }, data: { blockId: "implement" } },
  ],
  edges: [{ id: "e", source: "plan", target: "impl", sourceHandle: "artifact", targetHandle: "artifact" }],
});

const settings: Settings = { startingPrompt: "do it", sandbox: "docker", maxSteps: 10 };
const noop = async () => ({ outputs: {} });

async function run(f: Flow, env: Record<string, string>, s: Settings = settings) {
  const h = startRun({ flow: f, blocks: BUILTIN_BLOCKS, env, settings: s, runners: { ai: runAi, auto: noop } });
  return h.done;
}

beforeEach(() => {
  created.length = 0;
  dockerOpts.length = 0;
  execCalls.length = 0;
});
const scratch: string[] = [];
afterEach(() => {
  for (const d of scratch.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe("engine: where agents run", () => {
  it("a flow set to this computer runs every agent on the host, with no container pre-flight", async () => {
    const final = await run(flow("host"), { REPO_PATH: "/repo", ANTHROPIC_API_KEY: "" });
    expect(final.status).toBe("done");
    expect(created).toEqual([{ tag: "none", cwd: "/repo", branch: `sandflow/${final.id}`, baseBranch: undefined }]);
    expect(execCalls).toEqual([]);
    expect(final.nodes.plan.outputs?.artifact).toBe("none");
  });

  it("mixes: one node on this computer, the rest in the Settings container, on the same branch", async () => {
    const final = await run(flow(undefined, "host"), { REPO_PATH: "/repo", BASE_BRANCH: "main" });
    expect(final.status).toBe("done");
    expect(created.map((c) => c.tag)).toEqual(["none", "bind-mount"]);
    expect(new Set(created.map((c) => c.branch)).size).toBe(1);
    expect(execCalls).toEqual([["preflight", "docker"]]);
    expect(final.nodes.plan.outputs?.artifact).toBe("none");
    expect(final.nodes.impl.outputs?.artifact).toBe("bind-mount");
  });

  it("a node can ask for a container while Settings → Sandbox is None (Docker)", async () => {
    const final = await run(flow(undefined, "sandbox"), { REPO_PATH: "/repo" }, { ...settings, sandbox: "none" });
    expect(created.map((c) => c.tag)).toEqual(["bind-mount", "none"]);
    expect(execCalls).toEqual([["preflight", "docker"]]);
    expect(final.status).toBe("done");
  });

  it("without a project path, agents on this computer work in a scratch git repo", async () => {
    const final = await run(flow("host"), { BASE_BRANCH: "main" });
    expect(final.status).toBe("done");
    expect(created).toHaveLength(1);
    const dir = created[0].cwd;
    scratch.push(dir);
    expect(fs.existsSync(`${dir}/.git`)).toBe(true);
    expect(created[0].baseBranch).toBeUndefined();
    expect(final.logs.some((l) => l.msg.includes(dir))).toBe(true);
  });
});
