// Help for agents placing and configuring blocks: finding a block by a loose reference, the fields a node can
// override (with types and examples), field-specific validation of overrides, and "what still needs setting" gaps.
// Used by the MCP tools (backend/mcp.ts) and the flow edit ops (shared/flowOps.ts).

import { AGENT_PROVIDERS } from "./agents";
import { CONDITION_OPS, validateCondition } from "./conditions";
import { GIT_EVENTS } from "./events";
import { GATE_LEVELS } from "./gates";
import { ENV_NAME_RE, resolveBlock, templateChain } from "./resolve";
import { skillProblem } from "./skills";
import { EXIT_NAME_RE } from "./subflow";
import type { BlockConfig, BlockDef, BlockKind, GateFailLevel, ResolvedConfig } from "./types";
import { validateTrigger } from "./validate";

type FieldType = "string" | "boolean" | "number" | "string[]" | "object" | "array";

interface FieldDoc {
  type: FieldType;
  /** Block kinds the field means something for (undefined = every kind). */
  kinds?: BlockKind[];
  doc: string;
  example?: unknown;
}

const AGENTS: BlockKind[] = ["ai", "manager"];

/**
 * Every BlockConfig field, documented for agents. Typed as a Record over `keyof BlockConfig` so adding a field to
 * BlockConfig fails to compile until it's described here (and accepted by the override checks below).
 */
