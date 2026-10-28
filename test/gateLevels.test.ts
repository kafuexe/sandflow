import { describe, expect, it } from "vitest";
import { startRun, type NodeRunner, type RunContext } from "../backend/engine";
import type { TriageRunner } from "../backend/recovery";
import { runAi } from "../backend/runners/ai";
import { runAuto } from "../backend/runners/auto";
import { runChecks } from "../backend/runners/checks";
import { blockingGates, gateResult } from "../backend/runners/gate";
import { configProblems } from "../shared/blockHelp";
import { FinalError, worstLevel } from "../shared/gates";
import { BUILTIN_BLOCKS } from "../shared/library";
import { DEFAULT_CONFIG, applyConfig, resolveBlock } from "../shared/resolve";
import type { BlockDef, CheckCommand, Flow, FlowEdge, GateFailLevel, NodeRunState, ResolvedConfig } from "../shared/types";

const BLOCKS: BlockDef[] = [
  { id: "checks", name: "Checks", isTemplate: false, config: { kind: "auto", autoAction: "checks", inputs: { artifact: true, steer: true }, outputs: { artifact: true, steer: true } } },
  { id: "agent", name: "Agent", isTemplate: false, config: { kind: "ai", inputs: { artifact: true, steer: true }, outputs: { artifact: true, steer: true } } },
];
const failEdge: FlowEdge = { id: "f", source: "c", target: "fix", sourceHandle: "exit:fail", targetHandle: "steer" };
const node = { id: "c", type: "block" as const, position: { x: 0, y: 0 }, data: { blockId: "checks" } };

/** A sandbox answering git state, then each check by its command text (exit code from `exits`). */
function checksSandbox(exits: Record<string, number>) {
  return {
    worktreePath: "/w",
    async exec(cmd: string) {
      if (cmd.startsWith("git rev-parse HEAD")) return { exitCode: 0, stdout: "abc" };
      const command = /sh -c '([^']*)'/.exec(cmd)?.[1] ?? cmd;
      const code = exits[command] ?? 0;
      return { exitCode: code, stdout: `${command} output`, stderr: code ? "boom" : "" };
    },
    run: async () => ({ stdout: "", commits: [], iterations: [] }),
    close: async () => ({}),
  };
}

function ctxOf(sandbox: unknown, ns: NodeRunState, edges: FlowEdge[] = []): RunContext {
  return {
    settings: { startingPrompt: "Build it", sandbox: "docker", maxSteps: 10 },
    env: { REPO_PATH: "/r", ANTHROPIC_API_KEY: "k" },
    flow: { id: "f", name: "F", nodes: [node], edges },
    run: { id: "r", flowId: "f", flowName: "F", status: "running", startedAt: 0, nodes: { c: ns }, logs: [] },
    blockEnv: () => ({ REPO_PATH: "/r", ANTHROPIC_API_KEY: "k" }),
    log: () => {},
    ask: async () => "",
    abort: new AbortController(),
    installedSkills: new Set(),
    sandbox,
    nodeState: () => ns,
    blocks: [...BLOCKS, ...BUILTIN_BLOCKS],
    cleanup: [],
    loadSkill: async () => [{ path: "SKILL.md", content: "skill" }],
  } as unknown as RunContext;
}

const checksCfg = (commands: CheckCommand[], onFail: GateFailLevel = "retry"): ResolvedConfig => ({
  ...DEFAULT_CONFIG,
  kind: "auto",
  autoAction: "checks",
  checks: { commands, reuse: false },
  onFail,
});
const ns = (): NodeRunState => ({ status: "running", executions: 1 });

