import type {
  BlockConfig,
  BlockDef,
  Flow,
  FlowNode,
  IntegrationValue,
  ResolvedConfig,
  RunOnChoice,
  SkillRef,
} from "./types";
import { HOST_LOGIN_ENV, resolveRunOn } from "./runOn";
import { skillKey } from "./skills";
import { DEFAULT_COMBINE, DEFAULT_SPLIT } from "./stack";

export const DEFAULT_CONFIG: ResolvedConfig = {
  kind: "ai",
  description: "",
  color: "#64748b",
  icon: "box",
  inputs: { artifact: false, steer: false, startingPrompt: false },
  outputs: { artifact: false, steer: false },
  env: [],
  allowQuestions: false,
  skills: [],
  instructions: "",
  extraInstructions: "",
  autoAction: "shell",
  shellCommand: "",
  // No model = the agent CLI's own default model (no --model flag), like the Edit-with-AI chat.
  agent: { provider: "claudeCode", model: "", effort: "high" },
  runOn: "inherit",
  maxIterations: 1,
  trigger: { type: "manual", overlap: "queue" },
  condition: { match: "all", rules: [] },
  script: { run: "", where: "sandbox", exits: [] },
  subflow: { flowId: "" },
  flowOutput: { name: "done" },
  stack: {
    flowId: "",
    successExits: ["done"],
    workspace: "isolated",
    maxConcurrent: 3,
    maxChildren: 12,
    maxRetries: 1,
    splitInstructions: DEFAULT_SPLIT,
    combineInstructions: DEFAULT_COMBINE,
  },
  integration: { ref: "", action: "", exits: [], options: {} },
};

const uniq = (xs: string[]) => Array.from(new Set(xs.filter(Boolean)));

function mergeSkills(a: SkillRef[], b: SkillRef[] = []): SkillRef[] {
  const out = [...a];
  for (const s of b) {
    const i = out.findIndex((x) => skillKey(x) === skillKey(s));
    if (i >= 0) out[i] = { ...out[i], ...s };
    else out.push(s);
  }
  return out;
}

/** Layer a partial config on top of a resolved one. Arrays of env/skills are unioned, objects shallow-merged. */
export function applyConfig(base: ResolvedConfig, patch: BlockConfig | undefined): ResolvedConfig {
  if (!patch) return base;
  const def = <T>(v: T | undefined, fallback: T): T => (v === undefined ? fallback : v);
  return {
    kind: def(patch.kind, base.kind),
    description: def(patch.description, base.description),
    color: def(patch.color, base.color),
    icon: def(patch.icon, base.icon),
    inputs: { ...base.inputs, ...stripUndef(patch.inputs) },
    outputs: { ...base.outputs, ...stripUndef(patch.outputs) },
    env: uniq([...base.env, ...(patch.env ?? [])]),
    allowQuestions: def(patch.allowQuestions, base.allowQuestions),
    skills: mergeSkills(base.skills, patch.skills),
    instructions: def(patch.instructions, base.instructions),
    extraInstructions: [base.extraInstructions, patch.extraInstructions ?? ""]
      .filter((s) => s && s.trim())
      .join("\n\n"),
    autoAction: def(patch.autoAction, base.autoAction),
    shellCommand: def(patch.shellCommand, base.shellCommand),
    agent: { ...base.agent, ...agentPatch(patch.agent) },
    runOn: def(patch.runOn, base.runOn),
    maxIterations: def(patch.maxIterations, base.maxIterations),
    // Trigger settings merge field by field; a condition's rule list is replaced as a whole.
    trigger: { ...base.trigger, ...stripUndef(patch.trigger) },
    condition: def(patch.condition, base.condition),
    script: { ...base.script, ...stripUndef(patch.script) },
    subflow: { ...base.subflow, ...stripUndef(patch.subflow) },
    flowOutput: { ...base.flowOutput, ...stripUndef(patch.flowOutput) },
    stack: { ...base.stack, ...stripUndef(patch.stack) },
    // Option values merge one by one, so a node can set one option and keep the block's others.
    integration: patch.integration
      ? {
          ...base.integration,
          ...stripUndef({ ...patch.integration, options: undefined }),
          options: { ...base.integration.options, ...(stripUndef(patch.integration.options) as Record<string, IntegrationValue>) },
        }
      : base.integration,
  };
}

