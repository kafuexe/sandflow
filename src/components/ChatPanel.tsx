import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  ArrowUp,
  BotMessageSquare,
  CircleAlert,
  Eye,
  Library,
  ListChecks,
  Loader2,
  MessageSquarePlus,
  Square,
  Trash2,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { defaultAgent, useChatStore } from "@/lib/chatStore";
import { useCurrentFlow, useStore } from "@/lib/store";
import { cn } from "@/lib/utils";
import { AGENT_LABELS, AGENT_PROVIDERS } from "../../shared/agents";
import { resolveNode } from "../../shared/resolve";
import type { AgentProvider, ChatMessage, ChatToolCall, Flow } from "../../shared/types";

/** The assistant's colour is the AI-block colour used on the canvas. */
const AI = "#8b5cf6";
const EDGE_COLORS: Record<string, string> = { artifact: "#3b82f6", steer: "#f59e0b", true: "#22c55e", false: "#ef4444" };

// ---------- tiny markdown (paragraphs, bullets, **bold**, `code`) ----------

function Inline({ text }: { text: string }) {
  const parts = text.split(/(`[^`]+`|\*\*[^*]+\*\*)/g);
  return (
    <>
      {parts.map((p, i) =>
        p.startsWith("`") && p.endsWith("`") && p.length > 1 ? (
          <code key={i} className="rounded bg-muted px-1 py-px font-mono text-[0.85em]">
            {p.slice(1, -1)}
          </code>
        ) : p.startsWith("**") && p.endsWith("**") && p.length > 3 ? (
          <strong key={i} className="font-semibold text-foreground">
            {p.slice(2, -2)}
          </strong>
        ) : (
          <Fragment key={i}>{p}</Fragment>
        ),
      )}
    </>
  );
}

function Prose({ text }: { text: string }) {
  const blocks = text.trim().split(/\n{2,}/);
  return (
    <div className="space-y-2">
      {blocks.map((b, i) => {
        const lines = b.split("\n");
        if (lines.every((l) => /^\s*([-*]|\d+\.)\s/.test(l))) {
          return (
            <ul key={i} className="space-y-1 pl-4">
              {lines.map((l, j) => (
                <li key={j} className="list-disc marker:text-muted-foreground">
                  <Inline text={l.replace(/^\s*([-*]|\d+\.)\s/, "")} />
                </li>
              ))}
            </ul>
          );
        }
        return (
          <p key={i} className="whitespace-pre-wrap">
            <Inline text={b} />
          </p>
        );
      })}
    </div>
  );
}

// ---------- tool calls ----------

const READ_TOOLS: Record<string, { label: string; icon: ReactNode }> = {
  list_blocks: { label: "Read the block library", icon: <Library /> },
  list_flows: { label: "Listed the flows", icon: <Library /> },
  get_flow: { label: "Looked at the flow", icon: <Eye /> },
  validate_flow: { label: "Checked the flow for problems", icon: <ListChecks /> },
  flow_requirements: { label: "Checked which inputs the flow needs", icon: <ListChecks /> },
};

const WRITE_TITLES: Record<string, string> = {
  edit_flow: "Edited the flow",
  replace_flow: "Rebuilt the flow",
  create_flow: "Created a flow",
  save_block: "Saved a block",
};

/** Lines of the `Changes:` section of an edit tool's result. */
function changeLines(result: string): string[] {
  const m = /Changes:\n([\s\S]*?)(\n\n|$)/.exec(result);
  return m ? m[1].split("\n").filter((l) => /^[+~-] /.test(l)) : [];
}

function problemCount(result: string): number {
  const m = /Errors:\n((?:- .*\n?)+)/.exec(result);
  return m ? m[1].trim().split("\n").length : 0;
}

function NodeChip({ id, flow, gone }: { id: string; flow: Flow | null; gone?: boolean }) {
  const blocks = useStore((s) => s.data?.blocks ?? []);
  const node = flow?.nodes.find((n) => n.id === id);
  let color = "#71717a";
  if (node) {
    try {
      color = resolveNode(node, blocks).color;
    } catch {
      /* unknown block */
    }
  }
  return (
    <span
      className={cn(
        "inline-flex max-w-[9rem] items-center gap-1 rounded border bg-background/60 px-1.5 py-px font-mono text-[11px]",
        gone && "text-muted-foreground line-through decoration-red-400/70",
      )}
      title={node?.data.label || id}
    >
      <span className="size-1.5 shrink-0 rounded-full" style={{ background: color }} />
      <span className="truncate">{id}</span>
    </span>
  );
}

/** A connection drawn the way the canvas draws it: solid blue artifact, dashed amber steer. */
function EdgeStroke({ handle, gone }: { handle: string; gone?: boolean }) {
  const color = EDGE_COLORS[handle] ?? "#a1a1aa";
  return (
    <span className="inline-flex shrink-0 items-center" title={handle}>
      <svg width="34" height="10" viewBox="0 0 34 10" aria-hidden className={cn(gone && "opacity-40")}>
        <line x1="1" y1="5" x2="27" y2="5" stroke={color} strokeWidth="2" strokeDasharray={handle === "steer" ? "4 3" : undefined} />
        <path d="M26 1.5 L32 5 L26 8.5 Z" fill={color} />
      </svg>
      {(handle === "true" || handle === "false") && <span className="ml-0.5 text-[10px] text-muted-foreground">{handle}</span>}
    </span>
  );
}

function ChangeLine({ line, flow }: { line: string; flow: Flow | null }) {
  const sign = line[0];
  const body = line.slice(2);
  const mark = (
    <span className={cn("w-3 shrink-0 text-center font-mono", sign === "+" ? "text-emerald-400" : sign === "-" ? "text-red-400" : "text-muted-foreground")}>
      {sign === "~" ? "·" : sign}
    </span>
  );
  const edge = /^edge ([\w-]+)\.(\w+) -> ([\w-]+)\.(\w+)$/.exec(body);
  if (edge) {
    const gone = sign === "-";
    return (
      <div className="flex min-w-0 items-center gap-1.5">
        {mark}
        <NodeChip id={edge[1]} flow={flow} gone={gone} />
        <EdgeStroke handle={edge[2]} gone={gone} />
        {edge[4] !== "artifact" && <span className="text-[10px] text-muted-foreground">{edge[4]}</span>}
        <NodeChip id={edge[3]} flow={flow} gone={gone} />
      </div>
    );
  }
  const node = /^node ([\w-]+)(?: \((.*)\))?$/.exec(body);
  if (node) {
    return (
      <div className="flex min-w-0 items-center gap-1.5">
        {mark}
        <NodeChip id={node[1]} flow={flow} gone={sign === "-"} />
        {node[2] && <span className="truncate text-muted-foreground">{node[2]}</span>}
      </div>
    );
  }
  return (
    <div className="flex min-w-0 items-center gap-1.5">
      {mark}
      <span className="truncate text-muted-foreground">{body}</span>
    </div>
  );
}

function ToolCall({ call, flow }: { call: ChatToolCall; flow: Flow | null }) {
  const pending = call.result === undefined;
  const read = READ_TOOLS[call.name];
  if (read) {
    return (
      <div className={cn("flex items-center gap-2 text-xs text-muted-foreground [&_svg]:size-3.5", call.isError && "text-red-400")}>
        {pending ? <Loader2 className="animate-spin" /> : read.icon}
        {read.label}
        {call.isError && " — failed"}
      </div>
    );
  }
  const title = WRITE_TITLES[call.name] ?? call.name;
  if (call.isError) {
    return (
      <div className="rounded-md border border-red-500/30 bg-red-500/5 px-2.5 py-2 text-xs">
        <div className="flex items-center gap-1.5 font-medium text-red-300">
          <CircleAlert className="size-3.5" /> {title}: didn't work
        </div>
        <div className="mt-1 whitespace-pre-wrap text-muted-foreground">{call.result}</div>
      </div>
    );
  }
  const lines = call.result ? changeLines(call.result) : [];
  const problems = call.result ? problemCount(call.result) : 0;
  return (
    <div className="rounded-md border bg-card/60 px-2.5 py-2 text-xs" style={{ borderLeft: `2px solid ${AI}` }}>
      <div className="flex items-center gap-1.5 font-medium">
        {pending && <Loader2 className="size-3.5 animate-spin text-muted-foreground" />}
        {title}
        {call.name === "save_block" && typeof (call.input as { name?: string })?.name === "string" && (
          <span className="font-normal text-muted-foreground">“{(call.input as { name: string }).name}”</span>
        )}
      </div>
      {lines.length > 0 && (
        <div className="mt-1.5 space-y-1">
          {lines.map((l, i) => (
            <ChangeLine key={i} line={l} flow={flow} />
          ))}
        </div>
      )}
      {problems > 0 && (
        <div className="mt-1.5 text-amber-300">
          {problems} problem{problems > 1 ? "s" : ""} left to fix
        </div>
      )}
    </div>
  );
}

// ---------- messages ----------

function AssistantMessage({ msg, flow }: { msg: ChatMessage; flow: Flow | null }) {
  const running = msg.status === "running";
  return (
    <div className="space-y-2.5 text-sm leading-relaxed">
      {msg.parts.map((p, i) =>
        p.type === "text" ? <Prose key={i} text={p.text} /> : <ToolCall key={p.call.id || i} call={p.call} flow={flow} />,
      )}
      {running && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span className="relative flex size-2">
            <span className="absolute inline-flex size-full animate-ping rounded-full opacity-60 motion-reduce:animate-none" style={{ background: AI }} />
            <span className="relative inline-flex size-2 rounded-full" style={{ background: AI }} />
          </span>
          {msg.parts.length ? "Working" : "Reading your flow"}
        </div>
      )}
      {msg.status === "error" && (
        <div className="flex gap-2 rounded-md border border-red-500/30 bg-red-500/5 px-2.5 py-2 text-xs text-red-300">
          <CircleAlert className="mt-px size-3.5 shrink-0" />
          <span className="whitespace-pre-wrap">{msg.error || "The assistant stopped with an error."}</span>
        </div>
      )}
      {msg.status === "cancelled" && <div className="text-xs text-muted-foreground">Stopped.</div>}
    </div>
  );
}

function UserMessage({ msg }: { msg: ChatMessage }) {
  const text = msg.parts.map((p) => (p.type === "text" ? p.text : "")).join("\n");
  return (
    <div className="flex justify-end">
      <div className="max-w-[88%] whitespace-pre-wrap rounded-lg rounded-br-sm bg-secondary px-3 py-2 text-sm">{text}</div>
    </div>
  );
}

// ---------- empty state ----------

const START_IDEAS = [
  "Plan, implement and review a change, then open a merge request",
  "When someone comments “@sandflow” on my GitLab MRs, answer the question",
  "Every weekday at 9:00, run a shell command and report the result",
];
const CHANGE_IDEAS = [
  "Explain what this flow does, step by step",
  "Add a security review before the merge request",
  "Let the planning step ask me questions when something is unclear",
];

function EmptyState({ flow, onPick }: { flow: Flow | null; onPick: (text: string) => void }) {
  const empty = !flow?.nodes.length;
  const ideas = empty ? START_IDEAS : CHANGE_IDEAS;
  return (
    <div className="flex flex-1 flex-col justify-end gap-4 px-4 pb-2">
      <div>
        <h2 className="text-base font-semibold">{empty ? "Describe the flow you want" : "What should change?"}</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {empty
            ? "Say what should start it and what each step does. The assistant builds it on the canvas."
            : `Ask for a change to “${flow?.name}” or ask how it works. Edits show up on the canvas as they're made.`}
        </p>
      </div>
      <div className="space-y-1.5">
        {ideas.map((idea) => (
          <button
            key={idea}
            type="button"
            onClick={() => onPick(idea)}
            className="block w-full rounded-md border border-dashed px-3 py-2 text-left text-sm text-muted-foreground transition-colors hover:border-solid hover:bg-accent/40 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          >
            {idea}
          </button>
        ))}
      </div>
    </div>
  );
}

