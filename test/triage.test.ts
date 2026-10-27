import { describe, expect, it } from "vitest";
import { TRIAGE_DENIED, TRIAGE_TOOLS, triageAnswer, triageArgs } from "../backend/triage";
import { eventsAfter } from "../shared/runEvents";
import type { RunState } from "../shared/types";

describe("the real triage agent (claude -p, read-only)", () => {
  it("allows only reading tools and git history, refuses edits, passes the model", () => {
    const args = triageArgs("haiku");
    expect(args.slice(0, 3)).toEqual(["-p", "--output-format", "json"]);
    expect(args[args.indexOf("--allowedTools") + 1]).toBe(TRIAGE_TOOLS.join(","));
    expect(TRIAGE_TOOLS.some((t) => /^(Edit|Write|Bash)$/.test(t))).toBe(false);
    expect(TRIAGE_TOOLS.filter((t) => t.startsWith("Bash(")).every((t) => /^Bash\(git (log|diff|status|show):\*\)$/.test(t))).toBe(true);
    expect(args[args.indexOf("--disallowedTools") + 1].split(",")).toEqual(expect.arrayContaining(["Edit", "Write"]));
    expect(TRIAGE_DENIED).toContain("Write");
    expect(args.slice(-2)).toEqual(["--model", "haiku"]);
    expect(triageArgs("")).not.toContain("--model");
  });

  it("reads the answer out of the JSON envelope; an error result throws", () => {
    expect(triageAnswer('{"type":"result","subtype":"success","is_error":false,"result":"{\\"action\\":\\"retry\\"}"}')).toBe('{"action":"retry"}');
    expect(() => triageAnswer('{"type":"result","subtype":"error_max_turns","is_error":true,"result":""}')).toThrow(/error_max_turns/);
    expect(triageAnswer("plain text answer")).toBe("plain text answer");
  });
});

describe("watchers see recovery events", () => {
  it("each recovery entry once, after the cursor", () => {
    const run = {
      id: "r",
      flowId: "f",
      flowName: "F",
      status: "running",
      startedAt: 1,
      nodes: { a: { status: "running", executions: 1 } },
      logs: [],
      recovery: { a: { cycles: 0, history: [{ at: 1, cause: "crash", message: "x", decision: "retry", by: "auto" }] } },
    } as unknown as RunState;
    const first = eventsAfter(run);
    expect(first.events).toEqual([{ type: "recovery", node: "a", cause: "crash", decision: "retry" }]);
    run.recovery!.a.history.push({ at: 2, cause: "error", message: "y", decision: "hold", by: "auto", guard: "recovery-exhausted", reason: "used all" });
    expect(eventsAfter(run, first.cursor).events).toEqual([{ type: "recovery", node: "a", cause: "error", decision: "hold", guard: "recovery-exhausted", reason: "used all" }]);
  });
});
