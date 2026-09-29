// Deterministic If-block logic, shared by the engine and the editor (for previews / validation).

import type { ConditionOp, ConditionRule, ConditionSpec, TriggerEvent } from "./types";

export interface ConditionData {
  /** The block's input artifact. */
  text?: string;
  steer?: string;
  trigger?: TriggerEvent;
}

export const CONDITION_OPS: { op: ConditionOp; label: string; needsValue: boolean }[] = [
  { op: "equals", label: "equals", needsValue: true },
  { op: "not_equals", label: "does not equal", needsValue: true },
  { op: "contains", label: "contains", needsValue: true },
  { op: "not_contains", label: "does not contain", needsValue: true },
  { op: "starts_with", label: "starts with", needsValue: true },
  { op: "ends_with", label: "ends with", needsValue: true },
  { op: "matches", label: "matches regex", needsValue: true },
  { op: "in", label: "is one of", needsValue: true },
  { op: "gt", label: ">", needsValue: true },
  { op: "lt", label: "<", needsValue: true },
  { op: "exists", label: "exists", needsValue: false },
  { op: "not_exists", label: "does not exist", needsValue: false },
  { op: "is_true", label: "is true", needsValue: false },
  { op: "is_false", label: "is false", needsValue: false },
];

const SYMBOL: Partial<Record<ConditionOp, string>> = { equals: "=", not_equals: "≠", gt: ">", lt: "<" };

/** Fields offered in the editor (free text is allowed too). */
export const CONDITION_FIELDS = [
  "trigger.author",
  "trigger.body",
  "trigger.title",
  "trigger.type",
  "trigger.labels",
  "trigger.branch",
  "trigger.repo",
  "text",
  "steer",
];

function lookup(obj: unknown, path: string[]): unknown {
  let cur = obj;
  for (const key of path) {
    if (cur === null || cur === undefined) return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

function tryJson(text: string | undefined): unknown {
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Resolve a dotted field path against the input + trigger event. */
export function readField(field: string, data: ConditionData): unknown {
  const [head, ...rest] = field.trim().split(".");
  switch (head) {
    case "text":
      return data.text;
    case "steer":
      return data.steer;
    case "json":
      return lookup(tryJson(data.text), rest);
    case "trigger":
      return lookup(data.trigger, rest);
    default:
      return undefined;
  }
}

const str = (v: unknown) => (v === null || v === undefined ? "" : typeof v === "object" ? JSON.stringify(v) : String(v));

function evalRule(rule: ConditionRule, data: ConditionData): boolean {
  const actual = readField(rule.field, data);
  const cs = rule.caseSensitive === true;
  const norm = (s: string) => (cs ? s : s.toLowerCase());
  const value = rule.value ?? "";
  const list = () => value.split(/[,\n]/).map((s) => norm(s.trim())).filter(Boolean);
  const num = (v: unknown) => (typeof v === "number" ? v : Number(String(v).trim()));

  switch (rule.op) {
    case "exists":
      return actual !== undefined && actual !== null && actual !== "";
    case "not_exists":
      return actual === undefined || actual === null || actual === "";
    case "is_true":
      return actual === true || norm(str(actual)) === "true";
    case "is_false":
      return actual === false || norm(str(actual)) === "false";
    case "gt":
    case "lt": {
      const a = num(actual);
      const b = num(value);
      if (Number.isNaN(a) || Number.isNaN(b) || actual === undefined || actual === "") return false;
      return rule.op === "gt" ? a > b : a < b;
    }
    case "matches":
      try {
        return new RegExp(value, cs ? "" : "i").test(str(actual));
      } catch {
        return false;
      }
    case "in":
      return list().includes(norm(str(actual)));
  }

  // Arrays (e.g. labels): string ops apply to any element.
  if (Array.isArray(actual)) {
    const items = actual.map((x) => norm(str(x)));
    const v = norm(value);
    switch (rule.op) {
      case "contains":
      case "equals":
        return items.includes(v);
      case "not_contains":
      case "not_equals":
        return !items.includes(v);
      default:
        return items.some((i) => (rule.op === "starts_with" ? i.startsWith(v) : i.endsWith(v)));
    }
  }

  const a = norm(str(actual));
  const v = norm(value);
  switch (rule.op) {
    case "equals":
      return a === v;
    case "not_equals":
      return a !== v;
    case "contains":
      return a.includes(v);
    case "not_contains":
      return !a.includes(v);
    case "starts_with":
      return a.startsWith(v);
    case "ends_with":
      return a.endsWith(v);
  }
  return false;
}

export interface ConditionResult {
  result: boolean;
  rules: { rule: ConditionRule; passed: boolean; actual: unknown }[];
}

/** Evaluate; an empty rule list is false so nothing continues by accident. */
export function evaluateCondition(spec: ConditionSpec, data: ConditionData): ConditionResult {
  const rules = spec.rules.map((rule) => ({ rule, passed: evalRule(rule, data), actual: readField(rule.field, data) }));
  if (!rules.length) return { result: false, rules };
  const result = spec.match === "any" ? rules.some((r) => r.passed) : rules.every((r) => r.passed);
  return { result, rules };
}

export function validateCondition(spec: ConditionSpec | undefined): string | undefined {
  if (!spec || !Array.isArray(spec.rules)) return "Missing condition";
  if (spec.match !== "all" && spec.match !== "any") return "Match must be all or any";
  for (const [i, r] of spec.rules.entries()) {
    const n = `Rule ${i + 1}`;
    if (!r.field?.trim()) return `${n}: choose a field`;
    const op = CONDITION_OPS.find((o) => o.op === r.op);
    if (!op) return `${n}: unknown operator "${r.op}"`;
    if (r.op === "matches") {
      try {
        new RegExp(r.value ?? "");
      } catch {
        return `${n}: invalid regex`;
      }
    }
    if ((r.op === "gt" || r.op === "lt") && Number.isNaN(Number((r.value ?? "").trim() || "x"))) {
      return `${n}: value must be a number`;
    }
  }
  return undefined;
}

export function describeCondition(spec: ConditionSpec | undefined): string {
  if (!spec?.rules.length) return "No rules (always false)";
  return spec.rules
    .map((r) => {
      const op = CONDITION_OPS.find((o) => o.op === r.op);
      const sym = SYMBOL[r.op] ?? op?.label ?? r.op;
      return op?.needsValue ? `${r.field} ${sym} "${r.value ?? ""}"` : `${r.field} ${sym}`;
    })
    .join(spec.match === "any" ? " OR " : " AND ");
}
