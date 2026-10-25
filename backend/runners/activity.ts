// Turns sandcastle's agent stream events into run log lines and live agent activity (thinking, replies, tool calls).

import { clip, MAX_ITEM_CHARS, MAX_TOOL_CHARS, parseClaudeStreamLine, parseOtherStreamLine, type ActivityDraft } from "../../shared/activity";
import type { AgentProvider } from "../../shared/types";
import type { RunContext } from "../engine";

/** The events sandcastle passes to `logging.onAgentStreamEvent` (only in log-to-file mode). */
export type StreamEvent =
  | { type: "text"; message: string }
  | { type: "toolCall"; name: string; formattedArgs?: string }
  | { type: "raw"; line: string }
  | { type: string; message?: string; name?: string; formattedArgs?: string; line?: string };

/**
 * Handler for one agent node's stream. Replies and tool calls go to the run log as before; activity comes from the
 * raw stdout lines for Claude Code (sandcastle's own parser drops thinking, tool results and some tools), and from
 * sandcastle's parsed events for every other agent.
 */
export function agentStreamHandler(ctx: Pick<RunContext, "log" | "activity">, nodeId: string, provider: AgentProvider) {
  const claude = provider === "claudeCode";
  return (ev: StreamEvent) => {
    if (ev.type === "text" && ev.message?.trim()) ctx.log("agent", ev.message.trim(), nodeId);
    else if (ev.type === "toolCall") ctx.log("agent", `🔧 ${ev.name} ${ev.formattedArgs ?? ""}`.trim(), nodeId);
    if (!ctx.activity) return;
    let items: ActivityDraft[] = [];
    if (ev.type === "raw" && typeof ev.line === "string") items = claude ? parseClaudeStreamLine(ev.line) : parseOtherStreamLine(ev.line);
    else if (!claude && ev.type === "text" && ev.message) items = [{ kind: "text", text: clip(ev.message, MAX_ITEM_CHARS), chunk: true }];
    else if (!claude && ev.type === "toolCall" && ev.name) {
      items = [{ kind: "tool", name: ev.name, text: clip((ev.formattedArgs ?? "").replace(/\s+/g, " ").trim(), MAX_TOOL_CHARS) }];
    }
    if (items.length) ctx.activity(nodeId, items);
  };
}
