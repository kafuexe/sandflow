// Regression: the model set on a template (e.g. the base pack's "AI Agent (template)") is the one every block
// extending it runs with — through storage, the API, the engine and the AI runner down to sandcastle's `claudeCode(model)`.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";

const agentCalls: { provider: string; model: string; env: Record<string, string> }[] = [];
vi.mock("@ai-hero/sandcastle", () => {
  const agent = (provider: string) => (model: string, opts: { env: Record<string, string> }) => {
    agentCalls.push({ provider, model, env: opts.env });
    return { provider, model, env: opts.env };
  };
  return {
    claudeCode: agent("claudeCode"),
    codex: agent("codex"),
    createSandbox: async () => ({
      worktreePath: "/wt",
      exec: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
      run: async () => ({ stdout: "<artifact>planned</artifact>", commits: [], iterations: [{}] }),
      close: async () => ({}),
    }),
  };
});
vi.mock("@ai-hero/sandcastle/sandboxes/no-sandbox", () => ({ noSandbox: () => ({ name: "none" }) }));

import { createApi } from "../backend/api";
import { createMcp } from "../backend/mcp";
import { runAi } from "../backend/runners/ai";
import { createStorage } from "../backend/storage";
import { auxModelEnv, CLAUDE_AUX_MODEL_ENV, isClaudeModel } from "../shared/agents";
import { agentOrigin, resolveNode } from "../shared/resolve";
import type { AppData, BlockDef, Flow, FlowNode, RunState } from "../shared/types";
import type { RunContext } from "../backend/engine";

const dirs: string[] = [];
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "sandflow-model-"));
  dirs.push(d);
  return d;
};
let server: Server | undefined;
afterEach(() => {
  server?.closeAllConnections();
  server?.close();
  server = undefined;
  agentCalls.length = 0;
  dirs.splice(0).forEach((d) => fs.rmSync(d, { recursive: true, force: true }));
});

const TPL = "base/tpl-ai-agent";
const withModel = (blocks: BlockDef[], id: string, model: string) =>
  blocks.map((b) => (b.id === id ? { ...b, modified: true, config: { ...b.config, agent: { ...b.config.agent!, model } } } : b));
const planNode = (overrides?: FlowNode["data"]["overrides"]): FlowNode => ({
  id: "plan",
  type: "block",
  position: { x: 0, y: 0 },
  data: { blockId: "base/plan", ...(overrides ? { overrides } : {}) },
});

describe("template model", () => {
  it("no block of the base pack hard-codes a model: the AI agent template is the one place to set it", () => {
    const dir = path.join(import.meta.dirname, "../packs/base/boxes");
    for (const f of fs.readdirSync(dir)) {
      const b = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) as BlockDef;
      if (b.id !== "tpl-ai-agent") expect(b.config.agent?.model, b.id).toBeUndefined();
    }
  });

  it("an edited pack template's model reaches every block extending it (storage → resolve)", () => {
    const dir = tmp();
    const s = createStorage(dir);
    s.saveBlocks(withModel(s.load().blocks, TPL, "glm-4.6"));
    const data = createStorage(dir).load();
    for (const f of data.flows) {
      for (const n of f.nodes) {
        const cfg = resolveNode(n, data.blocks);
        if (cfg.kind === "ai" || cfg.kind === "manager") expect(cfg.agent.model, `${f.id} › ${n.id}`).toBe("glm-4.6");
      }
    }
    expect(agentOrigin("model", "base/plan", data.blocks)).toMatchObject({ layer: "block", blockId: TPL, template: true });
  });

  it("a node's own model wins over the template, and says so; a blank one is ignored", () => {
    const blocks = createStorage(tmp()).load().blocks;
    const edited = withModel(blocks, TPL, "glm-4.6");
    expect(resolveNode(planNode({ agent: { model: "glm-4.5-air" } }), edited).agent.model).toBe("glm-4.5-air");
    expect(agentOrigin("model", "base/plan", edited, { agent: { model: "glm-4.5-air" } })).toEqual({ layer: "node" });
    // A blank (or whitespace) model never replaces the template's with an empty name.
    expect(resolveNode(planNode({ agent: { model: "  " } }), edited).agent.model).toBe("glm-4.6");
    expect(agentOrigin("model", "base/plan", edited, { agent: { model: "" } })).toMatchObject({ layer: "block", blockId: TPL });
    expect(resolveNode(planNode({ agent: { model: " glm-4.6 " } }), blocks).agent.model).toBe("glm-4.6");
  });

  it("running a flow through the API passes the template's model to claude (and logs where it came from)", async () => {
    const dir = tmp();
    const noop = async () => ({ outputs: {} });
    const api = createApi(createStorage(dir), { auto: noop, ai: runAi }, { exec: async () => ({ code: 0, stdout: "", stderr: "" }) });
    server = createServer((req, res) => api(req, res, () => ((res.statusCode = 404), res.end())));
    server.listen(0);
    await new Promise((r) => server!.once("listening", r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
    const send = (method: string, url: string, body: unknown) =>
      fetch(`${base}${url}`, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

    const data = (await (await fetch(`${base}/data`)).json()) as AppData;
    // Edit the pack template in place, as the block editor does.
    expect((await send("PUT", "/blocks", withModel(data.blocks, TPL, "glm-4.6"))).status).toBe(200);
    const flow: Flow = { id: "only-plan", name: "Only plan", nodes: [planNode()], edges: [] };
    expect((await send("PUT", "/flows", [...data.flows.filter((f) => !f.pack), flow])).status).toBe(200);
    await send("PUT", "/settings", { ...data.settings, sandbox: "none" });
    await send("PUT", "/env", { REPO_PATH: dir, ANTHROPIC_API_KEY: "", ANTHROPIC_AUTH_TOKEN: "t", ANTHROPIC_BASE_URL: "http://gw:4000" });

    const started = await send("POST", "/runs", { flowId: "only-plan", prompt: "Plan it" });
    expect(started.status).toBe(200);
    const { runId } = (await started.json()) as { runId: string };
    let run: RunState | undefined;
    for (let i = 0; i < 200 && !run?.finishedAt; i++) {
      await new Promise((r) => setTimeout(r, 20));
      run = (await (await fetch(`${base}/runs/${runId}`)).json()) as RunState;
    }
    expect(run?.status, run?.error).toBe("done");
    expect(agentCalls.map((c) => [c.provider, c.model])).toEqual([["claudeCode", "glm-4.6"]]);
    expect(run!.logs.some((l) => l.msg.includes("model glm-4.6 (from AI Agent (template))"))).toBe(true);
    // Behind the gateway, Claude Code's other models are the GLM model too.
    for (const k of CLAUDE_AUX_MODEL_ENV) expect(agentCalls[0].env[k]).toBe("glm-4.6");
  });

  it("the assistant (MCP save_block) can set the model on the pack template itself", async () => {
    const dir = tmp();
    const s = createStorage(dir);
    const mcp = createMcp({ load: s.load, saveFlows: s.saveFlows, saveBlocks: s.saveBlocks });
    const res = await mcp.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "save_block", arguments: { id: TPL, name: "AI Agent (template)", config: { agent: { model: "glm-4.6" } } } } });
    expect(JSON.stringify(res)).toContain("Updated block");
    const data = createStorage(dir).load();
    const tpl = data.blocks.find((b) => b.id === TPL)!;
    // Only the given fields change: provider/effort/env stay the pack's.
    expect(tpl).toMatchObject({ pack: "base", modified: true, config: { agent: { provider: "claudeCode", model: "glm-4.6", effort: "high" }, env: ["REPO_PATH", "ANTHROPIC_API_KEY"] } });
    expect(resolveNode(planNode(), data.blocks).agent.model).toBe("glm-4.6");
  });
});