export const CONFIG_FIELDS: Record<keyof BlockConfig, FieldDoc> = {
  kind: { type: "string", doc: "Block kind (blocks/templates only; a node can't change it — pick another block)" },
  description: { type: "string", doc: "One-line summary shown in the library" },
  color: { type: "string", doc: "Hex color, e.g. #8b5cf6" },
  icon: { type: "string", doc: "lucide icon name, e.g. bot, terminal" },
  inputs: { type: "object", doc: "Which inputs it accepts: {artifact, steer, startingPrompt} booleans", example: { steer: false } },
  outputs: { type: "object", doc: "Which outputs it emits: {artifact, steer} booleans", example: { steer: false } },
  env: { type: "string[]", doc: "Extra env var NAMES it needs (added to the inherited ones; the user fills values in)", example: ["JIRA_TOKEN"] },
  allowQuestions: { type: "boolean", kinds: AGENTS, doc: "Let the agent pause the run to ask the user a question" },
  skills: { type: "array", kinds: AGENTS, doc: "Skills installed before it runs: [{name, source:'owner/repo'}]" },
  instructions: { type: "string", kinds: AGENTS, doc: "The agent's role prompt (REPLACES the block's own — prefer extraInstructions)" },
  extraInstructions: {
    type: "string",
    kinds: AGENTS,
    doc: "Appended after the block's instructions — the usual way to customise an agent node",
    example: "Focus only on security issues.",
  },
  autoAction: { type: "string", kinds: ["auto"], doc: "create-task | create-mr | shell | post-comment | checks (pick the matching block instead)" },
  shellCommand: { type: "string", kinds: ["auto"], doc: "Shell command run on the host in REPO_PATH; stdout becomes the artifact", example: "npm test" },
  agent: {
    type: "object",
    kinds: AGENTS,
    doc: `Which agent runs it: {provider (${AGENT_PROVIDERS.join("|")}), model, effort (low|medium|high|xhigh|max), endpoint?, endpointEnv?}`,
    example: { model: "claude-sonnet-4-6" },
  },
  runOn: {
    type: "string",
    kinds: AGENTS,
    doc: "Where the agent runs: inherit (flow / Settings default) | sandbox (container) | host (the user's own computer, their installed CLI and login — only when the user asks; it gets access to their machine)",
    example: "host",
  },
  maxIterations: { type: "number", kinds: AGENTS, doc: "How many times the agent may loop on its own work (positive integer)" },
  trigger: {
    type: "object",
    kinds: ["trigger"],
    doc:
      "Merged into the block's trigger: {schedule, repo, host, mode (webhook|poll), pollSeconds, secretEnv, events, overlap (queue|skip)}. " +
      `schedule: {kind:'cron', expr:'0 0 9 * * 1-5', timezone?} | {kind:'interval', every, unit} | {kind:'once', at}. events: ${GIT_EVENTS.map((e) => e.type).join(", ")}`,
    example: { repo: "acme/web" },
  },
  condition: {
    type: "object",
    kinds: ["condition"],
    doc:
      "Replaces the If block's rules: {match: all|any, rules: [{field, op, value?}]}. Fields: text, steer, json.<path>, trigger.<path> " +
      `(author, body, title, labels, branch, type…). Ops: ${CONDITION_OPS.map((o) => o.op).join(", ")}`,
    example: { match: "all", rules: [{ field: "trigger.author", op: "equals", value: "alice" }] },
  },
  script: { type: "object", kinds: ["script"], doc: "{run: command, where: sandbox|host, exits?: [names], timeoutSeconds?}", example: { run: "python scripts/report.py" } },
  subflow: { type: "object", kinds: ["subflow"], doc: "{flowId}: the flow this node runs", example: { flowId: "review-loop" } },
  stack: {
    type: "object",
    kinds: ["stack"],
    doc: "{flowId, successExits, workspace: shared|isolated, maxConcurrent, maxChildren, maxRetries, splitInstructions, combineInstructions}: split the input into tasks, run the flow once per task, combine the results",
    example: { flowId: "fix-one-issue", successExits: ["done"], workspace: "isolated", maxConcurrent: 3, maxChildren: 10, maxRetries: 1 },
  },
  flowOutput: { type: "object", kinds: ["flow-output"], doc: "{name}: the exit this output becomes on the parent's subflow node", example: { name: "approved" } },
  timeoutSeconds: {
    type: "number",
    doc: "Longest the node may run, in seconds (any kind); the supervisor stops it after that. Unset = no limit (Shell command: 30 min); 0 = no limit. Script and integration blocks also keep their own time limits",
    example: 3600,
  },
  integration: {
    type: "object",
    kinds: ["integration"],
    doc: "{options: {<option id>: value}}: values for the harness action's options (merged into the block's); ref/action/exits come with the block",
    example: { options: { workflow: "quick" } },
  },
  checks: {
    type: "object",
    kinds: ["auto"],
    doc:
      "Checks block: {commands: [{name, run, required? (default true), timeoutSeconds? (default 600)}], reuse? (default true)}. Runs each command in the run's worktree; " +
      "leaves through exit 'pass' (every required check passed) or 'fail' (the failures' output becomes the steer — wire fail to a fix step). Replaces the command list as a whole",
    example: { commands: [{ name: "lint", run: "npm run lint" }, { name: "tests", run: "npm test" }] },
  },
  verdict: {
    type: "boolean",
    kinds: ["ai"],
    doc: "Makes an agent a gate: it must answer <verdict>PASS</verdict> or <verdict>FAIL</verdict> and the node leaves through exit 'pass' or 'fail' (no verdict = fail)",
    example: true,
  },
  devServer: {
    type: "object",
    kinds: ["ai"],
    doc: "{command, readyUrl?, startupTimeoutSeconds? (default 60)}: a dev server started in the worktree before the agent and stopped after it (for an AI tester)",
    example: { command: "npm run dev", readyUrl: "http://127.0.0.1:5173/" },
  },
  skipDocsOnly: {
    type: "boolean",
    kinds: ["ai"],
    doc: "With verdict: when the branch only changed docs (Markdown, docs/, README…), pass without running the agent",
    example: true,
  },
  onFail: {
    type: "string",
    kinds: ["ai", "auto"],
    doc:
      "Gates (Checks, verdict agents): what a failure does — note (reported, counts as PASS) | retry (default: exit 'fail') | " +
      "block (exit 'fail', or 'pass' when nothing is wired to fail; Create MR refuses until this gate passes) | stop (the run fails). " +
      "A check's own onFail overrides it; a Checks block takes the most severe level among its failed checks",
    example: "block",
  },
};

const FIELD_NAMES = Object.keys(CONFIG_FIELDS) as (keyof BlockConfig)[];

/** Fields worth setting on a node of this kind. */
export function fieldsFor(kind: BlockKind, forNode = true): (keyof BlockConfig)[] {
  const ok = FIELD_NAMES.filter((k) => {
    const f = CONFIG_FIELDS[k];
    if (forNode && ["kind", "color", "icon", "description", "autoAction"].includes(k)) return false;
    return !f.kinds || f.kinds.includes(kind);
  });
  // Kind-specific settings first; the generic ones (inputs, outputs, env…) after.
  return [...ok.filter((k) => CONFIG_FIELDS[k].kinds), ...ok.filter((k) => !CONFIG_FIELDS[k].kinds)];
}

// ---------- finding blocks ----------

function distance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}

