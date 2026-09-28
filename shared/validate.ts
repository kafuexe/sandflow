import { ENV_NAME_RE, flowRequirements, templateChain } from "./resolve";
import type { BlockDef, EnvValues, Flow } from "./types";

/** Problems with a block library (empty when valid). */
export function validateBlocks(blocks: BlockDef[]): string[] {
  const errors: string[] = [];
  const byId = new Map<string, BlockDef>();
  for (const b of blocks) {
    if (!b.id) errors.push(`Block "${b.name}" has no id`);
    else if (byId.has(b.id)) errors.push(`Duplicate block id "${b.id}"`);
    else byId.set(b.id, b);
  }
  for (const b of blocks) {
    if (b.extends) {
      const parent = byId.get(b.extends);
      if (!parent) errors.push(`"${b.name}" extends unknown block "${b.extends}"`);
      else if (!parent.isTemplate) errors.push(`"${b.name}" extends "${parent.name}", which is not a template`);
    }
    const endpoint = b.config.agent?.endpoint?.trim();
    if (endpoint && !/^https?:\/\/[^\s]+$/i.test(endpoint)) {
      errors.push(`"${b.name}" has an invalid endpoint "${endpoint}" (must be an http(s) URL)`);
    }
    const endpointEnv = b.config.agent?.endpointEnv?.trim();
    if (endpointEnv && !ENV_NAME_RE.test(endpointEnv)) {
      errors.push(`"${b.name}" has invalid endpoint env var name "${endpointEnv}"`);
    }
    for (const name of b.config.env ?? []) {
      if (!ENV_NAME_RE.test(name)) errors.push(`"${b.name}" has invalid env var name "${name}"`);
    }
  }
  for (const b of byId.values()) {
    try {
      templateChain(b.id, blocks);
    } catch (e) {
      const msg = (e as Error).message;
      if (!errors.includes(msg)) errors.push(msg);
    }
  }
  return errors;
}

/** Human-readable list of inputs a flow still needs before it can run (empty = ready). */
export function missingInputs(flow: Flow, blocks: BlockDef[], env: EnvValues, startingPrompt: string): string[] {
  const req = flowRequirements(flow, blocks);
  const missing: string[] = [];
  if (req.startingPromptNodes.length && !startingPrompt.trim()) missing.push("Starting prompt");
  for (const e of req.env) if (!env[e.name]?.trim()) missing.push(e.name);
  return missing;
}