describe("failure levels", () => {
  it("orders levels note < retry < block < stop", () => {
    expect(worstLevel(["note", "block", "retry"])).toBe("block");
    expect(worstLevel(["retry", "stop", "note"])).toBe("stop");
    expect(worstLevel([])).toBeUndefined();
  });

  it("are a config field, validated (the block's and each check's)", () => {
    expect(applyConfig(DEFAULT_CONFIG, {}).onFail).toBe("retry");
    expect(applyConfig(DEFAULT_CONFIG, { onFail: "block" }).onFail).toBe("block");
    expect(configProblems({ onFail: "stop" }, "ai")).toEqual([]);
    expect(configProblems({ onFail: "explode" }, "ai")[0]).toMatch(/unknown level/);
    expect(configProblems({ checks: { commands: [{ name: "t", run: "x", onFail: "nope" }] } }, "auto")[0]).toMatch(/commands\[\]\.onFail/);
  });
});

describe("Checks: failure levels", () => {
  const tests = { name: "tests", run: "npm test" };
  const lint = { name: "lint", run: "npm run lint" };

  it("note: reported, leaves through pass", async () => {
    const s = ns();
    const r = await runChecks(ctxOf(checksSandbox({ "npm test": 1 }), s, [failEdge]), node, checksCfg([tests], "note"), { steer: "in" });
    expect(r.exit).toBe("pass");
    expect(r.outputs.steer).toBe("in");
    expect(r.outputs.artifact).toMatch(/tests — failed \(note\)/);
    expect(s.gateBlock).toBeUndefined();
  });

  it("retry: leaves through fail with the failures as steer; flags it when nothing is wired to fail", async () => {
    const wired = await runChecks(ctxOf(checksSandbox({ "npm test": 1 }), ns(), [failEdge]), node, checksCfg([tests]), {});
    expect(wired.exit).toBe("fail");
    expect(wired.outputs.steer).toMatch(/1\. tests:/);
    expect(wired.flags).toBeUndefined();
    const loose = await runChecks(ctxOf(checksSandbox({ "npm test": 1 }), ns()), node, checksCfg([tests]), {});
    expect(loose.exit).toBe("fail");
    expect(loose.flags?.[0].message).toMatch(/nothing is connected to its fail exit/);
  });

  it("block: leaves through fail (pass when fail isn't wired), recorded until the gate passes", async () => {
    const s = ns();
    const r = await runChecks(ctxOf(checksSandbox({ "npm test": 1 }), s, [failEdge]), node, checksCfg([tests], "block"), {});
    expect(r.exit).toBe("fail");
    expect(s.gateBlock?.message).toBe("tests");
    expect(r.flags?.[0].message).toMatch(/Create MR is blocked/);
    const ok = await runChecks(ctxOf(checksSandbox({}), s, [failEdge]), node, checksCfg([tests], "block"), {});
    expect(ok.exit).toBe("pass");
    expect(s.gateBlock).toBeUndefined();

    const s2 = ns();
    const loose = await runChecks(ctxOf(checksSandbox({ "npm test": 1 }), s2), node, checksCfg([tests], "block"), {});
    expect(loose.exit).toBe("pass");
    expect(s2.gateBlock).toBeDefined();
  });

  it("stop: fails the run with a final error naming the gate and the failures", async () => {
    const p = runChecks(ctxOf(checksSandbox({ "npm test": 1 }), ns()), node, checksCfg([tests], "stop"), {});
    await expect(p).rejects.toBeInstanceOf(FinalError);
    await expect(runChecks(ctxOf(checksSandbox({ "npm test": 1 }), ns()), node, checksCfg([tests], "stop"), {})).rejects.toThrow(/Gate "Checks" failed \(on failure: stop\): tests/);
  });

  it("takes the most severe failed check; a check overrides the block; advisory stays report-only", async () => {
    const sb = () => checksSandbox({ "npm test": 1, "npm run lint": 1 });
    // lint is note, tests is block → block.
    const s = ns();
    const r = await runChecks(ctxOf(sb(), s, [failEdge]), node, checksCfg([{ ...lint, onFail: "note" }, { ...tests, onFail: "block" }]), {});
    expect(r.exit).toBe("fail");
    expect(s.gateBlock?.message).toBe("tests");
    expect(r.outputs.steer).not.toMatch(/lint/);
    // The block says stop, but each failing check says note → pass.
    const notes = await runChecks(ctxOf(sb(), ns()), node, checksCfg([{ ...lint, onFail: "note" }, { ...tests, onFail: "note" }], "stop"), {});
    expect(notes.exit).toBe("pass");
    // Advisory checks never gate, whatever the block's level.
    const adv = await runChecks(ctxOf(sb(), ns()), node, checksCfg([{ ...lint, required: false }], "stop"), {});
    expect(adv.exit).toBe("pass");
    expect(adv.outputs.artifact).toMatch(/lint — failed \(advisory\)/);
  });
});

