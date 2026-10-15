import { describe, expect, it } from "vitest";
import { applyOps, autoLayout, describeFlow, parseEdge, validateFlow } from "../shared/flowOps";
import { BUILTIN_BLOCKS, DEFAULT_FLOW } from "../shared/library";
import type { Flow } from "../shared/types";

const blocks = BUILTIN_BLOCKS;
const empty: Flow = { id: "f", name: "F", nodes: [], edges: [] };

describe("parseEdge", () => {
  it("reads handles and defaults them to artifact", () => {
    expect(parseEdge("plan.steer -> implement.steer")).toEqual({ source: "plan", sourceHandle: "steer", target: "implement", targetHandle: "steer" });
    expect(parseEdge("a -> b")).toEqual({ source: "a", sourceHandle: "artifact", target: "b", targetHandle: "artifact" });
    expect(parseEdge("check.true -> fix")).toMatchObject({ sourceHandle: "true", targetHandle: "artifact" });
  });
  it("explains bad syntax and handles", () => {
    expect(() => parseEdge("a => b")).toThrow(/source.handle -> target.handle/);
    expect(() => parseEdge("a.foo -> b")).toThrow(/isn't an output handle/);
    expect(() => parseEdge("a -> b.true")).toThrow(/isn't an input handle/);
  });
});

describe("applyOps", () => {
  it("builds a flow and lays it out left to right", () => {
    const r = applyOps(empty, blocks, [
      { op: "add_node", id: "start", block: "create-task" },
      { op: "add_node", id: "plan", block: "plan" },
      { op: "add_node", id: "impl", block: "implement" },
      { op: "connect", edge: "start -> plan" },
      { op: "connect", edge: "plan.artifact -> impl.artifact" },
      { op: "connect", edge: "plan.steer -> impl.steer" },
    ]);
    expect(r.flow.nodes.map((n) => n.position.x)).toEqual([0, 320, 640]);
    expect(r.flow.edges).toHaveLength(3);
    expect(r.changes).toContain("+ edge plan.steer -> impl.steer");
    expect(r.touched).toEqual(["start", "plan", "impl"]);
    expect(validateFlow(r.flow, blocks).errors).toEqual([]);
  });

  it("rejects edges the blocks can't carry, naming the op and the valid handles", () => {
    expect(() =>
      applyOps(empty, blocks, [
        { op: "add_node", id: "start", block: "create-task" },
        { op: "add_node", id: "plan", block: "plan" },
        { op: "connect", edge: "start.steer -> plan" },
      ]),
    ).toThrow(/Op 3 \(connect\): "start" doesn't output steer. Valid: artifact/);
    expect(() =>
      applyOps(empty, blocks, [
        { op: "add_node", id: "t", block: "manual-trigger" },
        { op: "add_node", id: "p", block: "plan" },
        { op: "connect", edge: "p -> t" },
      ]),
    ).toThrow(/triggers start a flow/);
    expect(() =>
      applyOps(empty, blocks, [
        { op: "add_node", id: "t", block: "manual-trigger" },
        { op: "add_node", id: "check", block: "if" },
        { op: "add_node", id: "p", block: "plan" },
        { op: "connect", edge: "t -> check" },
        { op: "connect", edge: "check -> p" },
      ]),
    ).toThrow(/connect from "check.true" or "check.false"/);
  });

  it("is all-or-nothing and doesn't mutate the input", () => {
    const before = structuredClone(DEFAULT_FLOW);
    expect(() => applyOps(DEFAULT_FLOW, blocks, [{ op: "remove_node", id: "n-plan" }, { op: "add_node", id: "x", block: "nope" }])).toThrow(
      /Unknown block "nope"/,
    );
    expect(DEFAULT_FLOW).toEqual(before);
  });

  it("removes a node with its edges, and places new nodes next to their neighbours", () => {
    const r = applyOps(DEFAULT_FLOW, blocks, [
      { op: "add_node", id: "security", block: "cr", label: "Security review" },
      { op: "disconnect", edge: "n-cr.artifact -> n-manager.artifact" },
      { op: "connect", edge: "n-cr.artifact -> security.artifact" },
      { op: "connect", edge: "security -> n-manager" },
      { op: "remove_node", id: "n-create-mr" },
    ]);
    const cr = r.flow.nodes.find((n) => n.id === "n-cr")!;
    const sec = r.flow.nodes.find((n) => n.id === "security")!;
    expect(sec.position.x).toBe(cr.position.x + 320);
    expect(sec.position.y).not.toBe(r.flow.nodes.find((n) => n.id === "n-manager")!.position.y); // didn't land on top of it
    expect(r.flow.edges.some((e) => e.target === "n-create-mr")).toBe(false);
    expect(r.changes).toContain("- edge n-manager.artifact -> n-create-mr.artifact");
    // untouched nodes keep their positions
    expect(r.flow.nodes.find((n) => n.id === "n-plan")!.position).toEqual(DEFAULT_FLOW.nodes.find((n) => n.id === "n-plan")!.position);
  });

  it("merges node overrides and removes keys set to null", () => {
    let f = applyOps(DEFAULT_FLOW, blocks, [{ op: "update_node", id: "n-plan", overrides: { allowQuestions: true, extraInstructions: "x" } }]).flow;
    f = applyOps(f, blocks, [{ op: "update_node", id: "n-plan", overrides: { extraInstructions: null }, label: "Planner" }]).flow;
    expect(f.nodes.find((n) => n.id === "n-plan")!.data).toMatchObject({ label: "Planner", overrides: { allowQuestions: true } });
    expect(f.nodes.find((n) => n.id === "n-plan")!.data.overrides).not.toHaveProperty("extraInstructions");
  });
});

describe("validateFlow", () => {
  it("accepts the default flow and flags loops without a start and lonely managers", () => {
    expect(validateFlow(DEFAULT_FLOW, blocks)).toEqual({ errors: [], warnings: [] });
    const loop = applyOps(empty, blocks, [
      { op: "add_node", id: "a", block: "cr" },
      { op: "add_node", id: "m", block: "manager" },
      { op: "connect", edge: "a -> m" },
      { op: "connect", edge: "m -> a" },
    ]).flow;
    const r = validateFlow(loop, blocks);
    expect(r.errors.join()).toMatch(/No start node/);
    expect(r.warnings.join()).toMatch(/Manager "m" routes to 1/);
  });
});

describe("autoLayout / describeFlow", () => {
  it("ignores loop back-edges when assigning columns", () => {
    const f = autoLayout(DEFAULT_FLOW);
    const x = (id: string) => f.nodes.find((n) => n.id === id)!.position.x;
    expect(x("n-create-task")).toBe(0);
    expect(x("n-manager")).toBeGreaterThan(x("n-cr"));
    expect(x("n-cr-fix")).toBeGreaterThan(x("n-manager"));
  });
  it("lists nodes with handles and edges in the edge syntax", () => {
    const text = describeFlow(DEFAULT_FLOW, blocks);
    expect(text).toContain("- n-plan: Plan (block plan) [ai; in: artifact, steer, starting prompt; out: artifact, steer]");
    expect(text).toContain("- n-cr-fix.artifact -> n-cr.artifact");
  });
});

describe("easier block placement", () => {
  it("defaults node ids from the block and wires every compatible handle with from/to", () => {
    const r = applyOps(empty, blocks, [
      { op: "add_node", block: "manual-trigger" },
      { op: "add_node", block: "plan", from: "manual-trigger" },
      { op: "add_node", block: "implement", from: "plan" },
      { op: "add_node", block: "plan", from: "implement" },
    ]);
    expect(r.flow.nodes.map((n) => n.id)).toEqual(["manual-trigger", "plan", "implement", "plan-2"]);
    expect(r.flow.edges.map((e) => `${e.source}.${e.sourceHandle} -> ${e.target}.${e.targetHandle}`)).toEqual([
      "manual-trigger.artifact -> plan.artifact",
      "plan.artifact -> implement.artifact",
      "plan.steer -> implement.steer",
      "implement.artifact -> plan-2.artifact",
      "implement.steer -> plan-2.steer",
    ]);
    expect(validateFlow(r.flow, blocks).errors).toEqual([]);
  });

  it("wires nodes added later in the same batch, and builds the guide's whole-flow example", () => {
    const r = applyOps(empty, blocks, [
      { op: "add_node", id: "start", block: "create-task" },
      { op: "add_node", id: "plan", block: "plan", from: "start" },
      { op: "add_node", id: "impl", block: "implement", from: "plan" },
      { op: "add_node", id: "review", block: "cr", from: "impl" },
      { op: "add_node", id: "manager", block: "manager", from: "review", to: ["mr", "fix"] },
      { op: "add_node", id: "mr", block: "create-mr" },
      { op: "add_node", id: "fix", block: "cr-fix", to: "review" },
    ]);
    expect(r.changes).toContain("+ edge manager.artifact -> mr.artifact");
    expect(r.changes).toContain("+ edge fix.steer -> review.steer");
    expect(validateFlow(r.flow, blocks)).toEqual({ errors: [], warnings: [] });
  });

  it("connects by node, by handle, and a bare If node through its true branch", () => {
    const r = applyOps(empty, blocks, [
      { op: "add_node", id: "t", block: "manual-trigger" },
      { op: "add_node", id: "check", block: "if", from: "t" },
      { op: "add_node", id: "yes", block: "answer-comment" },
      { op: "add_node", id: "no", block: "shell", overrides: { shellCommand: "echo skipped" } },
      { op: "connect", from: "check", to: "yes" },
      { op: "connect", from: "check.false", to: "no" },
    ]);
    expect(r.changes).toEqual(expect.arrayContaining(["+ edge check.true -> yes.artifact", "+ edge check.false -> no.artifact"]));
    const d = applyOps(r.flow, blocks, [{ op: "disconnect", from: "check", to: "yes" }]);
    expect(d.changes).toEqual(["- edge check.true -> yes.artifact"]);
    expect(() => applyOps(r.flow, blocks, [{ op: "connect", from: "yes", to: "t" }])).toThrow(/triggers start a flow/);
    expect(() => applyOps(r.flow, blocks, [{ op: "connect", from: "nope", to: "t" }])).toThrow(/No node "nope" in this flow. Nodes: t, check/);
    expect(() => applyOps(r.flow, blocks, [{ op: "connect" }])).toThrow(/needs "edge"/);
  });

  it("finds blocks by id without the pack, by name, and suggests close ids", () => {
    const packed = blocks.map((b) => ({ ...b, id: `base/${b.id}`, extends: b.extends ? `base/${b.extends}` : b.extends, pack: "base" }));
    const r = applyOps(empty, packed, [
      { op: "add_node", block: "plan" },
      { op: "add_node", block: "Shell command", from: "plan" },
    ]);
    expect(r.flow.nodes.map((n) => [n.id, n.data.blockId])).toEqual([["plan", "base/plan"], ["shell", "base/shell"]]);
    expect(() => applyOps(empty, packed, [{ op: "add_node", block: "implemnt" }])).toThrow(/Unknown block "implemnt". Did you mean "base\/implement"/);
  });

  it("rejects overrides with field-specific messages", () => {
    const add = (block: string, overrides: Record<string, unknown>) => () =>
      applyOps(empty, blocks, [{ op: "add_node", id: "n", block, overrides: overrides as never }]);
    expect(add("plan", { prompt: "x" })).toThrow(/overrides.prompt isn't a block setting.*Settable on ai blocks: .*extraInstructions/);
    expect(add("plan", { extraInstruction: "x" })).toThrow(/Did you mean extraInstructions/);
    expect(add("plan", { shellCommand: "ls" })).toThrow(/overrides.shellCommand only applies to auto blocks, and this block is ai/);
    expect(add("plan", { maxIterations: 0 })).toThrow(/overrides.maxIterations: must be a positive whole number/);
    expect(add("plan", { agent: { provider: "gpt" } })).toThrow(/unknown provider "gpt"/);
    expect(add("plan", { env: ["bad name"] })).toThrow(/"bad name" isn't a valid env var name/);
    expect(add("plan", { kind: "auto" })).toThrow(/can't change its block's kind/);
    expect(add("if", { condition: { rules: [{ field: "text", op: "like" }] } })).toThrow(/Rule 1: unknown operator "like"/);
    expect(add("schedule-trigger", { trigger: { schedule: { kind: "cron", expr: "nope" } } })).toThrow(/overrides.trigger/);
    expect(add("github-trigger", { trigger: { repo: "not a repo" } })).toThrow(/Invalid repository/);
    expect(add("shell", { shellCommand: 5 })).toThrow(/overrides.shellCommand must be a string, e.g. "npm test"/);
  });

  it("merges settings objects one level deep on update_node", () => {
    let f = applyOps(empty, blocks, [{ op: "add_node", id: "gh", block: "github-trigger", overrides: { trigger: { repo: "a/b", events: ["push"] } as never } }]).flow;
    f = applyOps(f, blocks, [{ op: "update_node", id: "gh", overrides: { trigger: { mode: "poll", events: null } } }]).flow;
    expect(f.nodes[0].data.overrides).toEqual({ trigger: { repo: "a/b", mode: "poll" } });
    expect(() => applyOps(f, blocks, [{ op: "update_node", id: "gh", overrides: { trigger: { mode: "push" } } }])).toThrow(/Unknown trigger mode/);
  });

  it("warns about blocks that still need settings", () => {
    const f = applyOps(empty, blocks, [
      { op: "add_node", id: "t", block: "manual-trigger" },
      { op: "add_node", id: "sh", block: "shell", from: "t", overrides: { shellCommand: "" } },
      { op: "add_node", id: "check", block: "if", from: "sh", overrides: { condition: { match: "all", rules: [] } } },
    ]).flow;
    const w = validateFlow(f, blocks).warnings.join("\n");
    expect(w).toMatch(/Node "sh" has no command — set overrides.shellCommand/);
    expect(w).toMatch(/Node "check" has no rules/);
  });
});
