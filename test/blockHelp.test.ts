import { describe, expect, it } from "vitest";
import { configGaps, configProblems, describeBlock, exampleOp, findBlock } from "../shared/blockHelp";
import { CORE_BLOCKS } from "../shared/core";
import { applyOps } from "../shared/flowOps";
import { BUILTIN_BLOCKS } from "../shared/library";
import { resolveBlock } from "../shared/resolve";

const blocks = [...CORE_BLOCKS, ...BUILTIN_BLOCKS];

describe("findBlock", () => {
  it("prefers the exact id and reports ambiguity", () => {
    const two = [...blocks, { ...BUILTIN_BLOCKS.find((b) => b.id === "plan")!, id: "acme/plan", pack: "acme" }];
    expect(findBlock("plan", two).id).toBe("plan");
    expect(() => findBlock("Plan", two.filter((b) => b.id !== "plan").concat({ ...two.find((b) => b.id === "acme/plan")!, id: "x/plan" }))).toThrow(/ambiguous.*acme\/plan, x\/plan/);
    expect(() => findBlock("", blocks)).toThrow(/"block" is required/);
  });
});

describe("describeBlock", () => {
  it("shows defaults, settable overrides, gaps and an example op that works", () => {
    const text = describeBlock(blocks.find((b) => b.id === "shell")!, blocks);
    expect(text).toContain("Kind: auto (action shell)");
    expect(text).toContain('shellCommand: "git log --oneline -5"');
    expect(text).toMatch(/- shellCommand \(string\)/);
    expect(text).not.toMatch(/- extraInstructions/);
    const script = describeBlock(blocks.find((b) => b.id === "sandflow/script")!, blocks);
    expect(script).toContain("Needs setting when placed:\n- no command — set overrides.script.run");
  });

  it("every block's example op applies cleanly (once the placeholder neighbour exists)", () => {
    for (const b of blocks) {
      const cfg = resolveBlock(b.id, blocks);
      const op = exampleOp(b, cfg) as Record<string, unknown>;
      expect(configProblems(op.overrides, cfg.kind)).toEqual([]);
      delete op.from;
      if (cfg.kind === "subflow") continue; // needs a real flow id
      expect(() => applyOps({ id: "f", name: "F", nodes: [], edges: [] }, blocks, [op as never])).not.toThrow();
      const placed = resolveBlock(b.id, blocks, op.overrides as never);
      expect(configGaps(placed).filter((g) => !g.startsWith("no instructions"))).toEqual([]);
    }
  });
});

describe("configProblems", () => {
  it("checks block configs too (kind allowed, kind-specific fields follow the new kind)", () => {
    expect(configProblems({ kind: "auto", shellCommand: "ls" }, "ai", false)).toEqual([]);
    expect(configProblems({ kind: "robot" }, "ai", false)[0]).toMatch(/unknown kind "robot"/);
    expect(configProblems({ inputs: { artefact: true } }, "ai", false)[0]).toMatch(/inputs.artefact isn't a field/);
    expect(configProblems("x", "ai")[0]).toMatch(/overrides must be an object/);
  });
});