describe("agent verdict: failure levels", () => {
  const agentSandbox = (...outputs: string[]) => {
    const result = (stdout: string): any => ({ stdout, commits: [], iterations: [], resume: async () => result(outputs.shift() ?? "") });
    return { exec: async () => ({ exitCode: 0, stdout: "", stderr: "" }), run: async () => result(outputs.shift() ?? ""), close: async () => ({}) };
  };
  const tnode = { ...node, data: { blockId: "cr" } };
  const gate = (onFail: GateFailLevel) => applyConfig(resolveBlock("cr", BUILTIN_BLOCKS), { verdict: true, skills: [], onFail });
  const fail = "<artifact>broken</artifact><steer>1. fix it</steer><verdict>FAIL</verdict>";

  it("note: a FAIL verdict counts as PASS, noted in the artifact", async () => {
    const r = await runAi(ctxOf(agentSandbox(fail), ns()), tnode, gate("note"), {});
    expect(r.exit).toBe("pass");
    expect(r.outputs.artifact).toMatch(/recorded as a note/);
  });

  it("retry: FAIL leaves through fail", async () => {
    const r = await runAi(ctxOf(agentSandbox(fail), ns(), [failEdge]), tnode, gate("retry"), {});
    expect(r.exit).toBe("fail");
    expect(r.outputs.steer).toBe("1. fix it");
  });

  it("block: FAIL is recorded on the node, and a PASS clears it", async () => {
    const s = ns();
    const r = await runAi(ctxOf(agentSandbox(fail), s, [failEdge]), tnode, gate("block"), {});
    expect(r.exit).toBe("fail");
    expect(s.gateBlock?.message).toBe("verdict FAIL");
    await runAi(ctxOf(agentSandbox("<verdict>PASS</verdict>"), s, [failEdge]), tnode, gate("block"), {});
    expect(s.gateBlock).toBeUndefined();
  });

  it("stop: FAIL — and no valid verdict — fails the run", async () => {
    await expect(runAi(ctxOf(agentSandbox(fail), ns()), tnode, gate("stop"), {})).rejects.toThrow(/on failure: stop\): verdict FAIL/);
    await expect(runAi(ctxOf(agentSandbox("<artifact>hmm</artifact>", "still hmm"), ns()), tnode, gate("stop"), {})).rejects.toThrow(/no valid verdict/);
  });

  it("note applies to a missing verdict too", async () => {
    const r = await runAi(ctxOf(agentSandbox("hmm", "still hmm"), ns()), tnode, gate("note"), {});
    expect(r.exit).toBe("pass");
  });
});

