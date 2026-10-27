import { describe, expect, it } from "vitest";
import { sectionRuns } from "../src/lib/runGroups";
import { activeRunsOf } from "../src/lib/runSelection";
import { steerability } from "../src/lib/steer";
import { resumeBlocker } from "../shared/resume";
import type { RunSummary } from "../shared/types";

const row = (id: string, o: Partial<RunSummary> = {}): RunSummary => ({ id, flowId: "f", flowName: "F", status: "running", startedAt: 1, ...o });

describe("durable runs in the UI", () => {
  it("a paused run isn't listed as working: it sits with the finished ones, flagged when it waits for you", () => {
    const paused = row("p", { status: "paused", phase: "interrupted", flags: { warning: 1, error: 0 } });
    const quiet = row("q", { status: "paused", phase: "paused" });
    const s = sectionRuns([row("r"), paused, quiet]);
    expect(s.running.map((r) => r.id)).toEqual(["r"]);
    expect(s.flagged.map((r) => r.id)).toEqual(["p"]);
    expect(s.earlier.map((r) => r.id)).toEqual(["q"]);
    expect(activeRunsOf([row("r"), quiet], "f").map((r) => r.id)).toEqual(["r"]);
  });

  it("a paused run can't be steered or resumed as a new run — it's continued", () => {
    const nodes = { a: { status: "idle" as const, executions: 1 } };
    expect(steerability({ nodes, phase: "paused" }, "a", { kind: "ai", agent: { provider: "claudeCode", model: "" } }).hint).toMatch(/paused/);
    expect(resumeBlocker({ phase: "interrupted", workspace: { branch: "b" } })).toMatch(/Continue it instead/);
  });
});
