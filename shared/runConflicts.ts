import type { EnvValues } from "./types";

/** A run that is still going, as far as concurrency checks care. */
export interface ActiveRunInfo {
  id: string;
  flowName: string;
  startedAt: number;
  /** See `sharedBranchKey`: set when the run works on an explicit branch of a project. */
  branchKey?: string;
}

/**
 * Runs normally get their own branch (`sandflow/<runId>`) and worktree, so any number can run side by side. With
 * both REPO_PATH and an explicit BRANCH_NAME set, every run uses that same branch of that same checkout — and so
 * the same worktree. Returns that `<repo>\0<branch>` key, or undefined when runs stay isolated.
 */
export function sharedBranchKey(env: EnvValues): string | undefined {
  const repo = env.REPO_PATH?.trim();
  const branch = env.BRANCH_NAME?.trim();
  return repo && branch ? `${repo}\0${branch}` : undefined;
}

/** A warning for a new run that would share its branch/worktree with runs already going (undefined: no clash). */
export function branchConflictWarning(env: EnvValues, active: ActiveRunInfo[]): string | undefined {
  const key = sharedBranchKey(env);
  if (!key) return undefined;
  const clash = active.filter((r) => r.branchKey === key);
  if (!clash.length) return undefined;
  const branch = env.BRANCH_NAME!.trim();
  const others = clash.map((r) => `"${r.flowName}" (${r.id})`).join(", ");
  return (
    `Another run is also working on branch ${branch} in ${env.REPO_PATH!.trim()}: ${others}. ` +
    `Both runs share that branch's worktree and may overwrite each other's changes — ` +
    `clear BRANCH_NAME (each run then gets its own sandflow/<run id> branch) to keep them apart.`
  );
}
