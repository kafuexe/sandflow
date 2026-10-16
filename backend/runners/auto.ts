import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { nodeLabel } from "../../shared/resolve";
import type { FlowNode, NodeIO, ResolvedConfig, TriggerEvent } from "../../shared/types";
import type { NodeResult, RunContext } from "../engine";
import { withMergeLock } from "../stack";
import { runTree } from "../proc";
import { codeOwner, trustedOnHost } from "./trust";

const execFileP = promisify(execFile);

/** Run a command; Stop kills it and everything it started (git push → ssh, gh → …). */
async function run(cmd: string, args: string[], cwd: string, signal?: AbortSignal, env?: NodeJS.ProcessEnv) {
  const r = await runTree(cmd, args, { cwd, signal, env });
  if (r.killed === "cancelled") throw new Error("Run cancelled");
  if (r.killed || r.code !== 0) {
    throw new Error(`${cmd} ${args[0] ?? ""} failed: ${(r.stderr.trim() || r.killed || `exit code ${r.code}`).trim()}`);
  }
  return r.stdout.trim();
}

function requireEnv(env: Record<string, string>, name: string): string {
  const v = env[name]?.trim();
  if (!v) throw new Error(`Missing env var ${name}`);
  return v;
}

/** Title for the MR: first markdown heading / non-empty line of the starting prompt, ≤ 72 chars. */
export function mrTitle(startingPrompt: string): string {
  const line = startingPrompt
    .split(/\r?\n/)
    .map((l) => l.replace(/^#+\s*/, "").trim())
    .find(Boolean);
  return (line || "Sandflow changes").slice(0, 72);
}

const MAX_COMMENT = 60_000;

/**
 * gh/glab command that posts `body` on the issue / MR / PR the trigger event came from.
 * Uses the REST API through the CLI so it works for issues and PRs alike and on self-hosted hosts.
 */
export function commentCommand(event: TriggerEvent | undefined, body: string): { cmd: string; args: string[] } {
  if (!event || (event.source !== "github" && event.source !== "gitlab")) {
    throw new Error("Post comment needs a GitHub or GitLab trigger event (this run wasn't started by one)");
  }
  if (!event.repo || event.number === undefined || !event.target) {
    throw new Error(`The ${event.type} event has no issue / merge request to comment on`);
  }
  if (!body.trim()) throw new Error("Nothing to post — the input artifact is empty");
  const text = body.length > MAX_COMMENT ? `${body.slice(0, MAX_COMMENT)}\n\n…(truncated)` : body;
  const hostArgs = event.host ? ["--hostname", event.host] : [];
  if (event.source === "github") {
    // PRs are issues in the REST API, so one endpoint covers both.
    return {
      cmd: "gh",
      args: ["api", ...hostArgs, "--method", "POST", `repos/${event.repo}/issues/${event.number}/comments`, "-f", `body=${text}`],
    };
  }
  const kind = event.target === "merge_request" ? "merge_requests" : "issues";
  return {
    cmd: "glab",
    args: ["api", ...hostArgs, "--method", "POST", `projects/${encodeURIComponent(event.repo)}/${kind}/${event.number}/notes`, "-f", `body=${text}`],
  };
}

/** Merge a Box Stack task's branch into the parent run's branch, in the parent's worktree, one task at a time. */
async function mergeIntoParent(ctx: RunContext, node: FlowNode, inputs: NodeIO): Promise<NodeResult> {
  const branch = ctx.run.stack?.branch;
  const parent = ctx.parentContext;
  if (!branch || !parent || !ctx.run.stack) {
    throw new Error("Merge into parent branch only works inside an isolated Box Stack task");
  }
  const worktree = (parent.sandbox as { worktreePath?: string } | undefined)?.worktreePath;
  if (!worktree) throw new Error("The parent run has no worktree to merge into yet");
  const target = parent.run.branch ?? "the parent branch";
  return withMergeLock(ctx.run.stack.groupId, async () => {
    try {
      await run("git", ["-c", "user.name=Sandflow", "-c", "user.email=sandflow@localhost", "merge", "--no-edit", branch], worktree, ctx.abort.signal);
    } catch (e) {
      await run("git", ["merge", "--abort"], worktree).catch(() => {});
      throw new Error(`Merge conflict merging ${branch} into ${target} — merge aborted. ${(e as Error).message}`);
    }
    ctx.log("info", `Merged ${branch} into ${target}`, node.id);
    // Hand the task's own result on, so the stack's combine step still sees what the task did.
    const merged = `Merged ${branch} into ${target}`;
    return { outputs: { artifact: inputs.artifact?.trim() ? `${inputs.artifact}\n\n${merged}` : merged, steer: inputs.steer } };
  });
}

export async function runAuto(ctx: RunContext, node: FlowNode, cfg: ResolvedConfig, inputs: NodeIO): Promise<NodeResult> {
  const env = ctx.blockEnv(cfg);
  const signal = ctx.abort.signal;

  if (cfg.autoAction === "post-comment") {
    const { cmd, args } = commentCommand(ctx.run.trigger, inputs.artifact ?? "");
    // e.g. GH_TOKEN / GITLAB_TOKEN if the block declares them
    const out = await run(cmd, args, process.cwd(), signal, { ...process.env, ...env });
    let url: string | undefined;
    try {
      const j = JSON.parse(out) as { html_url?: string; id?: number };
      url = j.html_url ?? (j.id !== undefined ? `${ctx.run.trigger?.url ?? ""}#note_${j.id}` : undefined);
    } catch {
      /* non-JSON output */
    }
    ctx.log("info", `Posted comment on ${ctx.run.trigger?.repo} ${ctx.run.trigger?.target === "merge_request" ? "MR" : "issue"} ${ctx.run.trigger?.number}`, node.id);
    return { outputs: { artifact: url ?? out.trim() } };
  }

  if (cfg.autoAction === "merge-parent") return mergeIntoParent(ctx, node, inputs);

  const repo = requireEnv(env, "REPO_PATH");
  switch (cfg.autoAction) {
    case "create-task": {
      const branch = requireEnv(env, "BRANCH_NAME");
      const base = env.BASE_BRANCH?.trim() || "main";
      try {
        await execFileP("git", ["check-ref-format", "--branch", branch], { cwd: repo, windowsHide: true });
      } catch {
        throw new Error(`Invalid branch name "${branch}"`);
      }
      let exists = true;
      try {
        await execFileP("git", ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], { cwd: repo, windowsHide: true });
      } catch {
        exists = false;
      }
      if (exists) {
        ctx.log("info", `Branch ${branch} already exists — reusing it`, node.id);
      } else {
        // Don't check it out: sandcastle creates a worktree for it, and a checked-out branch can't get one.
        await run("git", ["branch", branch, base], repo, signal);
        ctx.log("info", `Created branch ${branch} from ${base}`, node.id);
      }
      ctx.branch = branch;
      ctx.run.branch = branch;
      return {
        outputs: { artifact: `# Task\n\n${ctx.settings.startingPrompt.trim()}\n\nBranch: ${branch} (from ${base})` },
      };
    }

    case "create-mr": {
      const branch = ctx.branch ?? requireEnv(env, "BRANCH_NAME");
      const base = env.BASE_BRANCH?.trim() || "main";
      const provider = (env.MR_PROVIDER?.trim() || "github").toLowerCase();
      const title = mrTitle(ctx.settings.startingPrompt);
      const summary = Object.entries(ctx.run.nodes)
        .filter(([, s]) => s.executions > 0)
        .map(([id, s]) => {
          const n = ctx.flow.nodes.find((x) => x.id === id);
          return `- ${n ? nodeLabel(n, ctx.blocks) : id}: ${s.status} ×${s.executions}`;
        })
        .join("\n");
      const body = `${inputs.artifact?.trim() ?? ""}\n\n---\n_Created by Sandflow run \`${ctx.run.id}\`_\n\n${summary}`.trim();

      await run("git", ["push", "-u", "origin", branch], repo, signal);
      ctx.log("info", `Pushed ${branch}`, node.id);
      let out: string;
      if (provider === "github") {
        out = await run("gh", ["pr", "create", "--head", branch, "--base", base, "--title", title, "--body", body], repo, signal);
      } else if (provider === "gitlab") {
        out = await run(
          "glab",
          ["mr", "create", "--source-branch", branch, "--target-branch", base, "--title", title, "--description", body, "--yes"],
          repo,
          signal,
        );
      } else {
        throw new Error(`Unknown MR_PROVIDER "${provider}" (use github or gitlab)`);
      }
      ctx.log("info", out, node.id);
      return { outputs: { artifact: out } };
    }

    case "shell": {
      const cmd = cfg.shellCommand.trim();
      if (!cmd) throw new Error("Shell block has no command");
      // Shell commands run on this machine: one that comes from a pack needs that pack to be trusted.
      const owner = codeOwner(ctx, node, (c) => c.shellCommand);
      if (!trustedOnHost(ctx, owner)) {
        throw new Error(`This command comes from pack "${owner}", which isn't allowed to run code on this machine (Packs → ${owner}). Command: ${cmd}`);
      }
      // Its own process group: Stop kills the shell and everything it started, not just the shell.
      const r = await runTree(cmd, null, {
        cwd: repo,
        signal,
        env: { ...process.env, ...env, SANDFLOW_ARTIFACT: inputs.artifact ?? "", SANDFLOW_STEER: inputs.steer ?? "" },
      });
      if (r.killed === "cancelled") throw new Error("Run cancelled");
      if (r.killed) throw new Error(`Command ${r.killed}`);
      if (r.code !== 0) throw new Error(`Command exited with code ${r.code}${r.stderr.trim() ? `: ${r.stderr.trim().slice(-2000)}` : ""}`);
      const stdout = r.stdout;
      return { outputs: { artifact: stdout.trim() } };
    }
  }
}
