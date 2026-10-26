// Integrations: other harnesses (CLIs that run a whole pipeline themselves, e.g. MEOW) driven from a flow.
//
// An integration is data — `integrations/<id>.json` in a pack, or one of your own — describing the harness's
// executable and its actions. Each action becomes an `integration` block; its options become fields on the node,
// and turn into command-line arguments through small templates. Nothing here runs anything: the runner
// (backend/runners/integration.ts) spawns the command, without a shell, on this machine.

import { LOCAL_PACK, PACK_ID_RE, PACK_ITEM_ID_RE } from "./packs";
import { ENV_NAME_RE } from "./resolve";
import { EXIT_NAME_RE } from "./subflow";
import type {
  BlockDef,
  IntegrationAction,
  IntegrationChoice,
  IntegrationDef,
  IntegrationInfo,
  IntegrationOption,
  IntegrationValue,
} from "./types";

/** Pack id your own integrations' blocks live under (`local/meow-run`). Reserved: no pack can use it. */
export const LOCAL_INTEGRATIONS = LOCAL_PACK;
export const INTEGRATION_COLOR = "#0ea5e9";
export const DEFAULT_INTEGRATION_TIMEOUT_S = 4 * 60 * 60;
const OPTION_TYPES = ["string", "text", "boolean", "number", "select", "args"] as const;
const COMMAND_RE = /^[\w.+-]{1,64}$/;

/** `base/meow` → `meow`. */
const localPart = (id: string) => (id.includes("/") ? id.slice(id.indexOf("/") + 1) : id);

/** Block id of an action: `<pack>/<integration>-<action>`. */
export const integrationBlockId = (integrationId: string, actionId: string) => `${integrationId}-${actionId}`;

/** Env var that points at a specific executable: `meow` → `SANDFLOW_MEOW_PATH`. */
export const commandPathEnv = (command: string) => `SANDFLOW_${command.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_PATH`;

/** Options an action shows: its own, then the integration's shared ones (an action's option wins on the same id). */
export function actionOptions(def: IntegrationDef, action: IntegrationAction): IntegrationOption[] {
  const own = action.options ?? [];
  return [...own, ...(def.options ?? []).filter((o) => !own.some((x) => x.id === o.id))];
}

/** Named exits of an action (exit-code exits, then the fail exit). Empty = plain outputs. */
export function actionExits(action: IntegrationAction): string[] {
  return [...new Set([...Object.values(action.exitCodes ?? {}), ...(action.failExit ? [action.failExit] : [])])];
}

export const choiceOf = (c: string | IntegrationChoice): IntegrationChoice => (typeof c === "string" ? { value: c } : c);

function regexProblem(src: unknown, what: string): string | undefined {
  if (typeof src !== "string") return `${what} must be a regex string`;
  try {
    new RegExp(src, "m");
    return undefined;
  } catch (e) {
    return `${what}: invalid regex (${(e as Error).message})`;
  }
}

const isStringList = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");

function optionProblems(o: IntegrationOption | undefined, where: string): string[] {
  if (!o || typeof o !== "object") return [`${where}: each option must be an object`];
  const errors: string[] = [];
  const at = `${where} option "${o.id}"`;
  if (typeof o.id !== "string" || !/^[A-Za-z_][\w-]{0,40}$/.test(o.id)) errors.push(`${where}: option id ${JSON.stringify(o.id)} must be letters, digits, _ and -`);
  if (typeof o.label !== "string" || !o.label.trim()) errors.push(`${at} needs a label`);
  if (!OPTION_TYPES.includes(o.type)) errors.push(`${at}: type must be one of ${OPTION_TYPES.join(", ")}`);
  if (o.args !== undefined && !isStringList(o.args)) errors.push(`${at}: args must be a list of strings`);
  if (o.choices !== undefined) {
    if (!Array.isArray(o.choices) || !o.choices.every((c) => typeof c === "string" || (c && typeof c.value === "string")))
      errors.push(`${at}: choices must be strings or {value, label}`);
  }
  if (o.choicesFrom !== undefined) {
    if (!o.choicesFrom || !isStringList(o.choicesFrom.args)) errors.push(`${at}: choicesFrom.args must be a list of strings`);
    else if (o.choicesFrom.pattern !== undefined) {
      const bad = regexProblem(o.choicesFrom.pattern, `${at} choicesFrom.pattern`);
      if (bad) errors.push(bad);
    }
  }
  if (o.type === "args" && o.args !== undefined && !o.args.some((a) => /\{\{\s*value\s*\}\}/.test(a))) errors.push(`${at}: an "args" option's args must use {{value}}`);
  if ((o.choices || o.choicesFrom) && o.type !== "select") errors.push(`${at}: choices only apply to type "select"`);
  if (o.default !== undefined && !["string", "number", "boolean"].includes(typeof o.default)) errors.push(`${at}: default must be a string, number or boolean`);
  return errors;
}

