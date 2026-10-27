import { describe, expect, it } from "vitest";
import { eventsAfter, runEvents } from "../shared/runEvents";
import type { RunState } from "../shared/types";

const base = (patch: Partial<RunState> = {}): RunState => ({
  id: "r1",
  flowId: "f",
  flowName: "F",
  status: "running",
  startedAt: 1000,
  nodes: { plan: { status: "idle", executions: 0 }, impl: { status: "idle", executions: 0 } },
  logs: [],
  ...patch,
});

describe("runEvents", () => {
  it("derives node, question, flag and end events from status fields when the run has no phases", () => {
    const run = base({
      status: "failed",
      finishedAt: 5000,
      error: "boom",
      nodes: { plan: { status: "done", executions: 1 }, impl: { status: "failed", executions: 1, error: "tests failed" }, skip: { status: "idle", executions: 0 } },
      questions: [{ nodeId: "plan", question: "Which DB?", askedAt: 2000, answer: "pg", answeredAt: 2100 }],
      flags: [{ id: "x", severity: "error", message: "Agent stuck", nodeKey: "impl", at: 3000 }],
    });
    expect(runEvents(run)).toEqual([
      { type: "node", node: "plan", status: "done", execution: 1 },
      { type: "node", node: "impl", status: "failed", execution: 1, error: "tests failed" },
      { type: "question", node: "plan", question: "Which DB?", answer: "pg" },
      { type: "flag", severity: "error", message: "Agent stuck", node: "impl" },
      { type: "end", status: "failed", error: "boom" },
    ]);
  });

  it("counts each finished execution of a looping node once, and skips steps copied from a resumed run", () => {
    const run = base({ nodes: { cr: { status: "running", executions: 3 }, old: { status: "done", executions: 1, restored: true } } });
    expect(runEvents(run)).toEqual([
      { type: "node", node: "cr", status: "done", execution: 1 },
      { type: "node", node: "cr", status: "done", execution: 2 },
    ]);
  });

  it("uses phase transitions when the journal has them (and then no separate end event)", () => {
    const run = {
      ...base({ status: "done", finishedAt: 9000 }),
      attempt: 2,
      transitions: [
        { phase: "running", at: 1000, attempt: 1 },
        { phase: "interrupted", at: 2000, attempt: 1 },
        { phase: "continuing", at: 3000, attempt: 2 },
        { phase: "running", at: 3001, attempt: 2 },
        { phase: "done", at: 9000, attempt: 2 },
      ],
    } as RunState;
    expect(runEvents(run)).toEqual([
      { type: "phase", phase: "interrupted", at: 2000, attempt: 1 },
      { type: "phase", phase: "continuing", at: 3000, attempt: 2 },
      { type: "phase", phase: "done", at: 9000, attempt: 2 },
    ]);
  });
});

describe("eventsAfter", () => {
  it("returns only what's new since the cursor, and the cursor survives a round trip through a string", () => {
    const run = base({ nodes: { plan: { status: "running", executions: 1 }, impl: { status: "idle", executions: 0 } } });
    const first = eventsAfter(run);
    expect(first.events).toEqual([]);
    run.nodes.plan.status = "done";
    run.questions = [{ nodeId: "impl", question: "Ok?", askedAt: 2 }];
    run.pendingQuestion = { nodeId: "impl", question: "Ok?", askedAt: 2 };
    const second = eventsAfter(run, first.cursor);
    expect(second.events).toEqual([
      { type: "node", node: "plan", status: "done", execution: 1 },
      { type: "question", node: "impl", question: "Ok?", pending: true },
    ]);
    expect(eventsAfter(run, second.cursor).events).toEqual([]);
    // Answering doesn't repeat the question; finishing adds the end.
    run.questions[0].answer = "yes";
    run.pendingQuestion = undefined;
    run.status = "done";
    run.finishedAt = 3;
    expect(eventsAfter(structuredClone(run), second.cursor).events).toEqual([{ type: "end", status: "done" }]);
  });

  it("treats a missing or unreadable cursor as the start", () => {
    const run = base({ status: "cancelled", finishedAt: 2 });
    expect(eventsAfter(run, "garbage").events).toEqual([{ type: "end", status: "cancelled" }]);
    expect(eventsAfter(run, "").events).toEqual([{ type: "end", status: "cancelled" }]);
  });
});
