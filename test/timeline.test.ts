import { describe, expect, it } from "vitest";
import { BUILTIN_BLOCKS, DEFAULT_FLOW } from "../shared/library";
import type { LogLine, RunState } from "../shared/types";
import { buildTimeline, flowSteps, runTitle } from "../src/lib/timeline";

const log = (ts: number, msg: string, nodeId?: string, level: LogLine["level"] = "info"): LogLine => ({ ts, level, nodeId, msg });

function state(patch: Partial<RunState>): RunState {
  return { id: "r", flowId: "f", flowName: "F", status: "running", startedAt: 0, nodes: {}, logs: [], ...patch };
}

describe("flowSteps", () => {
  it("lists nodes in the order the flow reaches them, each once", () => {
    const ids = flowSteps(DEFAULT_FLOW, BUILTIN_BLOCKS).map((s) => s.id);
    expect(ids.slice(0, 5)).toEqual(["n-create-task", "n-plan", "n-implement", "n-cr", "n-manager"]);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toHaveLength(DEFAULT_FLOW.nodes.length);
  });
});

describe("buildTimeline", () => {
  it("groups logs into steps and interleaves questions by time", () => {
    const run = state({
      status: "waiting",
      pendingQuestion: { nodeId: "b", question: "Which DB?", askedAt: 25 },
      questions: [{ nodeId: "b", question: "Which DB?", askedAt: 25 }],
      logs: [
        log(10, "▶ A (auto) — execution 1", "a"),
        log(11, "doing a", "a", "agent"),
        log(12, "✓ A", "a"),
        log(20, "▶ B (ai) — execution 1", "b"),
        log(21, "thinking", "b", "agent"),
        log(25, "Question: Which DB?", "b"),
      ],
    });
    const items = buildTimeline(run);
    expect(items.map((i) => i.kind)).toEqual(["step", "step", "question"]);
    const [a, b] = items as Extract<(typeof items)[number], { kind: "step" }>[];
    expect(a).toMatchObject({ nodeId: "a", execution: 1, status: "done", endedAt: 12 });
    expect(a.lines.map((l) => l.msg)).toEqual(["doing a"]);
    expect(b).toMatchObject({ nodeId: "b", status: "waiting" });
    expect(b.lines.map((l) => l.msg)).toEqual(["thinking"]);
  });

  it("marks the open step stopped or failed when the run ends, and keeps run-level errors", () => {
    const logs = [log(1, "▶ A (ai) — execution 2", "a"), log(2, "A: boom", undefined, "error")];
    const failed = buildTimeline(state({ status: "failed", finishedAt: 3, logs }));
    expect(failed[0]).toMatchObject({ kind: "step", status: "failed", execution: 2 });
    expect(failed[1]).toMatchObject({ kind: "notice", level: "error", text: "A: boom" });
    const stopped = buildTimeline(state({ status: "cancelled", finishedAt: 3, logs: logs.slice(0, 1) }));
    expect(stopped[0]).toMatchObject({ status: "stopped" });
  });

  it("records where a manager routed", () => {
    const items = buildTimeline(
      state({ logs: [log(1, "▶ M (manager) — execution 1", "m"), log(2, "↪ routed to Create MR", "m"), log(3, "✓ M", "m")] }),
    );
    expect(items[0]).toMatchObject({ note: "routed to Create MR", status: "done" });
  });
});

describe("runTitle", () => {
  it("uses the first line of the prompt, else the trigger, else the flow", () => {
    expect(runTitle({ flowName: "F", prompt: "Fix login\nmore" })).toBe("Fix login");
    expect(runTitle({ flowName: "F", trigger: { source: "github", type: "issue.opened", title: "Bug" } })).toBe("Bug");
    expect(runTitle({ flowName: "F" })).toBe("F");
  });
});
