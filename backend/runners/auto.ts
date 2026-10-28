import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { nodeLabel } from "../../shared/resolve";
import type { FlowNode, NodeDelivery, NodeIO, ResolvedConfig, TriggerEvent } from "../../shared/types";
import type { NodeResult, RunContext } from "../engine";
import { withMergeLock } from "../stack";
import { exitText, runTree } from "../proc";
import { runChecks } from "./checks";
import { blockingGates } from "./gate";
import { FinalError } from "../../shared/gates";
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

/** The posted comment's URL from gh / glab's JSON answer. */
function commentUrlOf(out: string, event: TriggerEvent | undefined): string | undefined {
  try {
    const j = JSON.parse(out) as { html_url?: string; id?: number };
    return j.html_url ?? (j.id !== undefined ? `${event?.url ?? ""}#note_${j.id}` : undefined);
  } catch {
    return undefined; // non-JSON output
  }
}

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

/**
 * Irreversible steps (MEOW delivery): run under the run's delivery lock — a pause or Stop waits for them instead of
 * cutting them in half — and remember what they did in the journal (per execution of the node), so a continued run
 * never posts, pushes or opens an MR twice.
 */
function delivery(ctx: RunContext, node: FlowNode) {
  const ns = ctx.nodeState?.(node.id);
  const exec = ns?.executions ?? 0;
  return {
    /** What this execution already delivered (a continued, interrupted attempt). */
    done: ns?.delivery?.exec === exec ? ns.delivery : undefined,
    save(patch: Omit<NodeDelivery, "exec">) {
      if (!ns) return;
      ns.delivery = { ...(ns.delivery?.exec === exec ? ns.delivery : {}), ...patch, exec };
      ctx.journal?.();
    },
    run: <T>(fn: () => Promise<T>): Promise<T> => (ctx.deliver ? ctx.deliver(fn) : fn()),
  };
}

/** URL of an open MR / PR for `branch`, if the provider already has one (so Create MR reuses it). */
async function openMrUrl(provider: string, branch: string, repo: string, signal: AbortSignal): Promise<string | undefined> {
  try {
    const out =
      provider === "github"
        ? await run("gh", ["pr", "list", "--head", branch, "--state", "open", "--json", "url", "--jq", ".[0].url"], repo, signal)
        : await run("glab", ["mr", "list", "--source-branch", branch], repo, signal);
    return /https?:\/\/\S+/.exec(out)?.[0];
  } catch (e) {
    if ((e as Error).message === "Run cancelled") throw e;
    return undefined; // can't tell: create it
  }
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
  const d = delivery(ctx, node);
  const merged = `Merged ${branch} into ${target}`;
  const result = (): NodeResult => ({ outputs: { artifact: inputs.artifact?.trim() ? `${inputs.artifact}\n\n${merged}` : merged, steer: inputs.steer } });
  if (d.done?.merged) {
    ctx.log("info", `${merged} already (before the run was interrupted) — not merging again`, node.id);
    return result();
  }
  return d.run(() => withMergeLock(ctx.run.stack!.groupId, async () => {
    try {
      await run("git", ["-c", "user.name=Sandflow", "-c", "user.email=sandflow@localhost", "merge", "--no-edit", branch], worktree, ctx.abort.signal);
    } catch (e) {
      await run("git", ["merge", "--abort"], worktree).catch(() => {});
      throw new Error(`Merge conflict merging ${branch} into ${target} — merge aborted. ${(e as Error).message}`);
    }
    ctx.log("info", merged, node.id);
    d.save({ merged: true });
    // Hand the task's own result on, so the stack's combine step still sees what the task did.
    return result();
  }));
}

