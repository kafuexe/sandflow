import type { AgentProvider } from "./types";

/** Env var each provider reads its API base URL from (used for custom / on-prem endpoints). */
export const ENDPOINT_ENV: Partial<Record<AgentProvider, string>> = {
  claudeCode: "ANTHROPIC_BASE_URL",
  codex: "OPENAI_BASE_URL",
};

/**
 * How each provider reaches its API: base URL and credentials. Set in Inputs, these go to every agent of that
 * provider — whether or not the block lists them — so a gateway (e.g. a LiteLLM proxy) works for the whole app,
 * the same as it does for the assistant.
 */
/**
 * Claude Code's other model settings: the models it uses besides the main one (background / small-fast calls,
 * subagents, and what the haiku / sonnet / opus aliases mean). Behind a gateway that only serves your own model, these
 * must point at it too.
 */
export const CLAUDE_AUX_MODEL_ENV = [
  "ANTHROPIC_SMALL_FAST_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "CLAUDE_CODE_SUBAGENT_MODEL",
];

export const GATEWAY_ENV: Partial<Record<AgentProvider, string[]>> = {
  claudeCode: ["ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY", "ANTHROPIC_CUSTOM_HEADERS", ...CLAUDE_AUX_MODEL_ENV],
  codex: ["OPENAI_BASE_URL", "OPENAI_API_KEY"],
};

/** Every agent a block (or the "Edit with AI" assistant) can use, with its display name. */
export const AGENT_LABELS: Record<AgentProvider, string> = {
  claudeCode: "Claude Code",
  codex: "Codex",
  pi: "pi",
  opencode: "OpenCode",
  cursor: "Cursor",
  copilot: "Copilot",
};

export const AGENT_PROVIDERS = Object.keys(AGENT_LABELS) as AgentProvider[];

/** A Claude model name or alias (what Anthropic's API itself serves), as opposed to a gateway's own model (e.g. GLM). */
export const isClaudeModel = (model: string): boolean => /^(claude-|anthropic[./:]|(opus|sonnet|haiku|default|best|opusplan)(\[|$))/i.test(model.trim());

/**
 * For Claude Code talking to a gateway with a non-Claude model: point its other models (CLAUDE_AUX_MODEL_ENV) at that
 * model too, so its side calls don't ask the gateway for a Claude model it doesn't serve. Values already set (e.g. in
 * Inputs) are kept; nothing is added for Claude models or without a gateway.
 */
export function auxModelEnv(provider: AgentProvider, model: string | undefined, env: Record<string, string | undefined>, gateway: boolean): Record<string, string> {
  const m = model?.trim();
  if (provider !== "claudeCode" || !m || !gateway || isClaudeModel(m)) return {};
  return Object.fromEntries(CLAUDE_AUX_MODEL_ENV.filter((k) => !env[k]?.trim()).map((k) => [k, m]));
}
