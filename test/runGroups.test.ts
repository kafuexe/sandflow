import { describe, expect, it } from "vitest";
import { groupRuns, sectionRuns, taskTone } from "../src/lib/runGroups";
import type { RunSummary, StackRunInfo } from "../shared/types";

const run = (id: string, over: Partial<RunSummary> = {}): RunSummary => ({ id, flowId: "f", flowName: "F", status: "done", startedAt: 1, finishedAt: 2, ...over });
const kid = (id: string, parent: string, stack: Partial<StackRunInfo>, over: Partial<RunSummary> = {}) =>
  run(id, {
    parent: { runId: parent, nodeKey: "s" },
    stack: { groupId: "g1", name: "Areas", index: 0, total: 3, task: "t", attempt: 1, maxAttempts: 2, ...stack },
    ...over,
  });

describe("grouping runs", () => {
  it("puts stack children under their parent, latest attempt per task, in task order", () => {
    const list = [
      kid("c3", "p", { index: 1, task: "billing", attempt: 2, outcome: undefined }, { status: "running", finishedAt: undefined }),
      kid("c2", "p", { index: 1, task: "billing", attempt: 1, outcome: "rejected" }, { status: "failed" }),
      kid("c1", "p", { index: 0, task: "auth", outcome: "succeeded" }),
      run("p", { status: "running", finishedAt: undefined }),
    ];
    const { roots, groups } = groupRuns(list);
    expect(roots.map((r) => r.id)).toEqual(["p"]);
    const [g] = groups.get("p")!;
    expect(g).toMatchObject({ groupId: "g1", name: "Areas", total: 3, settled: 1 });
    expect(g.tasks.map((t) => t.id)).toEqual(["c1", "c3"]);
    expect(g.attempts.get(1)!.map((t) => t.id)).toEqual(["c2", "c3"]);
  });

  it("keeps separate groups for each time the stack ran", () => {
    const { groups } = groupRuns([kid("b", "p", { groupId: "g2" }, { startedAt: 5 }), kid("a", "p", { groupId: "g1" }, { startedAt: 3 }), run("p")]);
    expect(groups.get("p")!.map((g) => g.groupId)).toEqual(["g1", "g2"]);
  });
});

describe("sections", () => {
  it("flagged finished runs first, then questions (children included), running, earlier", () => {
    const list = [
      kid("ask", "p1", { task: "db" }, { status: "waiting", finishedAt: undefined, pendingQuestion: { nodeId: "work", question: "Which DB?" } }),
      run("p1", { status: "running", finishedAt: undefined }),
      run("flagged", { flags: { warning: 1, error: 0 } }),
      run("plain"),
      run("flaggedLive", { status: "running", finishedAt: undefined, flags: { warning: 1, error: 0 } }),
    ];
    const s = sectionRuns(list);
    expect(s.flagged.map((r) => r.id)).toEqual(["flagged"]);
    expect(s.waiting.map((r) => r.id)).toEqual(["ask"]);
    expect(s.running.map((r) => r.id)).toEqual(["p1", "flaggedLive"]);
    expect(s.earlier.map((r) => r.id)).toEqual(["plain"]);
  });
});

describe("task tones", () => {
  it("colours a task by where it got to", () => {
    expect(taskTone(kid("a", "p", { outcome: "succeeded" }))).toBe("done");
    expect(taskTone(kid("a", "p", { outcome: "dropped" }))).toBe("dropped");
    expect(taskTone(kid("a", "p", { attempt: 2 }, { status: "running", finishedAt: undefined }))).toBe("running");
    expect(taskTone(kid("a", "p", {}, { status: "waiting", finishedAt: undefined, pendingQuestion: { nodeId: "w", question: "?" } }))).toBe("waiting");
    expect(taskTone(kid("a", "p", { outcome: "rejected" }, { status: "failed" }))).toBe("running");
    expect(taskTone(kid("a", "p", {}, { status: "cancelled" }))).toBe("cancelled");
  });
});
