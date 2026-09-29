// MCP server (streamable HTTP, stateless, JSON responses) that lets agents read and edit flows.
// Mounted at /api/mcp. `?flow=<id>` scopes a session to one flow — the in-app "Edit with AI" chat uses that.

import { flowRequirements } from "../shared/resolve";
import { applyOps, autoLayout, describeBlocks, describeFlow, validateFlow, type FlowOp } from "../shared/flowOps";
import { validateBlocks } from "../shared/validate";
import type { AppData, BlockConfig, BlockDef, Flow } from "../shared/types";

export interface McpDeps {
  load(): AppData;
  /** Persist flows; `touched` = node ids the agent added/changed in `flowId` (the UI highlights them). */
  saveFlows(flows: Flow[], change: { flowId: string; touched: string[] }): void;
  saveBlocks(blocks: BlockDef[]): void;
}

interface JsonRpc {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

interface Tool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** Hidden when the session is scoped to one flow. */
  unscopedOnly?: boolean;
  run(args: Record<string, unknown>, ctx: { scope?: string }): string;
}

const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];

class ToolError extends Error {}

const flowIdProp = {
  flowId: { type: "string", description: "Flow id. Optional in a chat scoped to one flow (defaults to that flow)." },
};

const nodeSchema = {
  type: "object",
  required: ["id", "block"],
  properties: {
    id: { type: "string", description: "Short readable node id you choose, e.g. \"plan\", \"review\", \"check-author\"" },
    block: { type: "string", description: "Block id from list_blocks" },
    label: { type: "string", description: "Display name (defaults to the block name)" },
    overrides: { type: "object", description: "Per-node BlockConfig overrides, e.g. {\"extraInstructions\": \"…\"} or {\"condition\": {…}}" },
  },
};

const opSchema = {
  type: "object",
  required: ["op"],
  description:
    "One of: {op:'add_node', id, block, label?, overrides?} · {op:'update_node', id, block?, label?, overrides?} (override keys set to null are removed; overrides:null clears all) · " +
    "{op:'remove_node', id} · {op:'connect', edge:'a.artifact -> b.steer'} · {op:'disconnect', edge} · {op:'rename_flow', name} · {op:'auto_layout'}",
  properties: {
    op: { type: "string", enum: ["add_node", "update_node", "remove_node", "connect", "disconnect", "rename_flow", "auto_layout"] },
    id: { type: "string" },
    block: { type: "string" },
    label: { type: ["string", "null"] },
    overrides: { type: ["object", "null"] },
    edge: { type: "string", description: "source.handle -> target.handle (handles default to artifact)" },
    name: { type: "string" },
  },
};

