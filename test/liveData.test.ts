// The builder store against the real API (fetch + EventSource bridged to a local server): what the assistant
// changes over MCP has to reach the store right away, so the Inputs side panel (derived from it) stays current.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApi } from "../backend/api";
import { createStorage } from "../backend/storage";
import { flowRequirements } from "../shared/resolve";

let dir: string;
let server: Server;
let origin: string;
const realFetch = globalThis.fetch;
const sources: { close(): void }[] = [];

class NodeEventSource {
  private ctrl = new AbortController();
  private handlers = new Map<string, ((ev: { data: string }) => void)[]>();
  constructor(url: string) {
    sources.push(this);
    void (async () => {
      try {
        const res = await realFetch(origin + url, { signal: this.ctrl.signal });
        const reader = res.body!.getReader();
        const dec = new TextDecoder();
        let buf = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) return;
          buf += dec.decode(value, { stream: true });
          let i;
          while ((i = buf.indexOf("\n\n")) >= 0) {
            const chunk = buf.slice(0, i);
            buf = buf.slice(i + 2);
            let event = "message";
            let data = "";
            for (const line of chunk.split("\n")) {
              if (line.startsWith("event: ")) event = line.slice(7);
              else if (line.startsWith("data: ")) data += line.slice(6);
            }
            if (data) this.handlers.get(event)?.forEach((fn) => fn({ data }));
          }
        }
      } catch {
        /* closed */
      }
    })();
  }
  addEventListener(name: string, fn: (ev: { data: string }) => void) {
    this.handlers.set(name, [...(this.handlers.get(name) ?? []), fn]);
  }
  close() {
    this.ctrl.abort();
  }
}

/** Client-side hooks into the bridged fetch. */
let hooks: { failPut?: boolean; delayNextGet?: number; gets: number };

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "sandflow-live-"));
  const noop = async () => ({ outputs: {} });
  const api = createApi(createStorage(dir), { auto: noop, ai: noop }, { exec: async () => ({ code: 1, stdout: "", stderr: "" }) });
  server = createServer((req, res) => api(req, res, () => ((res.statusCode = 404), res.end())));
  server.listen(0);
  await new Promise((r) => server.once("listening", r));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  hooks = { gets: 0 };
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    if (init?.method === "PUT" && hooks.failPut) {
      hooks.failPut = false;
      throw new TypeError("Failed to fetch");
    }
    const res = await realFetch(url.startsWith("/") ? origin + url : url, init);
    if (url === "/api/data" && (init?.method ?? "GET") === "GET") {
      hooks.gets++;
      const delay = hooks.delayNextGet;
      hooks.delayNextGet = undefined;
      // A slow response: arrives after ones requested later.
      if (delay) await new Promise((r) => setTimeout(r, delay));
    }
    return res;
  });
  vi.stubGlobal("EventSource", NodeEventSource);
  vi.resetModules();
});

afterEach(() => {
  sources.forEach((s) => s.close());
  sources.length = 0;
  vi.unstubAllGlobals();
  server.closeAllConnections();
  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

async function waitFor(fn: () => boolean, ms = 3000) {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A fresh store, loaded, on a new flow of our own (with one node) — plus an MCP client scoped to it. */
async function setup() {
  const { useStore } = await import("../src/lib/store");
  const s = () => useStore.getState();
  await s().load();
  s().createFlow("Mine");
  s().addNode("base/plan", { x: 0, y: 0 });
  expect(await s().flushSaves()).toBe(true);
  const flowId = s().currentFlowId!;
  const tool = async (name: string, args: unknown) => {
    const res = await realFetch(`${origin}/api/mcp?flow=${encodeURIComponent(flowId)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    });
    const out = (await res.json()) as { result: { isError?: boolean; content: { text: string }[] } };
    expect(out.result.isError, out.result.content[0]?.text).toBeFalsy();
  };
  /** Required env names of the flow on screen, as the Inputs panel lists them. */
  const requiredEnv = () => {
    const d = s().data!;
    const f = d.flows.find((x) => x.id === s().currentFlowId)!;
    return flowRequirements(f, d.blocks, d.flows).env.map((e) => e.name);
  };
  return { s, tool, requiredEnv };
}

describe("live data: assistant edits reach the store (and the Inputs panel)", () => {
  it("block and flow edits show up without a reload", async () => {
    const { tool, requiredEnv } = await setup();
    await tool("edit_flow", { ops: [{ op: "add_node", id: "x1", block: "base/plan", overrides: { env: ["NODE_TOKEN"] } }] });
    await waitFor(() => requiredEnv().includes("NODE_TOKEN"));
    await tool("save_block", { id: "custom1", name: "Custom", config: { kind: "ai", env: ["BLOCK_ENV"] } });
    await tool("edit_flow", { ops: [{ op: "add_node", id: "x2", block: "custom1" }] });
    await waitFor(() => requiredEnv().includes("BLOCK_ENV"));
    // Editing only the block (no flow change) updates what the flow needs.
    await tool("save_block", { id: "custom1", name: "Custom", config: { kind: "ai", env: ["BLOCK_ENV_2"] } });
    await waitFor(() => requiredEnv().includes("BLOCK_ENV_2") && !requiredEnv().includes("BLOCK_ENV"));
  });

  it("still applies them after one of your saves failed", async () => {
    const { s, tool, requiredEnv } = await setup();
    const node = s().data!.flows.find((f) => f.id === s().currentFlowId)!.nodes[0];
    hooks.failPut = true;
    s().updateNodeData(node.id, { label: "Renamed" });
    expect(await s().flushSaves()).toBe(false);
    await tool("edit_flow", { ops: [{ op: "add_node", id: "x1", block: "base/plan", overrides: { env: ["AFTER_FAILURE"] } }] });
    await waitFor(() => requiredEnv().includes("AFTER_FAILURE"));
  });

  it("a slow reload can't put back an older version", async () => {
    const { tool, requiredEnv } = await setup();
    hooks.delayNextGet = 300;
    const before = hooks.gets;
    await tool("edit_flow", { ops: [{ op: "add_node", id: "x1", block: "base/plan", overrides: { env: ["FIRST"] } }] });
    await waitFor(() => hooks.gets > before);
    await tool("edit_flow", { ops: [{ op: "update_node", id: "x1", overrides: { env: ["SECOND"] } }] });
    await waitFor(() => requiredEnv().includes("SECOND"));
    await sleep(400); // the slow (older) response has landed by now
    expect(requiredEnv()).toContain("SECOND");
  });
});