/** An agent patch without unset or blank values (a blank model / endpoint means "inherit", never "pass an empty name"), trimmed. */
function agentPatch(a: BlockConfig["agent"]): Partial<ResolvedConfig["agent"]> {
  if (!a) return {};
  return Object.fromEntries(
    Object.entries(a)
      .filter(([, v]) => v !== undefined && !(typeof v === "string" && !v.trim()))
      .map(([k, v]) => [k, typeof v === "string" ? v.trim() : v]),
  ) as Partial<ResolvedConfig["agent"]>;
}

function stripUndef<T extends object>(o: T | undefined): Partial<T> {
  if (!o) return {};
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

/** Returns the template chain root-first, ending with the block itself. Throws on cycles. */
export function templateChain(blockId: string, blocks: BlockDef[]): BlockDef[] {
  const byId = new Map(blocks.map((b) => [b.id, b]));
  const chain: BlockDef[] = [];
  const seen = new Set<string>();
  let cur = byId.get(blockId);
  while (cur) {
    if (seen.has(cur.id)) throw new Error(`Template cycle detected at "${cur.name}"`);
    seen.add(cur.id);
    chain.unshift(cur);
    cur = cur.extends ? byId.get(cur.extends) : undefined;
  }
  return chain;
}

export function resolveBlock(blockId: string, blocks: BlockDef[], overrides?: BlockConfig): ResolvedConfig {
  let cfg = DEFAULT_CONFIG;
  for (const b of templateChain(blockId, blocks)) cfg = applyConfig(cfg, b.config);
  return applyConfig(cfg, overrides);
}

/** Resolved config of everything *above* this block (what it would inherit). */
export function resolveInherited(block: BlockDef, blocks: BlockDef[]): ResolvedConfig {
  if (!block.extends) return DEFAULT_CONFIG;
  try {
    return resolveBlock(block.extends, blocks);
  } catch {
    return DEFAULT_CONFIG;
  }
}

export function resolveNode(node: FlowNode, blocks: BlockDef[]): ResolvedConfig {
  return resolveBlock(node.data.blockId, blocks, node.data.overrides);
}

/** Where an agent setting comes from: the node's own override, a block in its template chain, or Sandflow's default. */
export type AgentOrigin =
  | { layer: "node" }
  | { layer: "block"; blockId: string; blockName: string; template: boolean }
  | { layer: "default" };

/**
 * Which layer decides `agent[key]` for a block (plus node overrides): the most specific one that sets it. Used to
 * show where a node's model comes from — e.g. "from AI Agent (template)" or "node override".
 */
export function agentOrigin(
  key: keyof ResolvedConfig["agent"],
  blockId: string,
  blocks: BlockDef[],
  overrides?: BlockConfig,
): AgentOrigin {
  const set = (c: BlockConfig | undefined) => {
    const v = c?.agent?.[key];
    return v !== undefined && !(typeof v === "string" && !v.trim());
  };
  if (set(overrides)) return { layer: "node" };
  let chain: BlockDef[];
  try {
    chain = templateChain(blockId, blocks);
  } catch {
    return { layer: "default" };
  }
  const b = [...chain].reverse().find((x) => set(x.config));
  return b ? { layer: "block", blockId: b.id, blockName: b.name, template: b.isTemplate } : { layer: "default" };
}

/** Would setting `candidateParent` as parent of `blockId` create a cycle? */
export function wouldCycle(blockId: string, candidateParent: string, blocks: BlockDef[]): boolean {
  try {
    return templateChain(candidateParent, blocks).some((b) => b.id === blockId);
  } catch {
    return true;
  }
}

export interface RequiredEnvEntry {
  name: string;
  nodes: { id: string; label: string }[];
  /** Every node that declares it can run without it (see `envOptionalFor`) — the run may start while it's empty. */
  optional: boolean;
}

/** Env var holding the project (repository) path. */
export const PROJECT_ENV = "REPO_PATH";

/**
 * Can a block with this config run without `name` set? Agents (ai / manager) don't need a project: without
 * REPO_PATH they work in a fresh, empty scratch workspace. Auto, script and other blocks that declare it still need it.
 */
export function envOptionalFor(cfg: ResolvedConfig, name: string): boolean {
  return name === PROJECT_ENV && (cfg.kind === "ai" || cfg.kind === "manager");
}

export interface FlowRequirements {
  env: RequiredEnvEntry[];
  startingPromptNodes: { id: string; label: string }[];
}

/**
 * Everything a flow needs from the user before it can start — including what its subflows need
 * (pass `flows` so they can be found; nodes inside a subflow are listed as `Subflow › Node`).
 */
export function flowRequirements(flow: Flow, blocks: BlockDef[], flows: Flow[] = []): FlowRequirements {
  const env = new Map<string, RequiredEnvEntry>();
  const startingPromptNodes: { id: string; label: string }[] = [];

  // `outer` = where the enclosing flows run their agents (innermost first).
  const visit = (f: Flow, prefix: string, labelPrefix: string, seen: Set<string>, asSubflow: boolean, outer: RunOnChoice[] = []) => {
    const flowRunOn = [f.runOn, ...outer].filter((x): x is RunOnChoice => !!x);
    for (const node of f.nodes) {
      let cfg: ResolvedConfig;
      try {
        cfg = resolveNode(node, blocks);
      } catch {
        continue;
      }
      // Inside a subflow, triggers never fire and Flow input hands on what the parent sent.
      if (asSubflow && (cfg.kind === "trigger" || cfg.kind === "flow-input")) continue;
      const id = prefix + node.id;
      const label = labelPrefix + nodeLabel(node, blocks);
      if (cfg.inputs.startingPrompt) startingPromptNodes.push({ id, label });
      // An agent on this computer uses the local CLI's own login, so API keys aren't required (or passed — see
      // hostAgentEnv) unless it talks to a custom endpoint.
      const ownLogin =
        (cfg.kind === "ai" || cfg.kind === "manager") && !cfg.agent.endpoint?.trim() && resolveRunOn([cfg.runOn, ...flowRunOn]) === "host";
      const names = cfg.env.filter((n) => !(ownLogin && HOST_LOGIN_ENV.includes(n)));
      // Webhook triggers (the default mode of GitHub / GitLab triggers) need their secret to verify the git host's signature.
      const t = cfg.kind === "trigger" ? cfg.trigger : undefined;
      if ((t?.type === "github" || t?.type === "gitlab") && (t.mode ?? "webhook") === "webhook" && t.secretEnv?.trim()) {
        names.push(t.secretEnv.trim());
      }
      for (const name of new Set(names)) {
        const e = env.get(name) ?? { name, nodes: [], optional: true };
        e.nodes.push({ id, label });
        e.optional &&= envOptionalFor(cfg, name);
        env.set(name, e);
      }
      if (cfg.kind === "subflow" || cfg.kind === "stack") {
        const child = flows.find((x) => x.id === (cfg.kind === "stack" ? cfg.stack.flowId : cfg.subflow.flowId));
        if (child && !seen.has(child.id)) visit(child, `${id}/`, `${label} › `, new Set([...seen, child.id]), true, flowRunOn);
      }
    }
  };
  visit(flow, "", "", new Set([flow.id]), false);

  return {
    env: [...env.values()].sort((a, b) => a.name.localeCompare(b.name)),
    startingPromptNodes,
  };
}

/** Does the flow have a schedule / GitHub / GitLab trigger (one that can start it while it's Active)? */
export function startsItself(flow: Flow, blocks: BlockDef[]): boolean {
  return flow.nodes.some((n) => {
    try {
      const cfg = resolveNode(n, blocks);
      return cfg.kind === "trigger" && cfg.trigger.type !== "manual";
    } catch {
      return false;
    }
  });
}

export function nodeLabel(node: FlowNode, blocks: BlockDef[]): string {
  return node.data.label || blocks.find((b) => b.id === node.data.blockId)?.name || "Unknown block";
}

export function isSecretName(name: string) {
  return /(KEY|TOKEN|SECRET|PASSWORD|PAT)$/i.test(name) || /(API_KEY|TOKEN|SECRET)/i.test(name);
}

export const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
