import { describe, expect, it } from "vitest";
import { activeRunsLabel, activeRunsOf, mergeRun, runToShow, toSummary } from "../src/lib/runSelection";
import { branchConflictWarning, sharedBranchKey } from "../shared/runConflicts";
import type { RunState, RunSummary } from "../shared/types";

const sum = (id: string, flowId: string, startedAt: number, extra: Partial<RunSummary> = {}): RunSummary => ({
  id, flowId, flowName: flowId.toUpperCase(), status: "running", startedAt, ...extra,
});
const state = (id: string, flowId: string, startedAt: number, extra: Partial<RunState> = {}): RunState => ({
  id, flowId, flowName: flowId.toUpperCase(), status: "running", startedAt, nodes: {}, logs: [], ...extra,
});

const runs = [
  sum("a3", "a", 30),
  sum("b1", "b", 25),
  sum("a2", "a", 20, { status: "waiting" }),
  sum("a1", "a", 10, { status: "done", finishedAt: 15 }),
];

describe("activeRunsOf", () => {
  it("lists a flow's unfinished runs, newest first", () => {
    expect(activeRunsOf(runs, "a").map((r) => r.id)).toEqual(["a3", "a2"]);
    expect(activeRunsOf(runs, "b").map((r) => r.id)).toEqual(["b1"]);
    expect(activeRunsOf(runs, null)).toEqual([]);
  });
  it("includes a just-started run the polled list hasn't seen", () => {
    expect(activeRunsOf(runs, "a", state("a4", "a", 40)).map((r) => r.id)).toEqual(["a4", "a3", "a2"]);
  });
  it("prefers the watched run's live state over its stale summary", () => {
    const finished = state("a3", "a", 30, { status: "done", finishedAt: 35 });
    expect(activeRunsOf(runs, "a", finished).map((r) => r.id)).toEqual(["a2"]);
  });
});

describe("mergeRun / toSummary", () => {
  it("replaces by id and keeps newest-first order", () => {
    const merged = mergeRun(runs, state("a2", "a", 20, { status: "running", prompt: "p" }));
    expect(merged.map((r) => r.id)).toEqual(["a3", "b1", "a2", "a1"]);
    expect(merged.find((r) => r.id === "a2")).toMatchObject({ status: "running", prompt: "p" });
    expect(mergeRun(runs, undefined)).toBe(runs);
  });
  it("drops logs and nodes from a summary", () => {
    expect(Object.keys(toSummary(state("x", "a", 1)))).not.toContain("logs");
  });
});

describe("runToShow", () => {
  it("keeps the watched run when it belongs to the flow (even finished)", () => {
    expect(runToShow(runs, "a", state("a1", "a", 10, { finishedAt: 15, status: "done" }))).toBe("a1");
  });
  it("otherwise picks the flow's most recent active run", () => {
    expect(runToShow(runs, "a", state("b1", "b", 25))).toBe("a3");
    expect(runToShow(runs, "a")).toBe("a3");
  });
  it("is undefined when the flow has nothing running", () => {
    expect(runToShow(runs, "c", state("b1", "b", 25))).toBeUndefined();
    expect(runToShow(runs, null)).toBeUndefined();
  });
});

describe("activeRunsLabel", () => {
  it("counts running and waiting runs", () => {
    expect(activeRunsLabel(activeRunsOf(runs, "a"))).toBe("1 running · 1 waiting");
    expect(activeRunsLabel([sum("x", "a", 1), sum("y", "a", 2)])).toBe("2 running");
    expect(activeRunsLabel([sum("x", "a", 1, { pendingQuestion: { nodeId: "n", question: "?" } })])).toBe("1 waiting");
  });
});

describe("branch conflicts between runs", () => {
  it("only an explicit BRANCH_NAME in a project makes runs share a branch", () => {
    expect(sharedBranchKey({})).toBeUndefined();
    expect(sharedBranchKey({ REPO_PATH: "/r" })).toBeUndefined();
    expect(sharedBranchKey({ BRANCH_NAME: "b" })).toBeUndefined();
    expect(sharedBranchKey({ REPO_PATH: " /r ", BRANCH_NAME: " b " })).toBe("/r\0b");
  });
  it("warns only about active runs on the same repo + branch", () => {
    const env = { REPO_PATH: "/r", BRANCH_NAME: "b" };
    const other = { id: "r1", flowName: "F", startedAt: 1 };
    expect(branchConflictWarning(env, [])).toBeUndefined();
    expect(branchConflictWarning(env, [{ ...other, branchKey: "/r\0c" }])).toBeUndefined();
    expect(branchConflictWarning(env, [{ ...other }])).toBeUndefined();
    expect(branchConflictWarning({ REPO_PATH: "/r" }, [{ ...other, branchKey: "/r\0b" }])).toBeUndefined();
    expect(branchConflictWarning(env, [{ ...other, branchKey: "/r\0b" }])).toMatch(/branch b in \/r: "F" \(r1\)/);
  });
});
