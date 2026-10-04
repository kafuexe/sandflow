// MCP endpoint, data revisions and "Edit with AI" chats (with scripted agents instead of real CLIs).

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { createApi } from "../backend/api";
import { ADAPTERS, MCP_BRIDGE } from "../backend/assistantAgents";
import { extractOps, resolveCli, type AssistantRunner, type AssistantTurn } from "../backend/chats";
import { createStorage } from "../backend/storage";
import { AGENT_PROVIDERS } from "../shared/agents";
import { FLOW_GUIDE } from "../shared/flowGuide";
import type { AppData, Chat } from "../shared/types";

let dir: string;
let server: Server;
let base: string;
const turns: AssistantTurn[] = [];

async function start(assistant?: AssistantRunner) {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "sandflow-assistant-"));
  const noop = async () => ({ outputs: {} });
  const api = createApi(createStorage(dir), { auto: noop, ai: noop }, { exec: async () => ({ code: 1, stdout: "", stderr: "" }), assistant });
  server = createServer((req, res) => api(req, res, () => ((res.statusCode = 404), res.end())));
  server.listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
}

afterEach(() => {
  server?.closeAllConnections();
  server?.close();
  turns.length = 0;
  fs.rmSync(dir, { recursive: true, force: true });
});

const post = (url: string, body: unknown) =>
  fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

let rpcId = 0;
async function rpc(method: string, params?: unknown, scope?: string) {
  const res = await post(`${base}/mcp${scope ? `?flow=${scope}` : ""}`, { jsonrpc: "2.0", id: ++rpcId, method, params });
  return (await res.json()) as { result?: any; error?: { message: string } };
}
const callTool = async (name: string, args: unknown, scope?: string) => (await rpc("tools/call", { name, arguments: args }, scope)).result;

async function waitFor<T>(fn: () => Promise<T | undefined>, ms = 3000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v !== undefined) return v;
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe("MCP server", () => {
  it("speaks the MCP handshake and lists tools; scoping hides create_flow", async () => {
    await start();
    const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } });
    expect(init.result.protocolVersion).toBe("2025-06-18");
    expect(init.result.serverInfo.name).toBe("sandflow");
    const note = await post(`${base}/mcp`, { jsonrpc: "2.0", method: "notifications/initialized" });
    expect(note.status).toBe(202);
    const all = (await rpc("tools/list")).result.tools.map((t: { name: string }) => t.name);
    expect(all).toEqual(expect.arrayContaining(["list_blocks", "get_flow", "create_flow", "edit_flow", "replace_flow", "save_block"]));
    const scoped = (await rpc("tools/list", {}, "feature-pipeline")).result.tools.map((t: { name: string }) => t.name);
    expect(scoped).not.toContain("create_flow");
    expect((await rpc("nope")).error?.message).toMatch(/Method not found/);
  });

  it("creates and edits flows, bumping the revision and reporting touched nodes", async () => {
    await start();
    const events: string[] = [];
    const ctrl = new AbortController();
    void fetch(`${base}/data/events`, { signal: ctrl.signal }).then(async (r) => {
      const reader = r.body!.getReader();
      for (;;) {
        const { value, done } = await reader.read().catch(() => ({ value: undefined, done: true }));
        if (done) break;
        events.push(new TextDecoder().decode(value));
      }
    });
    const created = await callTool("create_flow", {
      name: "Nightly report",
      nodes: [{ id: "t", block: "base/schedule-trigger" }, { id: "sh", block: "base/shell", overrides: { shellCommand: "git log -5" } }],
      edges: ["t -> sh"],
    });
    expect(created.isError).toBeUndefined();
    expect(created.content[0].text).toContain("Created flow \"Nightly report\" (id: nightly-report)");
    expect(created.content[0].text).toContain("+ edge t.artifact -> sh.artifact");

    const bad = await callTool("edit_flow", { flowId: "nightly-report", ops: [{ op: "connect", edge: "sh.steer -> t" }] });
    expect(bad.isError).toBe(true);
    expect(bad.content[0].text).toMatch(/doesn't output steer/);

    const data = (await (await fetch(`${base}/data`)).json()) as AppData & { rev: number };
    expect(data.rev).toBe(1); // the failed edit saved nothing
    expect(data.flows.find((f) => f.id === "nightly-report")!.nodes[1].data.overrides).toEqual({ shellCommand: "git log -5" });
    await waitFor(async () => (events.join("").includes('"touched":["t","sh"]') ? true : undefined));
    expect(events.join("")).toContain('"source":"assistant"');
    ctrl.abort();
  });

  it("keeps a scoped session to its own flow", async () => {
    await start();
    const r = await callTool("edit_flow", { flowId: "feature-pipeline", ops: [{ op: "rename_flow", name: "x" }] }, "other");
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/can only edit its own flow/);
    const ok = await callTool("get_flow", {}, "feature-pipeline");
    expect(ok.content[0].text).toContain('Flow "Feature pipeline"');
  });

  it("won't overwrite pack blocks but saves valid custom ones", async () => {
    await start();
    expect((await callTool("save_block", { id: "base/plan", name: "Plan", config: {} })).content[0].text).toMatch(/comes from a pack/);
    const ok = await callTool("save_block", {
      id: "security-review",
      name: "Security review",
      extends: "base/tpl-reviewer",
      config: { instructions: "Look for security issues only." },
    });
    expect(ok.content[0].text).toContain('Created block "Security review"');
    expect((await callTool("save_block", { id: "x", name: "X", extends: "base/plan", config: {} })).isError).toBe(true);
  });
});

