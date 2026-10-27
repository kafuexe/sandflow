// Continuing a paused / interrupted run as the same run (MEOW `resume --continue`): what a crash looks like in the
// journal, the checks before a run may go on (`_validate`, in MEOW's order), and Repair, which adopts the current
// state instead (`--repair`).

import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { activeNodeKeys, statusOfPhase } from "../shared/journal";
import { resolveNode } from "../shared/resolve";
import type { AppData, BlockDef, Flow, ResolvedConfig, RunState } from "../shared/types";
import { mutates } from "./engine";
import { flowFingerprint, settingsFingerprint } from "./journal";

const execFileP = promisify(execFile);
const git = (cwd: string, ...args: string[]) => execFileP("git", args, { cwd, windowsHide: true }).then((r) => r.stdout.trim());
const gitOk = (cwd: string, ...args: string[]) => git(cwd, ...args).then(() => true, () => false);

/** The resolved block of a node key (`sub/plan` = node `plan` inside subflow node `sub`). */
export function nodeConfigAt(key: string, flow: Flow | undefined, flows: Flow[], blocks: BlockDef[]): ResolvedConfig | undefined {
  let f = flow;
  let cfg: ResolvedConfig | undefined;
  for (const id of key.split("/")) {
    const n = f?.nodes.find((x) => x.id === id);
    if (!n) return undefined;
    try {
      cfg = resolveNode(n, blocks);
    } catch {
      return undefined;
    }
    f = cfg.kind === "subflow" ? flows.find((x) => x.id === cfg!.subflow.flowId) : undefined;
  }
  return cfg;
}

/**
 * A run Sandflow was driving when it died (phase running / waiting / pausing / continuing, no live driver): it's
 * interrupted. Steps that were going get `interrupted` — `mutation` when they could have been changing files.
 */
export function markCrashed(run: RunState, data: Pick<AppData, "flows" | "blocks">): RunState {
  const flow = data.flows.find((f) => f.id === run.flowId);
  for (const k of activeNodeKeys(run)) {
    const ns = run.nodes[k];
    if (ns.interrupted) continue;
    const cfg = nodeConfigAt(k, flow, data.flows, data.blocks);
    // Unknown (flow changed): assume the worst — it may have been changing files.
    ns.interrupted = !cfg || mutates(cfg) ? "mutation" : "plain";
  }
  for (const ns of Object.values(run.nodes)) if (ns.status === "running" || ns.status === "waiting" || ns.status === "queued") ns.status = "idle";
  run.pendingQuestion = undefined;
  run.pauseReason = "crash";
  run.phase = "interrupted";
  run.status = statusOfPhase("interrupted");
  (run.transitions ??= []).push({ phase: "interrupted", at: Date.now(), attempt: run.attempt ?? 1 });
  const last = run.logs.at(-1)?.ts ?? run.startedAt;
  run.logs.push({ ts: Date.now(), level: "warn", msg: "⏸ Interrupted — Sandflow stopped while this run was active" });
  if (!run.parent && !run.flags?.some((f) => f.id === "interrupted" && !f.dismissed)) {
    (run.flags ??= []).push({ id: "interrupted", severity: "warning", message: "Interrupted — Sandflow stopped while this run was active", at: last });
  }
  return run;
}

/** The branch a run works on: Create task's, else the sandbox branch it started with. */
export const runBranch = (run: RunState) => run.branch ?? run.workspace?.branch ?? `sandflow/${run.id}`;

