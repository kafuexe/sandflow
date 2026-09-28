import { describe, expect, it } from "vitest";
import { BUILTIN_BLOCKS, DEFAULT_FLOW } from "../shared/library";
import { missingInputs, validateBlocks } from "../shared/validate";
import type { BlockDef } from "../shared/types";

describe("validateBlocks", () => {
  it("accepts the builtins", () => {
    expect(validateBlocks(BUILTIN_BLOCKS)).toEqual([]);
  });
  it("rejects duplicate ids", () => {
    expect(validateBlocks([...BUILTIN_BLOCKS, BUILTIN_BLOCKS[0]]).join()).toMatch(/duplicate/i);
  });
  it("rejects extending a non-template", () => {
    const bad: BlockDef = { id: "x", name: "X", isTemplate: false, extends: "plan", config: {} };
    expect(validateBlocks([...BUILTIN_BLOCKS, bad]).join()).toMatch(/not a template/i);
  });
  it("rejects missing parents and cycles", () => {
    const a: BlockDef = { id: "a", name: "A", isTemplate: true, extends: "b", config: {} };
    const b: BlockDef = { id: "b", name: "B", isTemplate: true, extends: "a", config: {} };
    expect(validateBlocks([a, b]).join()).toMatch(/cycle/i);
    const c: BlockDef = { id: "c", name: "C", isTemplate: false, extends: "nope", config: {} };
    expect(validateBlocks([c]).join()).toMatch(/unknown/i);
  });
  it("rejects invalid env names", () => {
    const d: BlockDef = { id: "d", name: "D", isTemplate: false, config: { env: ["BAD-NAME"] } };
    expect(validateBlocks([d]).join()).toMatch(/BAD-NAME/);
  });
});

describe("missingInputs", () => {
  it("lists missing env vars and starting prompt", () => {
    const missing = missingInputs(DEFAULT_FLOW, BUILTIN_BLOCKS, { REPO_PATH: "/r" }, "  ");
    expect(missing).toContain("Starting prompt");
    expect(missing).toContain("ANTHROPIC_API_KEY");
    expect(missing).not.toContain("REPO_PATH");
  });
  it("is empty when all filled", () => {
    const env = Object.fromEntries(
      ["REPO_PATH", "ANTHROPIC_API_KEY", "BRANCH_NAME", "BASE_BRANCH", "MR_PROVIDER"].map((k) => [k, "x"]),
    );
    expect(missingInputs(DEFAULT_FLOW, BUILTIN_BLOCKS, env, "do it")).toEqual([]);
  });
});
