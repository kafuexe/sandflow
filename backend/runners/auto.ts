import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { nodeLabel } from "../../shared/resolve";
import type { FlowNode, NodeIO, ResolvedConfig } from "../../shared/types";
import type { NodeResult, RunContext } from "../engine";

const execFileP = promisify(execFile);

async function run(cmd: string, args: string[], cwd: string, signal?: AbortSignal) {
  try {
    const { stdout } = await execFileP(cmd, args, { cwd, signal, maxBuffer: 20 * 1024 * 1024, windowsHide: true });
    return stdout.trim();
  } catch (e) {
    const err = e as Error & { stderr?: string };
    throw new Error(`${cmd} ${args[0] ?? ""} failed: ${(err.stderr || err.message).trim()}`);
  }
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

export async function runAuto(ctx: RunContext, node: FlowNode, cfg: ResolvedConfig, inputs: NodeIO): Promise<NodeResult> {
  const env = ctx.blockEnv(cfg);
  const signal = ctx.abort.signal;
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
      const stdout = await new Promise<string>((resolve, reject) => {
        const child = spawn(cmd, {
          shell: true,
          cwd: repo,
          signal,
          windowsHide: true,
          env: { ...process.env, ...env, SANDFLOW_ARTIFACT: inputs.artifact ?? "", SANDFLOW_STEER: inputs.steer ?? "" },
        });
        let out = "";
        let err = "";
        child.stdout.on("data", (d) => (out += d));
        child.stderr.on("data", (d) => (err += d));
        child.on("error", reject);
        child.on("close", (code) => {
          if (code === 0) resolve(out);
          else reject(new Error(`Command exited with code ${code}${err.trim() ? `: ${err.trim().slice(-2000)}` : ""}`));
        });
      });
      return { outputs: { artifact: stdout.trim() } };
    }
  }
}