describe("Claude Code's other models behind a gateway", () => {
  it("are pinned to a non-Claude model only with a gateway, never over values you set", () => {
    expect(isClaudeModel("claude-opus-4-8")).toBe(true);
    expect(isClaudeModel("sonnet")).toBe(true);
    expect(isClaudeModel("opus[1m]")).toBe(true);
    expect(isClaudeModel("glm-4.6")).toBe(false);
    expect(isClaudeModel("GLM-4.5-Air")).toBe(false);
    expect(auxModelEnv("claudeCode", "glm-4.6", {}, false)).toEqual({});
    expect(auxModelEnv("claudeCode", "claude-opus-4-8", {}, true)).toEqual({});
    expect(auxModelEnv("codex", "glm-4.6", {}, true)).toEqual({});
    const pinned = auxModelEnv("claudeCode", "glm-4.6", { ANTHROPIC_SMALL_FAST_MODEL: "glm-4.5-air" }, true);
    expect(pinned.ANTHROPIC_SMALL_FAST_MODEL).toBeUndefined();
    expect(pinned.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe("glm-4.6");
  });

  it("values set in Inputs reach the agent and win over the pinned ones", async () => {
    const blocks = createStorage(tmp()).load().blocks;
    const edited = withModel(blocks, TPL, "glm-4.6");
    const env: Record<string, string> = { REPO_PATH: "/r", ANTHROPIC_AUTH_TOKEN: "t", ANTHROPIC_BASE_URL: "http://gw", ANTHROPIC_SMALL_FAST_MODEL: "glm-4.5-air" };
    const sandbox = {
      exec: async () => ({ exitCode: 0 }),
      run: async () => ({ stdout: "<artifact>A</artifact>", commits: [], iterations: [] }),
      close: async () => ({}),
    };
    const ctx = {
      settings: { startingPrompt: "x", sandbox: "docker", maxSteps: 10 },
      env,
      flow: { id: "f", name: "F", nodes: [planNode()], edges: [] },
      blocks: edited,
      sandbox,
      run: { id: "r", flowId: "f", flowName: "F", status: "running", startedAt: 0, nodes: {}, logs: [] },
      blockEnv: (cfg: { env: string[] }) => Object.fromEntries(cfg.env.filter((k) => k in env).map((k) => [k, env[k]])),
      log: () => {},
      ask: async () => "",
      abort: new AbortController(),
      installedSkills: new Set(),
      cleanup: [],
    } as unknown as RunContext;
    await runAi(ctx, planNode(), resolveNode(planNode(), edited), {});
    expect(agentCalls[0].model).toBe("glm-4.6");
    expect(agentCalls[0].env).toMatchObject({ ANTHROPIC_SMALL_FAST_MODEL: "glm-4.5-air", CLAUDE_CODE_SUBAGENT_MODEL: "glm-4.6", ANTHROPIC_BASE_URL: "http://gw" });
  });
});