/** sandcastle's managed worktree for a branch. */
export const worktreePath = (repo: string, branch: string) => path.join(repo, ".sandcastle", "worktrees", branch.replace(/\//g, "-"));

export interface Check {
  problems: string[];
  /** Repair can adopt the current state for every problem found. */
  repairable: boolean;
}

/**
 * May this run continue? MEOW `_validate` order: journal (already loaded strictly) → repo exists → branch exists →
 * worktree present or re-creatable from the branch → fingerprints match. Problems are written for the user.
 */
export async function checkContinue(run: RunState, data: AppData): Promise<Check> {
  const problems: string[] = [];
  let repairable = true;
  const flow = data.flows.find((f) => f.id === run.flowId);
  if (!flow) return { problems: [`Flow "${run.flowName}" no longer exists`], repairable: false };
  const repo = run.workspace?.repo;
  const now = data.env.REPO_PATH?.trim();
  if (repo) {
    if (!fs.existsSync(repo) || !(await gitOk(repo, "rev-parse", "--git-dir"))) {
      problems.push(`The project folder ${repo} is missing or isn't a git repository any more — restore it to continue`);
      repairable = false;
    } else if (now !== repo) {
      problems.push(now ? `REPO_PATH changed since the run started (${repo} → ${now})` : `REPO_PATH is no longer set (the run worked in ${repo})`);
    }
    if (repairable) {
      const branch = runBranch(run);
      // Only a branch the run actually worked on must still exist (`run.branch` is set once its sandbox was made).
      const exists = await gitOk(repo, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`);
      if (run.branch && !exists) problems.push(`Branch ${branch} no longer exists in ${repo}, so the code changes the earlier steps made are gone (was it deleted or merged?)`);
      const commit = run.fingerprints?.workspace.commit;
      if (exists && commit && !(await gitOk(repo, "merge-base", "--is-ancestor", commit, branch))) {
        problems.push(`Branch ${branch} was rewritten since the run started (commit ${commit.slice(0, 7)} isn't on it any more)`);
      }
      // A missing worktree is fine: sandcastle re-creates it from the branch.
    }
  } else {
    if (now) problems.push(`REPO_PATH is set now (${now}), but the run had no project`);
    if (activeNodeKeys(run).some((k) => run.nodes[k].interrupted === "mutation")) {
      problems.push("This run had no project (REPO_PATH): the files the interrupted step was changing were in a scratch workspace that's gone");
    }
  }
  const fp = run.fingerprints;
  if (fp) {
    if (fp.flow !== flowFingerprint(flow, data.flows, data.blocks)) problems.push("The flow, or a block or subflow it uses, changed since the run started");
    if (fp.settings !== settingsFingerprint(data.settings)) problems.push("Settings that change how runs work (sandbox, image, max steps) changed since the run started");
  }
  return { problems, repairable };
}

/**
 * Repair (MEOW `--repair`): adopt the current state for everything that drifted — new fingerprints, the current
 * REPO_PATH, the branch as it is now (or re-created from the base branch). Returns each change, for the journal.
 */
export async function repairRun(run: RunState, data: AppData): Promise<string[]> {
  const changes: string[] = [];
  const flow = data.flows.find((f) => f.id === run.flowId);
  if (!flow) throw new Error(`Flow "${run.flowName}" no longer exists — it can't be repaired`);
  const fp = (run.fingerprints ??= { flow: "", settings: "", workspace: { branch: runBranch(run) } });
  const flowNow = flowFingerprint(flow, data.flows, data.blocks);
  if (fp.flow !== flowNow) {
    fp.flow = flowNow;
    changes.push("adopted the flow as it is now");
  }
  const settingsNow = settingsFingerprint(data.settings);
  if (fp.settings !== settingsNow) {
    fp.settings = settingsNow;
    changes.push("adopted the current settings");
  }
  const repo = data.env.REPO_PATH?.trim() || undefined;
  if (repo !== run.workspace?.repo) {
    changes.push(repo ? `works in ${repo} now (was ${run.workspace?.repo ?? "a scratch workspace"})` : "works in a new scratch workspace now (no REPO_PATH)");
    run.workspace = { ...(repo ? { repo } : {}), branch: run.workspace?.branch ?? runBranch(run) };
    if (repo) fp.workspace.repo = repo;
    else delete fp.workspace.repo;
  }
  const branch = runBranch(run);
  if (repo) {
    const head = await git(repo, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`).catch(() => undefined);
    if (!head) {
      if (run.branch) changes.push(`branch ${branch} is missing — it's re-created from the base branch (the earlier steps' code changes are not on it)`);
      delete fp.workspace.commit;
    } else if (fp.workspace.commit && !(await gitOk(repo, "merge-base", "--is-ancestor", fp.workspace.commit, branch))) {
      changes.push(`adopted branch ${branch} as it is now (${head.slice(0, 7)})`);
      fp.workspace.commit = head;
    }
  }
  if (!repo) for (const ns of Object.values(run.nodes)) if (ns.interrupted === "mutation") ns.interrupted = "plain";
  return changes;
}
