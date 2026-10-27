// MCP server (streamable HTTP, stateless, JSON responses) that lets agents read and edit flows.
// Mounted at /api/mcp. `?flow=<id>` scopes a session to one flow — the in-app "Edit with AI" chat uses that.

import { configProblems, describeBlock, findBlock } from "../shared/blockHelp";
import { flowRequirements, resolveBlock, startsItself } from "../shared/resolve";
import { applyOps, autoLayout, describeBlocks, describeFlow, validateFlow, type FlowOp } from "../shared/flowOps";
import { validateBlocks } from "../shared/validate";
import { runTools, type McpRuns } from "./mcpRuns";
import { editablePackBlock } from "./storage";
import type { AppData, BlockConfig, BlockDef, Flow, RunStartedBy } from "../shared/types";

export interface McpDeps {
  load(): AppData;
  /** Persist flows; `touched` = node ids the agent added/changed in `flowId` (the UI highlights them). */
  saveFlows(flows: Flow[], change: { flowId: string; touched: string[] }): void;
  saveBlocks(blocks: BlockDef[]): void;
  /** Start / watch / answer / stop runs (the run tools are offered only with this). */
  runs?: McpRuns;
}

interface JsonRpc {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** Hidden when the session is scoped to one flow. */
  unscopedOnly?: boolean;
  run(args: Record<string, unknown>, ctx: { scope?: string; client?: RunStartedBy; signal?: AbortSignal }): string | Promise<string>;
}

const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];

class ToolError extends Error {}

const flowIdProp = {
  flowId: { type: "string", description: "Flow id. Optional in a chat scoped to one flow (defaults to that flow)." },
};

const refsSchema = (dir: string) => ({
  type: ["string", "array"],
  items: { type: "string" },
  description:
    `Node(s) to wire ${dir} this one. A bare node id wires every compatible handle (artifact→artifact and steer→steer); ` +
    "\"node.handle\" wires just one (\"plan.steer\", \"check.true\", \"review.exit:approved\"). May name nodes added later in the same batch.",
});

const nodeProps = {
  id: { type: "string", description: "Short readable node id, e.g. \"plan\", \"check-author\". Optional: defaults to the block id without its pack (\"base/plan\" → \"plan\", then \"plan-2\")" },
  block: { type: "string", description: "Block from list_blocks: full id (\"base/plan\"), id without the pack (\"plan\") or its name (\"Shell command\")" },
  label: { type: "string", description: "Display name (defaults to the block name)" },
  overrides: {
    type: "object",
    description:
      "Only the settings that differ from the block (get_block lists them), e.g. {\"extraInstructions\": \"…\"}, {\"shellCommand\": \"npm test\"}, " +
      "{\"trigger\": {\"repo\": \"acme/web\"}}, {\"condition\": {\"match\": \"all\", \"rules\": [{\"field\": \"trigger.author\", \"op\": \"equals\", \"value\": \"alice\"}]}}",
  },
  from: refsSchema("into"),
  to: refsSchema("out of"),
};

const nodeSchema = { type: "object", required: ["block"], properties: nodeProps };