/** Up to `n` of `options` closest to `word` (by edit distance, or containing it). */
export function closest(word: string, options: string[], n = 3): string[] {
  const w = word.toLowerCase();
  return options
    .map((o) => {
      const l = o.toLowerCase();
      const tail = l.slice(l.lastIndexOf("/") + 1);
      const score = l.includes(w) || (w.length > 2 && w.includes(tail)) ? 0 : Math.min(distance(w, l), distance(w, tail));
      return { o, score };
    })
    .filter((x) => x.score <= Math.max(2, Math.floor(w.length / 3)))
    .sort((a, b) => a.score - b.score)
    .slice(0, n)
    .map((x) => x.o);
}

/**
 * Find a block by a loose reference: its exact id, its id without the pack prefix (`plan` → `base/plan`) or its
 * display name (`Shell command`), case-insensitively. Throws with suggestions when nothing (or several) match.
 */
export function findBlock(ref: unknown, blocks: BlockDef[]): BlockDef {
  const r = typeof ref === "string" ? ref.trim() : "";
  if (!r) throw new Error('"block" is required: a block id from list_blocks, e.g. "base/plan"');
  const exact = blocks.find((b) => b.id === r);
  if (exact) return exact;
  const l = r.toLowerCase();
  const byId = blocks.filter((b) => b.id.toLowerCase() === l || b.id.toLowerCase().endsWith(`/${l}`));
  if (byId.length === 1) return byId[0];
  const byName = blocks.filter((b) => b.name.toLowerCase() === l);
  if (!byId.length && byName.length === 1) return byName[0];
  const several = byId.length > 1 ? byId : byName;
  if (several.length > 1) throw new Error(`Block "${r}" is ambiguous — use the full id: ${several.map((b) => b.id).join(", ")}`);
  const near = closest(r, [...blocks.map((b) => b.id), ...blocks.map((b) => b.name)]).map((x) => blocks.find((b) => b.id === x || b.name === x)!.id);
  const hint = [...new Set(near)];
  throw new Error(`Unknown block "${r}".${hint.length ? ` Did you mean ${hint.map((h) => `"${h}"`).join(" or ")}?` : ""} list_blocks shows every block id`);
}

// ---------- validating overrides / configs ----------

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

function typeProblem(type: FieldType, v: unknown): string | undefined {
  switch (type) {
    case "string":
      return typeof v === "string" ? undefined : "must be a string";
    case "boolean":
      return typeof v === "boolean" ? undefined : "must be true or false";
    case "number":
      return typeof v === "number" && Number.isFinite(v) ? undefined : "must be a number";
    case "string[]":
      return Array.isArray(v) && v.every((x) => typeof x === "string") ? undefined : "must be an array of strings";
    case "array":
      return Array.isArray(v) ? undefined : "must be an array";
    case "object":
      return isObj(v) ? undefined : "must be an object";
  }
}

function keysProblem(name: string, v: Record<string, unknown>, allowed: string[], type: "boolean" | undefined): string | undefined {
  for (const [k, x] of Object.entries(v)) {
    if (!allowed.includes(k)) return `${name}.${k} isn't a field. Use: ${allowed.join(", ")}`;
    if (type === "boolean" && typeof x !== "boolean") return `${name}.${k} must be true or false`;
  }
  return undefined;
}

/**
 * Field-specific problems with a partial BlockConfig (node overrides when `forNode`, or a block's config).
 * `kind` = the kind of the block it applies to. Returns one message per problem, each naming the field.
 */
export function configProblems(cfg: unknown, kind: BlockKind, forNode = true): string[] {
  const where = forNode ? "overrides" : "config";
  if (cfg === undefined || cfg === null) return [];
  if (!isObj(cfg)) return [`${where} must be an object, e.g. {"extraInstructions": "…"}`];
  const out: string[] = [];
  // A block config may set its own kind; its other fields are checked against that.
  const effectiveKind = !forNode && typeof cfg.kind === "string" ? (cfg.kind as BlockKind) : kind;
  for (const [key, v] of Object.entries(cfg)) {
    const name = `${where}.${key}`;
    const f = CONFIG_FIELDS[key as keyof BlockConfig];
    if (!f) {
      const near = closest(key, FIELD_NAMES as string[], 2);
      out.push(`${name} isn't a block setting.${near.length ? ` Did you mean ${near.join(" or ")}?` : ""} Settable on ${effectiveKind} blocks: ${fieldsFor(effectiveKind, forNode).join(", ")}`);
      continue;
    }
    if (v === undefined) continue;
    if (forNode && key === "kind") {
      out.push(`${name}: a node can't change its block's kind — place a ${String(v)} block instead`);
      continue;
    }
    if (f.kinds && !f.kinds.includes(effectiveKind)) {
      out.push(`${name} only applies to ${f.kinds.join("/")} blocks, and this block is ${effectiveKind}. Settable here: ${fieldsFor(effectiveKind, forNode).join(", ")}`);
      continue;
    }
    const tp = typeProblem(f.type, v);
    if (tp) {
      out.push(`${name} ${tp}${f.example !== undefined ? `, e.g. ${JSON.stringify(f.example)}` : ""}`);
      continue;
    }
    const p = valueProblem(key as keyof BlockConfig, v);
    if (p) out.push(`${name}: ${p}`);
  }
  return out;
}

