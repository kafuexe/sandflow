// What an agent block is doing while it runs: its thinking, replies and tool calls, parsed from the agent CLI's
// output stream. Shared by the server (parsing, capping) and the UI (showing it).

export type ActivityKind = "thinking" | "text" | "tool" | "tool_result" | "result";

export interface AgentActivity {
  ts: number;
  kind: ActivityKind;
  /** thinking / text / result: the text; tool: a short summary of its input; tool_result: the start of its output. */
  text: string;
  /** tool: the tool's name. */
  name?: string;
  /** tool_result / result: the tool or the run reported an error. */
  isError?: boolean;
  /** Which execution of the node it belongs to (1-based). */
  exec?: number;
}

/** An activity item before it gets its timestamp / execution. `chunk`: a piece of a streamed reply (joined to the one before). */
export type ActivityDraft = Omit<AgentActivity, "ts" | "exec"> & { chunk?: boolean };

/** Longest text kept in one item (thinking and replies can be long — the start is what tells you what's going on). */
export const MAX_ITEM_CHARS = 4000;
/** Tool inputs and results are shown as one compact line. */
export const MAX_TOOL_CHARS = 200;
export const MAX_RESULT_CHARS = 400;
/** Per node: older items are dropped once a node's activity holds more text than this. */
export const MAX_NODE_CHARS = 48_000;

export function clip(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

// Input fields that best describe a call, by how commonly tools use them.
const SUMMARY_KEYS = ["command", "file_path", "pattern", "path", "url", "query", "description", "prompt", "skill", "notebook_path"];

/** One line saying what a tool call does, e.g. `npm test` for Bash or `src/app.ts` for Read. */
export function summarizeToolInput(input: unknown): string {
  if (input === undefined || input === null) return "";
  if (typeof input !== "object") return clip(oneLine(String(input)), MAX_TOOL_CHARS);
  const o = input as Record<string, unknown>;
  const key = SUMMARY_KEYS.find((k) => typeof o[k] === "string" && (o[k] as string).trim());
  if (key) {
    const extra = key === "pattern" && typeof o.path === "string" ? ` in ${o.path}` : "";
    return clip(oneLine(`${o[key] as string}${extra}`), MAX_TOOL_CHARS);
  }
  if (Array.isArray(o.todos)) {
    const todos = o.todos as { content?: unknown; status?: unknown }[];
    const active = todos.find((t) => t?.status === "in_progress");
    return clip(`${todos.length} todo${todos.length === 1 ? "" : "s"}${typeof active?.content === "string" ? ` · now: ${active.content}` : ""}`, MAX_TOOL_CHARS);
  }
  try {
    return clip(oneLine(JSON.stringify(input)), MAX_TOOL_CHARS);
  } catch {
    return "";
  }
}

/** Text of a tool_result's `content` (a string, or text blocks). */
function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((b) => (b && typeof b === "object" && (b as { type?: unknown }).type === "text" ? String((b as { text?: unknown }).text ?? "") : ""))
    .filter(Boolean)
    .join("\n");
}

/**
 * Activity in one line of Claude Code's `--output-format stream-json` output. Anything that isn't a JSON object
 * of a known shape (stderr noise, partial lines, other event types) gives nothing.
 */
export function parseClaudeStreamLine(line: string): ActivityDraft[] {
  const t = line.trim();
  if (!t.startsWith("{")) return [];
  let obj: Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  try {
    obj = JSON.parse(t);
  } catch {
    return [];
  }
  if (!obj || typeof obj !== "object") return [];
  const out: ActivityDraft[] = [];
  const content = obj.message?.content;
  if (obj.type === "assistant" && Array.isArray(content)) {
    for (const b of content) {
      if (!b || typeof b !== "object") continue;
      if (b.type === "thinking" && typeof b.thinking === "string" && b.thinking.trim()) {
        out.push({ kind: "thinking", text: clip(b.thinking.trim(), MAX_ITEM_CHARS) });
      } else if (b.type === "redacted_thinking") {
        out.push({ kind: "thinking", text: "(thinking hidden)" });
      } else if (b.type === "text" && typeof b.text === "string" && b.text.trim()) {
        out.push({ kind: "text", text: clip(b.text.trim(), MAX_ITEM_CHARS) });
      } else if (b.type === "tool_use" && typeof b.name === "string") {
        out.push({ kind: "tool", name: b.name, text: summarizeToolInput(b.input) });
      }
    }
  } else if (obj.type === "user" && Array.isArray(content)) {
    for (const b of content) {
      if (!b || typeof b !== "object" || b.type !== "tool_result") continue;
      const text = clip(oneLine(resultText(b.content)), MAX_RESULT_CHARS);
      out.push({ kind: "tool_result", text: text || (b.is_error ? "error" : "(no output)"), ...(b.is_error ? { isError: true } : {}) });
    }
  } else if (obj.type === "result") {
    const parts: string[] = [];
    if (typeof obj.num_turns === "number") parts.push(`${obj.num_turns} turn${obj.num_turns === 1 ? "" : "s"}`);
    if (typeof obj.duration_ms === "number") parts.push(`${Math.round(obj.duration_ms / 100) / 10}s`);
    if (typeof obj.total_cost_usd === "number") parts.push(`$${obj.total_cost_usd.toFixed(4)}`);
    const isError = obj.is_error === true || (typeof obj.subtype === "string" && obj.subtype.startsWith("error"));
    const head = isError ? `Failed${typeof obj.subtype === "string" && obj.subtype !== "error" ? ` (${obj.subtype})` : ""}` : "Finished";
    out.push({ kind: "result", text: `${head}${parts.length ? ` · ${parts.join(" · ")}` : ""}`, ...(isError ? { isError: true } : {}) });
  }
  return out;
}

/**
 * Best effort for other agents' JSON lines: only what sandcastle's own parsers drop (Codex reasoning). Their replies
 * and tool calls come through sandcastle's typed stream events.
 */
export function parseOtherStreamLine(line: string): ActivityDraft[] {
  const t = line.trim();
  if (!t.startsWith("{")) return [];
  try {
    const obj = JSON.parse(t);
    const item = obj?.item;
    if (obj?.type === "item.completed" && item?.type === "reasoning" && typeof item.text === "string" && item.text.trim()) {
      return [{ kind: "thinking", text: clip(item.text.trim(), MAX_ITEM_CHARS) }];
    }
  } catch {
    /* not JSON */
  }
  return [];
}

const size = (a: AgentActivity) => a.text.length + (a.name?.length ?? 0);

/**
 * `list` with `items` added (in place), keeping at most `maxChars` of text: the oldest items go first. A text
 * `chunk` right after a text item of the same execution is joined to it (agents that stream replies in pieces).
 */
export function appendActivity(list: AgentActivity[], items: (AgentActivity & { chunk?: boolean })[], maxChars = MAX_NODE_CHARS): AgentActivity[] {
  for (const { chunk, ...it } of items) {
    const last = list[list.length - 1];
    if (chunk && it.kind === "text" && last?.kind === "text" && last.exec === it.exec && last.text.length + it.text.length <= MAX_ITEM_CHARS) {
      list[list.length - 1] = { ...last, text: last.text + it.text, ts: it.ts };
    } else list.push(it);
  }
  let total = list.reduce((n, a) => n + size(a), 0);
  let drop = 0;
  while (total > maxChars && drop < list.length - 1) total -= size(list[drop++]);
  if (drop) list.splice(0, drop);
  return list;
}
