// Where an agent block runs: in a container sandbox, or on this computer with the locally installed agent CLI.

import type { EnvValues, RunOn, RunOnChoice, SandboxKind } from "./types";

export const RUN_ON_LABELS: Record<RunOn, string> = {
  sandbox: "Sandbox container",
  host: "This computer",
};

/** Shown wherever an agent is set to run on this computer. */
export const HOST_WARNING =
  "Runs the agent CLI installed on this computer (e.g. `claude` on your PATH) with your own login and config — " +
  "no container. The agent can read and change anything your user account can, not just the project.";

/** Where agents run when neither the block nor the flow says: Settings → Sandbox (None = this computer). */
export const settingsRunOn = (sandbox: SandboxKind): RunOn => (sandbox === "none" ? "host" : "sandbox");

const isRunOn = (v: unknown): v is RunOn => v === "sandbox" || v === "host";

/** Problem with a `runOn` value (block config, node override or flow), or undefined. */
export function runOnProblem(v: unknown, allowInherit = true): string | undefined {
  if (v === undefined || isRunOn(v) || (allowInherit && v === "inherit")) return undefined;
  return `"runOn" must be ${allowInherit ? "inherit, " : ""}sandbox or host (got ${JSON.stringify(v)})`;
}

/**
 * Where an agent runs: the first explicit choice, most specific first (block/node, its flow, outer flows), else
 * Settings → Sandbox. Without `sandbox` (settings unknown) an undecided result is `undefined`.
 */
export function resolveRunOn(choices: (RunOnChoice | undefined)[], sandbox?: SandboxKind): RunOn | undefined {
  const explicit = choices.find(isRunOn);
  if (explicit) return explicit;
  return sandbox === undefined ? undefined : settingsRunOn(sandbox);
}

/**
 * Agent login variables an agent on this computer doesn't need — the local CLI uses your own login. A block may still
 * declare them (for containers); when it runs on this computer they become optional.
 */
export const HOST_LOGIN_ENV = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "OPENAI_API_KEY", "CURSOR_API_KEY"];

/**
 * Env for an agent on this computer. Blank values are dropped, and so are the login variables (unless the block talks
 * to a custom endpoint, which needs them), so a key meant for containers can't replace the CLI's own login.
 */
export function hostAgentEnv(env: EnvValues, keepLogin = false): EnvValues {
  return Object.fromEntries(Object.entries(env).filter(([k, v]) => v.trim() !== "" && (keepLogin || !HOST_LOGIN_ENV.includes(k))));
}
