// The supervisor and recovery together: a step the supervisor stops (stuck / timeout) fails with that cause, and
// recovery retries it automatically — the run doesn't fail.

import { describe, expect, it } from "vitest";
import { startRun, type NodeRunner } from "../backend/engine";
import type { TriageRunner } from "../backend/recovery";
import { CORE_BLOCKS } from "../shared/core";
import { BUILTIN_BLOCKS } from "../shared/library";
import type { Flow, Settings } from "../shared/types";

const blocks = [...CORE_BLOCKS, ...BUILTIN_BLOCKS];
const settings: Settings = { startingPrompt: "Do it", sandbox: "none", maxSteps: 40 };
const flow: Flow = { id: "f", name: "F", nodes: [{ id: "a", type: "block", position: { x: 0, y: 0 }, data: { blockId: "plan" } }], edges: [] };

describe("supervisor stop → recovery", () => {
  it("a step stopped as stuck is retried automatically, with its cause, and the run finishes", async () => {
    let calls = 0;
    let started!: () => void;
    const firstStarted = new Promise<void>((r) => (started = r));
    const runner: NodeRunner = async (ctx) => {
      calls++;
      if (calls === 1) {
        started();
        // Hangs until the supervisor stops it.
        await new Promise((_, reject) => ctx.abort.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
      }
      return { outputs: { artifact: "done" } };
    };
    const triage: TriageRunner = async () => {
      throw new Error("triage shouldn't be needed for a stuck step that works on retry");
    };
    const h = startRun({ flow, blocks, flows: [flow], env: { REPO_PATH: "/r" }, settings, runners: { auto: runner, ai: runner, triage }, sleep: async () => {} });
    await firstStarted;
    expect(h.stopNode("a", "stuck", "No sign of life for 30 min")).toBe(true);
    const run = await h.done;
    expect(run.status).toBe("done");
    expect(calls).toBe(2);
    expect(run.recovery?.a.history[0]).toMatchObject({ cause: "stuck", by: "auto" });
  });
});
