import { ENV_NAME_RE, flowRequirements, templateChain } from "./resolve";
import { validateCondition } from "./conditions";
import { GIT_EVENTS } from "./events";
import { validateSchedule } from "./schedule";
import { skillProblem } from "./skills";
import { EXIT_NAME_RE, exitName, isExitHandle } from "./subflow";
import type { BlockDef, EdgeInputKind, EnvValues, Flow, ResolvedConfig, SourceHandle, TriggerConfig } from "./types";

/**
 * Problems with a block library (empty when valid). `only` limits the per-block checks to those ids — used when
 * saving, so a block you didn't touch (e.g. one extending a pack you removed) doesn't stop you saving others.
 */
export function validateBlocks(blocks: BlockDef[], only?: Set<string>): string[] {
  const errors: string[] = [];
  const byId = new Map<string, BlockDef>();
  for (const b of blocks) {
    if (!b.id) errors.push(`Block "${b.name}" has no id`);
    else if (byId.has(b.id)) errors.push(`Duplicate block id "${b.id}"`);
    else byId.set(b.id, b);
    // `pack/id` is how pack blocks are named, so your own ids can't look like that.
    if (b.id && !b.pack && b.id.includes("/")) errors.push(`Block id "${b.id}" can't contain "/" (that's reserved for pack blocks)`);
  }
  for (const b of blocks) {
    if (only && !only.has(b.id)) continue;
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
    const triggerProblem = validateTrigger(b.config.trigger);
    if (triggerProblem) errors.push(`"${b.name}": ${triggerProblem}`);
    if (b.config.condition) {
      const p = validateCondition(b.config.condition);
      if (p) errors.push(`"${b.name}": ${p}`);
    }
    for (const s of b.config.skills ?? []) {
      const problem = skillProblem(s);
      if (problem) errors.push(`"${b.name}": skill "${s.name}" — ${problem}`);
    }
    for (const name of b.config.env ?? []) {
      if (!ENV_NAME_RE.test(name)) errors.push(`"${b.name}" has invalid env var name "${name}"`);
    }
    const sc = b.config.script;
    if (sc) {
      if (sc.where !== undefined && sc.where !== "sandbox" && sc.where !== "host") errors.push(`"${b.name}": script "where" must be sandbox or host`);
      for (const x of sc.exits ?? []) if (!EXIT_NAME_RE.test(x)) errors.push(`"${b.name}": invalid exit name "${x}" (letters, digits, _ and -)`);
      if (sc.exits && new Set(sc.exits).size !== sc.exits.length) errors.push(`"${b.name}": duplicate exit names`);
      if (sc.timeoutSeconds !== undefined && !(sc.timeoutSeconds > 0)) errors.push(`"${b.name}": script timeout must be a positive number of seconds`);
    }
    const out = b.config.flowOutput?.name;
    if (out !== undefined && out !== "" && !EXIT_NAME_RE.test(out)) errors.push(`"${b.name}": invalid output name "${out}" (letters, digits, _ and -)`);
  }
  for (const b of byId.values()) {
    if (only && !only.has(b.id)) continue;
    try {
      templateChain(b.id, blocks);
    } catch (e) {
      const msg = (e as Error).message;
      if (!errors.includes(msg)) errors.push(msg);
    }
  }
  return errors;
}

const REPO_RE = /^[\w.-]+(\/[\w.-]+)+$/;
const HOST_RE = /^[a-z0-9.-]+(:\d+)?$/i;

/** Problem with a (partial) trigger config, or undefined. */
export function validateTrigger(t: Partial<TriggerConfig> | undefined): string | undefined {
  if (!t) return undefined;
  if (t.type && !["manual", "schedule", "github", "gitlab"].includes(t.type)) return `Unknown trigger type "${t.type}"`;
  if (t.schedule) {
    const p = validateSchedule(t.schedule);
    if (p) return p;
  }
  const repo = t.repo?.trim();
  if (repo && !REPO_RE.test(repo)) return `Invalid repository "${repo}" (use owner/repo or group/subgroup/project)`;
  const host = t.host?.trim();
  if (host && !HOST_RE.test(host)) return `Invalid host "${host}" (just the hostname, e.g. gitlab.corp.local)`;
  if (t.mode && t.mode !== "webhook" && t.mode !== "poll") return `Unknown trigger mode "${t.mode}"`;
  if (t.pollSeconds !== undefined && (!Number.isFinite(t.pollSeconds) || t.pollSeconds < 15)) {
    return "Poll interval must be at least 15 seconds";
  }
  const secret = t.secretEnv?.trim();
  if (secret && !ENV_NAME_RE.test(secret)) return `Invalid secret env var name "${secret}"`;
  const known = GIT_EVENTS.map((e) => e.type);
  const bad = (t.events ?? []).find((e) => !known.includes(e));
  if (bad) return `Unknown event "${bad}"`;
  if (t.overlap && t.overlap !== "queue" && t.overlap !== "skip") return `Unknown overlap policy "${t.overlap}"`;
  return undefined;
}

/**
 * Can `source.handle` connect to `target.targetHandle`? Branch handles only come out of If blocks; `exit:<name>`
 * handles out of a Script / subflow that has that exit (`sourceExits`, see `resolveNodeIn`).
 */
export function edgeAllowed(
  source: ResolvedConfig,
  handle: SourceHandle,
  target: ResolvedConfig,
  targetHandle: EdgeInputKind,
  sourceExits: string[] = [],
): boolean {
  if (target.kind === "trigger" || target.kind === "flow-input" || !target.inputs[targetHandle]) return false;
  if (handle === "true" || handle === "false") return source.kind === "condition";
  if (isExitHandle(handle)) return sourceExits.includes(exitName(handle));
  // A block with named exits leaves only through them.
  return source.kind !== "condition" && !sourceExits.length && source.outputs[handle] === true;
}

/** Human-readable list of inputs a flow still needs before it can run (empty = ready). */
export function missingInputs(flow: Flow, blocks: BlockDef[], env: EnvValues, startingPrompt: string, flows: Flow[] = []): string[] {
  const req = flowRequirements(flow, blocks, flows);
  const missing: string[] = [];
  if (req.startingPromptNodes.length && !startingPrompt.trim()) missing.push("Starting prompt");
  for (const e of req.env) if (!env[e.name]?.trim()) missing.push(e.name);
  return missing;
}
