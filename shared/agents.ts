import type { AgentProvider } from "./types";

/** Env var each provider reads its API base URL from (used for custom / on-prem endpoints). */
export const ENDPOINT_ENV: Partial<Record<AgentProvider, string>> = {
  claudeCode: "ANTHROPIC_BASE_URL",
  codex: "OPENAI_BASE_URL",
};
