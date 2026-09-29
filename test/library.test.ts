import { describe, expect, it } from "vitest";
import { BUILTIN_BLOCKS, DEFAULT_FLOW, EXAMPLE_FLOWS, SKILL_CATALOG } from "../shared/library";
import { edgeAllowed, validateBlocks } from "../shared/validate";
import { flowRequirements, resolveBlock, templateChain } from "../shared/resolve";

describe("built-in library", () => {
  it("has unique ids and every extends points at a template", () => {
    const ids = BUILTIN_BLOCKS.map((b) => b.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const b of BUILTIN_BLOCKS) {
      if (!b.extends) continue;
      const parent = BUILTIN_BLOCKS.find((p) => p.id === b.extends);
      expect(parent?.isTemplate, `${b.id} extends ${b.extends}`).toBe(true);
    }
  });

  it("reviewer is a template of a template and CR inherits through it", () => {
    expect(templateChain("cr", BUILTIN_BLOCKS).map((b) => b.id)).toEqual(["tpl-ai-agent", "tpl-reviewer", "cr"]);
    const cr = resolveBlock("cr", BUILTIN_BLOCKS);
    expect(cr.kind).toBe("ai");
    expect(cr.env).toEqual(expect.arrayContaining(["REPO_PATH", "ANTHROPIC_API_KEY"]));
    expect(cr.skills.map((s) => s.name)).toEqual(expect.arrayContaining(["requesting-code-review", "code-review"]));
  });

  it("resolves the kinds and actions from the plan", () => {
    const r = (id: string) => resolveBlock(id, BUILTIN_BLOCKS);
    expect(r("create-task")).toMatchObject({ kind: "auto", autoAction: "create-task" });
    expect(r("create-mr")).toMatchObject({ kind: "auto", autoAction: "create-mr" });
    expect(r("shell")).toMatchObject({ kind: "auto", autoAction: "shell" });
    expect(r("manager").kind).toBe("manager");
    expect(r("implement").maxIterations).toBe(5);
    expect(r("cr-fix").maxIterations).toBe(3);
    expect(r("create-task").env).toEqual(expect.arrayContaining(["REPO_PATH", "BRANCH_NAME", "BASE_BRANCH"]));
    expect(r("create-mr").env).toEqual(expect.arrayContaining(["MR_PROVIDER", "BASE_BRANCH", "BRANCH_NAME"]));
  });

  it("default flow is wired to existing nodes with accepted handles", () => {
    const ids = new Set(DEFAULT_FLOW.nodes.map((n) => n.id));
    for (const e of DEFAULT_FLOW.edges) {
      expect(ids.has(e.source) && ids.has(e.target)).toBe(true);
      const src = resolveBlock(DEFAULT_FLOW.nodes.find((n) => n.id === e.source)!.data.blockId, BUILTIN_BLOCKS);
      const tgt = resolveBlock(DEFAULT_FLOW.nodes.find((n) => n.id === e.target)!.data.blockId, BUILTIN_BLOCKS);
      expect(edgeAllowed(src, e.sourceHandle, tgt, e.targetHandle)).toBe(true);
    }
    const mgr = DEFAULT_FLOW.nodes.find((n) => n.data.blockId === "manager")!;
    const targets = new Set(DEFAULT_FLOW.edges.filter((e) => e.source === mgr.id).map((e) => e.target));
    expect(targets.size).toBe(2);
    const req = flowRequirements(DEFAULT_FLOW, BUILTIN_BLOCKS);
    expect(req.startingPromptNodes.length).toBeGreaterThan(0);
    expect(req.env.map((e) => e.name)).toContain("REPO_PATH");
  });

  it("example flows are wired with allowed connections and valid blocks", () => {
    expect(validateBlocks(BUILTIN_BLOCKS)).toEqual([]);
    for (const flow of EXAMPLE_FLOWS) {
      for (const e of flow.edges) {
        const s = flow.nodes.find((n) => n.id === e.source)!;
        const t = flow.nodes.find((n) => n.id === e.target)!;
        const src = resolveBlock(s.data.blockId, BUILTIN_BLOCKS, s.data.overrides);
        const tgt = resolveBlock(t.data.blockId, BUILTIN_BLOCKS, t.data.overrides);
        expect(edgeAllowed(src, e.sourceHandle, tgt, e.targetHandle), `${flow.id}: ${e.id}`).toBe(true);
      }
    }
    const trig = resolveBlock("gitlab-trigger", BUILTIN_BLOCKS);
    const ifCfg = resolveBlock("if", BUILTIN_BLOCKS);
    const ai = resolveBlock("answer-comment", BUILTIN_BLOCKS);
    expect(edgeAllowed(ai, "artifact", trig, "artifact")).toBe(false); // nothing flows into a trigger
    expect(edgeAllowed(ai, "true", ai, "artifact")).toBe(false); // branch handles only from If
    expect(edgeAllowed(ifCfg, "artifact", ai, "artifact")).toBe(false);
    expect(edgeAllowed(ifCfg, "false", ai, "steer")).toBe(true);
  });

  it("skill catalog entries have valid sources and names", () => {
    for (const s of SKILL_CATALOG) {
      expect(s.source).toMatch(/^[\w.-]+\/[\w.-]+$/);
      expect(s.name).toMatch(/^[\w.-]+$/);
    }
  });
});
