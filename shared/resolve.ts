import type {
  BlockConfig,
  BlockDef,
  Flow,
  FlowNode,
  ResolvedConfig,
  SkillRef,
} from "./types";
import { skillKey } from "./skills";

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
  agent: { provider: "claudeCode", model: "claude-opus-4-8", effort: "high" },
  maxIterations: 1,
  trigger: { type: "manual", overlap: "queue" },
  condition: { match: "all", rules: [] },
  script: { run: "", where: "sandbox", exits: [] },
  subflow: { flowId: "" },
  flowOutput: { name: "done" },
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
    agent: { ...base.agent, ...stripUndef(patch.agent) },
    maxIterations: def(patch.maxIterations, base.maxIterations),
    // Trigger settings merge field by field; a condition's rule list is replaced as a whole.
    trigger: { ...base.trigger, ...stripUndef(patch.trigger) },
    condition: def(patch.condition, base.condition),
    script: { ...base.script, ...stripUndef(patch.script) },
    subflow: { ...base.subflow, ...stripUndef(patch.subflow) },
    flowOutput: { ...base.flowOutput, ...stripUndef(patch.flowOutput) },
  };
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

  const visit = (f: Flow, prefix: string, labelPrefix: string, seen: Set<string>, asSubflow: boolean) => {
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
      const names = [...cfg.env];
      // Webhook triggers need their secret (to verify the git host's signature).
      if (cfg.kind === "trigger" && cfg.trigger.mode === "webhook" && cfg.trigger.secretEnv?.trim()) {
        names.push(cfg.trigger.secretEnv.trim());
      }
      for (const name of new Set(names)) {
        const e = env.get(name) ?? { name, nodes: [] };
        e.nodes.push({ id, label });
        env.set(name, e);
      }
      if (cfg.kind === "subflow") {
        const child = flows.find((x) => x.id === cfg.subflow.flowId);
        if (child && !seen.has(child.id)) visit(child, `${id}/`, `${label} › `, new Set([...seen, child.id]), true);
      }
    }
  };
  visit(flow, "", "", new Set([flow.id]), false);

  return {
    env: [...env.values()].sort((a, b) => a.name.localeCompare(b.name)),
    startingPromptNodes,
  };
}

export function nodeLabel(node: FlowNode, blocks: BlockDef[]): string {
  return node.data.label || blocks.find((b) => b.id === node.data.blockId)?.name || "Unknown block";
}

export function isSecretName(name: string) {
  return /(KEY|TOKEN|SECRET|PASSWORD|PAT)$/i.test(name) || /(API_KEY|TOKEN|SECRET)/i.test(name);
}

export const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