// ---------- agent picker ----------

/** Which agent answers: any agent a block can use, plus an optional model (empty = that CLI's default). */
function AgentPicker({ disabled }: { disabled: boolean }) {
  const chatAgent = useChatStore((s) => s.chat?.agent);
  const fallback = useStore((s) => s.data?.settings.assistantAgent);
  const agent = chatAgent ?? fallback ?? defaultAgent();
  const setAgent = useChatStore((s) => s.setAgent);
  const [model, setModel] = useState(agent.model ?? "");
  useEffect(() => setModel(agent.model ?? ""), [agent.provider, agent.model]);
  const commitModel = () => {
    if ((agent.model ?? "") !== model.trim()) void setAgent({ provider: agent.provider, model: model.trim() || undefined });
  };

  return (
    <div className="flex min-w-0 items-center gap-1">
      <Select value={agent.provider} disabled={disabled} onValueChange={(v) => void setAgent({ provider: v as AgentProvider })}>
        <SelectTrigger size="sm" className="h-7 gap-1 border-none bg-transparent px-1.5 text-xs shadow-none dark:bg-transparent" aria-label="Agent that answers">
          <SelectValue />
        </SelectTrigger>
        <SelectContent align="start">
          {AGENT_PROVIDERS.map((p) => (
            <SelectItem key={p} value={p}>
              {AGENT_LABELS[p]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <input
        value={model}
        disabled={disabled}
        onChange={(e) => setModel(e.target.value)}
        onBlur={commitModel}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commitModel();
            e.currentTarget.blur();
          }
        }}
        placeholder="default model"
        aria-label="Model"
        title="Model for this agent. Leave empty to use the agent's default."
        className="h-7 w-28 min-w-0 rounded-md bg-transparent px-1.5 text-xs text-muted-foreground outline-none placeholder:text-muted-foreground/60 hover:bg-accent/40 focus:bg-accent/40 focus:text-foreground disabled:opacity-50"
      />
    </div>
  );
}

// ---------- panel ----------

function timeAgo(ts: number): string {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(ts).toLocaleDateString();
}

export function ChatPanel() {
  const flow = useCurrentFlow();
  const { chats, chatId, chat, sending, error } = useChatStore();
  const { close, select, newChat, send, cancel, remove } = useChatStore.getState();
  const [draft, setDraft] = useState("");
  const scroller = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const pinned = useRef(true);
  const running = !!chat?.running;
  const messages = chat?.messages ?? [];

  // Follow new output unless the user scrolled up to read.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [chat]);

  useEffect(() => {
    input.current?.focus();
  }, [chatId]);

  // Grow the composer with its content (up to ~8 lines).
  useLayoutEffect(() => {
    const el = input.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 180)}px`;
  }, [draft]);

  const submit = async () => {
    const text = draft.trim();
    if (!text || running || sending) return;
    pinned.current = true;
    setDraft("");
    if (!(await send(text))) setDraft(text);
  };

  const selectValue = chatId ?? "new";
  const loading = !!chatId && !chat;
  const title = useMemo(() => chats.find((c) => c.id === chatId)?.title, [chats, chatId]);

  return (
    <aside className="flex h-full w-[380px] shrink-0 flex-col border-l bg-background" aria-label="Edit with AI">
      <div className="flex h-12 shrink-0 items-center gap-1 border-b px-2">
        <BotMessageSquare className="mx-1 size-4 shrink-0" style={{ color: AI }} aria-hidden />
        <Select value={selectValue} onValueChange={(v) => (v === "new" ? newChat() : select(v))}>
          <SelectTrigger size="sm" className="min-w-0 flex-1 border-none bg-transparent px-1.5 shadow-none dark:bg-transparent" aria-label="Chats for this flow">
            <SelectValue placeholder="New chat">{chatId ? title ?? "Chat" : "New chat"}</SelectValue>
          </SelectTrigger>
          <SelectContent align="start" className="w-[320px]">
            <SelectItem value="new">New chat</SelectItem>
            {chats.map((c) => (
              <SelectItem key={c.id} value={c.id}>
                <span className="flex min-w-0 flex-col items-start">
                  <span className="max-w-[260px] truncate">{c.title}</span>
                  <span className="text-[11px] text-muted-foreground">
                    {c.running ? "Working now" : timeAgo(c.updatedAt)}
                  </span>
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button size="icon" variant="ghost" className="size-8" title="New chat" aria-label="New chat" onClick={newChat} disabled={!chatId}>
          <MessageSquarePlus />
        </Button>
        <Button
          size="icon"
          variant="ghost"
          className="size-8"
          title="Delete this chat"
          aria-label="Delete this chat"
          disabled={!chatId || running}
          onClick={() => chatId && confirm(`Delete the chat "${title ?? "Chat"}"? The flow keeps its changes.`) && void remove(chatId)}
        >
          <Trash2 />
        </Button>
        <Button size="icon" variant="ghost" className="size-8" title="Close" aria-label="Close the assistant" onClick={close}>
          <X />
        </Button>
      </div>

      <div
        ref={scroller}
        className="flex min-h-0 flex-1 flex-col overflow-y-auto"
        onScroll={(e) => {
          const el = e.currentTarget;
          pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
      >
        {loading ? (
          <div className="flex flex-1 items-center justify-center text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
          </div>
        ) : messages.length === 0 ? (
          <EmptyState
            flow={flow}
            onPick={(t) => {
              setDraft(t);
              input.current?.focus();
            }}
          />
        ) : (
          <div className="space-y-5 px-4 py-4" aria-live="polite">
            {messages.map((m, i) => {
              if (m.role === "user") return <UserMessage key={m.id} msg={m} />;
              // Name the agent only where it changed, so a switched-agent chat reads clearly.
              const prev = messages.slice(0, i).reverse().find((x) => x.role === "assistant");
              const switched = !!m.agent && !!prev?.agent && prev.agent !== m.agent;
              return (
                <div key={m.id} className="space-y-1.5">
                  {switched && <div className="text-[11px] text-muted-foreground">Now answering: {AGENT_LABELS[m.agent!]}</div>}
                  <AssistantMessage msg={m} flow={flow} />
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="shrink-0 border-t p-3">
        {error && (
          <div className="mb-2 flex gap-2 text-xs text-red-300">
            <CircleAlert className="mt-px size-3.5 shrink-0" /> {error}
          </div>
        )}
        <form
          className="rounded-lg border bg-card/60 focus-within:ring-2 focus-within:ring-ring/60"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <textarea
            ref={input}
            rows={2}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void submit();
              }
            }}
            placeholder={flow?.nodes.length ? "Ask for a change…" : "Describe the flow you want…"}
            title="Enter to send, Shift+Enter for a new line"
            aria-label="Message the assistant"
            className="block w-full resize-none bg-transparent px-3 pt-2.5 text-sm outline-none placeholder:text-muted-foreground"
          />
          <div className="flex items-center justify-between gap-2 px-2 pb-2">
            <AgentPicker disabled={running} />
            {running ? (
              <Button type="button" size="sm" variant="outline" onClick={() => void cancel()}>
                <Square className="fill-current" /> Stop
              </Button>
            ) : (
              <Button type="submit" size="icon" className="size-8" disabled={!draft.trim() || sending} aria-label="Send">
                {sending ? <Loader2 className="animate-spin" /> : <ArrowUp />}
              </Button>
            )}
          </div>
        </form>
      </div>
    </aside>
  );
}