describe("data revisions", () => {
  it("rejects a UI save based on a stale revision with 409", async () => {
    await start();
    const data = (await (await fetch(`${base}/data`)).json()) as AppData & { rev: number };
    await callTool("edit_flow", { flowId: "feature-pipeline", ops: [{ op: "rename_flow", name: "Renamed by AI" }] });
    const stale = await fetch(`${base}/flows?rev=${data.rev}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(data.flows) });
    expect(stale.status).toBe(409);
    const fresh = await fetch(`${base}/flows?rev=${data.rev + 1}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(data.flows) });
    expect(await fresh.json()).toEqual({ ok: true, rev: data.rev + 2 });
  });
});

describe("chats", () => {
  /** A fake agent that edits the flow through the real MCP endpoint (as a CLI would via its MCP config). */
  const scripted: AssistantRunner = async function* (turn) {
    turns.push(turn);
    yield { type: "session", id: `${turn.agent.provider}-session` };
    await fetch(turn.mcp.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "edit_flow", arguments: { ops: [{ op: "rename_flow", name: turn.prompt.split("\n").at(-1) }] } } }),
    });
    yield { type: "text", text: "Renamed it." };
  };

  const finished = (id: string) =>
    waitFor(async () => {
      const c = (await (await fetch(`${base}/chats/${id}`)).json()) as Chat & { running: boolean };
      return c.running ? undefined : c;
    });

  it("runs a turn against the chat's flow, records the tool calls and resumes the session next time", async () => {
    await start(scripted);
    const chat = (await (await post(`${base}/chats`, { flowId: "feature-pipeline" })).json()) as Chat;
    expect(chat.agent).toEqual({ provider: "claudeCode" });
    expect((await post(`${base}/chats/${chat.id}/messages`, { text: "Ship it pipeline" })).status).toBe(200);
    const done = await finished(chat.id);
    expect(done.title).toBe("Ship it pipeline");
    expect(done.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(done.messages[1]).toMatchObject({ status: "done", agent: "claudeCode" });
    expect(done.messages[1].parts[0]).toMatchObject({ type: "tool", call: { name: "edit_flow", isError: false } });
    expect((done.messages[1].parts[0] as { call: { result: string } }).call.result).toContain('~ flow renamed to "Ship it pipeline"');
    expect(done.messages[1].parts[1]).toEqual({ type: "text", text: "Renamed it." });
    expect(done.sessions).toEqual({ claudeCode: "claudeCode-session" });

    // Claude takes the system prompt as a flag, so the first prompt is just the request.
    expect(turns[0].prompt).toBe("Ship it pipeline");
    expect(turns[0].resumeId).toBeUndefined();
    expect(turns[0].mcp.url).toMatch(/\/api\/mcp\?flow=feature-pipeline&chat=chat-/);
    expect(turns[0].mcp.args[0]).toMatch(/sandflow-mcp-bridge\.cjs$/);
    expect(turns[0].systemPrompt).toContain(FLOW_GUIDE);
    const data = (await (await fetch(`${base}/data`)).json()) as AppData;
    expect(data.flows[0].name).toBe("Ship it pipeline");

    await post(`${base}/chats/${chat.id}/messages`, { text: "Again" });
    await finished(chat.id);
    expect(turns[1].resumeId).toBe("claudeCode-session");
    expect(turns[1].prompt).toBe("Again");

    const list = (await (await fetch(`${base}/chats?flowId=feature-pipeline`)).json()) as { id: string }[];
    expect(list.map((c) => c.id)).toEqual([chat.id]);
    expect(await (await fetch(`${base}/chats?flowId=other`)).json()).toEqual([]);
  });

  it("switches agents mid-chat: the new agent gets the instructions and the conversation so far", async () => {
    await start(scripted);
    const chat = (await (await post(`${base}/chats`, { flowId: "feature-pipeline", agent: { provider: "codex", model: "gpt-5.2" } })).json()) as Chat;
    expect(chat.agent).toEqual({ provider: "codex", model: "gpt-5.2" });
    await post(`${base}/chats/${chat.id}/messages`, { text: "First" });
    await finished(chat.id);
    // No system-prompt flag: instructions go into the first prompt of the session.
    expect(turns[0].prompt).toContain("# Sandflow flow assistant");
    expect(turns[0].prompt).toMatch(/# Request\n\nFirst$/);
    expect(turns[0].model).toBe("gpt-5.2");

    const patched = await fetch(`${base}/chats/${chat.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ agent: { provider: "cursor" } }) });
    expect(((await patched.json()) as Chat).agent).toEqual({ provider: "cursor" });
    await post(`${base}/chats/${chat.id}/messages`, { text: "Second" });
    const done = await finished(chat.id);
    expect(turns[1].agent.provider).toBe("cursor");
    expect(turns[1].resumeId).toBeUndefined();
    expect(turns[1].prompt).toContain("# Conversation so far\n\nUser: First");
    expect(done.messages.map((m) => m.agent).filter(Boolean)).toEqual(["codex", "cursor"]);
    expect(done.sessions).toEqual({ codex: "codex-session", cursor: "cursor-session" });

    const bad = await fetch(`${base}/chats/${chat.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ agent: { provider: "gemini" } }) });
    expect(bad.status).toBe(400);
  });

  it("pi (no MCP) edits through a sandflow-ops block, and gets a retry when the ops don't apply", async () => {
    const replies = [
      'Adding it.\n```sandflow-ops\n[{"op":"connect","edge":"n-plan.steer -> n-create-task"}]\n```',
      'Fixed.\n```sandflow-ops\n[{"op":"rename_flow","name":"From pi"}]\n```',
    ];
    const pi: AssistantRunner = async function* (turn) {
      turns.push(turn);
      yield { type: "session", id: "pi-1" };
      yield { type: "text", text: replies[turns.length - 1] };
    };
    await start(pi);
    const chat = (await (await post(`${base}/chats`, { flowId: "feature-pipeline", agent: { provider: "pi" } })).json()) as Chat;
    await post(`${base}/chats/${chat.id}/messages`, { text: "Rename it" });
    const done = await finished(chat.id);
    expect(turns).toHaveLength(2);
    expect(turns[0].prompt).toContain("# Current flow");
    expect(turns[0].prompt).toContain("# Block library");
    expect(turns[0].prompt).toContain("sandflow-ops");
    expect(turns[1].resumeId).toBe("pi-1");
    expect(turns[1].prompt).toMatch(/couldn't apply your sandflow-ops block: .*doesn't accept/s);
    const reply = done.messages[1];
    expect(reply.status).toBe("done");
    expect(reply.parts.map((p) => (p.type === "text" ? p.text : `${p.call.name}:${p.call.isError}`))).toEqual([
      "Adding it.",
      "edit_flow:true",
      "Fixed.",
      "edit_flow:false",
    ]);
    const data = (await (await fetch(`${base}/data`)).json()) as AppData;
    expect(data.flows[0].name).toBe("From pi");
  });

  it("allows one editing turn per flow at a time and can be stopped", async () => {
    const slow: AssistantRunner = async function* (turn) {
      yield { type: "session", id: "s" };
      await new Promise<void>((r) => turn.signal.addEventListener("abort", () => r()));
    };
    await start(slow);
    const a = (await (await post(`${base}/chats`, { flowId: "feature-pipeline" })).json()) as Chat;
    const b = (await (await post(`${base}/chats`, { flowId: "feature-pipeline" })).json()) as Chat;
    await post(`${base}/chats/${a.id}/messages`, { text: "one" });
    const blocked = await post(`${base}/chats/${b.id}/messages`, { text: "two" });
    expect(blocked.status).toBe(409);
    expect(((await blocked.json()) as { error: string }).error).toMatch(/Another chat is editing this flow/);
    await post(`${base}/chats/${a.id}/cancel`, {});
    const stopped = await finished(a.id);
    expect(stopped.messages[1].status).toBe("cancelled");
    expect((await post(`${base}/chats/${b.id}/messages`, { text: "two" })).status).toBe(200);
  });

  it("deletes chats", async () => {
    await start(scripted);
    const chat = (await (await post(`${base}/chats`, { flowId: "feature-pipeline" })).json()) as Chat;
    const del = await fetch(`${base}/chats/${chat.id}`, { method: "DELETE", headers: { "content-type": "application/json" }, body: "{}" });
    expect(del.status).toBe(200);
    expect((await fetch(`${base}/chats/${chat.id}`)).status).toBe(404);
    expect((await fetch(`${base}/chats/chat-..%2F..%2Fx`)).status).toBe(404);
  });
});

