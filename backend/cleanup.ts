// Clean up what finished runs leave in your repos (MEOW `meow cleanup`): the branches Sandflow made for them
// (`sandflow/<run id>`, Box Stack task branches) and those branches' leftover worktrees. Only what is safe goes:
//  - the run has ended (done / failed / stopped — not running, waiting or paused) and no live run uses the branch;
//  - its worktree, if one is left, has no uncommitted changes and isn't your main checkout;
//  - every commit on the branch is also on another branch or on a remote (merged, pushed, or never had any).
// Branches you named (BRANCH_NAME, Create task) are never touched, and nothing is force-removed.

import type { CleanupItem, CleanupResult, RunState } from "../shared/types";
import { runTree } from "./proc";

export type Git = (repo: string, args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;

export const git: Git = async (repo, args) => {
  const r = await runTree("git", args, { cwd: repo, timeoutMs: 30_000 });
  return { code: r.killed ? 1 : r.code, stdout: r.stdout, stderr: r.stderr };
};

const ENDED = new Set<RunState["status"]>(["done", "failed", "cancelled"]);

/** The branch Sandflow made for this run, if it made one: its per-run branch or a Box Stack task's. */
export function ownedBranch(run: RunState): string | undefined {
  if (run.stack?.branch) return run.stack.branch;
  const b = run.workspace?.branch ?? run.branch;
  return b && b === `sandflow/${run.id}` ? b : undefined;
}

interface Worktree {
  path: string;
  branch?: string;
}

function parseWorktrees(porcelain: string): Worktree[] {
  const out: Worktree[] = [];
  let cur: Worktree | undefined;
  for (const line of porcelain.split(/\r?\n/)) {
    if (line.startsWith("worktree ")) out.push((cur = { path: line.slice(9) }));
    else if (line.startsWith("branch refs/heads/") && cur) cur.branch = line.slice(18);
  }
  return out;
}

/**
 * What can go. `runs`: saved and live runs; `busyBranches`: `<repo>\0<branch>` of runs still going (they keep their
 * branch whatever their saved state says).
 */
export async function planCleanup(runs: RunState[], busyBranches: Set<string>, exec: Git = git): Promise<CleanupItem[]> {
  const groups = new Map<string, { repo: string; branch: string; runs: RunState[] }>();
  for (const r of runs) {
    const repo = r.workspace?.repo;
    const branch = ownedBranch(r);
    if (!repo || !branch) continue;
    const id = `${repo}\0${branch}`;
    const g = groups.get(id) ?? { repo, branch, runs: [] };
    g.runs.push(r);
    groups.set(id, g);
  }

  const worktreesByRepo = new Map<string, Worktree[] | undefined>();
  const items: CleanupItem[] = [];
  for (const [id, g] of groups) {
    const runIds = g.runs.map((r) => r.id).sort().reverse();
    const item = (removable: boolean, reason: string, worktree?: string): CleanupItem => ({ id, repo: g.repo, branch: g.branch, runIds, worktree, removable, reason });
    const exists = await exec(g.repo, ["rev-parse", "--verify", "--quiet", `refs/heads/${g.branch}`]);
    if (exists.code !== 0) continue; // already gone (or the repo is)
    if (busyBranches.has(id) || g.runs.some((r) => !ENDED.has(r.status) || r.hold)) {
      items.push(item(false, "A run on this branch hasn't ended (it's running, waiting or paused)"));
      continue;
    }
    if (!worktreesByRepo.has(g.repo)) {
      const w = await exec(g.repo, ["worktree", "list", "--porcelain"]);
      worktreesByRepo.set(g.repo, w.code === 0 ? parseWorktrees(w.stdout) : undefined);
    }
    const worktrees = worktreesByRepo.get(g.repo);
    if (!worktrees) {
      items.push(item(false, "Couldn't list the repo's worktrees"));
      continue;
    }
    const wt = worktrees.find((w) => w.branch === g.branch);
    if (wt && wt === worktrees[0]) {
      items.push(item(false, "It's checked out in your main checkout", wt.path));
      continue;
    }
    if (wt) {
      const st = await exec(wt.path, ["status", "--porcelain"]);
      if (st.code !== 0) {
        items.push(item(false, `Couldn't read its worktree (${wt.path})`, wt.path));
        continue;
      }
      if (st.stdout.trim()) {
        items.push(item(false, `Its worktree has uncommitted changes (${wt.path})`, wt.path));
        continue;
      }
    }
    // Commits only this branch has would be lost: keep it unless every commit is also somewhere else.
    // (`--exclude` patterns for `--branches` leave out the refs/heads/ prefix.)
    const only = await exec(g.repo, ["rev-list", "--count", `refs/heads/${g.branch}`, "--not", `--exclude=${g.branch}`, "--branches", "--remotes"]);
    if (only.code !== 0) {
      items.push(item(false, "Couldn't tell whether its commits are anywhere else", wt?.path));
      continue;
    }
    const n = Number(only.stdout.trim());
    if (n > 0) {
      items.push(item(false, `${n} commit${n === 1 ? " is" : "s are"} only on this branch (not merged or pushed)`, wt?.path));
      continue;
    }
    items.push(item(true, `Every commit is on another branch or a remote${wt ? "; its worktree is clean" : ""}. Resuming ${runIds.length === 1 ? "that run" : "those runs"} won't be possible afterwards.`, wt?.path));
  }
  return items.sort((a, b) => Number(b.removable) - Number(a.removable) || a.repo.localeCompare(b.repo) || a.branch.localeCompare(b.branch));
}

/** Remove the chosen items — each checked again first (`planCleanup`), so only what is still safe goes. */
export async function applyCleanup(ids: string[], runs: RunState[], busyBranches: Set<string>, exec: Git = git): Promise<CleanupResult[]> {
  const plan = new Map((await planCleanup(runs, busyBranches, exec)).map((i) => [i.id, i]));
  const out: CleanupResult[] = [];
  for (const id of ids) {
    const it = plan.get(id);
    if (!it) {
      out.push({ id, ok: false, message: "Not found (already removed?)" });
      continue;
    }
    if (!it.removable) {
      out.push({ id, ok: false, message: `Kept: ${it.reason}` });
      continue;
    }
    if (it.worktree) {
      const w = await exec(it.repo, ["worktree", "remove", it.worktree]);
      if (w.code !== 0) {
        out.push({ id, ok: false, message: `Couldn't remove the worktree: ${(w.stderr || w.stdout).trim()}` });
        continue;
      }
    }
    // -D: `-d` only knows "merged into HEAD / upstream"; planCleanup already checked every commit is elsewhere.
    const b = await exec(it.repo, ["branch", "-D", it.branch]);
    out.push(b.code === 0 ? { id, ok: true, message: `Removed ${it.branch}${it.worktree ? " and its worktree" : ""}` } : { id, ok: false, message: `Couldn't delete the branch: ${(b.stderr || b.stdout).trim()}` });
  }
  for (const repo of new Set(ids.map((i) => plan.get(i)?.repo).filter((r): r is string => !!r))) await exec(repo, ["worktree", "prune"]);
  return out;
}