/** Problems with an integration definition (empty = valid). */
export function integrationProblems(d: unknown): string[] {
  if (!d || typeof d !== "object" || Array.isArray(d)) return ["an integration must be a JSON object"];
  const x = d as Partial<IntegrationDef>;
  const errors: string[] = [];
  if (typeof x.id !== "string" || !PACK_ID_RE.test(x.id)) errors.push(`"id" must be lowercase letters, digits and dashes (got ${JSON.stringify(x.id)})`);
  if (typeof x.name !== "string" || !x.name.trim()) errors.push(`"name" is required`);
  if (typeof x.command !== "string" || !COMMAND_RE.test(x.command)) {
    errors.push(`"command" must be an executable name like "meow" — no paths or spaces (set ${commandPathEnv(String(x.command ?? "name"))} to use a specific file)`);
  }
  if (x.env !== undefined && !(isStringList(x.env) && x.env.every((n) => ENV_NAME_RE.test(n)))) errors.push(`"env" must be a list of env var names`);
  if (x.detect !== undefined) {
    if (!x.detect || !isStringList(x.detect.args)) errors.push(`"detect.args" must be a list of strings`);
    else if (x.detect.pattern !== undefined) {
      const bad = regexProblem(x.detect.pattern, `"detect.pattern"`);
      if (bad) errors.push(bad);
    }
  }
  if (x.install !== undefined && (!x.install || typeof x.install !== "object")) errors.push(`"install" must be an object`);
  if (x.install?.commands !== undefined && (typeof x.install.commands !== "object" || !Object.values(x.install.commands).every((c) => typeof c === "string"))) {
    errors.push(`"install.commands" must map platforms to command strings`);
  }
  const shared = x.options ?? [];
  if (!Array.isArray(shared)) errors.push(`"options" must be a list`);
  else for (const o of shared) errors.push(...optionProblems(o, "integration"));
  if (!Array.isArray(x.actions) || !x.actions.length) {
    errors.push(`"actions" must list at least one action`);
    return errors;
  }
  const seen = new Set<string>();
  for (const a of x.actions) {
    if (!a || typeof a !== "object") {
      errors.push("each action must be an object");
      continue;
    }
    const at = `action "${a.id}"`;
    if (typeof a.id !== "string" || !/^[a-z0-9][a-z0-9-]{0,40}$/.test(a.id)) errors.push(`action id ${JSON.stringify(a.id)} must be lowercase letters, digits and dashes`);
    else if (seen.has(a.id)) errors.push(`duplicate action id "${a.id}"`);
    else seen.add(a.id);
    if (typeof x.id === "string" && typeof a.id === "string" && !PACK_ITEM_ID_RE.test(integrationBlockId(x.id, a.id))) errors.push(`${at}: id too long`);
    if (typeof a.name !== "string" || !a.name.trim()) errors.push(`${at} needs a name`);
    if (!isStringList(a.args)) errors.push(`${at}: args must be a list of strings`);
    if (a.env !== undefined && !(isStringList(a.env) && a.env.every((n) => ENV_NAME_RE.test(n)))) errors.push(`${at}: env must be a list of env var names`);
    if (a.cwd !== undefined && typeof a.cwd !== "string") errors.push(`${at}: cwd must be a string`);
    if (a.artifact !== undefined && typeof a.artifact !== "string") errors.push(`${at}: artifact must be a template string`);
    if (a.timeoutSeconds !== undefined && !(typeof a.timeoutSeconds === "number" && a.timeoutSeconds > 0)) errors.push(`${at}: timeoutSeconds must be a positive number`);
    if (a.exitCodes !== undefined) {
      if (!a.exitCodes || typeof a.exitCodes !== "object") errors.push(`${at}: exitCodes must map exit codes to exit names`);
      else
        for (const [code, name] of Object.entries(a.exitCodes)) {
          if (!/^-?\d+$/.test(code)) errors.push(`${at}: exit code "${code}" isn't a number`);
          if (typeof name !== "string" || !EXIT_NAME_RE.test(name)) errors.push(`${at}: exit name ${JSON.stringify(name)} must be letters, digits, _ and -`);
        }
    }
    if (a.failExit !== undefined && (typeof a.failExit !== "string" || !EXIT_NAME_RE.test(a.failExit))) errors.push(`${at}: failExit must be an exit name`);
    for (const [name, re] of Object.entries(a.matches ?? {})) {
      if (!/^\w+$/.test(name)) errors.push(`${at}: match name "${name}" must be letters, digits and _`);
      const bad = regexProblem(re, `${at} match "${name}"`);
      if (bad) errors.push(bad);
    }
    const own = a.options ?? [];
    if (!Array.isArray(own)) errors.push(`${at}: options must be a list`);
    else {
      for (const o of own) errors.push(...optionProblems(o, at));
      const ids = own.map((o) => o?.id);
      const dup = ids.find((id, i) => ids.indexOf(id) !== i);
      if (dup) errors.push(`${at}: duplicate option "${dup}"`);
    }
  }
  return errors;
}