describe("agent adapters", () => {
  const turn = {
    prompt: "Do it",
    systemPrompt: "SYS",
    model: "m1",
    workDir: path.join(os.tmpdir(), "wd"),
    mcp: { url: "http://h/api/mcp?flow=f&chat=c", command: "/usr/bin/node", args: ["/wd/bridge.cjs", "http://h/api/mcp?flow=f&chat=c"], env: { ELECTRON_RUN_AS_NODE: "1" } },
  };

  it("has an adapter for every agent a block can use", () => {
    expect(Object.keys(ADAPTERS).sort()).toEqual([...AGENT_PROVIDERS].sort());
  });

  it("builds each CLI's headless command with Sandflow's MCP server", () => {
    const claude = ADAPTERS.claudeCode.build({ ...turn, resumeId: "s1" });
    expect(claude.args).toEqual(expect.arrayContaining(["-p", "--strict-mcp-config", "--allowedTools", "mcp__sandflow", "--resume", "s1", "--model", "m1"]));
    expect(claude.args[claude.args.indexOf("--tools") + 1]).toBe("");
    expect(JSON.parse(claude.files!["mcp.json"]).mcpServers.sandflow).toEqual({ type: "http", url: turn.mcp.url });
    expect(claude.stdin).toBe("Do it");

    const codex = ADAPTERS.codex.build({ ...turn, resumeId: "t1" });
    expect(codex.args.slice(0, 3)).toEqual(["exec", "resume", "t1"]);
    expect(codex.args).toContain(`mcp_servers.sandflow.command="/usr/bin/node"`);
    expect(codex.args).toContain(`mcp_servers.sandflow.args=["/wd/bridge.cjs","http://h/api/mcp?flow=f&chat=c"]`);
    expect(codex.args).toContain(`mcp_servers.sandflow.env={ELECTRON_RUN_AS_NODE="1"}`);
    expect(codex.args).toContain(`sandbox_mode="read-only"`);
    expect(codex.args.at(-1)).toBe("-");

    const oc = ADAPTERS.opencode.build(turn);
    expect(oc.args).toEqual(["run", "--format", "json", "--model", "m1", "Do it"]);
    const ocConfig = JSON.parse(oc.files!["opencode.json"]);
    expect(ocConfig.mcp.sandflow.command).toEqual(["/usr/bin/node", ...turn.mcp.args]);
    expect(ocConfig.tools.bash).toBe(false);

    const cur = ADAPTERS.cursor.build({ ...turn, resumeId: "c9" });
    expect(cur.args).toEqual(expect.arrayContaining(["--print", "--approve-mcps", "--resume", "c9"]));
    expect(JSON.parse(cur.files![".cursor/mcp.json"]).mcpServers.sandflow.args).toEqual(turn.mcp.args);

    const cop = ADAPTERS.copilot.build(turn);
    expect(cop.args.slice(0, 2)).toEqual(["-p", "Do it"]);
    expect(cop.args).toEqual(expect.arrayContaining(["--allow-tool", "sandflow", "--deny-tool", "shell"]));
    expect(cop.args[cop.args.indexOf("--additional-mcp-config") + 1]).toBe(`@${path.join(turn.workDir, "copilot-mcp.json")}`);

    const piCmd = ADAPTERS.pi.build({ ...turn, resumeId: "p1" });
    expect(piCmd.args).toEqual(["-p", "--mode", "json", "--model", "m1", "--session", "p1"]);
    expect(ADAPTERS.pi.tools).toBe("text");
  });

  it("reads session ids, reply text and errors from each stream format", () => {
    const p = (provider: keyof typeof ADAPTERS, o: unknown) => ADAPTERS[provider].parse(JSON.stringify(o));
    expect(p("claudeCode", { type: "system", subtype: "init", session_id: "s" })).toEqual([{ type: "session", id: "s" }]);
    expect(p("claudeCode", { type: "assistant", message: { content: [{ type: "text", text: "Hi" }, { type: "tool_use", name: "x" }] } })).toEqual([{ type: "text", text: "Hi" }]);
    expect(p("claudeCode", { type: "result", subtype: "error_max_turns", is_error: true })[0]).toMatchObject({ type: "error" });
    expect(p("codex", { type: "thread.started", thread_id: "t" })).toEqual([{ type: "session", id: "t" }]);
    expect(p("codex", { type: "item.completed", item: { type: "agent_message", text: "Done" } })).toEqual([{ type: "text", text: "Done" }]);
    expect(p("codex", { type: "turn.failed", error: { message: "quota" } })).toEqual([{ type: "error", message: "quota" }]);
    expect(p("opencode", { type: "step_start", sessionID: "o" })).toEqual([{ type: "session", id: "o" }]);
    expect(p("opencode", { type: "text", part: { type: "text", text: "Yo" } })).toEqual([{ type: "text", text: "Yo" }]);
    expect(p("cursor", { type: "system", subtype: "init", session_id: "cu" })).toEqual([{ type: "session", id: "cu" }]);
    expect(p("copilot", { type: "assistant.message", data: { content: "Ok" } })).toEqual([{ type: "text", text: "Ok" }]);
    expect(p("copilot", { type: "result", sessionId: "cp" })).toEqual([{ type: "session", id: "cp" }]);
    expect(p("pi", { type: "session", id: "pi" })).toEqual([{ type: "session", id: "pi" }]);
    expect(p("pi", { type: "agent_end", messages: [{ role: "user", content: [] }, { role: "assistant", content: [{ type: "text", text: "Fin" }] }] })).toEqual([
      { type: "text", text: "Fin" },
    ]);
    expect(ADAPTERS.codex.parse("not json")).toEqual([]);
  });

  it("finds the ops block in a text-protocol reply", () => {
    expect(extractOps("Hello")).toEqual({ text: "Hello" });
    expect(extractOps('Done.\n```sandflow-ops\n[{"op":"auto_layout"}]\n```')).toEqual({ text: "Done.", ops: [{ op: "auto_layout" }] });
    expect(extractOps("x\n```sandflow-ops\n[oops\n```").parseError).toMatch(/isn't valid JSON/);
  });
});

describe("stdio MCP bridge", () => {
  it("forwards JSON-RPC lines to the HTTP endpoint and answers on stdout", async () => {
    await start();
    const bridge = path.join(dir, "bridge.cjs");
    fs.writeFileSync(bridge, MCP_BRIDGE);
    const child = spawn(process.execPath, [bridge, `${base}/mcp?flow=feature-pipeline`], { stdio: ["pipe", "pipe", "inherit"] });
    let out = "";
    child.stdout.on("data", (d: Buffer) => (out += d.toString()));
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } })}\n`);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
    child.stdin.end(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "validate_flow", arguments: {} } })}\n`);
    await new Promise((r) => child.once("close", r));
    const lines = out.trim().split("\n").map((l) => JSON.parse(l) as { id: number; result: any });
    expect(lines.map((l) => l.id).sort()).toEqual([1, 2]);
    expect(lines.find((l) => l.id === 2)!.result.content[0].text).toBe("Valid: no errors.");
  });
});