export function createMcp(deps: McpDeps) {
  function pickFlow(args: Record<string, unknown>, scope: string | undefined, forWrite: boolean): { data: AppData; flow: Flow } {
    const data = deps.load();
    const id = (args.flowId as string | undefined) || scope;
    if (!id) throw new ToolError("flowId is required (list_flows shows the ids)");
    if (forWrite && scope && id !== scope) {
      throw new ToolError(`This chat can only edit its own flow ("${scope}"). Ask the user to open a chat on "${id}" instead.`);
    }
    const flow = data.flows.find((f) => f.id === id);
    if (!flow) throw new ToolError(`No flow "${id}". list_flows shows the ids`);
    return { data, flow };
  }

  function report(flow: Flow, blocks: BlockDef[]): string {
    const r = validateFlow(flow, blocks);
    const parts = [];
    parts.push(r.errors.length ? `Errors:\n${r.errors.map((e) => `- ${e}`).join("\n")}` : "Valid: no errors.");
    if (r.warnings.length) parts.push(`Warnings:\n${r.warnings.map((w) => `- ${w}`).join("\n")}`);
    return parts.join("\n");
  }

  function save(data: AppData, flow: Flow, touched: string[]) {
    const exists = data.flows.some((f) => f.id === flow.id);
    const flows = exists ? data.flows.map((f) => (f.id === flow.id ? flow : f)) : [...data.flows, flow];
    deps.saveFlows(flows, { flowId: flow.id, touched });
  }

  /** Build a flow from scratch (used by create_flow and replace_flow). */
  function build(base: Flow, blocks: BlockDef[], args: Record<string, unknown>) {
    const nodes = (args.nodes as Record<string, unknown>[] | undefined) ?? [];
    const edges = (args.edges as string[] | undefined) ?? [];
    if (!Array.isArray(nodes) || !Array.isArray(edges)) throw new ToolError("nodes and edges must be arrays");
    const ops: FlowOp[] = [
      ...nodes.map((n) => ({ op: "add_node" as const, id: String(n.id ?? ""), block: String(n.block ?? ""), label: n.label as string | undefined, overrides: n.overrides as BlockConfig | undefined })),
      ...edges.map((edge) => ({ op: "connect" as const, edge: String(edge) })),
    ];
    const r = applyOps({ ...base, nodes: [], edges: [] }, blocks, ops);
    return { ...r, flow: autoLayout(r.flow) };
  }

  const tools: Tool[] = [
    {
      name: "list_blocks",
      description:
        "List every block a flow can use: id, name, kind, which edge inputs/outputs it has, env vars it needs, and what it does. Call this before adding nodes.",
      inputSchema: { type: "object", properties: {} },
      run: () => describeBlocks(deps.load().blocks),
    },
    {
      name: "list_flows",
      description: "List flows (id, name, node count).",
      inputSchema: { type: "object", properties: {} },
      run: (_a, { scope }) =>
        deps
          .load()
          .flows.map((f) => `- ${f.id}: ${f.name} (${f.nodes.length} nodes)${f.id === scope ? " ← this chat's flow" : ""}`)
          .join("\n") || "(no flows)",
    },
    {
      name: "get_flow",
      description: "Show a flow's nodes (with their block, kind and handles) and edges, plus validation problems.",
      inputSchema: { type: "object", properties: flowIdProp },
      run: (a, { scope }) => {
        const { data, flow } = pickFlow(a, scope, false);
        return `${describeFlow(flow, data.blocks)}\n\n${report(flow, data.blocks)}`;
      },
    },
    {
      name: "create_flow",
      description:
        "Create a new flow in one call. Nodes get laid out automatically. Edges are strings like \"plan.artifact -> implement.artifact\".",
      unscopedOnly: true,
      inputSchema: {
        type: "object",
        required: ["name", "nodes", "edges"],
        properties: { name: { type: "string" }, nodes: { type: "array", items: nodeSchema }, edges: { type: "array", items: { type: "string" } } },
      },
      run: (a) => {
        const data = deps.load();
        const name = String(a.name ?? "").trim();
        if (!name) throw new ToolError("name is required");
        let id = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "flow";
        while (data.flows.some((f) => f.id === id)) id = `${id}-${Math.random().toString(36).slice(2, 5)}`;
        const r = build({ id, name, nodes: [], edges: [] }, data.blocks, a);
        save(data, r.flow, r.touched);
        return `Created flow "${name}" (id: ${id}).\n\nChanges:\n${r.changes.join("\n")}\n\n${describeFlow(r.flow, data.blocks)}\n\n${report(r.flow, data.blocks)}`;
      },
    },
    {
      name: "replace_flow",
      description:
        "Replace ALL nodes and edges of an existing flow (use for a from-scratch design; prefer edit_flow for changes). Nodes get laid out automatically.",
      inputSchema: {
        type: "object",
        required: ["nodes", "edges"],
        properties: { ...flowIdProp, name: { type: "string", description: "Optional new flow name" }, nodes: { type: "array", items: nodeSchema }, edges: { type: "array", items: { type: "string" } } },
      },
      run: (a, { scope }) => {
        const { data, flow } = pickFlow(a, scope, true);
        const name = typeof a.name === "string" && a.name.trim() ? a.name.trim() : flow.name;
        const r = build({ ...flow, name }, data.blocks, a);
        save(data, r.flow, r.touched);
        return `Replaced flow "${name}".\n\nChanges:\n${r.changes.join("\n") || "(emptied the flow)"}\n\n${describeFlow(r.flow, data.blocks)}\n\n${report(r.flow, data.blocks)}`;
      },
    },
    {
      name: "edit_flow",
      description:
        "Apply a batch of edits to a flow. All-or-nothing: if one op fails nothing is saved and the error says which op. New nodes are placed next to their neighbours.",
      inputSchema: { type: "object", required: ["ops"], properties: { ...flowIdProp, ops: { type: "array", items: opSchema } } },
      run: (a, { scope }) => {
        const { data, flow } = pickFlow(a, scope, true);
        if (!Array.isArray(a.ops) || !a.ops.length) throw new ToolError("ops must be a non-empty array");
        const r = applyOps(flow, data.blocks, a.ops as FlowOp[]);
        save(data, r.flow, r.touched);
        return `Changes:\n${r.changes.join("\n") || "(nothing changed)"}\n\n${describeFlow(r.flow, data.blocks)}\n\n${report(r.flow, data.blocks)}`;
      },
    },
    {
      name: "validate_flow",
      description: "Check a flow for errors (bad edges, unknown blocks, no start node) and likely mistakes.",
      inputSchema: { type: "object", properties: flowIdProp },
      run: (a, { scope }) => {
        const { data, flow } = pickFlow(a, scope, false);
        return report(flow, data.blocks);
      },
    },
    {
      name: "flow_requirements",
      description: "Which env vars and whether a starting prompt the user must fill in before the flow can run (names only — never values).",
      inputSchema: { type: "object", properties: flowIdProp },
      run: (a, { scope }) => {
        const { data, flow } = pickFlow(a, scope, false);
        const req = flowRequirements(flow, data.blocks);
        const lines = req.env.map((e) => `- ${e.name} (${data.env[e.name]?.trim() ? "set" : "MISSING"}) — used by ${e.nodes.map((n) => n.label).join(", ")}`);
        if (req.startingPromptNodes.length) {
          lines.unshift(`- Starting prompt (${data.settings.startingPrompt.trim() ? "set" : "MISSING"}) — used by ${req.startingPromptNodes.map((n) => n.label).join(", ")}`);
        }
        return lines.length ? `The user fills these in the Inputs tab:\n${lines.join("\n")}` : "This flow needs no inputs.";
      },
    },
    {
      name: "save_block",
      description:
        "Create or update a custom (non-built-in) block or template in the library. Prefer extending a template (e.g. tpl-ai-agent) and setting only what differs: description, instructions, inputs/outputs, env, skills.",
      inputSchema: {
        type: "object",
        required: ["id", "name", "config"],
        properties: {
          id: { type: "string", description: "Stable id, e.g. \"security-review\"" },
          name: { type: "string" },
          isTemplate: { type: "boolean" },
          extends: { type: ["string", "null"], description: "Template id to inherit from" },
          config: { type: "object", description: "Partial BlockConfig: kind, description, color, icon, inputs, outputs, env, instructions, autoAction, shellCommand, agent, maxIterations, allowQuestions, condition, trigger" },
        },
      },
      run: (a) => {
        const data = deps.load();
        const id = String(a.id ?? "").trim();
        if (!/^[A-Za-z][\w-]{0,63}$/.test(id)) throw new ToolError(`Block id "${id}" is invalid: letters, digits, _ or -, starting with a letter`);
        const existing = data.blocks.find((b) => b.id === id);
        if (existing?.builtin) throw new ToolError(`"${id}" is a built-in block and can't be changed. Save a new block that extends a template instead`);
        const block: BlockDef = {
          id,
          name: String(a.name ?? "").trim() || id,
          isTemplate: !!a.isTemplate,
          extends: (a.extends as string | null | undefined) ?? null,
          config: (a.config as BlockConfig) ?? {},
        };
        const blocks = existing ? data.blocks.map((b) => (b.id === id ? block : b)) : [...data.blocks, block];
        const errors = validateBlocks(blocks);
        if (errors.length) throw new ToolError(errors.join("\n"));
        deps.saveBlocks(blocks);
        return `${existing ? "Updated" : "Created"} block "${block.name}" (id: ${id}).\n${describeBlocks([block, ...blocks.filter((b) => b.id !== id)]).split("\n")[0]}`;
      },
    },
  ];

  const visible = (scope?: string) => tools.filter((t) => !(scope && t.unscopedOnly));

  /** Run one tool. `onCall` sees every call (the chat panel shows them). */
  function callTool(name: string, args: Record<string, unknown>, ctx: CallContext = {}): { text: string; isError: boolean } {
    const tool = visible(ctx.scope).find((t) => t.name === name);
    let out: { text: string; isError: boolean };
    if (!tool) out = { text: `Unknown tool "${name}"`, isError: true };
    else {
      try {
        out = { text: tool.run(args, { scope: ctx.scope }), isError: false };
      } catch (e) {
        out = { text: (e as Error).message, isError: true };
      }
    }
    ctx.onCall?.({ name, input: args, ...out });
    return out;
  }

  function call(msg: JsonRpc, ctx: CallContext): unknown {
    switch (msg.method) {
      case "initialize": {
        const asked = String(msg.params?.protocolVersion ?? "");
        return {
          protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
          capabilities: { tools: {} },
          serverInfo: { name: "sandflow", version: "1.0.0" },
          instructions:
            "Sandflow flows are graphs of blocks wired by artifact/steer edges. Call list_blocks first, then get_flow. " +
            "Edit with edit_flow (batched ops) or build from scratch with replace_flow/create_flow. You can't run flows or set env values.",
        };
      }
      case "ping":
        return {};
      case "tools/list":
        return { tools: visible(ctx.scope).map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) };
      case "tools/call": {
        const r = callTool(String(msg.params?.name ?? ""), (msg.params?.arguments as Record<string, unknown>) ?? {}, ctx);
        return r.isError ? { content: [{ type: "text", text: r.text }], isError: true } : { content: [{ type: "text", text: r.text }] };
      }
      default:
        throw Object.assign(new Error(`Method not found: ${msg.method}`), { rpcCode: -32601 });
    }
  }

  /** Handle one POSTed JSON-RPC message or batch. Returns undefined when there's nothing to answer (notifications). */
  function handle(body: unknown, ctx: CallContext = {}): unknown {
    const one = (m: JsonRpc) => {
      if (!m || m.jsonrpc !== "2.0" || typeof m.method !== "string") {
        return { jsonrpc: "2.0", id: m?.id ?? null, error: { code: -32600, message: "Invalid request" } };
      }
      if (m.id === undefined || m.id === null) return undefined; // notification
      try {
        return { jsonrpc: "2.0", id: m.id, result: call(m, ctx) };
      } catch (e) {
        return { jsonrpc: "2.0", id: m.id, error: { code: (e as { rpcCode?: number }).rpcCode ?? -32603, message: (e as Error).message } };
      }
    };
    if (Array.isArray(body)) {
      const out = body.map(one).filter(Boolean);
      return out.length ? out : undefined;
    }
    return one(body as JsonRpc);
  }

  return { handle, callTool, tools: () => tools.map((t) => t.name) };
}

export type Mcp = ReturnType<typeof createMcp>;

export interface CallContext {
  /** Flow this session may edit (the in-app chat). */
  scope?: string;
  onCall?(call: { name: string; input: unknown; text: string; isError: boolean }): void;
}
