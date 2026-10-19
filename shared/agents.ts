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
export const GATEWAY_ENV: Partial<Record<AgentProvider, string[]>> = {
  claudeCode: ["ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY", "ANTHROPIC_CUSTOM_HEADERS"],
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
