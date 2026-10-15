import { describe, expect, it } from "vitest";
import { buildSections, filterFlows, highlightSegments, matchRanges, moveActive, pushRecent } from "../src/lib/flowSwitcher";
import { FLOW_COLORS, cloneFlow, isFlowColor, sanitizeFlowColor } from "../shared/flows";
import type { Flow } from "../shared/types";

const f = (id: string, name: string, extra: Partial<Flow> = {}): Flow => ({ id, name, nodes: [], edges: [], ...extra });

const flows = [
  f("fp", "Feature pipeline"),
  f("bug", "Bugfix loop"),
  f("rel", "Release notes"),
  f("pipe", "Pipeline"),
  f("f10", "Flow 10"),
  f("f2", "Flow 2"),
  f("base/review", "Review until approved", { pack: "base", description: "Loops a reviewer" }),
];
const ids = (xs: { flow: Flow }[]) => xs.map((x) => x.flow.id);

describe("matchRanges", () => {
  it("is case-insensitive, needs every word, and prefers word starts", () => {
    expect(matchRanges("Feature pipeline", "PIPE")).toEqual([[8, 12]]);
    expect(matchRanges("Feature pipeline", "pipe feat")).toEqual([[0, 4], [8, 12]]);
    expect(matchRanges("Feature pipeline", "pipe xyz")).toBeNull();
    expect(matchRanges("aXbX", "x")).toEqual([[1, 2]]);
    expect(matchRanges("Anything", "  ")).toEqual([]);
  });

  it("treats regex characters literally and merges overlaps", () => {
    expect(matchRanges("C++ (beta)", "(beta")).toEqual([[4, 9]]);
    expect(matchRanges("Release", "rel releas")).toEqual([[0, 6]]);
  });
});

describe("filterFlows", () => {
  it("ranks exact, then prefix, then word-start, then scattered hits", () => {
    expect(ids(filterFlows(flows, "pipeline"))).toEqual(["pipe", "fp"]);
    expect(ids(filterFlows(flows, "flow"))).toEqual(["f2", "f10"]); // natural order: 2 before 10
    expect(ids(filterFlows(flows, "loop bug"))).toEqual(["bug"]);
  });

  it("puts word-start hits ahead of hits inside a word, even against recency", () => {
    const xs = [f("a", "Feature pipeline"), f("b", "Code review")];
    expect(ids(filterFlows(xs, "re", ["a"]))).toEqual(["b", "a"]);
  });

  it("finds flows by pack or description, without a name highlight", () => {
    const hits = filterFlows(flows, "reviewer");
    expect(ids(hits)).toEqual(["base/review"]);
    expect(hits[0].ranges).toEqual([]);
    expect(ids(filterFlows(flows, "base"))).toEqual(["base/review"]);
  });

  it("breaks ties by recency", () => {
    expect(ids(filterFlows(flows, "flow", ["f10"]))).toEqual(["f10", "f2"]);
  });

  it("returns nothing for no match", () => {
    expect(filterFlows(flows, "zzz")).toEqual([]);
  });
});

describe("buildSections", () => {
  it("groups recent, your flows A–Z and pack flows, each flow once", () => {
    const s = buildSections(flows, "", ["rel", "gone"]);
    expect(s.map((x) => [x.key, x.label])).toEqual([
      ["recent", "Recent"],
      ["own", "All flows"],
      ["pack", "From packs"],
    ]);
    expect(ids(s[0].items)).toEqual(["rel"]);
    expect(ids(s[1].items)).toEqual(["bug", "fp", "f2", "f10", "pipe"]);
    expect(ids(s[2].items)).toEqual(["base/review"]);
    // A recent pack flow moves up into Recent, leaving its group empty (and hidden).
    const again = buildSections(flows, "", ["base/review"]);
    expect(again.map((x) => x.key)).toEqual(["recent", "own"]);
  });

  it("drops empty sections and skips recents for short lists", () => {
    const s = buildSections(flows.slice(0, 3), "", ["rel"]);
    expect(s.map((x) => x.key)).toEqual(["own"]);
    expect(s[0].label).toBe("Your flows");
    expect(ids(s[0].items)).toEqual(["bug", "fp", "rel"]);
  });

  it("caps recents", () => {
    const s = buildSections(flows, "", ["fp", "bug", "rel", "pipe", "f2"], { recentLimit: 2 });
    expect(ids(s[0].items)).toEqual(["fp", "bug"]);
  });

  it("shows one results section when searching, and none when nothing matches", () => {
    const s = buildSections(flows, "pipe", ["fp"]);
    expect(s).toHaveLength(1);
    expect(s[0].key).toBe("results");
    expect(ids(s[0].items)).toEqual(["pipe", "fp"]);
    expect(buildSections(flows, "nope")).toEqual([]);
  });
});

describe("helpers", () => {
  it("splits text into highlight segments", () => {
    expect(highlightSegments("Feature pipeline", [[8, 12]])).toEqual([
      { text: "Feature ", match: false },
      { text: "pipe", match: true },
      { text: "line", match: false },
    ]);
    expect(highlightSegments("abc", [])).toEqual([{ text: "abc", match: false }]);
    expect(highlightSegments("abc", [[0, 9]])).toEqual([{ text: "abc", match: true }]);
  });

  it("keeps recents unique, newest first, capped", () => {
    expect(pushRecent(["a", "b", "c"], "c")).toEqual(["c", "a", "b"]);
    expect(pushRecent(["a", "b"], "z", 2)).toEqual(["z", "a"]);
  });

  it("moves the active option with wrap-around", () => {
    expect(moveActive(-1, 3, "ArrowDown")).toBe(0);
    expect(moveActive(2, 3, "ArrowDown")).toBe(0);
    expect(moveActive(0, 3, "ArrowUp")).toBe(2);
    expect(moveActive(1, 3, "End")).toBe(2);
    expect(moveActive(1, 3, "Home")).toBe(0);
    expect(moveActive(0, 0, "ArrowDown")).toBe(-1);
  });
});

describe("flow colours", () => {
  it("accepts only palette colours and drops anything else", () => {
    expect(FLOW_COLORS.every(isFlowColor)).toBe(true);
    expect(isFlowColor("#fff")).toBe(false);
    expect(isFlowColor(undefined)).toBe(false);
    const legacy = f("a", "A");
    expect(sanitizeFlowColor(legacy)).toBe(legacy);
    expect(sanitizeFlowColor(f("a", "A", { color: "teal" })).color).toBe("teal");
    expect(sanitizeFlowColor({ ...legacy, color: "neon" } as unknown as Flow)).not.toHaveProperty("color");
  });

  it("keeps the colour when a flow is duplicated", () => {
    expect(cloneFlow(f("a", "A", { color: "pink" }), "b", "B").color).toBe("pink");
    expect(cloneFlow(f("a", "A"), "b", "B")).not.toHaveProperty("color");
  });
});
