import { describe, expect, it } from "vitest";
import { describeCondition, evaluateCondition, validateCondition } from "../shared/conditions";
import type { ConditionSpec, TriggerEvent } from "../shared/types";

const trigger: TriggerEvent = {
  source: "gitlab",
  type: "merge_request.comment",
  author: "ofek",
  body: "Hey @sandflow what does this function do?",
  number: 12,
  labels: ["backend", "urgent"],
  firedAt: 0,
  raw: { object_attributes: { noteable_type: "MergeRequest" }, user: { id: 42 } },
};
const data = { text: '{"score": 7, "verdict": "APPROVED"}', trigger };

const run = (spec: ConditionSpec) => evaluateCondition(spec, data);

describe("conditions", () => {
  it("matches the MR-comment example: author is X AND the magic word is present", () => {
    const spec: ConditionSpec = {
      match: "all",
      rules: [
        { field: "trigger.author", op: "equals", value: "ofek" },
        { field: "trigger.body", op: "contains", value: "@SANDFLOW" },
      ],
    };
    expect(run(spec)).toMatchObject({ result: true });
    expect(evaluateCondition(spec, { trigger: { ...trigger, author: "mallory" } }).result).toBe(false);
    expect(evaluateCondition(spec, { trigger: { ...trigger, body: "no magic here" } }).result).toBe(false);
  });

  it("supports any/all and reports per-rule results", () => {
    const spec: ConditionSpec = {
      match: "any",
      rules: [
        { field: "trigger.author", op: "equals", value: "nobody" },
        { field: "trigger.labels", op: "contains", value: "urgent" },
      ],
    };
    const r = run(spec);
    expect(r.result).toBe(true);
    expect(r.rules.map((x) => x.passed)).toEqual([false, true]);
  });

  it("reads JSON artifacts, raw payloads and numbers", () => {
    expect(run({ match: "all", rules: [{ field: "json.score", op: "gt", value: "5" }] }).result).toBe(true);
    expect(run({ match: "all", rules: [{ field: "json.verdict", op: "in", value: "APPROVED, MERGED" }] }).result).toBe(true);
    expect(run({ match: "all", rules: [{ field: "trigger.raw.user.id", op: "equals", value: "42" }] }).result).toBe(true);
    expect(run({ match: "all", rules: [{ field: "trigger.number", op: "lt", value: "10" }] }).result).toBe(false);
  });

  it("handles regex, case sensitivity, existence and booleans", () => {
    expect(run({ match: "all", rules: [{ field: "trigger.body", op: "matches", value: "what (does|is)" }] }).result).toBe(true);
    expect(run({ match: "all", rules: [{ field: "trigger.body", op: "contains", value: "HEY", caseSensitive: true }] }).result).toBe(false);
    expect(run({ match: "all", rules: [{ field: "trigger.branch", op: "not_exists" }] }).result).toBe(true);
    expect(run({ match: "all", rules: [{ field: "trigger.author", op: "exists" }] }).result).toBe(true);
    expect(evaluateCondition({ match: "all", rules: [{ field: "json.ok", op: "is_true" }] }, { text: '{"ok": true}' }).result).toBe(true);
    expect(run({ match: "all", rules: [{ field: "text", op: "starts_with", value: "{" }] }).result).toBe(true);
  });

  it("an empty rule list is false (never continue by accident)", () => {
    expect(run({ match: "all", rules: [] }).result).toBe(false);
    expect(run({ match: "any", rules: [] }).result).toBe(false);
  });

  it("validates rules", () => {
    expect(validateCondition({ match: "all", rules: [{ field: "", op: "equals" }] })).toMatch(/field/i);
    expect(validateCondition({ match: "all", rules: [{ field: "text", op: "matches", value: "(" }] })).toMatch(/regex/i);
    expect(validateCondition({ match: "all", rules: [{ field: "text", op: "bogus" as never }] })).toMatch(/operator/i);
    expect(validateCondition({ match: "all", rules: [{ field: "text", op: "gt", value: "x" }] })).toMatch(/number/i);
    expect(validateCondition({ match: "all", rules: [{ field: "trigger.author", op: "equals", value: "x" }] })).toBeUndefined();
  });

  it("describes a condition", () => {
    expect(
      describeCondition({
        match: "all",
        rules: [
          { field: "trigger.author", op: "equals", value: "ofek" },
          { field: "trigger.body", op: "contains", value: "@sandflow" },
        ],
      }),
    ).toBe('trigger.author = "ofek" AND trigger.body contains "@sandflow"');
  });
});
