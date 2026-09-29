// How the "Edit with AI" assistant drives each agent CLI on the host, headless.
//
// Print-mode invocations and stream formats follow @ai-hero/sandcastle's providers (the same CLIs the blocks run).
// Tool calls are NOT parsed from the streams: Sandflow's MCP server records every call it serves, so adapters only
// extract reply text, the session id (to resume the conversation next turn) and errors.
//
// MCP wiring:
//   claudeCode          → HTTP MCP via --mcp-config (built-in tools off)
//   codex/opencode/
//   cursor/copilot      → a tiny stdio bridge (sandflow-mcp-bridge.cjs) that forwards JSON-RPC to the HTTP endpoint;
//                         every MCP-capable CLI supports stdio servers
//   pi                  → no MCP support: the "ops block" text protocol (see chats.ts)

import path from "node:path";
import type { AgentProvider } from "../shared/types";

export type AssistantEvent =
  | { type: "session"; id: string }
  | { type: "text"; text: string }
  | { type: "error"; message: string };

export interface McpLaunch {
  /** Streamable-HTTP endpoint (already scoped to the flow and chat). */
  url: string;
  /** Stdio bridge: command + args that speak MCP on stdin/stdout. */
  command: string;
  args: string[];
  env: Record<string, string>;
}

export interface AdapterTurn {
  /** Full prompt for this turn (the service already prepended instructions when the agent needs them inline). */
  prompt: string;
  systemPrompt: string;
  model?: string;
  /** Agent session to continue. */
  resumeId?: string;
  workDir: string;
  mcp: McpLaunch;
}

export interface AgentCommand {
  args: string[];
  stdin?: string;
  /** Files to write into the turn's work dir first (relative path → content). */
  files?: Record<string, string>;
}

export interface AgentAdapter {
  provider: AgentProvider;
  /** Executable names to look for on PATH, in order. */
  bins: string[];
  /** How the agent reaches Sandflow's tools. */
  tools: "mcp" | "text";
  /** Takes the system prompt as a flag; otherwise it's prepended to the first prompt of a session. */
  systemPromptFlag: boolean;
  /** Sandflow env vars (by name) handed to the CLI when they're set there but not in the process env. */
  authEnv: string[];
  build(t: AdapterTurn): AgentCommand;
  parse(line: string): AssistantEvent[];
}

const json = (line: string): Record<string, any> | undefined => {
  if (!line.startsWith("{")) return undefined;
  try {
    return JSON.parse(line) as Record<string, any>;
  } catch {
    return undefined;
  }
};

const errorText = (o: Record<string, any>): string =>
  String(o.message ?? o.error?.message ?? o.error ?? o.data?.message ?? o.result ?? "The agent reported an error");

/** Claude Code / Cursor `stream-json` (Cursor's format is Claude's). */
function parseClaudeStream(line: string): AssistantEvent[] {
  const m = json(line);
  if (!m) return [];
  if (m.type === "system" && m.subtype === "init") return typeof m.session_id === "string" ? [{ type: "session", id: m.session_id }] : [];
  if (m.type === "assistant") {
    return ((m.message?.content ?? []) as Record<string, unknown>[])
      .filter((c) => c.type === "text" && typeof c.text === "string" && c.text.trim())
      .map((c) => ({ type: "text", text: String(c.text) }));
  }
  if (m.type === "result" && (m.is_error || String(m.subtype ?? "").startsWith("error"))) {
    return [{ type: "error", message: String(m.result ?? m.subtype ?? "The assistant stopped with an error") }];
  }
  return [];
}

/** TOML value for `codex -c key=value` (JSON strings/arrays are valid TOML). */
const toml = (v: unknown): string =>
  v && typeof v === "object" && !Array.isArray(v)
    ? `{${Object.entries(v)
        .map(([k, x]) => `${k}=${JSON.stringify(x)}`)
        .join(",")}}`
    : JSON.stringify(v);

