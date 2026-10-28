import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { applyCleanup, ownedBranch, planCleanup } from "../backend/cleanup";
import type { RunState } from "../shared/types";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

function repo() {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sandflow-clean-")));
  dirs.push(d);
  const git = (...a: string[]) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...a], { cwd: d }).toString();
  git("init", "-q", "-b", "main");
  git("commit", "-q", "--allow-empty", "-m", "init");
  return { d, git };
}

const run = (id: string, repoPath: string, status: RunState["status"] = "done", extra: Partial<RunState> = {}): RunState =>
  ({ id, flowId: "f", flowName: "F", status, startedAt: 0, logs: [], nodes: {}, workspace: { repo: repoPath, branch: `sandflow/${id}` }, ...extra }) as RunState;

describe("cleanup", () => {
  it("only owns Sandflow's own branches", () => {
    expect(ownedBranch(run("r1", "/x"))).toBe("sandflow/r1");
    expect(ownedBranch({ ...run("r2", "/x"), workspace: { repo: "/x", branch: "feat/mine" } })).toBeUndefined();
    expect(ownedBranch({ ...run("r3", "/x"), stack: { groupId: "g", name: "s", index: 0, total: 1, task: "t", attempt: 1, maxAttempts: 1, branch: "feat/mine-g-1-t" } })).toBe("feat/mine-g-1-t");
  });

  it("offers merged branches, keeps ones with unique commits or a live run, and removes what's picked", async () => {
    const { d, git } = repo();
    git("branch", "sandflow/merged"); // no commits of its own
    git("checkout", "-q", "-b", "sandflow/unique");
    git("commit", "-q", "--allow-empty", "-m", "only here");
    git("checkout", "-q", "main");
    git("branch", "sandflow/live");
    git("branch", "sandflow/paused");
    const runs = [run("merged", d), run("unique", d), run("live", d), run("paused", d, "paused")];
    const items = await planCleanup(runs, new Set([`${d}\0sandflow/live`]));
    const by = Object.fromEntries(items.map((i) => [i.branch, i]));
    expect(by["sandflow/merged"].removable).toBe(true);
    expect(by["sandflow/unique"].removable).toBe(false);
    expect(by["sandflow/unique"].reason).toMatch(/1 commit is only on this branch/);
    expect(by["sandflow/live"].removable).toBe(false);
    expect(by["sandflow/paused"].removable).toBe(false);

    const results = await applyCleanup([by["sandflow/merged"].id, by["sandflow/unique"].id], runs, new Set());
    expect(results[0]).toMatchObject({ ok: true });
    expect(results[1]).toMatchObject({ ok: false });
    expect(git("branch", "--list", "sandflow/*")).not.toContain("sandflow/merged");
    expect(git("branch", "--list", "sandflow/*")).toContain("sandflow/unique");
  });

  it("removes a clean leftover worktree with its branch; keeps a dirty one", async () => {
    const { d, git } = repo();
    const clean = path.join(d, ".sandcastle", "worktrees", "clean");
    const dirty = path.join(d, ".sandcastle", "worktrees", "dirty");
    git("worktree", "add", "-q", "-b", "sandflow/clean", clean);
    git("worktree", "add", "-q", "-b", "sandflow/dirty", dirty);
    fs.writeFileSync(path.join(dirty, "wip.txt"), "x");
    const runs = [run("clean", d), run("dirty", d)];
    const items = await planCleanup(runs, new Set());
    const by = Object.fromEntries(items.map((i) => [i.branch, i]));
    expect(by["sandflow/clean"]).toMatchObject({ removable: true });
    expect(by["sandflow/dirty"].reason).toMatch(/uncommitted changes/);
    const [r] = await applyCleanup([by["sandflow/clean"].id], runs, new Set());
    expect(r.ok).toBe(true);
    expect(fs.existsSync(clean)).toBe(false);
    expect(fs.existsSync(dirty)).toBe(true);
  });
});