const levelProblem = (v: unknown) => (GATE_LEVELS.includes(v as GateFailLevel) ? undefined : `unknown level "${v}". Use one of: ${GATE_LEVELS.join(", ")}`);

function valueProblem(key: keyof BlockConfig, v: unknown): string | undefined {
  switch (key) {
    case "kind": {
      const kinds: BlockKind[] = ["auto", "ai", "manager", "trigger", "condition", "script", "subflow", "stack", "flow-input", "flow-output", "integration"];
      return kinds.includes(v as BlockKind) ? undefined : `unknown kind "${v}". Use one of: ${kinds.join(", ")}`;
    }
    case "inputs":
      return keysProblem("inputs", v as Record<string, unknown>, ["artifact", "steer", "startingPrompt"], "boolean");
    case "outputs":
      return keysProblem("outputs", v as Record<string, unknown>, ["artifact", "steer"], "boolean");
    case "env": {
      const bad = (v as string[]).find((n) => !ENV_NAME_RE.test(n));
      return bad === undefined ? undefined : `"${bad}" isn't a valid env var name (letters, digits and _, not starting with a digit)`;
    }
    case "autoAction":
      return ["create-task", "create-mr", "shell", "post-comment"].includes(v as string) ? undefined : `unknown action "${v}". Use create-task, create-mr, shell or post-comment`;
    case "maxIterations":
      return Number.isInteger(v) && (v as number) > 0 ? undefined : "must be a positive whole number";
    case "timeoutSeconds":
      return typeof v === "number" && Number.isFinite(v) && v >= 0 ? undefined : "must be a number of seconds (0 = no limit)";
    case "onFail":
      return levelProblem(v);
    case "checks": {
      const cmds = (v as { commands?: unknown }).commands;
      const bad = Array.isArray(cmds) ? cmds.find((c) => isObj(c) && c.onFail !== undefined && levelProblem(c.onFail)) : undefined;
      return bad ? `commands[].onFail: ${levelProblem((bad as Record<string, unknown>).onFail)}` : undefined;
    }
    case "agent": {
      const a = v as Record<string, unknown>;
      if (a.provider !== undefined && !AGENT_PROVIDERS.includes(a.provider as never)) return `unknown provider "${a.provider}". Use one of: ${AGENT_PROVIDERS.join(", ")}`;
      if (a.effort !== undefined && !["low", "medium", "high", "xhigh", "max"].includes(a.effort as string)) return `unknown effort "${a.effort}". Use low, medium, high, xhigh or max`;
      for (const k of ["model", "endpoint", "endpointEnv"]) if (a[k] !== undefined && typeof a[k] !== "string") return `agent.${k} must be a string`;
      return undefined;
    }
    case "skills":
      for (const s of v as unknown[]) {
        if (!isObj(s) || typeof s.name !== "string") return `each skill needs at least {name, source: "owner/repo"}`;
        const p = skillProblem(s as never);
        if (p) return `skill "${s.name}" — ${p}`;
      }
      return undefined;
    case "trigger": {
      const t = v as Record<string, unknown>;
      if (t.events !== undefined && !Array.isArray(t.events)) return `trigger.events must be an array, e.g. ["merge_request.comment"]`;
      if (t.pollSeconds !== undefined && typeof t.pollSeconds !== "number") return "trigger.pollSeconds must be a number";
      if (t.schedule !== undefined && !isObj(t.schedule)) return `trigger.schedule must be an object, e.g. {"kind":"cron","expr":"0 0 9 * * 1-5"}`;
      return validateTrigger(t as never);
    }
    case "condition": {
      const c = v as Record<string, unknown>;
      if (!Array.isArray(c.rules)) return `needs a rules array, e.g. ${JSON.stringify(CONFIG_FIELDS.condition.example)}`;
      return validateCondition({ match: (c.match ?? "all") as "all", rules: c.rules as never });
    }
    case "script": {
      const s = v as Record<string, unknown>;
      if (s.run !== undefined && typeof s.run !== "string") return "script.run must be a string (a shell command)";
      if (s.where !== undefined && s.where !== "sandbox" && s.where !== "host") return 'script.where must be "sandbox" or "host"';
      if (s.exits !== undefined && (!Array.isArray(s.exits) || s.exits.some((x) => typeof x !== "string" || !EXIT_NAME_RE.test(x)))) {
        return "script.exits must be names (letters, digits, _ and -)";
      }
      if (s.timeoutSeconds !== undefined && !((s.timeoutSeconds as number) > 0)) return "script.timeoutSeconds must be a positive number";
      return undefined;
    }
    case "integration": {
      const x = v as Record<string, unknown>;
      for (const k of ["ref", "action"]) if (x[k] !== undefined && typeof x[k] !== "string") return `integration.${k} must be a string`;
      if (x.exits !== undefined && (!Array.isArray(x.exits) || x.exits.some((e) => typeof e !== "string" || !EXIT_NAME_RE.test(e)))) return "integration.exits must be names (letters, digits, _ and -)";
      if (x.options !== undefined) {
        if (!isObj(x.options)) return `integration.options must be an object, e.g. ${JSON.stringify(CONFIG_FIELDS.integration.example)}`;
        const bad = Object.entries(x.options).find(([, o]) => !["string", "number", "boolean"].includes(typeof o));
        if (bad) return `integration.options.${bad[0]} must be a string, number or boolean`;
      }
      return undefined;
    }
    case "subflow":
      return (v as { flowId?: unknown }).flowId === undefined || typeof (v as { flowId?: unknown }).flowId === "string" ? undefined : "subflow.flowId must be a flow id string";
    case "flowOutput": {
      const n = (v as { name?: unknown }).name;
      return n === undefined || (typeof n === "string" && EXIT_NAME_RE.test(n)) ? undefined : "flowOutput.name must be letters, digits, _ and -";
    }
    default:
      return undefined;
  }
}