const claudeCode: AgentAdapter = {
  provider: "claudeCode",
  bins: ["claude"],
  tools: "mcp",
  systemPromptFlag: true,
  authEnv: ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL"],
  build: (t) => ({
    args: [
      "-p",
      "--output-format", "stream-json",
      "--verbose",
      "--tools", "",
      "--strict-mcp-config",
      "--mcp-config", "mcp.json",
      "--allowedTools", "mcp__sandflow",
      "--append-system-prompt-file", "system-prompt.md",
      ...(t.model ? ["--model", t.model] : []),
      ...(t.resumeId ? ["--resume", t.resumeId] : []),
    ],
    stdin: t.prompt,
    files: {
      "mcp.json": JSON.stringify({ mcpServers: { sandflow: { type: "http", url: t.mcp.url } } }),
      "system-prompt.md": t.systemPrompt,
    },
  }),
  parse: parseClaudeStream,
};

const codex: AgentAdapter = {
  provider: "codex",
  bins: ["codex"],
  tools: "mcp",
  systemPromptFlag: false,
  authEnv: ["OPENAI_API_KEY", "OPENAI_BASE_URL"],
  build: (t) => ({
    args: [
      "exec",
      ...(t.resumeId ? ["resume", t.resumeId] : []),
      "--json",
      "--skip-git-repo-check",
      // Read-only sandbox, never ask: it can only change things through Sandflow's tools.
      "-c", `sandbox_mode="read-only"`,
      "-c", `approval_policy="never"`,
      "-c", `mcp_servers.sandflow.command=${toml(t.mcp.command)}`,
      "-c", `mcp_servers.sandflow.args=${toml(t.mcp.args)}`,
      "-c", `mcp_servers.sandflow.env=${toml(t.mcp.env)}`,
      ...(t.model ? ["-m", t.model] : []),
      "-",
    ],
    stdin: t.prompt,
  }),
  parse(line) {
    const o = json(line);
    if (!o) return [];
    if (o.type === "thread.started" && typeof o.thread_id === "string") return [{ type: "session", id: o.thread_id }];
    if (o.type === "item.completed" && o.item?.type === "agent_message" && typeof o.item.text === "string") return [{ type: "text", text: o.item.text }];
    if (o.type === "error" || o.type === "turn.failed") return [{ type: "error", message: errorText(o) }];
    return [];
  },
};

const opencode: AgentAdapter = {
  provider: "opencode",
  bins: ["opencode"],
  tools: "mcp",
  systemPromptFlag: false,
  authEnv: ["ANTHROPIC_API_KEY", "OPENAI_API_KEY"],
  build: (t) => ({
    args: ["run", "--format", "json", ...(t.model ? ["--model", t.model] : []), ...(t.resumeId ? ["--session", t.resumeId] : []), t.prompt],
    files: {
      // Project config in the work dir: Sandflow's tools on, the file/shell tools off.
      "opencode.json": JSON.stringify(
        {
          $schema: "https://opencode.ai/config.json",
          mcp: { sandflow: { type: "local", command: [t.mcp.command, ...t.mcp.args], environment: t.mcp.env, enabled: true } },
          tools: { bash: false, edit: false, write: false, patch: false, webfetch: false },
        },
        null,
        2,
      ),
    },
  }),
  parse(line) {
    const o = json(line);
    if (!o) return [];
    if (o.type === "step_start" && typeof o.sessionID === "string") return [{ type: "session", id: o.sessionID }];
    if (o.type === "text" && o.part?.type === "text" && typeof o.part.text === "string") return [{ type: "text", text: o.part.text }];
    if (o.type === "error") return [{ type: "error", message: errorText(o) }];
    return [];
  },
};

const cursor: AgentAdapter = {
  provider: "cursor",
  bins: ["cursor-agent", "agent"],
  tools: "mcp",
  systemPromptFlag: false,
  authEnv: ["CURSOR_API_KEY"],
  build: (t) => ({
    args: [
      "--print",
      "--output-format", "stream-json",
      "--approve-mcps",
      "--force",
      ...(t.model ? ["--model", t.model] : []),
      ...(t.resumeId ? ["--resume", t.resumeId] : []),
      t.prompt,
    ],
    files: { ".cursor/mcp.json": JSON.stringify({ mcpServers: { sandflow: { command: t.mcp.command, args: t.mcp.args, env: t.mcp.env } } }, null, 2) },
  }),
  parse: parseClaudeStream,
};