export async function runAuto(ctx: RunContext, node: FlowNode, cfg: ResolvedConfig, inputs: NodeIO): Promise<NodeResult> {
  const env = ctx.blockEnv(cfg);
  const signal = ctx.abort.signal;

  if (cfg.autoAction === "post-comment") {
    const { cmd, args } = commentCommand(ctx.run.trigger, inputs.artifact ?? "");
    const d = delivery(ctx, node);
    if (d.done?.commentUrl) {
      ctx.log("info", `Comment already posted (${d.done.commentUrl}) before the run was interrupted — not posting it twice`, node.id);
      return { outputs: { artifact: d.done.commentUrl } };
    }
    // e.g. GH_TOKEN / GITLAB_TOKEN if the block declares them
    const out = await d.run(async () => {
      const o = await run(cmd, args, process.cwd(), signal, { ...process.env, ...env });
      d.save({ commentUrl: commentUrlOf(o, ctx.run.trigger) ?? (o.trim() || "posted") });
      return o;
    });
    const url = commentUrlOf(out, ctx.run.trigger);
    ctx.log("info", `Posted comment on ${ctx.run.trigger?.repo} ${ctx.run.trigger?.target === "merge_request" ? "MR" : "issue"} ${ctx.run.trigger?.number}`, node.id);
    return { outputs: { artifact: url ?? out.trim() } };
  }

  if (cfg.autoAction === "merge-parent") return mergeIntoParent(ctx, node, inputs);
  // In the run's worktree (a scratch one without REPO_PATH), not REPO_PATH's checkout.
  if (cfg.autoAction === "checks") return runChecks(ctx, node, cfg, inputs);

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
      // A gate failed at level `block` and hasn't passed since: never ship (final, so recovery doesn't retry it).
      const blocked = blockingGates(ctx.run, (k) => {
        const n = ctx.flow.nodes.find((x) => x.id === k);
        return n ? nodeLabel(n, ctx.blocks) : k;
      });
      if (blocked.length) throw new FinalError(`Not creating the MR: blocked by failed gate${blocked.length > 1 ? "s" : ""} ${blocked.join("; ")}`);
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
      if (provider !== "github" && provider !== "gitlab") throw new Error(`Unknown MR_PROVIDER "${provider}" (use github or gitlab)`);
      const d = delivery(ctx, node);
      if (d.done?.mrUrl) {
        ctx.log("info", `MR already created (${d.done.mrUrl}) before the run was interrupted — reusing it`, node.id);
        return { outputs: { artifact: d.done.mrUrl } };
      }
      return d.run(async () => {
        // Skip the push when origin already has this commit (an interrupted attempt got that far).
        const local = await run("git", ["rev-parse", branch], repo, signal);
        const remote = (await run("git", ["ls-remote", "origin", `refs/heads/${branch}`], repo, signal).catch(() => "")).split(/\s/)[0];
        if (remote && remote === local) ctx.log("info", `${branch} is already pushed (origin has ${local.slice(0, 7)}) — not pushing again`, node.id);
        else {
          await run("git", ["push", "-u", "origin", branch], repo, signal);
          ctx.log("info", `Pushed ${branch}`, node.id);
        }
        d.save({ pushed: true });
        const existing = await openMrUrl(provider, branch, repo, signal);
        let out: string;
        if (existing) {
          ctx.log("info", `An open ${provider === "github" ? "PR" : "MR"} for ${branch} already exists — reusing it: ${existing}`, node.id);
          out = existing;
        } else if (provider === "github") {
          out = await run("gh", ["pr", "create", "--head", branch, "--base", base, "--title", title, "--body", body], repo, signal);
        } else {
          out = await run(
            "glab",
            ["mr", "create", "--source-branch", branch, "--target-branch", base, "--title", title, "--description", body, "--yes"],
            repo,
            signal,
          );
        }
        d.save({ mrUrl: /https?:\/\/\S+/.exec(out)?.[0] ?? out.trim() });
        ctx.log("info", out, node.id);
        return { outputs: { artifact: out } };
      });
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
      if (r.code !== 0) throw new Error(`Command ${exitText(r)}${r.stderr.trim() ? `: ${r.stderr.trim().slice(-2000)}` : ""}`);
      const stdout = r.stdout;
      return { outputs: { artifact: stdout.trim() } };
    }
  }
}