/** Settings a placed block still needs before it does anything useful (each names the override to set). */
export function configGaps(cfg: ResolvedConfig): string[] {
  const gaps: string[] = [];
  if (cfg.kind === "auto" && cfg.autoAction === "shell" && !cfg.shellCommand.trim()) gaps.push('no command — set overrides.shellCommand, e.g. "npm test"');
  if (cfg.kind === "condition" && !cfg.condition.rules.length) gaps.push("no rules, so it's always false — set overrides.condition");
  if (cfg.kind === "trigger") {
    const t = cfg.trigger;
    if (t.type === "schedule" && !t.schedule) gaps.push('no schedule — set overrides.trigger.schedule, e.g. {"kind":"cron","expr":"0 0 9 * * 1-5"}');
    if ((t.type === "github" || t.type === "gitlab") && t.mode === "poll" && !t.repo?.trim()) gaps.push("polls but has no repository — set overrides.trigger.repo");
  }
  if (cfg.kind === "script" && !cfg.script.run.trim()) gaps.push("no command — set overrides.script.run");
  if (AGENTS.includes(cfg.kind) && !cfg.instructions.trim() && !cfg.extraInstructions.trim()) gaps.push("no instructions — set overrides.instructions");
  return gaps;
}

// ---------- describing one block ----------

const clip = (s: string, n = 240) => (s.length > n ? `${s.slice(0, n)}…` : s);
const ioList = (io: object) =>
  Object.entries(io)
    .filter(([, v]) => v)
    .map(([k]) => (k === "startingPrompt" ? "starting prompt" : k))
    .join(", ") || "-";

