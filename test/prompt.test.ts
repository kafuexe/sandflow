import { describe, expect, it } from "vitest";
import { buildPrompt, parseOutput } from "../backend/prompt";
import { resolveBlock } from "../shared/resolve";
import { BUILTIN_BLOCKS } from "../shared/library";

describe("parseOutput", () => {
  it("takes the last match of each tag", () => {
    const out = parseOutput("<artifact>old</artifact> x <artifact>\nnew\n</artifact><steer>s</steer><route>n-1</route>");
    expect(out).toEqual({ artifact: "new", steer: "s", route: "n-1", question: undefined });
  });
  it("finds a question", () => {
    expect(parseOutput("blah <question>Which DB?</question>").question).toBe("Which DB?");
  });
});

describe("buildPrompt", () => {
  const cfg = resolveBlock("plan", BUILTIN_BLOCKS);

  it("includes only sections for present inputs", () => {
    const p = buildPrompt({ cfg, inputs: { artifact: "ART" }, startingPrompt: "TASK", qa: [] });
    expect(p).toContain("# Role");
    expect(p).toContain("# Task (starting prompt)\nTASK");
    expect(p).toContain("# Input artifact\nART");
    expect(p).not.toContain("# Steering from previous step");
    expect(p).toContain("<artifact>");
    expect(p).toContain("<steer>");
    expect(p).not.toContain("<question>");
    expect(p).toContain("writing-plans");
  });

  it("omits the starting prompt when the block doesn't accept it", () => {
    const c = { ...cfg, inputs: { ...cfg.inputs, startingPrompt: false } };
    expect(buildPrompt({ cfg: c, inputs: {}, startingPrompt: "TASK", qa: [] })).not.toContain("TASK");
  });

  it("adds question protocol, Q&A, completion signal and routes", () => {
    const c = { ...cfg, allowQuestions: true, maxIterations: 3 };
    const p = buildPrompt({
      cfg: c,
      inputs: { steer: "S" },
      startingPrompt: "",
      qa: [{ question: "Q1", answer: "A1" }],
      routes: [{ id: "n-mr", label: "Create MR", description: "opens MR", handles: ["artifact"] }],
    });
    expect(p).toContain("<question>");
    expect(p).toContain("Q1");
    expect(p).toContain("A1");
    expect(p).toContain("<promise>COMPLETE</promise>");
    expect(p).toContain("n-mr");
    expect(p).toContain("<route>");
  });
});