describe("Create MR and blocking gates", () => {
  const mrCfg: ResolvedConfig = { ...DEFAULT_CONFIG, kind: "auto", autoAction: "create-mr", env: ["REPO_PATH"] };
  const mrNode = { id: "mr", type: "block" as const, position: { x: 0, y: 0 }, data: { blockId: "agent" } };

  it("refuses (finally) while a gate's blocking failure is recorded", async () => {
    const s: NodeRunState = { status: "done", executions: 1, gateBlock: { message: "tests", at: 1 } };
    const p = runAuto(ctxOf(undefined, s), mrNode, mrCfg, {});
    await expect(p).rejects.toBeInstanceOf(FinalError);
    await expect(runAuto(ctxOf(undefined, s), mrNode, mrCfg, {})).rejects.toThrow(/Not creating the MR: blocked by failed gate Checks \(tests\)/);
  });

  it("lists only gates that haven't passed since", () => {
    const run = { nodes: { a: { status: "done", executions: 2 }, "sub/b": { status: "done", executions: 1, gateBlock: { message: "verdict FAIL", at: 1 } } } } as any;
    expect(blockingGates(run, (k) => k)).toEqual(["sub/b (verdict FAIL)"]);
  });
});

describe("engine: gate levels", () => {
  const n = (id: string, blockId: string) => ({ id, type: "block" as const, position: { x: 0, y: 0 }, data: { blockId } });
  const flow = (edges: FlowEdge[]): Flow => ({
    id: "g",
    name: "G",
    nodes: [n("impl", "agent"), n("c", "checks"), n("fix", "agent"), n("ship", "agent")],
    edges: [{ id: "i", source: "impl", target: "c", sourceHandle: "artifact", targetHandle: "artifact" }, ...edges],
  });
  const passEdge: FlowEdge = { id: "p", source: "c", target: "ship", sourceHandle: "exit:pass", targetHandle: "artifact" };
  const back: FlowEdge = { id: "b", source: "fix", target: "c", sourceHandle: "artifact", targetHandle: "artifact" };
  let asked = 0;
  const triage: TriageRunner = async () => (asked++, JSON.stringify({ action: "retry", reason: "again" }));
  const start = (f: Flow, runner: NodeRunner) =>
    startRun({ flow: f, blocks: BLOCKS, flows: [f], env: {}, settings: { startingPrompt: "x", sandbox: "none", maxSteps: 20 }, runners: { auto: runner, ai: runner, triage }, sleep: async () => {} });

  it("stop fails the whole run at once — no recovery, nothing after it runs", async () => {
    asked = 0;
    let runs = 0;
    const runner: NodeRunner = async (ctx, node) => {
      if (node.id === "c") return (runs++, gateResult(ctx, node, { level: "stop", failures: "tests" }));
      return { outputs: { artifact: "ok" } };
    };
    const final = await start(flow([passEdge, failEdge]), runner).done;
    expect(final.status).toBe("failed");
    expect(final.error).toMatch(/Gate "Checks" failed \(on failure: stop\): tests/);
    expect(runs).toBe(1);
    expect(asked).toBe(0);
    expect(final.nodes.fix?.executions ?? 0).toBe(0);
    expect(final.nodes.ship?.executions ?? 0).toBe(0);
  });

  it("block → fix → pass clears the record before ship; unfixed and unwired, ship still sees it", async () => {
    let checks = 0;
    let seen: string[] = ["unset"];
    const runner = (failTimes: number): NodeRunner => async (ctx, node) => {
      if (node.id === "c") return gateResult(ctx, node, ++checks <= failTimes ? { level: "block", failures: "tests" } : {});
      if (node.id === "ship") seen = blockingGates(ctx.run, (k) => k);
      return { outputs: { artifact: `${node.id} done` } };
    };
    const fixed = await start(flow([passEdge, failEdge, back]), runner(1)).done;
    expect(fixed.error).toBeUndefined();
    expect(fixed.status).toBe("done");
    expect(fixed.nodes.c.executions).toBe(2);
    expect(seen).toEqual([]);

    checks = 0;
    const unwired = await start(flow([passEdge]), runner(99)).done;
    expect(unwired.nodes.c.exit).toBe("pass");
    expect(seen).toEqual(["c (tests)"]);
    expect(unwired.flags?.some((f) => /Create MR is blocked/.test(f.message))).toBe(true);
  });
});