/** A ready-to-use add_node op for this block, with the override it most likely needs. */
export function exampleOp(b: BlockDef, cfg: ResolvedConfig): Record<string, unknown> {
  const tail = b.id.slice(b.id.lastIndexOf("/") + 1).replace(/^tpl-/, "");
  const op: Record<string, unknown> = { op: "add_node", id: tail, block: b.id };
  if (cfg.kind !== "trigger" && cfg.kind !== "flow-input") op.from = "<previous node id>";
  let ov: Record<string, unknown> | undefined;
  switch (cfg.kind) {
    case "ai":
    case "manager":
      ov = cfg.instructions.trim() ? { extraInstructions: "<what this step should do differently>" } : { instructions: "<the agent's role and what to output>" };
      break;
    case "auto":
      if (cfg.autoAction === "shell") ov = { shellCommand: "npm test" };
      break;
    case "trigger":
      if (cfg.trigger.type === "schedule") ov = { trigger: { schedule: { kind: "cron", expr: "0 0 9 * * 1-5" } } };
      else if (cfg.trigger.type === "github" || cfg.trigger.type === "gitlab") ov = { trigger: { repo: cfg.trigger.type === "github" ? "owner/repo" : "group/project" } };
      break;
    case "condition":
      ov = { condition: CONFIG_FIELDS.condition.example };
      break;
    case "script":
      ov = { script: { run: cfg.script.run || "python scripts/report.py" } };
      break;
    case "subflow":
      ov = { subflow: { flowId: "<flow id from list_flows>" } };
      break;
    case "stack":
      ov = { stack: { flowId: "<flow id from list_flows>" } };
      break;
    case "flow-output":
      ov = { flowOutput: { name: "done" } };
      break;
  }
  if (ov) op.overrides = ov;
  return op;
}

/** Everything an agent needs to place and configure one block. */
export function describeBlock(b: BlockDef, blocks: BlockDef[]): string {
  const cfg = resolveBlock(b.id, blocks);
  const chain = templateChain(b.id, blocks).map((x) => x.id);
  const lines = [`${b.id} — ${b.name}${b.isTemplate ? " (template: can be placed or extended with save_block)" : ""}${b.pack ? ` [pack ${b.pack}]` : " [your block]"}`];
  lines.push(`Kind: ${cfg.kind}${cfg.kind === "auto" ? ` (action ${cfg.autoAction})` : ""}${chain.length > 1 ? `. Inherits: ${chain.join(" → ")}` : ""}`);
  if (cfg.description) lines.push(cfg.description);
  const named = cfg.kind === "script" ? cfg.script.exits : cfg.kind === "integration" ? cfg.integration.exits : [];
  const outs = cfg.kind === "condition" ? "true, false" : named.length ? named.map((x) => `exit:${x}`).join(", ") : cfg.kind === "subflow" ? "exit:<name> per Flow output of the flow it runs" : ioList(cfg.outputs);
  lines.push(`In: ${ioList(cfg.inputs)}. Out: ${outs}.`);
  lines.push(`Env vars (names the user fills in): ${cfg.env.join(", ") || "none"}`);

  const current: string[] = [];
  if (AGENTS.includes(cfg.kind)) {
    if (cfg.instructions) current.push(`instructions: ${JSON.stringify(clip(cfg.instructions))}`);
    if (cfg.extraInstructions) current.push(`extraInstructions: ${JSON.stringify(clip(cfg.extraInstructions))}`);
    current.push(`agent: ${JSON.stringify(cfg.agent)}`, `maxIterations: ${cfg.maxIterations}`, `allowQuestions: ${cfg.allowQuestions}`);
    if (cfg.skills.length) current.push(`skills: ${cfg.skills.map((s) => s.name).join(", ")}`);
  }
  if (cfg.kind === "auto" && cfg.autoAction === "shell") current.push(`shellCommand: ${JSON.stringify(cfg.shellCommand)}`);
  if (cfg.kind === "trigger") current.push(`trigger: ${JSON.stringify(cfg.trigger)}`);
  if (cfg.kind === "condition") current.push(`condition: ${JSON.stringify(cfg.condition)}`);
  if (cfg.kind === "script") current.push(`script: ${JSON.stringify(cfg.script)}`);
  if (cfg.kind === "flow-output") current.push(`flowOutput: ${JSON.stringify(cfg.flowOutput)}`);
  if (cfg.kind === "integration") current.push(`integration: ${JSON.stringify(cfg.integration)}`);
  if (current.length) lines.push("", "Defaults:", ...current.map((c) => `- ${c}`));

  const gaps = configGaps(cfg);
  if (gaps.length && cfg.kind !== "subflow") lines.push("", "Needs setting when placed:", ...gaps.map((g) => `- ${g}`));
  if (cfg.kind === "subflow") lines.push("", "Needs setting when placed:", '- which flow to run — set overrides.subflow.flowId');

  lines.push("", "Node overrides you can set (only what differs; everything else is inherited):");
  for (const k of fieldsFor(cfg.kind)) {
    const f = CONFIG_FIELDS[k];
    lines.push(`- ${k} (${f.type}): ${f.doc}${f.example !== undefined ? ` e.g. ${JSON.stringify(f.example)}` : ""}`);
  }
  lines.push("", "Example edit_flow op:", JSON.stringify(exampleOp(b, cfg)));
  return lines.join("\n");
}
