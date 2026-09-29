// "Edit with AI" chats: saved per flow under <data>/chats/. Each turn runs the chat's agent CLI (any agent a block
// can use) on the host; its only way to change things is Sandflow's MCP server, scoped to the chat's flow.

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { AGENT_LABELS } from "../shared/agents";
import { describeBlocks, describeFlow } from "../shared/flowOps";
import { FLOW_GUIDE } from "../shared/flowGuide";
import { validateAssistantAgent } from "../shared/settings";
import type { AppData, AssistantAgent, Chat, ChatMessage, ChatSummary } from "../shared/types";
import { ADAPTERS, MCP_BRIDGE, type AdapterTurn, type AssistantEvent } from "./assistantAgents";
import type { Mcp } from "./mcp";

export type { AssistantEvent } from "./assistantAgents";

const CHAT_ID_RE = /^chat-[\w-]+$/;
/** Text-protocol agents (pi) get this many tries to send ops that apply cleanly. */
const MAX_OP_ATTEMPTS = 3;

export interface AssistantTurn extends AdapterTurn {
  agent: AssistantAgent;
  env: NodeJS.ProcessEnv;
  signal: AbortSignal;
}

/** Runs one agent invocation and yields what happens. Swappable for tests. */
export type AssistantRunner = (turn: AssistantTurn) => AsyncIterable<AssistantEvent>;

// ---------- finding the CLI ----------

/**
 * How to start an agent CLI. On Windows an npm install is only a `<name>.cmd` shim, which Node can't spawn without a
 * shell — so read the shim for the real `.exe` (or `.js`) it forwards to. `SANDFLOW_<NAME>_PATH` overrides
 * (e.g. SANDFLOW_CLAUDE_PATH, SANDFLOW_CURSOR_AGENT_PATH).
 */
export function resolveCli(
  bins: string[],
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): { cmd: string; args: string[]; viaCmd?: boolean } {
  for (const bin of bins) {
    const override = env[`SANDFLOW_${bin.toUpperCase().replace(/-/g, "_")}_PATH`]?.trim();
    if (override) return { cmd: override, args: [] };
  }
  const dirs = (env.PATH ?? env.Path ?? "").split(path.delimiter).filter(Boolean);
  for (const bin of bins) {
    if (platform !== "win32") {
      if (bins.length === 1 || dirs.some((d) => fs.existsSync(path.join(d, bin)))) return { cmd: bin, args: [] };
      continue;
    }
    for (const dir of dirs) {
      const exe = path.join(dir, `${bin}.exe`);
      if (fs.existsSync(exe)) return { cmd: exe, args: [] };
      const shim = path.join(dir, `${bin}.cmd`);
      if (!fs.existsSync(shim)) continue;
      const target = /"%dp0%\\([^"]+\.(?:exe|js|cjs|mjs))"/i.exec(fs.readFileSync(shim, "utf8"))?.[1];
      // The shim writes the target with backslashes; split on either separator so this holds on any host.
      const full = target && path.join(dir, ...target.split(/[\\/]+/));
      if (full && fs.existsSync(full)) {
        // In Electron, process.execPath is the app; ELECTRON_RUN_AS_NODE makes it behave as node.
        return full.toLowerCase().endsWith(".exe") ? { cmd: full, args: [] } : { cmd: process.execPath, args: [full] };
      }
      return { cmd: shim, args: [], viaCmd: true };
    }
  }
  return { cmd: bins[0], args: [] };
}