const opSchema = {
  type: "object",
  required: ["op"],
  description:
    "One of: {op:'add_node', block, id?, label?, overrides?, from?, to?} · " +
    "{op:'update_node', id, block?, label?, overrides?} (overrides merge into the node's; a key set to null is removed; overrides:null clears all) · " +
    "{op:'remove_node', id} (its edges go too) · {op:'connect', from:'plan', to:'impl'} (every compatible handle) or {op:'connect', edge:'a.artifact -> b.steer'} · " +
    "{op:'disconnect', edge} or {op:'disconnect', from, to} · {op:'rename_flow', name} · {op:'auto_layout'}",
  properties: {
    op: { type: "string", enum: ["add_node", "update_node", "remove_node", "connect", "disconnect", "rename_flow", "auto_layout"] },
    id: { type: "string" },
    block: { type: "string" },
    label: { type: ["string", "null"] },
    overrides: { type: ["object", "null"] },
    from: { type: ["string", "array"], items: { type: "string" }, description: "Source node (connect/disconnect), or node(s) feeding a new node (add_node)" },
    to: { type: ["string", "array"], items: { type: "string" }, description: "Target node (connect/disconnect), or node(s) a new node feeds (add_node)" },
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
    if (forWrite && flow.pack) {
      throw new ToolError(`"${flow.name}" comes from the ${flow.pack} pack and is read-only. Ask the user to duplicate it first (Flows tab → Duplicate)`);
    }
    return { data, flow };
  }

  function report(flow: Flow, data: AppData): string {
    const flows = data.flows.some((f) => f.id === flow.id) ? data.flows.map((f) => (f.id === flow.id ? flow : f)) : [...data.flows, flow];
    const r = validateFlow(flow, data.blocks, flows);
    const parts = [];
    parts.push(r.errors.length ? `Errors (fix these):\n${r.errors.map((e) => `- ${e}`).join("\n")}` : "Valid: no errors.");
    if (r.warnings.length) parts.push(`Warnings:\n${r.warnings.map((w) => `- ${w}`).join("\n")}`);
    const req = flowRequirements(flow, data.blocks, flows);
    const needs = [
      ...(req.startingPromptNodes.length && !data.settings.startingPrompt.trim()
        ? [startsItself(flow, data.blocks) ? "Starting prompt (only for manual runs — triggered runs use the event)" : "Starting prompt"]
        : []),
      ...req.env.filter((e) => !data.env[e.name]?.trim()).map((e) => (e.optional ? `${e.name} (optional)` : e.name)),
    ];
    if (needs.length) parts.push(`Still empty in the Inputs tab (the user fills these in): ${needs.join(", ")}`);
    return parts.join("\n");
  }

  /** Apply ops to a flow and save (unless dryRun), reporting the result; a failed batch saves nothing. */
  function edit(data: AppData, flow: Flow, ops: FlowOp[], dryRun = false): string {
    let r;
    try {
      r = applyOps(flow, data.blocks, ops, data.flows);
    } catch (e) {
      const ids = flow.nodes.map((n) => n.id).join(", ") || "none";
      throw new ToolError(`${(e as Error).message}\nNothing was saved. Nodes in "${flow.id}": ${ids}`);
    }
    if (!dryRun) save(data, r.flow, r.touched);
    const head = dryRun ? "Dry run — nothing saved. These changes would be made:" : "Changes:";
    return `${head}\n${r.changes.join("\n") || "(nothing changed)"}\n\n${describeFlow(r.flow, data.blocks, data.flows)}\n\n${report(r.flow, data)}`;
  }

  function save(data: AppData, flow: Flow, touched: string[]) {
    const exists = data.flows.some((f) => f.id === flow.id);
    const flows = exists ? data.flows.map((f) => (f.id === flow.id ? flow : f)) : [...data.flows, flow];
    deps.saveFlows(flows, { flowId: flow.id, touched });
  }

  /** Build a flow from scratch (used by create_flow and replace_flow). */
  function build(base: Flow, data: AppData, args: Record<string, unknown>) {
    const nodes = (args.nodes as Record<string, unknown>[] | undefined) ?? [];
    const edges = (args.edges as string[] | undefined) ?? [];
    if (!Array.isArray(nodes) || !Array.isArray(edges)) throw new ToolError("nodes and edges must be arrays");
    const ops: FlowOp[] = [
      ...nodes.map((n) => ({
        op: "add_node" as const,
        id: n.id === undefined || n.id === null ? undefined : String(n.id),
        block: String(n.block ?? ""),
        label: n.label as string | undefined,
        overrides: n.overrides as BlockConfig | undefined,
        from: n.from as string | string[] | undefined,
        to: n.to as string | string[] | undefined,
      })),
      ...edges.map((edge) => ({ op: "connect" as const, edge: String(edge) })),
    ];
    let r;
    try {
      r = applyOps({ ...base, nodes: [], edges: [] }, data.blocks, ops, data.flows);
    } catch (e) {
      throw new ToolError(`${(e as Error).message}\nNothing was saved. (Ops are numbered nodes first, then edges.)`);
    }
    return { ...r, flow: autoLayout(r.flow) };
  }

  const tools: McpTool[] = [
    {
      name: "list_blocks",
      description:
        "List the blocks a flow can use: id, name, kind, edge inputs/outputs, env vars it needs, and what it does. Call this before adding nodes. " +
        "Filter with kind (trigger, ai, auto, manager, condition, script, subflow, flow-input, flow-output) or query (matches id, name, description). " +
        "Then get_block shows one block's settings and an example op.",
      inputSchema: {
        type: "object",
        properties: {
          kind: { type: "string", description: "Only blocks of this kind" },
          query: { type: "string", description: "Only blocks whose id, name or description contains this (case-insensitive)" },
        },
      },
      run: (a) => {
        const blocks = deps.load().blocks;
        const q = typeof a.query === "string" ? a.query.trim().toLowerCase() : "";
        const shown = blocks.filter((b) => {
          let kind: string;
          try {
            kind = resolveBlock(b.id, blocks).kind;
          } catch {
            kind = "?";
          }
          if (typeof a.kind === "string" && a.kind && kind !== a.kind) return false;
          return !q || `${b.id} ${b.name} ${b.config.description ?? ""}`.toLowerCase().includes(q);
        });
        const text = shown.length ? describeBlocks(blocks, shown) : "";
        return text ? `${text}\n\nNext: get_block {block} for a block's settings, defaults and an example add_node op.` : "No blocks match. Call list_blocks with no filter to see them all.";
      },
    },
    {
      name: "get_block",
      description:
        "Everything needed to place one block: kind, inputs/outputs, env vars, current defaults (instructions, command, trigger, rules…), " +
        "the overrides a node can set (with types and examples), what still needs setting, and a ready-to-edit add_node op.",
      inputSchema: {
        type: "object",
        required: ["block"],
        properties: { block: { type: "string", description: "Block id (\"base/plan\"), id without the pack (\"plan\") or name (\"Shell command\")" } },
      },
      run: (a) => {
        const blocks = deps.load().blocks;
        let b;
        try {
          b = findBlock(a.block, blocks);
        } catch (e) {
          throw new ToolError((e as Error).message);
        }
        return describeBlock(b, blocks);
      },
    },
    {
      name: "list_flows",
      description: "List flows (id, name, node count). Pack flows are read-only but can run inside other flows as subflows.",
      inputSchema: { type: "object", properties: {} },
      run: (_a, { scope }) =>
        deps
          .load()
          .flows.map((f) => `- ${f.id}: ${f.name} (${f.nodes.length} nodes)${f.pack ? ` [pack ${f.pack}, read-only]` : ""}${f.id === scope ? " ← this chat's flow" : ""}`)
          .join("\n") || "(no flows)",
    },
    {
      name: "get_flow",
      description: "Show a flow's nodes (with their block, kind and handles) and edges, plus validation problems.",
      inputSchema: { type: "object", properties: flowIdProp },
      run: (a, { scope }) => {
        const { data, flow } = pickFlow(a, scope, false);
        return `${describeFlow(flow, data.blocks, data.flows)}\n\n${report(flow, data)}`;
      },
    },
    {
      name: "create_flow",
      description:
        "Create a new flow in one call. Each node is {block, id?, label?, overrides?, from?, to?} — from/to wire it to other nodes by id " +
        "(every compatible handle), or list edges as strings like \"plan.artifact -> implement.artifact\". Nodes get laid out automatically.",
      unscopedOnly: true,
      inputSchema: {
        type: "object",
        required: ["name", "nodes"],
        properties: { name: { type: "string" }, nodes: { type: "array", items: nodeSchema }, edges: { type: "array", items: { type: "string" } } },
      },
      run: (a) => {
        const data = deps.load();
        const name = String(a.name ?? "").trim();
        if (!name) throw new ToolError("name is required");
        let id = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "flow";
        while (data.flows.some((f) => f.id === id)) id = `${id}-${Math.random().toString(36).slice(2, 5)}`;
        const r = build({ id, name, nodes: [], edges: [] }, data, a);
        save(data, r.flow, r.touched);
        return `Created flow "${name}" (id: ${id}).\n\nChanges:\n${r.changes.join("\n")}\n\n${describeFlow(r.flow, data.blocks, data.flows)}\n\n${report(r.flow, data)}`;
      },
    },
    {
      name: "replace_flow",
      description:
        "Replace ALL nodes and edges of an existing flow (use for a from-scratch design; prefer edit_flow for changes). Same node format as create_flow. Nodes get laid out automatically.",
      inputSchema: {
        type: "object",
        required: ["nodes"],
        properties: { ...flowIdProp, name: { type: "string", description: "Optional new flow name" }, nodes: { type: "array", items: nodeSchema }, edges: { type: "array", items: { type: "string" } } },
      },
      run: (a, { scope }) => {
        const { data, flow } = pickFlow(a, scope, true);
        const name = typeof a.name === "string" && a.name.trim() ? a.name.trim() : flow.name;
        const r = build({ ...flow, name }, data, a);
        save(data, r.flow, r.touched);
        return `Replaced flow "${name}".\n\nChanges:\n${r.changes.join("\n") || "(emptied the flow)"}\n\n${describeFlow(r.flow, data.blocks, data.flows)}\n\n${report(r.flow, data)}`;
      },
    },
    {
      name: "edit_flow",
      description:
        "Apply a batch of edits to a flow. All-or-nothing: if one op fails nothing is saved and the error names the op and the field. " +
        "Place and wire a block in one op: {op:'add_node', block:'plan', from:'start'} (id defaults from the block; from/to wire every compatible handle). " +
        "New nodes are placed next to their neighbours — never send coordinates. Set dryRun to check a batch without saving. " +
        "The result lists the changes, the whole flow, validation problems and inputs the user still has to fill in.",
      inputSchema: {
        type: "object",
        required: ["ops"],
        properties: {
          ...flowIdProp,
          ops: { type: "array", items: opSchema },
          dryRun: { type: "boolean", description: "Validate and show the result without saving" },
        },
      },
      run: (a, { scope }) => {
        const { data, flow } = pickFlow(a, scope, true);
        if (!Array.isArray(a.ops) || !a.ops.length) throw new ToolError("ops must be a non-empty array");
        return edit(data, flow, a.ops as FlowOp[], a.dryRun === true);
      },
    },
    {
      name: "add_node",
      description:
        "Place one block in a flow and wire it up — shorthand for edit_flow with one add_node op. Only block is required: " +
        "the id defaults from the block, defaults come from the block, overrides set only what differs, and from/to connect it " +
        "(e.g. from:\"plan\" wires plan's artifact and steer into it; from:\"check.true\" wires an If branch).",
      inputSchema: { type: "object", required: ["block"], properties: { ...flowIdProp, ...nodeProps } },
      run: (a, { scope }) => {
        const { data, flow } = pickFlow(a, scope, true);
        const { flowId: _f, ...op } = a;
        return edit(data, flow, [{ ...op, op: "add_node" } as FlowOp]);
      },
    },
    {
      name: "update_node",
      description:
        "Change one node — shorthand for edit_flow with one update_node op. overrides MERGE into the node's existing ones " +
        "(settings objects like trigger/agent merge one level deep; a key set to null is removed; overrides:null clears all). block swaps the block, label renames it.",
      inputSchema: {
        type: "object",
        required: ["id"],
        properties: {
          ...flowIdProp,
          id: { type: "string", description: "Node id (get_flow lists them)" },
          block: nodeProps.block,
          label: { type: ["string", "null"], description: "New display name (null resets to the block name)" },
          overrides: { type: ["object", "null"], description: nodeProps.overrides.description },
        },
      },
      run: (a, { scope }) => {
        const { data, flow } = pickFlow(a, scope, true);
        const { flowId: _f, ...op } = a;
        return edit(data, flow, [{ ...op, op: "update_node" } as FlowOp]);
      },
    },
    {
      name: "connect",
      description:
        "Wire nodes — shorthand for edit_flow connect ops. Give from and to node ids to wire every compatible handle " +
        "(artifact→artifact, steer→steer), \"node.handle\" for just one (\"check.true\", \"plan.steer\"), or edges: [\"a.artifact -> b.steer\", …].",
      inputSchema: {
        type: "object",
        properties: {
          ...flowIdProp,
          from: { type: "string", description: "Source node id or node.handle" },
          to: { type: "string", description: "Target node id or node.handle" },
          edges: { type: "array", items: { type: "string" }, description: "Edges as \"source.handle -> target.handle\"" },
        },
      },
      run: (a, { scope }) => {
        const { data, flow } = pickFlow(a, scope, true);
        const ops: FlowOp[] = [];
        if (a.from !== undefined || a.to !== undefined) ops.push({ op: "connect", from: a.from as string, to: a.to as string });
        if (Array.isArray(a.edges)) ops.push(...a.edges.map((edge) => ({ op: "connect" as const, edge: String(edge) })));
        if (!ops.length) throw new ToolError('Give from and to (node ids), or edges: ["a.artifact -> b.artifact"]');
        return edit(data, flow, ops);
      },
    },
    {
      name: "validate_flow",
      description: "Check a flow for errors (bad edges, unknown blocks, no start node) and likely mistakes.",
      inputSchema: { type: "object", properties: flowIdProp },
      run: (a, { scope }) => {
        const { data, flow } = pickFlow(a, scope, false);
        return report(flow, data);
      },
    },
    {
      name: "flow_requirements",
      description: "Which env vars and whether a starting prompt the user must fill in before the flow can run (names only — never values).",
      inputSchema: { type: "object", properties: flowIdProp },
      run: (a, { scope }) => {
        const { data, flow } = pickFlow(a, scope, false);
        const req = flowRequirements(flow, data.blocks, data.flows);
        const lines = req.env.map((e) => `- ${e.name} (${data.env[e.name]?.trim() ? "set" : e.optional ? "optional, empty" : "MISSING"}) — used by ${e.nodes.map((n) => n.label).join(", ")}`);
        if (req.startingPromptNodes.length) {
          const state = data.settings.startingPrompt.trim()
            ? "set"
            : startsItself(flow, data.blocks)
              ? "empty — only needed for manual runs; triggered runs use the event instead"
              : "MISSING";
          lines.unshift(`- Starting prompt (${state}) — used by ${req.startingPromptNodes.map((n) => n.label).join(", ")}`);
        }
        return lines.length ? `The user fills these in the Inputs tab:\n${lines.join("\n")}` : "This flow needs no inputs.";
      },
    },
    {
      name: "save_block",
      description:
        "Create or update a custom block or template in the library — only when no block fits even with node overrides. " +
        "To change a pack block or template for every flow (e.g. the model of all agents: base/tpl-ai-agent's config.agent.model), pass its full id: " +
        "only the config fields you give change, and the user's version replaces the pack's until they revert it. " +
        "Extend a template (base/tpl-ai-agent for agents, base/tpl-auto-git for host steps, base/tpl-reviewer, base/tpl-trigger) and set only what differs: " +
        "description, instructions, inputs/outputs, env, skills. get_block on the template shows its fields.",
      inputSchema: {
        type: "object",
        required: ["id", "name", "config"],
        properties: {
          id: { type: "string", description: "Stable id, e.g. \"security-review\"" },
          name: { type: "string" },
          isTemplate: { type: "boolean" },
          extends: { type: ["string", "null"], description: "Template id to inherit from" },
          config: { type: "object", description: "Partial BlockConfig: kind, description, color, icon, inputs, outputs, env, instructions, autoAction, shellCommand, agent, runOn (ai/manager: inherit | sandbox | host = this computer), maxIterations, allowQuestions, condition, trigger" },
        },
      },
      run: (a) => {
        const data = deps.load();
        const id = String(a.id ?? "").trim();
        const existing = data.blocks.find((b) => b.id === id);
        // A pack block is edited in place, like in the block editor: your version replaces the pack's (and every block
        // extending it sees the change — e.g. the model of base/tpl-ai-agent). Sandflow's core blocks stay read-only.
        const packEdit = !!existing && editablePackBlock(existing);
        if ((existing?.pack && !packEdit) || existing?.builtin) {
          throw new ToolError(`"${id}" is built into Sandflow and can't be changed. Save a new block that extends a template instead`);
        }
        if (!packEdit && !/^[A-Za-z][\w-]{0,63}$/.test(id)) throw new ToolError(`Block id "${id}" is invalid: letters, digits, _ or -, starting with a letter`);
        let parent: string | null = null;
        if (typeof a.extends === "string" && a.extends.trim()) {
          try {
            parent = findBlock(a.extends, data.blocks).id;
          } catch (e) {
            throw new ToolError(`extends: ${(e as Error).message}`);
          }
        }
        const isObj = (v: unknown) => !!v && typeof v === "object" && !Array.isArray(v);
        if (a.config !== undefined && !isObj(a.config)) throw new ToolError("config must be an object");
        const patch = (a.config as BlockConfig) ?? {};
        if (patch.agent !== undefined && !isObj(patch.agent)) throw new ToolError("config.agent must be an object, e.g. {\"model\": \"…\"}");
        const block: BlockDef = packEdit
          ? {
              ...existing!,
              name: String(a.name ?? "").trim() || existing!.name,
              extends: a.extends === undefined ? (existing!.extends ?? null) : parent,
              // Only the fields given change; the agent settings merge field by field (so setting a model keeps the provider).
              config: { ...existing!.config, ...patch, ...(patch.agent ? { agent: { ...existing!.config.agent, ...patch.agent } } : {}) },
              modified: true,
            }
          : {
              id,
              name: String(a.name ?? "").trim() || id,
              isTemplate: !!a.isTemplate,
              extends: parent,
              config: patch,
            };
        const blocks = existing ? data.blocks.map((b) => (b.id === id ? block : b)) : [...data.blocks, block];
        const errors = validateBlocks(blocks, new Set([id]));
        if (!errors.length) {
          let kind;
          try {
            kind = resolveBlock(id, blocks).kind;
          } catch {
            kind = undefined;
          }
          if (kind) errors.push(...configProblems(a.config, kind, false));
        }
        if (errors.length) throw new ToolError(errors.join("\n"));
        deps.saveBlocks(blocks);
        return `${existing ? "Updated" : "Created"} block "${block.name}" (id: ${id}).\n${describeBlocks([block, ...blocks.filter((b) => b.id !== id)]).split("\n")[0]}`;
      },
    },
    ...(deps.runs ? runTools(deps.runs) : []),
  ];

  const visible = (scope?: string) => tools.filter((t) => !(scope && t.unscopedOnly));

  /** Run one tool. `onCall` sees every call (the chat panel shows them). */
  async function callTool(name: string, args: Record<string, unknown>, ctx: CallContext = {}): Promise<{ text: string; isError: boolean }> {
    const tool = visible(ctx.scope).find((t) => t.name === name);
    let out: { text: string; isError: boolean };
    if (!tool) out = { text: `Unknown tool "${name}"`, isError: true };
    else {
      try {
        out = { text: await tool.run(args, { scope: ctx.scope, client: ctx.client, signal: ctx.signal }), isError: false };
      } catch (e) {
        out = { text: (e as Error).message, isError: true };
      }
    }
    ctx.onCall?.({ name, input: args, ...out });
    return out;
  }

  async function call(msg: JsonRpc, ctx: CallContext): Promise<unknown> {
    switch (msg.method) {
      case "initialize": {
        const asked = String(msg.params?.protocolVersion ?? "");
        return {
          protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
          capabilities: { tools: {} },
          serverInfo: { name: "sandflow", version: "1.0.0" },
          instructions:
            "Sandflow flows are graphs of blocks wired by artifact/steer edges. Call list_blocks first (get_block for one block's settings), then get_flow. " +
            "Place and wire blocks with add_node {block, from, overrides} or batch with edit_flow; build from scratch with replace_flow/create_flow. " +
            "Every edit returns the flow, validation problems and inputs still empty. " +
            (deps.runs && !ctx.scope
              ? "Run a flow with start_run, then follow it with watch_run (pass back its cursor) until it ends; answer_question, steer_run, stop_run and get_run act on a run. You can't set saved env values."
              : "You can't run flows or set env values."),
        };
      }
      case "ping":
        return {};
      case "tools/list":
        return { tools: visible(ctx.scope).map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) };
      case "tools/call": {
        const r = await callTool(String(msg.params?.name ?? ""), (msg.params?.arguments as Record<string, unknown>) ?? {}, ctx);
        return r.isError ? { content: [{ type: "text", text: r.text }], isError: true } : { content: [{ type: "text", text: r.text }] };
      }
      default:
        throw Object.assign(new Error(`Method not found: ${msg.method}`), { rpcCode: -32601 });
    }
  }

  /** Handle one POSTed JSON-RPC message or batch. Returns undefined when there's nothing to answer (notifications). */
  async function handle(body: unknown, ctx: CallContext = {}): Promise<unknown> {
    const one = async (m: JsonRpc) => {
      if (!m || m.jsonrpc !== "2.0" || typeof m.method !== "string") {
        return { jsonrpc: "2.0", id: m?.id ?? null, error: { code: -32600, message: "Invalid request" } };
      }
      if (m.id === undefined || m.id === null) return undefined; // notification
      try {
        return { jsonrpc: "2.0", id: m.id, result: await call(m, ctx) };
      } catch (e) {
        return { jsonrpc: "2.0", id: m.id, error: { code: (e as { rpcCode?: number }).rpcCode ?? -32603, message: (e as Error).message } };
      }
    };
    if (Array.isArray(body)) {
      const out = (await Promise.all(body.map(one))).filter(Boolean);
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
  /** Who is calling, recorded on the runs it starts (Claude Code's bridge says so). */
  client?: RunStartedBy;
  /** Aborted when the caller goes away (ends a watch_run early). */
  signal?: AbortSignal;
  onCall?(call: { name: string; input: unknown; text: string; isError: boolean }): void;
}