describe("resolveCli", () => {
  it("follows a Windows npm shim to the real executable or script, and honours the override", () => {
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), "sandflow-bin-"));
    try {
      const exe = path.join(bin, "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe");
      fs.mkdirSync(path.dirname(exe), { recursive: true });
      fs.writeFileSync(exe, "");
      fs.writeFileSync(path.join(bin, "claude.cmd"), '@ECHO off\r\n"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe"   %*\r\n');
      expect(resolveCli(["claude"], { PATH: bin }, "win32")).toEqual({ cmd: exe, args: [] });
      fs.rmSync(exe);
      expect(resolveCli(["claude"], { PATH: bin }, "win32")).toEqual({ cmd: path.join(bin, "claude.cmd"), args: [], viaCmd: true });

      const js = path.join(bin, "node_modules", "@openai", "codex", "bin", "codex.js");
      fs.mkdirSync(path.dirname(js), { recursive: true });
      fs.writeFileSync(js, "");
      fs.writeFileSync(path.join(bin, "codex.cmd"), '@ECHO off\r\n"%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*\r\n');
      expect(resolveCli(["codex"], { PATH: bin }, "win32")).toEqual({ cmd: process.execPath, args: [js] });

      expect(resolveCli(["cursor-agent", "agent"], { PATH: bin, SANDFLOW_CURSOR_AGENT_PATH: "/opt/ca" }, "win32")).toEqual({ cmd: "/opt/ca", args: [] });
      expect(resolveCli(["claude"], { PATH: bin }, "linux")).toEqual({ cmd: "claude", args: [] });
    } finally {
      fs.rmSync(bin, { recursive: true, force: true });
    }
  });
});

describe("agent skill", () => {
  it("contains the same flow guide the in-app assistant gets", () => {
    const skill = fs.readFileSync(path.join(import.meta.dirname, "../agent-skills/sandflow-flows/SKILL.md"), "utf8").replace(/\r\n/g, "\n");
    expect(skill).toContain(FLOW_GUIDE.trim());
  });
});
