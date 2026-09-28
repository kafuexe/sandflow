import { describe, expect, it } from "vitest";
import { cloneFlow, newFlow } from "../shared/flows";
import { DEFAULT_FLOW } from "../shared/library";

describe("flows", () => {
  it("creates an empty flow", () => {
    expect(newFlow("f1", "Mine")).toEqual({ id: "f1", name: "Mine", nodes: [], edges: [] });
  });

  it("clones nodes, edges and overrides deeply under a new id and name", () => {
    const src = structuredClone(DEFAULT_FLOW);
    src.nodes[1].data.overrides = { allowQuestions: true, env: ["X"] };
    const copy = cloneFlow(src, "f2", "Copy");
    expect(copy.id).toBe("f2");
    expect(copy.name).toBe("Copy");
    expect(copy.nodes).toEqual(src.nodes);
    expect(copy.edges).toEqual(src.edges);
    copy.nodes[1].data.overrides!.env!.push("Y");
    copy.nodes[0].position.x = 999;
    copy.edges.pop();
    expect(src.nodes[1].data.overrides!.env).toEqual(["X"]);
    expect(src.nodes[0].position.x).toBe(DEFAULT_FLOW.nodes[0].position.x);
    expect(src.edges.length).toBe(DEFAULT_FLOW.edges.length);
  });
});
