import { describe, expect, it } from "vitest";
import { pickFlowId, saveFlowId, savedFlowIds } from "../src/lib/activeFlow";

const flows = [{ id: "a" }, { id: "b" }, { id: "c" }];

describe("pickFlowId", () => {
  it("restores the saved flow when it still exists", () => {
    expect(pickFlowId(flows, ["b"])).toBe("b");
  });
  it("takes the first candidate that still exists (URL before localStorage)", () => {
    expect(pickFlowId(flows, ["gone", "c"])).toBe("c");
    expect(pickFlowId(flows, ["b", "c"])).toBe("b");
  });
  it("falls back to the first flow when nothing saved matches", () => {
    expect(pickFlowId(flows, [])).toBe("a");
    expect(pickFlowId(flows, ["gone", null, undefined, ""])).toBe("a");
  });
  it("is null with no flows", () => {
    expect(pickFlowId([], ["a"])).toBeNull();
  });
});

describe("persistence helpers without a browser", () => {
  it("never throw", () => {
    expect(savedFlowIds()).toEqual([]);
    expect(() => saveFlowId("a")).not.toThrow();
  });
});
