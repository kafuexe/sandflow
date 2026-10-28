import { describe, expect, it } from "vitest";
import { startRun, type NodeRunner } from "../backend/engine";
import { formatUsd, modelPrice, runUsage, usageCost } from "../shared/pricing";
import type { BlockDef, Flow, RunState } from "../shared/types";

describe("pricing", () => {
  it("prices Claude model ids, aliases and platform ids; not others", () => {
    expect(modelPrice("claude-opus-5-5")?.input).toBe(4);
    expect(modelPrice("claude-opus-5")?.input).toBe(5);
    expect(modelPrice("anthropic.claude-sonnet-5-5")?.output).toBe(10);
    expect(modelPrice("opus")).toEqual(modelPrice("claude-opus-5-5"));
    expect(modelPrice("claude-haiku-4-5")?.input).toBe(1);
    expect(modelPrice("gpt-5")).toBeUndefined();
    expect(modelPrice("")).toBeUndefined();
  });

  it("adds input, output and cache tokens", () => {
    // Opus 5.5: $4 in, $20 out, $0.20 cache read, $5 cache write per million.
    expect(usageCost({ inputTokens: 1e6, outputTokens: 1e6, cacheReadTokens: 1e6, cacheWriteTokens: 1e6 }, "claude-opus-5-5")).toBeCloseTo(29.2);
    expect(usageCost({ inputTokens: 10, outputTokens: 10 }, undefined)).toBeUndefined();
    expect(formatUsd(0.004)).toBe("<$0.01");
    expect(formatUsd(1.5)).toBe("$1.50");
  });

  it("totals a run with its stack children and counts unpriced turns", () => {
    const run = (id: string, usage: RunState["nodes"][string]["usage"]): RunState =>
      ({ id, flowId: "f", flowName: "F", status: "done", startedAt: 0, logs: [], nodes: { a: { status: "done", executions: 1, usage } } }) as RunState;
    const parent = run("p", [{ inputTokens: 100, outputTokens: 10, costUsd: 0.5, at: 0 }, { inputTokens: 5, outputTokens: 5, at: 0 }]);
    const child = run("c", [{ inputTokens: 1, outputTokens: 1, costUsd: 0.25, at: 0 }]);
    const t = runUsage(parent, [child]);
    expect(t.costUsd).toBeCloseTo(0.75);
    expect(t.inputTokens).toBe(106);
    expect(t.unpriced).toBe(1);
  });
});

describe("engine: budget", () => {
  const blocks: BlockDef[] = [{ id: "agent", name: "Agent", isTemplate: false, config: { kind: "ai", inputs: { artifact: true }, outputs: { artifact: true } } }];
  const flow = (budgetUsd?: number): Flow => ({
    id: "b", name: "B", budgetUsd,
    nodes: [
      { id: "one", type: "block", position: { x: 0, y: 0 }, data: { blockId: "agent" } },
      { id: "two", type: "block", position: { x: 0, y: 0 }, data: { blockId: "agent" } },
    ],
    edges: [{ id: "1", source: "one", target: "two", sourceHandle: "artifact", targetHandle: "artifact" }],
  });
  // Each step spends $4 (a million Opus 5.5 input tokens).
  const runner: NodeRunner = async (c, node) => {
    c.noteUsage?.(node.id, { inputTokens: 1e6, outputTokens: 0, model: "claude-opus-5-5" });
    await new Promise((r) => setTimeout(r, 5));
    return { outputs: { artifact: "x" } };
  };
  const go = (f: Flow) => startRun({ flow: f, blocks, env: {}, settings: { startingPrompt: "x", sandbox: "none", maxSteps: 10 }, runners: { auto: runner, ai: runner } }).done;

  it("prices usage and keeps the run total", async () => {
    const final = await go(flow());
    expect(final.status).toBe("done");
    expect(final.nodes.one.usage?.[0].costUsd).toBe(4);
    expect(final.costUsd).toBe(8);
  });

  it("warns near the budget and stops the run past it", async () => {
    const final = await go(flow(5));
    expect(final.status).toBe("cancelled");
    expect(final.flags?.some((f) => f.severity === "warning" && /of the flow's \$5\.00 budget/.test(f.message))).toBe(true);
    expect(final.flags?.some((f) => f.severity === "error" && /over the flow's \$5\.00 budget/.test(f.message))).toBe(true);
  });
});
