import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { commentCommand, mrTitle, runAuto } from "../backend/runners/auto";
import { resolveBlock } from "../shared/resolve";
import { BUILTIN_BLOCKS } from "../shared/library";
import type { RunContext } from "../backend/engine";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

function repo() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "sandflow-repo-"));
  dirs.push(d);
  const git = (...a: string[]) => execFileSync("git", a, { cwd: d });
  git("init", "-q", "-b", "main");
  git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init");
  return { d, git };
}

function ctx(env: Record<string, string>, startingPrompt = "Add login\nmore"): RunContext {
  return {
    settings: { startingPrompt, sandbox: "none", maxSteps: 10 },
    env,
    run: { id: "r", flowId: "f", flowName: "F", status: "running", startedAt: 0, nodes: {}, logs: [] },
    blockEnv: (cfg: { env: string[] }) => Object.fromEntries(cfg.env.filter((k) => k in env).map((k) => [k, env[k]])),
    log: () => {},
    ask: async () => "",
    abort: new AbortController(),
    installedSkills: new Set(),
  } as unknown as RunContext;
}

const node = { id: "n", type: "block" as const, position: { x: 0, y: 0 }, data: { blockId: "create-task" } };

describe("auto runner", () => {
  it("create-task creates the branch without checking it out, and reuses it", async () => {
    const { d, git } = repo();
    const c = ctx({ REPO_PATH: d, BRANCH_NAME: "feat/login", BASE_BRANCH: "main" });
    const cfg = resolveBlock("create-task", BUILTIN_BLOCKS);
    const res = await runAuto(c, node, cfg, {});
    expect(res.outputs.artifact).toContain("Add login");
    expect(res.outputs.artifact).toContain("feat/login");
    expect(c.branch).toBe("feat/login");
    expect(git("branch", "--show-current").toString().trim()).toBe("main");
    expect(git("branch", "--list", "feat/login").toString()).toContain("feat/login");
    await expect(runAuto(c, node, cfg, {})).resolves.toBeTruthy();
  });

  it("create-task rejects an invalid branch name", async () => {
    const { d } = repo();
    const c = ctx({ REPO_PATH: d, BRANCH_NAME: "bad..name", BASE_BRANCH: "main" });
    await expect(runAuto(c, node, resolveBlock("create-task", BUILTIN_BLOCKS), {})).rejects.toThrow(/branch/i);
  });

  it("shell captures stdout and exposes artifact env", async () => {
    const { d } = repo();
    const c = ctx({ REPO_PATH: d });
    const cfg = { ...resolveBlock("shell", BUILTIN_BLOCKS), shellCommand: "node -e \"process.stdout.write(process.env.SANDFLOW_ARTIFACT)\"" };
    const res = await runAuto(c, { ...node, data: { blockId: "shell" } }, cfg, { artifact: "hi" });
    expect(res.outputs.artifact).toBe("hi");
  });

  it("shell fails on non-zero exit", async () => {
    const { d } = repo();
    const cfg = { ...resolveBlock("shell", BUILTIN_BLOCKS), shellCommand: "node -e \"process.exit(3)\"" };
    await expect(runAuto(ctx({ REPO_PATH: d }), node, cfg, {})).rejects.toThrow(/exit/i);
  });

  it("commentCommand posts to the right GitHub / GitLab endpoint, with host and without a shell", () => {
    const base = { firedAt: 0, type: "merge_request.comment", number: 9, target: "merge_request" as const };
    expect(commentCommand({ ...base, source: "github", repo: "acme/app" }, "Answer")).toEqual({
      cmd: "gh",
      args: ["api", "--method", "POST", "repos/acme/app/issues/9/comments", "-f", "body=Answer"],
    });
    expect(commentCommand({ ...base, source: "gitlab", repo: "grp/sub/app", host: "gitlab.corp.local" }, "Answer; rm -rf /")).toEqual({
      cmd: "glab",
      args: ["api", "--hostname", "gitlab.corp.local", "--method", "POST", "projects/grp%2Fsub%2Fapp/merge_requests/9/notes", "-f", "body=Answer; rm -rf /"],
    });
    expect(commentCommand({ ...base, source: "gitlab", repo: "g/a", target: "issue" }, "x").args[3]).toBe("projects/g%2Fa/issues/9/notes");
  });

  it("commentCommand refuses runs without a git event, target or body", () => {
    expect(() => commentCommand({ source: "manual", type: "manual", firedAt: 0 }, "x")).toThrow(/GitHub or GitLab trigger/);
    expect(() => commentCommand({ source: "github", type: "push", repo: "a/b", firedAt: 0 }, "x")).toThrow(/nothing to comment on|no issue/i);
    expect(() => commentCommand({ source: "github", type: "issue.opened", repo: "a/b", number: 1, target: "issue", firedAt: 0 }, "  ")).toThrow(/empty/);
  });

  it("post-comment doesn't need REPO_PATH", async () => {
    const c = ctx({});
    const cfg = resolveBlock("post-comment", BUILTIN_BLOCKS);
    await expect(runAuto(c, { ...node, data: { blockId: "post-comment" } }, cfg, { artifact: "x" })).rejects.toThrow(/trigger event/);
  });

  it("mrTitle uses the first heading/line, capped at 72 chars", () => {
    expect(mrTitle("# Add login\n\nbody")).toBe("Add login");
    expect(mrTitle("\n\nFix it")).toBe("Fix it");
    expect(mrTitle("x".repeat(100)).length).toBe(72);
    expect(mrTitle("")).toBe("Sandflow changes");
  });
});