/** An integration loaded from `pack` (or your own, `local`), with its id qualified. */
export function integrationInfo(def: IntegrationDef, pack: string, trusted: boolean, problems: string[] = []): IntegrationInfo {
  return { id: `${pack}/${localPart(def.id)}`, pack, def, trusted, problems };
}

/** The blocks an integration adds: one per action, in the integration's pack (`base/meow-run`). */
export function integrationBlocks(info: IntegrationInfo): BlockDef[] {
  const { def } = info;
  return def.actions.map((a): BlockDef => ({
    id: integrationBlockId(info.id, a.id),
    name: a.name,
    isTemplate: false,
    pack: info.pack,
    config: {
      kind: "integration",
      description: a.description ?? def.description ?? `Runs ${def.command} ${a.id}`,
      color: def.color ?? INTEGRATION_COLOR,
      icon: a.icon ?? def.icon ?? "plug",
      inputs: { artifact: true, steer: false, startingPrompt: true, ...a.inputs },
      outputs: { artifact: true, steer: false, ...a.outputs },
      env: [...new Set([...(def.env ?? []), ...(a.env ?? [])])],
      integration: { ref: info.id, action: a.id, exits: actionExits(a), options: {} },
    },
  }));
}

// ---------- templates ----------

/** Values a template can use: `input`, `artifact`, `steer`, `prompt`, `env.X`, `option.X`, `run.id`, `worktree`, … */
export type TemplateVars = Record<string, string | undefined>;

const PLACEHOLDER = /\{\{\s*([\w.-]+)\s*\}\}/g;

/** Fill `{{name}}` placeholders; unknown names become empty. */
export function renderTemplate(t: string, vars: TemplateVars): string {
  return t.replace(PLACEHOLDER, (_, name: string) => vars[name] ?? "");
}

/**
 * Split a command line into arguments — whitespace separates, '…' and "…" quote, \ escapes a quote — without
 * expanding anything (no variables, globs or commands). `--label "two words" -v` → `["--label", "two words", "-v"]`.
 */
export function splitArgs(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let started = false;
  let quote: "'" | '"' | undefined;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote === "'") {
      if (c === "'") quote = undefined;
      else cur += c;
    } else if (quote === '"') {
      if (c === '"') quote = undefined;
      else if (c === "\\" && (line[i + 1] === '"' || line[i + 1] === "\\")) cur += line[++i];
      else cur += c;
    } else if (/\s/.test(c)) {
      if (started) out.push(cur);
      cur = "";
      started = false;
    } else {
      started = true;
      if (c === "'" || c === '"') quote = c;
      // Only a quote is escaped, so Windows paths (`C:\repo`) pass through as typed.
      else if (c === "\\" && (line[i + 1] === '"' || line[i + 1] === "'")) cur += line[++i];
      else cur += c;
    }
  }
  if (quote) throw new Error(`Unclosed ${quote} in "${line}"`);
  if (started) out.push(cur);
  return out;
}

const SOLE_PLACEHOLDER = /^\s*\{\{\s*([\w.-]+)\s*\}\}\s*$/;

/**
 * Render one argument template. One that's nothing but a placeholder which came out empty is dropped (an unset
 * optional value); one that's nothing but a placeholder named in `split` (an `args` option) becomes several arguments.
 */
function renderArg(t: string, vars: TemplateVars, split: Set<string>): string[] {
  const sole = SOLE_PLACEHOLDER.exec(t)?.[1];
  if (sole && split.has(sole)) return splitArgs(vars[sole] ?? "");
  const out = renderTemplate(t, vars);
  return out === "" && sole ? [] : [out];
}

