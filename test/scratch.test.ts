import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RunContext } from "../backend/engine";
import { DEFAULT_FLOW, BUILTIN_BLOCKS } from "../shared/library";

const created: Record<string, unknown>[] = [];
const closed: string[] = [];
vi.mock("@ai-hero/sandcastle", () => ({
  createSandbox: async (opts: Record<string, unknown>) => {
    // A scratch workspace must be an empty git repo with a commit, or sandcastle can't make a worktree.
    const dir = opts.cwd as string;
    const emptyRepo = fs.existsSync(dir) && fs.readdirSync(dir).join() === ".git" && /^[0-9a-f]{40}$/.test(execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir }).toString().trim());
    created.push({ ...opts, emptyRepo });
    return { worktreePath: `${opts.cwd}/wt`, close: async () => (closed.push(opts.cwd as string), {}) };
  },
}));
vi.mock("@ai-hero/sandcastle/sandboxes/no-sandbox", () => ({ noSandbox: () => ({ tag: "none" }) }));

const { createScratchWorkspace, getSandbox, usesScratchWorkspace } = await import("../backend/runners/ai");

function ctx(env: Record<string, string>): RunContext {
  return {
    settings: { startingPrompt: "", sandbox: "none", maxSteps: 10 },
    env,
    flow: DEFAULT_FLOW,
    blocks: BUILTIN_BLOCKS,
    run: { id: "r1", flowId: "f", flowName: "F", status: "running", startedAt: 0, nodes: {}, logs: [] },
    log: () => {},
    abort: new AbortController(),
    installedSkills: new Set(),
    cleanup: [],
  } as unknown as RunContext;
}

beforeEach(() => {
  created.length = 0;
  closed.length = 0;
});

describe("scratch workspace (no REPO_PATH)", () => {
  it("is used only when REPO_PATH is empty", () => {
    expect(usesScratchWorkspace(ctx({}))).toBe(true);
    expect(usesScratchWorkspace(ctx({ REPO_PATH: "  " }))).toBe(true);
    expect(usesScratchWorkspace(ctx({ REPO_PATH: "/repo" }))).toBe(false);
  });

  it("creates an empty git repo in a temp dir", async () => {
    const dir = await createScratchWorkspace();
    try {
      expect(fs.readdirSync(dir)).toEqual([".git"]);
      expect(execFileSync("git", ["log", "--format=%s"], { cwd: dir }).toString().trim()).toBe("Empty workspace");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("runs the sandbox in a fresh workspace and removes it after the run", async () => {
    const c = ctx({ BASE_BRANCH: "develop" });
    await getSandbox(c);
    expect(created).toHaveLength(1);
    const dir = created[0].cwd as string;
    expect(created[0].emptyRepo).toBe(true);
    expect(created[0].baseBranch).toBeUndefined();
    expect(c.run.branch).toBeUndefined();
    expect(fs.existsSync(dir)).toBe(true);
    for (const fn of c.cleanup) await fn();
    expect(closed).toEqual([dir]);
    expect(fs.existsSync(dir)).toBe(false);
  });

  it("uses the project when REPO_PATH is set", async () => {
    const c = ctx({ REPO_PATH: "/repo", BASE_BRANCH: "develop" });
    await getSandbox(c);
    expect(created[0]).toMatchObject({ cwd: "/repo", baseBranch: "develop", branch: "sandflow/r1" });
    expect(c.run.branch).toBe("sandflow/r1");
  });
});
