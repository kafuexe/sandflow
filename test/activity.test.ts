import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ACTIVITY_FLUSH_MS, startRun, type NodeRunner, type RunContext } from "../backend/engine";
import { agentStreamHandler } from "../backend/runners/activity";
import { runAi } from "../backend/runners/ai";
import {
  appendActivity,
  MAX_ITEM_CHARS,
  parseClaudeStreamLine,
  parseOtherStreamLine,
  summarizeToolInput,
  type ActivityDraft,
  type AgentActivity,
} from "../shared/activity";
import { BUILTIN_BLOCKS } from "../shared/library";
import type { Flow, RunState, Settings } from "../shared/types";
import { activityOf, groupActivity, loadFilter, loadOpen, saveFilter, saveOpen } from "../src/lib/activityView";

const j = (o: unknown) => JSON.stringify(o);
const assistant = (...content: unknown[]) => j({ type: "assistant", message: { role: "assistant", content } });

// Lines as `claude --print --verbose --output-format stream-json` prints them.
const CLAUDE_LINES = [
  j({ type: "system", subtype: "init", session_id: "s1", tools: ["Bash"], model: "claude-sonnet" }),
  assistant({ type: "thinking", thinking: "The user wants a login page.\nLet me look at the routes first.", signature: "x" }),
  assistant({ type: "tool_use", id: "t1", name: "Bash", input: { command: "ls src/routes", description: "List routes" } }),
  j({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "home.tsx\nabout.tsx" }] } }),
  assistant({ type: "text", text: "I'll add a login route." }, { type: "tool_use", id: "t2", name: "Write", input: { file_path: "src/routes/login.tsx", content: "…" } }),
  j({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t2", is_error: true, content: [{ type: "text", text: "Permission denied" }] }] } }),
  j({ type: "result", subtype: "success", is_error: false, num_turns: 3, duration_ms: 12_345, total_cost_usd: 0.0123, result: "done" }),
];

describe("parseClaudeStreamLine", () => {
  it("turns thinking, replies, tool calls, tool results and the result into activity", () => {
    const all = CLAUDE_LINES.flatMap(parseClaudeStreamLine);
    expect(all).toEqual([
      { kind: "thinking", text: "The user wants a login page.\nLet me look at the routes first." },
      { kind: "tool", name: "Bash", text: "ls src/routes" },
      { kind: "tool_result", text: "home.tsx about.tsx" },
      { kind: "text", text: "I'll add a login route." },
      { kind: "tool", name: "Write", text: "src/routes/login.tsx" },
      { kind: "tool_result", text: "Permission denied", isError: true },
      { kind: "result", text: "Finished · 3 turns · 12.3s · $0.0123" },
    ]);
  });

  it("reports a failed result", () => {
    expect(parseClaudeStreamLine(j({ type: "result", subtype: "error_max_turns", is_error: true }))).toEqual([
      { kind: "result", text: "Failed (error_max_turns)", isError: true },
    ]);
  });

  it("ignores garbage and lines it doesn't know", () => {
    for (const line of ["", "plain text from stderr", "{not json", "null", "[1,2]", "{}", j({ type: "stream_event" }), j({ type: "assistant" }), j({ type: "assistant", message: { content: [null, 3, { type: "text", text: "  " }] } })]) {
      expect(parseClaudeStreamLine(line)).toEqual([]);
    }
  });

  it("caps long thinking and shows redacted thinking", () => {
    const [long] = parseClaudeStreamLine(assistant({ type: "thinking", thinking: "x".repeat(MAX_ITEM_CHARS * 2) }));
    expect(long.text.length).toBe(MAX_ITEM_CHARS);
    expect(long.text.endsWith("…")).toBe(true);
    expect(parseClaudeStreamLine(assistant({ type: "redacted_thinking", data: "…" }))).toEqual([{ kind: "thinking", text: "(thinking hidden)" }]);
  });
});

describe("summarizeToolInput", () => {
  it("picks the field that says what the call does", () => {
    expect(summarizeToolInput({ command: "npm   test\n--run" })).toBe("npm test --run");
    expect(summarizeToolInput({ pattern: "TODO", path: "src" })).toBe("TODO in src");
    expect(summarizeToolInput({ todos: [{ content: "a", status: "done" }, { content: "Write tests", status: "in_progress" }] })).toBe("2 todos · now: Write tests");
    expect(summarizeToolInput({ a: 1 })).toBe('{"a":1}');
    expect(summarizeToolInput(undefined)).toBe("");
    expect(summarizeToolInput({ command: "y".repeat(500) }).length).toBe(200);
  });
});

describe("parseOtherStreamLine", () => {
  it("picks up Codex reasoning and nothing else", () => {
    expect(parseOtherStreamLine(j({ type: "item.completed", item: { type: "reasoning", text: "Checking tests" } }))).toEqual([{ kind: "thinking", text: "Checking tests" }]);
    expect(parseOtherStreamLine(j({ type: "item.completed", item: { type: "agent_message", text: "hi" } }))).toEqual([]);
    expect(parseOtherStreamLine("garbage")).toEqual([]);
  });
});

describe("appendActivity", () => {
  const item = (text: string, ts: number, kind: AgentActivity["kind"] = "thinking"): AgentActivity => ({ kind, text, ts, exec: 1 });

  it("drops the oldest items once a node holds too much text, keeping the newest", () => {
    const list: AgentActivity[] = [];
    for (let i = 0; i < 10; i++) appendActivity(list, [item(`${i}`.repeat(100), i)], 350);
    expect(list.map((a) => a.ts)).toEqual([7, 8, 9]);
    // A single item over the cap is still kept.
    expect(appendActivity([], [item("z".repeat(1000), 1)], 10)).toHaveLength(1);
  });

  it("joins streamed reply chunks, but not separate replies", () => {
    const list: AgentActivity[] = [];
    appendActivity(list, [{ ...item("Hel", 1, "text"), chunk: true }, { ...item("lo", 2, "text"), chunk: true }, item("Next", 3, "text")]);
    expect(list.map((a) => a.text)).toEqual(["Hello", "Next"]);
    expect(list[0]).not.toHaveProperty("chunk");
  });
});

describe("agentStreamHandler", () => {
  function sink() {
    const logs: string[] = [];
    const items: ActivityDraft[] = [];
    const ctx = { log: (_l: string, m: string) => void logs.push(m), activity: (_n: string, a: ActivityDraft[]) => void items.push(...a) } as Pick<RunContext, "log" | "activity">;
    return { ctx, logs, items };
  }

  it("Claude Code: activity from raw lines, the log from sandcastle's parsed events", () => {
    const { ctx, logs, items } = sink();
    const h = agentStreamHandler(ctx, "n", "claudeCode");
    for (const line of CLAUDE_LINES) h({ type: "raw", line });
    h({ type: "text", message: "I'll add a login route." });
    h({ type: "toolCall", name: "Bash", formattedArgs: "ls src/routes" });
    expect(items.map((a) => a.kind)).toEqual(["thinking", "tool", "tool_result", "text", "tool", "tool_result", "result"]);
    expect(logs).toEqual(["I'll add a login route.", "🔧 Bash ls src/routes"]);
  });

  it("other agents: their text chunks and tool calls", () => {
    const { ctx, items } = sink();
    const h = agentStreamHandler(ctx, "n", "codex");
    h({ type: "raw", line: j({ type: "item.completed", item: { type: "reasoning", text: "Hmm" } }) });
    h({ type: "text", message: "Done " });
    h({ type: "toolCall", name: "Bash", formattedArgs: "npm\ntest" });
    expect(items).toEqual([
      { kind: "thinking", text: "Hmm" },
      { kind: "text", text: "Done ", chunk: true },
      { kind: "tool", name: "Bash", text: "npm test" },
    ]);
  });

  it("works without an activity sink", () => {
    const logs: string[] = [];
    const h = agentStreamHandler({ log: (_l, m) => void logs.push(m) }, "n", "claudeCode");
    h({ type: "raw", line: CLAUDE_LINES[1] });
    expect(logs).toEqual([]);
  });
});

describe("engine: agent activity", () => {
  const settings: Settings = { startingPrompt: "Add login", sandbox: "docker", maxSteps: 10 };
  const flow: Flow = { id: "f", name: "F", nodes: [{ id: "a", type: "block", position: { x: 0, y: 0 }, data: { blockId: "plan" } }], edges: [] };
  afterEach(() => vi.useRealTimers());

  it("batches activity into few state pushes and saves it on the run", async () => {
    vi.useFakeTimers();
    const states: RunState[] = [];
    let release!: () => void;
    const runner: NodeRunner = async (ctx) => {
      for (let i = 0; i < 50; i++) ctx.activity?.("a", [{ kind: "thinking", text: `step ${i}` }]);
      await new Promise<void>((r) => (release = r));
      return { outputs: { artifact: "ok" } };
    };
    const h = startRun({ flow, blocks: BUILTIN_BLOCKS, env: {}, settings, runners: { auto: runner, ai: runner }, onChange: (s) => states.push(structuredClone(s)) });
    await vi.advanceTimersByTimeAsync(0);
    const before = states.length;
    expect(states.at(-1)?.activity).toBeUndefined();
    await vi.advanceTimersByTimeAsync(ACTIVITY_FLUSH_MS);
    expect(states.length).toBe(before + 1);
    expect(states.at(-1)!.activity!.a).toHaveLength(50);
    expect(states.at(-1)!.activity!.a[0]).toMatchObject({ kind: "thinking", text: "step 0", exec: 1 });
    release();
    const final = await h.done;
    expect(final.activity!.a).toHaveLength(50);
  });

  it("flushes what's pending when the node finishes", async () => {
    const runner: NodeRunner = async (ctx) => {
      ctx.activity?.("a", [{ kind: "text", text: "bye" }]);
      return { outputs: {} };
    };
    const final = await startRun({ flow, blocks: BUILTIN_BLOCKS, env: {}, settings, runners: { auto: runner, ai: runner } }).done;
    expect(final.activity?.a.map((a) => a.text)).toEqual(["bye"]);
    const done = final.logs.findIndex((l) => l.msg.startsWith("✓"));
    expect(done).toBeGreaterThan(0);
  });

  it("runAi streams a Claude agent's thinking and tool calls into the run (sandcastle mocked)", async () => {
    const logRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sandflow-activity-"));
    const runOpts: Record<string, any>[] = [];
    const sandbox = {
      exec: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
      close: async () => ({}),
      run: async (opts: Record<string, any>) => {
        runOpts.push(opts);
        const emitEvent = opts.logging?.onAgentStreamEvent as (e: unknown) => void;
        for (const line of CLAUDE_LINES) emitEvent({ type: "raw", line, iteration: 1, timestamp: new Date() });
        emitEvent({ type: "text", message: "I'll add a login route.", iteration: 1, timestamp: new Date() });
        return { stdout: "<artifact>PLAN</artifact>", commits: [], iterations: [] };
      },
    };
    const ai: NodeRunner = (ctx, node, cfg, inputs) => {
      ctx.sandbox = sandbox;
      return runAi(ctx, node, { ...cfg, skills: [] }, inputs);
    };
    try {
      const final = await startRun({ flow, blocks: BUILTIN_BLOCKS, env: { REPO_PATH: "/r" }, settings, logRoot, runners: { auto: ai, ai } }).done;
      expect(final.status).toBe("done");
      expect(runOpts[0].logging.path).toContain(logRoot);
      expect(final.activity?.a.map((a) => a.kind)).toEqual(["thinking", "tool", "tool_result", "text", "tool", "tool_result", "result"]);
      expect(final.activity?.a.find((a) => a.kind === "tool")).toMatchObject({ name: "Bash", text: "ls src/routes", exec: 1 });
      expect(final.logs.some((l) => l.level === "agent" && l.msg === "I'll add a login route.")).toBe(true);
    } finally {
      fs.rmSync(logRoot, { recursive: true, force: true });
    }
  });
});

describe("activity view helpers", () => {
  const a = (kind: AgentActivity["kind"], ts: number, exec?: number): AgentActivity => ({ kind, text: kind, ts, exec });

  it("groups by node in the order they started, filtered", () => {
    const activity = { b: [a("text", 5), a("tool", 6)], a: [a("thinking", 1), a("tool_result", 2), a("result", 3)] };
    expect(groupActivity(activity).map((g) => g.nodeKey)).toEqual(["a", "b"]);
    const noThinking = groupActivity(activity, { thinking: false, text: true, tools: false });
    expect(noThinking.map((g) => [g.nodeKey, g.items.map((i) => i.kind)])).toEqual([["a", ["result"]], ["b", ["text"]]]);
    expect(groupActivity(undefined)).toEqual([]);
  });

  it("picks one execution's activity", () => {
    expect(activityOf({ n: [a("text", 1, 1), a("text", 2, 2), a("text", 3)] }, "n", 2).map((x) => x.ts)).toEqual([2, 3]);
    expect(activityOf(undefined, "n", 1)).toEqual([]);
  });

  it("remembers open sections and the filter, and survives broken storage", () => {
    const store = new Map<string, string>();
    const mem = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) };
    expect(loadOpen("logs", true, mem)).toBe(true);
    saveOpen("logs", false, mem);
    expect(loadOpen("logs", true, mem)).toBe(false);
    saveFilter({ thinking: false, text: true, tools: true }, mem);
    expect(loadFilter(mem)).toEqual({ thinking: false, text: true, tools: true });
    store.set("sandflow.activityFilter", "{nope");
    expect(loadFilter(mem)).toEqual({ thinking: true, text: true, tools: true });
    const broken = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); }, removeItem: () => {} };
    expect(loadOpen("x", false, broken)).toBe(false);
    expect(() => saveOpen("x", true, broken)).not.toThrow();
    expect(loadFilter(broken)).toEqual({ thinking: true, text: true, tools: true });
    expect(() => saveFilter({ thinking: true, text: true, tools: true }, broken)).not.toThrow();
  });
});