const copilot: AgentAdapter = {
  provider: "copilot",
  bins: ["copilot"],
  tools: "mcp",
  systemPromptFlag: false,
  authEnv: ["COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"],
  build: (t) => ({
    args: [
      "-p", t.prompt,
      "--output-format", "json",
      "--additional-mcp-config", `@${path.join(t.workDir, "copilot-mcp.json")}`,
      "--allow-tool", "sandflow",
      "--deny-tool", "shell",
      "--deny-tool", "write",
      ...(t.model ? ["--model", t.model] : []),
      ...(t.resumeId ? ["--resume", t.resumeId] : []),
    ],
    files: {
      "copilot-mcp.json": JSON.stringify({ mcpServers: { sandflow: { type: "local", command: t.mcp.command, args: t.mcp.args, env: t.mcp.env, tools: ["*"] } } }, null, 2),
    },
  }),
  parse(line) {
    const o = json(line);
    if (!o) return [];
    if (o.type === "assistant.message" && typeof o.data?.content === "string" && o.data.content.trim()) return [{ type: "text", text: o.data.content }];
    if (o.type === "result" && typeof o.sessionId === "string") return [{ type: "session", id: o.sessionId }];
    if (o.type === "error" || o.type === "agent_error") return [{ type: "error", message: errorText(o) }];
    return [];
  },
};

const pi: AgentAdapter = {
  provider: "pi",
  bins: ["pi"],
  tools: "text",
  systemPromptFlag: false,
  authEnv: ["ANTHROPIC_API_KEY", "OPENAI_API_KEY"],
  build: (t) => ({
    args: ["-p", "--mode", "json", ...(t.model ? ["--model", t.model] : []), ...(t.resumeId ? ["--session", t.resumeId] : [])],
    stdin: t.prompt,
  }),
  parse(line) {
    const o = json(line);
    if (!o) return [];
    if (o.type === "session" && typeof o.id === "string") return [{ type: "session", id: o.id }];
    // The final assistant message (deltas would duplicate it).
    if (o.type === "agent_end" && Array.isArray(o.messages)) {
      const last = [...o.messages].reverse().find((m: { role?: string }) => m?.role === "assistant");
      const text = ((last?.content ?? []) as { type?: string; text?: string }[])
        .filter((b) => b.type === "text" && typeof b.text === "string")
        .map((b) => b.text)
        .join("");
      return text.trim() ? [{ type: "text", text }] : [];
    }
    if (o.type === "agent_error" || o.type === "error") return [{ type: "error", message: errorText(o) }];
    return [];
  },
};

export const ADAPTERS: Record<AgentProvider, AgentAdapter> = { claudeCode, codex, opencode, cursor, copilot, pi };

/** Stdio ↔ HTTP MCP bridge, run with Node: `node sandflow-mcp-bridge.cjs <url>`. */
export const MCP_BRIDGE = `// Generated by Sandflow: forwards MCP JSON-RPC from stdin to Sandflow's HTTP endpoint.
const url = process.argv[2];
let pending = 0;
let closed = false;
const done = () => closed && !pending && process.exit(0);
const reply = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
require("node:readline").createInterface({ input: process.stdin })
  .on("line", async (line) => {
    if (!line.trim()) return;
    pending++;
    let id;
    try { id = JSON.parse(line).id; } catch {}
    try {
      const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: line });
      const text = res.status === 202 ? "" : (await res.text()).trim();
      if (text) process.stdout.write(text.replace(/\\r?\\n/g, " ") + "\\n");
      else if (res.status >= 400 && id !== undefined) reply({ jsonrpc: "2.0", id, error: { code: -32603, message: "Sandflow answered " + res.status } });
    } catch (e) {
      if (id !== undefined) reply({ jsonrpc: "2.0", id, error: { code: -32603, message: "Sandflow isn't reachable: " + e.message } });
    } finally {
      pending--;
      done();
    }
  })
  .on("close", () => { closed = true; done(); });
`;
