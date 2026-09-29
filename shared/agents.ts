import type { AgentProvider } from "./types";

/** Env var each provider reads its API base URL from (used for custom / on-prem endpoints). */
export const ENDPOINT_ENV: Partial<Record<AgentProvider, string>> = {
  claudeCode: "ANTHROPIC_BASE_URL",
  codex: "OPENAI_BASE_URL",
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