/** The value an option has: the node's / block's, else its default. */
export function optionValue(o: IntegrationOption, values: Record<string, IntegrationValue>): IntegrationValue | undefined {
  const v = values[o.id];
  return v === undefined || v === "" ? o.default : v;
}

const isSet = (v: IntegrationValue | undefined) => v !== undefined && v !== "" && v !== false;

/**
 * The argv after the command: the action's args, then each set option's args. `values` are the option values from
 * the block and node; `vars` everything else a template may use. Throws when a required option isn't set.
 */
export function buildArgs(def: IntegrationDef, action: IntegrationAction, values: Record<string, IntegrationValue>, vars: TemplateVars): string[] {
  const options = actionOptions(def, action);
  const optionVars: TemplateVars = {};
  // `args` options are free-form command-line text: split into arguments wherever they stand alone.
  const split = new Set(options.filter((o) => o.type === "args").map((o) => `option.${o.id}`));
  for (const o of options) {
    const v = optionValue(o, values);
    if (o.required && !isSet(v)) throw new Error(`Set "${o.label}" — it's required`);
    if (o.type === "number" && isSet(v) && !Number.isFinite(Number(v))) throw new Error(`"${o.label}" must be a number (got "${v}")`);
    optionVars[`option.${o.id}`] = isSet(v) ? String(v) : undefined;
  }
  const all = { ...vars, ...optionVars };
  const out = action.args.flatMap((t) => renderArg(t, all, split));
  for (const o of options) {
    const v = optionValue(o, values);
    if (!isSet(v)) continue;
    // An `args` option without args of its own is appended as it is — unless the action's args already place it.
    const placed = action.args.some((t) => new RegExp(`\\{\\{\\s*option\\.${o.id}\\s*\\}\\}`).test(t));
    const templates = o.args?.length ? o.args : o.type === "args" && !placed ? ["{{value}}"] : [];
    const own = o.type === "args" ? new Set([...split, "value"]) : split;
    out.push(...templates.flatMap((t) => renderArg(t, { ...all, value: String(v) }, own)));
  }
  return out;
}

/** Pull values out of a harness's output with the action's `matches`. */
export function outputMatches(action: IntegrationAction, text: string): TemplateVars {
  const out: TemplateVars = {};
  for (const [name, src] of Object.entries(action.matches ?? {})) {
    const all = [...text.matchAll(new RegExp(src, "gm"))];
    // The last match: harnesses tend to print the final result (an MR link) at the end.
    const m = all[all.length - 1];
    if (m) out[`match.${name}`] = (m[1] ?? m[0]).trim();
  }
  return out;
}

/** Choices from a harness's output: one per matching line (group 1 = value, group 2 = label). */
export function parseChoices(stdout: string, pattern?: string): IntegrationChoice[] {
  const re = pattern ? new RegExp(pattern) : undefined;
  const out: IntegrationChoice[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const m = re ? re.exec(line) : [line.trim(), line.trim()];
    if (!m) continue;
    const value = (m[1] ?? m[0]).trim();
    if (!value || out.some((c) => c.value === value)) continue;
    const label = m[2]?.trim();
    out.push(label && label !== value ? { value, label } : { value });
  }
  return out;
}

/** First version-like text in a `--version` output (`meow 0.1.20` → `0.1.20`). */
export function parseVersion(text: string, pattern?: string): string | undefined {
  if (pattern) {
    const m = new RegExp(pattern, "m").exec(text);
    return m ? (m[1] ?? m[0]).trim() : undefined;
  }
  return /\bv?(\d+\.\d+(?:\.\d+)?(?:[-+][\w.]+)?)\b/.exec(text)?.[1];
}

/** How to install it on this platform, if the integration says. */
export function installCommand(def: IntegrationDef, platform: string): string | undefined {
  const c = def.install?.commands;
  return c?.[platform] ?? c?.default;
}

/** Is `pack` one whose integrations you wrote yourself? */
export const isLocalIntegrationPack = (pack: string | undefined) => pack === LOCAL_INTEGRATIONS;

/** Starting point for "New integration". */
export function integrationTemplate(): IntegrationDef {
  return {
    id: "my-harness",
    name: "My harness",
    description: "Runs my-harness on this machine.",
    command: "my-harness",
    detect: { args: ["--version"] },
    env: ["REPO_PATH"],
    actions: [
      {
        id: "run",
        name: "My harness: run",
        args: ["run", "{{input}}", "--dir", "{{env.REPO_PATH}}"],
        options: [{ id: "verbose", label: "Verbose", type: "boolean", args: ["--verbose"] }],
        exitCodes: { "0": "done" },
        failExit: "failed",
      },
    ],
  };
}