/** cmd.exe command line for a .cmd shim we couldn't see through. */
function cmdLine(cmd: string, args: string[]): string {
  const bad = [cmd, ...args].find((a) => /["%\r\n]/.test(a));
  if (bad !== undefined) throw new Error(`Can't pass this argument through ${path.basename(cmd)} safely. Set SANDFLOW_<NAME>_PATH to the agent's executable instead.`);
  return `"${[cmd, ...args].map((a) => `"${a}"`).join(" ")}"`;
}

/** Default runner: the agent's CLI via its adapter. */
export const cliRunner: AssistantRunner = async function* (turn) {
  const adapter = ADAPTERS[turn.agent.provider];
  const command = adapter.build(turn);
  for (const [rel, content] of Object.entries(command.files ?? {})) {
    const f = path.join(turn.workDir, rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, content);
  }
  const bin = resolveCli(adapter.bins, turn.env);
  const opts = { cwd: turn.workDir, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] as ["pipe", "pipe", "pipe"] };
  const child = bin.viaCmd
    ? spawn(turn.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", cmdLine(bin.cmd, command.args)], { ...opts, env: turn.env, windowsVerbatimArguments: true })
    : spawn(bin.cmd, [...bin.args, ...command.args], { ...opts, env: bin.args.length ? { ...turn.env, ELECTRON_RUN_AS_NODE: "1" } : turn.env });

  const kill = () => child.kill();
  turn.signal.addEventListener("abort", kill, { once: true });
  let stderr = "";
  child.stderr.on("data", (d: Buffer) => (stderr = (stderr + d.toString()).slice(-4000)));
  const exited = new Promise<{ code: number | null; err?: Error }>((resolve) => {
    child.once("error", (err) => resolve({ code: null, err }));
    child.once("close", (code) => resolve({ code }));
  });
  child.stdin.on("error", () => {});
  child.stdin.end(command.stdin ?? "");

  const name = AGENT_LABELS[turn.agent.provider];
  let reportedError = false;
  try {
    for await (const line of createInterface({ input: child.stdout })) {
      for (const ev of adapter.parse(line)) {
        if (ev.type === "error") reportedError = true;
        yield ev;
      }
    }
    const { code, err } = await exited;
    if (turn.signal.aborted) return;
    if (err) {
      const missing = (err as NodeJS.ErrnoException).code === "ENOENT";
      const envName = `SANDFLOW_${adapter.bins[0].toUpperCase().replace(/-/g, "_")}_PATH`;
      yield {
        type: "error",
        message: missing
          ? `Couldn't start ${name}: \`${adapter.bins.join("` or `")}\` isn't installed or isn't on PATH. Install it, or set ${envName} to its executable.`
          : `Couldn't start ${name}: ${err.message}`,
      };
    } else if (code !== 0 && !reportedError) {
      const tail = stderr.trim().split("\n").slice(-3).join(" ");
      yield { type: "error", message: `${name} exited with code ${code}.${tail ? ` ${tail}` : ""}` };
    }
  } finally {
    turn.signal.removeEventListener("abort", kill);
    if (child.exitCode === null) child.kill();
  }
};

// ---------- prompts ----------

export function systemPrompt(flowName: string, flowId: string, tools: "mcp" | "text"): string {
  const lines = [
    "# Sandflow flow assistant",
    "",
    `You are the assistant inside Sandflow, a visual builder for coding-agent pipelines. The user is looking at the flow "${flowName}" (id: ${flowId}) on the canvas and chatting with you in a side panel.`,
  ];
  if (tools === "mcp") {
    lines.push(
      "Your tools (the sandflow MCP server) read and edit that flow; the canvas updates live as you save. You can't edit other flows, set env values or run flows. Don't use any other tools.",
    );
  } else {
    lines.push(
      "You have no tools here. Each message includes the flow's current state and the block library. To change the flow, end your reply with ONE fenced block tagged `sandflow-ops` holding JSON:",
      "- an array of edit ops: add_node {id, block, label?, overrides?}, update_node {id, block?, label?, overrides?}, remove_node {id}, connect {edge}, disconnect {edge}, rename_flow {name}, auto_layout — e.g.",
      '```sandflow-ops\n[{"op":"add_node","id":"review","block":"cr"},{"op":"connect","edge":"impl.artifact -> review.artifact"}]\n```',
      '- or {"replace": {"name"?: "...", "nodes": [{id, block, label?, overrides?}], "edges": ["a.artifact -> b.artifact"]}} to rebuild the whole flow.',
      "Sandflow applies it and replies if it failed so you can send a corrected block. Only include the block when you want changes. You can't set env values or run flows.",
      "The guide below names MCP tools; in this chat the ops block does the same job (edit_flow = ops array, replace_flow = replace).",
    );
  }
  lines.push(
    "",
    "Reply style: plain, short. Don't restate the whole flow — the user can see it. After changing the flow, say in 1–3 sentences what you changed and anything the user still needs to fill in or decide.",
    "If the request is ambiguous in a way that changes the design (which trigger, which repo host, whether to open an MR), ask one short question before building.",
    "",
    FLOW_GUIDE,
  );
  return lines.join("\n");
}

const plain = (m: ChatMessage) =>
  m.parts
    .map((p) => (p.type === "text" ? p.text : p.call.isError ? "" : `[${p.call.name}] ${(p.call.result ?? "").split("\n\n")[0]}`))
    .filter(Boolean)
    .join("\n");

/** The conversation so far, for an agent that joins mid-chat (the user switched agents). */
function transcript(messages: ChatMessage[]): string {
  const text = messages
    .filter((m) => m.status !== "running")
    .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${plain(m)}`)
    .join("\n\n");
  return text.length > 8000 ? `…${text.slice(-8000)}` : text;
}

/** Last `sandflow-ops` block in a reply: the reply without it, and its JSON. */
export function extractOps(reply: string): { text: string; ops?: unknown; parseError?: string } {
  const re = /```sandflow-ops\s*\n([\s\S]*?)```/g;
  const matches = [...reply.matchAll(re)];
  if (!matches.length) return { text: reply };
  const last = matches.at(-1)!;
  const text = reply.replace(re, "").trim();
  try {
    return { text, ops: JSON.parse(last[1]) };
  } catch (e) {
    return { text, parseError: `The sandflow-ops block isn't valid JSON: ${(e as Error).message}` };
  }
}

// ---------- service ----------

export type ChatService = ReturnType<typeof createChatService>;

const DEFAULT_AGENT: AssistantAgent = { provider: "claudeCode" };

export function createChatService(opts: { dir: string; load(): AppData; mcp: Mcp; runner?: AssistantRunner; env?: NodeJS.ProcessEnv }) {
  const chatsDir = path.join(opts.dir, "chats");
  const runner = opts.runner ?? cliRunner;
  const active = new Map<string, { ctrl: AbortController; reply: ChatMessage }>();
  const listeners = new Map<string, Set<(c: Chat) => void>>();
  const cache = new Map<string, Chat>();

  const file = (id: string) => {
    if (!CHAT_ID_RE.test(id)) throw new Error("Invalid chat id");
    return path.join(chatsDir, `${id}.json`);
  };

  function write(chat: Chat) {
    fs.mkdirSync(chatsDir, { recursive: true });
    const f = file(chat.id);
    const tmp = `${f}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(chat, null, 2));
    fs.renameSync(tmp, f);
  }

  function get(id: string): Chat | undefined {
    const hit = cache.get(id);
    if (hit) return hit;
    try {
      const c = JSON.parse(fs.readFileSync(file(id), "utf8")) as Chat;
      return { ...c, agent: c.agent ?? DEFAULT_AGENT, sessions: c.sessions ?? {} };
    } catch {
      return undefined;
    }
  }

  const emit = (chat: Chat) => listeners.get(chat.id)?.forEach((fn) => fn(chat));
  const summary = (c: Chat): ChatSummary => ({ id: c.id, flowId: c.flowId, title: c.title, updatedAt: c.updatedAt, running: active.has(c.id) });
  const flowBusy = (flowId: string) => [...active.keys()].some((id) => get(id)?.flowId === flowId);

  function agentEnv(provider: AssistantAgent["provider"]): NodeJS.ProcessEnv {
    const base = opts.env ?? process.env;
    const stored = opts.load().env;
    const extra = Object.fromEntries(ADAPTERS[provider].authEnv.filter((k) => !base[k] && stored[k]?.trim()).map((k) => [k, stored[k]]));
    return { ...base, ...extra };
  }

  async function runTurn(chat: Chat, text: string, mcpBase: string, ctrl: AbortController, reply: ChatMessage) {
    const touch = () => {
      chat.updatedAt = Date.now();
      emit(chat);
    };
    const addText = (t: string) => {
      if (!t.trim()) return;
      const last = reply.parts.at(-1);
      if (last?.type === "text") last.text += `\n\n${t}`;
      else reply.parts.push({ type: "text", text: t });
    };
    try {
      const data = opts.load();
      const flow = data.flows.find((f) => f.id === chat.flowId);
      if (!flow) throw new Error("This chat's flow was deleted");
      const agent = chat.agent;
      const adapter = ADAPTERS[agent.provider];
      const workDir = path.join(chatsDir, chat.id, agent.provider);
      fs.mkdirSync(workDir, { recursive: true });
      const bridge = path.join(workDir, "sandflow-mcp-bridge.cjs");
      fs.writeFileSync(bridge, MCP_BRIDGE);
      const url = `${mcpBase}?flow=${encodeURIComponent(flow.id)}&chat=${encodeURIComponent(chat.id)}`;
      const sys = systemPrompt(flow.name, flow.id, adapter.tools);
      const earlier = chat.messages.slice(0, -2); // everything before this turn's user message + reply

      let request = text;
      for (let attempt = 1; ; attempt++) {
        const resumeId = chat.sessions[agent.provider];
        const parts: string[] = [];
        if (!resumeId && !adapter.systemPromptFlag) parts.push(sys);
        if (!resumeId && earlier.length) parts.push(`# Conversation so far\n\n${transcript(earlier)}`);
        if (adapter.tools === "text") {
          const now = opts.load();
          const current = now.flows.find((f) => f.id === flow.id) ?? flow;
          parts.push(`# Current flow\n\n${describeFlow(current, now.blocks)}`, `# Block library\n\n${describeBlocks(now.blocks)}`);
        }
        const prompt = parts.length ? `${parts.join("\n\n")}\n\n# Request\n\n${request}` : request;

        let said = "";
        for await (const ev of runner({
          agent,
          prompt,
          systemPrompt: sys,
          model: agent.model,
          resumeId,
          workDir,
          env: agentEnv(agent.provider),
          signal: ctrl.signal,
          mcp: { url, command: process.execPath, args: [bridge, url], env: { ELECTRON_RUN_AS_NODE: "1" } },
        })) {
          if (ev.type === "session") chat.sessions[agent.provider] = ev.id;
          else if (ev.type === "error") {
            reply.status = "error";
            reply.error = ev.message;
          } else if (adapter.tools === "text") said += (said ? "\n\n" : "") + ev.text;
          else addText(ev.text);
          touch();
        }
        if (adapter.tools !== "text" || ctrl.signal.aborted || reply.status === "error") break;

        // Text protocol: apply the ops block through the same MCP tools (so it's validated, saved and recorded).
        const { text: shown, ops, parseError } = extractOps(said);
        addText(shown);
        let failure = parseError;
        if (ops !== undefined && !failure) {
          const replace = ops && typeof ops === "object" && !Array.isArray(ops) ? (ops as { replace?: Record<string, unknown> }).replace : undefined;
          const r = replace
            ? opts.mcp.callTool("replace_flow", replace, { scope: flow.id, onCall: (c) => record(chat.id, c) })
            : opts.mcp.callTool("edit_flow", { ops }, { scope: flow.id, onCall: (c) => record(chat.id, c) });
          if (r.isError) failure = r.text;
        }
        touch();
        if (!failure) break;
        if (attempt >= MAX_OP_ATTEMPTS) {
          reply.status = "error";
          reply.error = `The changes couldn't be applied: ${failure}`;
          break;
        }
        request = `Sandflow couldn't apply your sandflow-ops block: ${failure}\nSend a corrected block (the flow above is unchanged).`;
      }
      if (ctrl.signal.aborted) reply.status = "cancelled";
      else if (reply.status === "running") reply.status = "done";
    } catch (e) {
      reply.status = ctrl.signal.aborted ? "cancelled" : "error";
      if (!ctrl.signal.aborted) reply.error = (e as Error).message;
    } finally {
      active.delete(chat.id);
      chat.updatedAt = Date.now();
      write(chat);
      cache.delete(chat.id);
      emit(chat);
    }
  }

  /** A tool call made during a chat's turn (reported by the MCP server). */
  function record(chatId: string, call: { name: string; input: unknown; text: string; isError: boolean }) {
    const a = active.get(chatId);
    const chat = cache.get(chatId);
    if (!a || !chat) return;
    a.reply.parts.push({ type: "tool", call: { id: randomUUID(), name: call.name, input: call.input, result: call.text, isError: call.isError } });
    chat.updatedAt = Date.now();
    emit(chat);
  }

  return {
    list(flowId: string): ChatSummary[] {
      let names: string[];
      try {
        names = fs.readdirSync(chatsDir).filter((n) => n.endsWith(".json"));
      } catch {
        return [];
      }
      return names
        .map((n) => get(n.slice(0, -5)))
        .filter((c): c is Chat => !!c && c.flowId === flowId)
        .map(summary)
        .sort((a, b) => b.updatedAt - a.updatedAt);
    },
    create(flowId: string, agent?: AssistantAgent): Chat {
      if (!opts.load().flows.some((f) => f.id === flowId)) throw new Error("Flow not found");
      const now = Date.now();
      const chat: Chat = {
        id: `chat-${randomUUID()}`,
        flowId,
        title: "New chat",
        createdAt: now,
        updatedAt: now,
        agent: validateAssistantAgent(agent ?? opts.load().settings.assistantAgent ?? DEFAULT_AGENT),
        sessions: {},
        messages: [],
      };
      write(chat);
      return chat;
    },
    get,
    running: (id: string) => active.has(id),
    /** Switch the agent answering in this chat (takes effect next turn). */
    setAgent(id: string, agent: AssistantAgent): Chat {
      const chat = get(id);
      if (!chat) throw new Error("Chat not found");
      if (active.has(id)) throw new Error("Wait for the current answer to finish before switching agents");
      chat.agent = validateAssistantAgent(agent);
      write(chat);
      emit(chat);
      return chat;
    },
    remove(id: string) {
      active.get(id)?.ctrl.abort();
      fs.rmSync(file(id), { force: true });
      fs.rmSync(path.join(chatsDir, id), { recursive: true, force: true });
    },
    /** Start a turn; the reply streams to subscribers. */
    send(id: string, text: string, mcpBase: string): { error?: string; status?: number } {
      const chat = get(id);
      if (!chat) return { status: 404, error: "Chat not found" };
      if (!text.trim()) return { status: 400, error: "Write a message first" };
      if (active.has(id)) return { status: 409, error: "The assistant is still answering in this chat" };
      if (flowBusy(chat.flowId)) return { status: 409, error: "Another chat is editing this flow right now. Wait for it to finish or stop it." };
      if (!chat.messages.length) chat.title = text.trim().replace(/\s+/g, " ").slice(0, 60);
      chat.messages.push({ id: randomUUID(), role: "user", ts: Date.now(), parts: [{ type: "text", text: text.trim() }] });
      const reply: ChatMessage = { id: randomUUID(), role: "assistant", ts: Date.now(), parts: [], status: "running", agent: chat.agent.provider };
      chat.messages.push(reply);
      const ctrl = new AbortController();
      active.set(id, { ctrl, reply });
      cache.set(id, chat);
      write(chat);
      emit(chat);
      void runTurn(chat, text.trim(), mcpBase, ctrl, reply);
      return {};
    },
    record,
    cancel(id: string): boolean {
      const a = active.get(id);
      a?.ctrl.abort();
      return !!a;
    },
    subscribe(id: string, fn: (c: Chat) => void): () => void {
      let set = listeners.get(id);
      if (!set) listeners.set(id, (set = new Set()));
      set.add(fn);
      return () => set!.delete(fn);
    },
    async shutdown() {
      [...active.values()].forEach((a) => a.ctrl.abort());
    },
  };
}
