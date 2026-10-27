import { describe, expect, it } from "vitest";
import { recoveryLine } from "../src/components/Recovery";

describe("recovery in the Run tab", () => {
  it("one line per thing recovery did: cause → decision, by whom, how", () => {
    expect(recoveryLine({ at: 1, cause: "crash", message: "x", decision: "retry", by: "auto", delayMs: 2000, session: "resume" })).toBe(
      "crashed → retried automatically after 2s (its own agent session)",
    );
    expect(recoveryLine({ at: 1, cause: "error", message: "x", decision: "blocked", by: "triage", guard: "needs-human" })).toBe("failed → held for you by triage");
    expect(recoveryLine({ at: 1, cause: "timeout", message: "x", decision: "rescope", by: "triage", session: "fresh" })).toBe(
      "ran out of time → rescoped by triage (fresh agent session)",
    );
  });
});
