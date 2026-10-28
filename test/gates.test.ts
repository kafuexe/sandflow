import { describe, expect, it } from "vitest";
import { startRun, type NodeRunner, type RunContext } from "../backend/engine";
import { buildPrompt } from "../backend/prompt";
import { runChecks } from "../backend/runners/checks";
import { isDocsFile, onlyDocsChanged, parseVerdict } from "../shared/gates";
import { DEFAULT_CONFIG, applyConfig, resolveBlock } from "../shared/resolve";
import { resolveNodeIn } from "../shared/subflow";
import type { BlockDef, Flow, NodeRunState, ResolvedConfig, Settings } from "../shared/types";

const BLOCKS: BlockDef[] = [
  { id: "checks", name: "Checks", isTemplate: false, config: { kind: "auto", autoAction: "checks", inputs: { artifact: true, steer: true }, outputs: { artifact: true, steer: true } } },
  { id: "tester", name: "Test", isTemplate: false, config: { kind: "ai", verdict: true, inputs: { artifact: true, steer: true }, outputs: { artifact: true, steer: true } } },
  { id: "agent", name: "Agent", isTemplate: false, config: { kind: "ai", inputs: { artifact: true, steer: true }, outputs: { artifact: true, steer: true } } },
];

describe("verdicts and docs-only changes", () => {
  it("takes the last valid verdict, and nothing else", () => {
    expect(parseVerdict("<verdict>PASS</verdict>")).toBe("pass");
    expect(parseVerdict("first <verdict>PASS</verdict> then <verdict> fail </verdict>")).toBe("fail");
    expect(parseVerdict("STATUS: PASS")).toBeUndefined();
    expect(parseVerdict("<verdict>maybe</verdict>")).toBeUndefined();
  });

  it("knows docs from code", () => {
    for (const f of ["README.md", "docs/setup.txt", "packages/a/CHANGES.md", "LICENSE", "doc/x.png"]) expect(isDocsFile(f)).toBe(true);
    for (const f of ["src/app.ts", "package.json", "lib/README.ts"]) expect(isDocsFile(f)).toBe(false);
    expect(onlyDocsChanged(["README.md", "docs/a.md"])).toBe(true);
    expect(onlyDocsChanged(["README.md", "src/a.ts"])).toBe(false);
    expect(onlyDocsChanged([])).toBe(false);
  });

  it("gates leave through pass / fail", () => {
    const n = (blockId: string) => ({ id: "n", type: "block" as const, position: { x: 0, y: 0 }, data: { blockId } });
    expect(resolveNodeIn(n("checks"), BLOCKS, []).exits).toEqual(["pass", "fail"]);
    expect(resolveNodeIn(n("tester"), BLOCKS, []).exits).toEqual(["pass", "fail"]);
    expect(resolveNodeIn(n("agent"), BLOCKS, []).exits).toEqual([]);
  });

  it("asks a gate agent for its verdict, and tells it about the dev server", () => {
    const cfg = applyConfig(resolveBlock("tester", BLOCKS), { devServer: { command: "npm run dev", readyUrl: "http://127.0.0.1:3000/" } });
    const p = buildPrompt({ cfg, inputs: { artifact: "plan" }, startingPrompt: "", qa: [] });
    expect(p).toContain("<verdict>PASS</verdict>");
    expect(p).toContain("npm run dev");
    expect(buildPrompt({ cfg: resolveBlock("agent", BLOCKS), inputs: {}, startingPrompt: "", qa: [] })).not.toContain("verdict");
  });
});

describe("engine: gate exits", () => {
  const flow: Flow = {
    id: "g", name: "G",
    nodes: [
      { id: "impl", type: "block", position: { x: 0, y: 0 }, data: { blockId: "agent" } },
      { id: "check", type: "block", position: { x: 0, y: 0 }, data: { blockId: "checks" } },
      { id: "fix", type: "block", position: { x: 0, y: 0 }, data: { blockId: "agent" } },
      { id: "ship", type: "block", position: { x: 0, y: 0 }, data: { blockId: "agent" } },
    ],
    edges: [
      { id: "0", source: "impl", target: "check", sourceHandle: "artifact", targetHandle: "artifact" },
      { id: "1", source: "check", target: "ship", sourceHandle: "exit:pass", targetHandle: "artifact" },
      { id: "2", source: "check", target: "fix", sourceHandle: "exit:fail", targetHandle: "steer" },
      { id: "3", source: "fix", target: "check", sourceHandle: "artifact", targetHandle: "artifact" },
    ],
  };

  it("follows fail to the fix step and pass on, carrying the steer", async () => {
    let checksRun = 0;
    const runner: NodeRunner = async (_c, node) => {
      if (node.id === "check") return ++checksRun === 1 ? { exit: "fail", outputs: { artifact: "report", steer: "fix lint" } } : { exit: "pass", outputs: { artifact: "ok" } };
      return { outputs: { artifact: `${node.id} done` } };
    };
    const h = startRun({ flow, blocks: BLOCKS, env: {}, settings: { startingPrompt: "x", sandbox: "none", maxSteps: 20 }, runners: { auto: runner, ai: runner } });
    const final = await h.done;
    expect(final.error).toBeUndefined();
    expect(final.status).toBe("done");
    expect(final.nodes.fix.inputs?.steer).toBe("fix lint");
    expect(final.nodes.check.executions).toBe(2);
    expect(final.nodes.check.exit).toBe("pass");
    expect(final.nodes.ship.executions).toBe(1);
  });
});

/** A sandbox whose shell answers from a script: `git` state, then each check by its command text. */
function fakeSandbox(state: { git: string; exits: Record<string, number> }) {
  const ran: string[] = [];
  return {
    ran,
    sandbox: {
      worktreePath: "/w",
      async exec(cmd: string) {
        if (cmd.startsWith("git rev-parse HEAD")) return { exitCode: 0, stdout: state.git };
        const m = /sh -c '([^']*)'/.exec(cmd);
        const command = m?.[1] ?? cmd;
        ran.push(command);
        const code = state.exits[command] ?? 0;
        return { exitCode: code, stdout: `${command} output`, stderr: code ? "boom" : "" };
      },
      run: async () => ({ stdout: "", commits: [], iterations: [] }),
      close: async () => ({}),
    },
  };
}

function checksCtx(sandbox: unknown, ns: NodeRunState): RunContext {
  const settings: Settings = { startingPrompt: "", sandbox: "docker", maxSteps: 10 };
  return {
    settings,
    env: {},
    run: { id: "r", flowId: "f", flowName: "F", status: "running", startedAt: 0, nodes: { c: ns }, logs: [] },
    blockEnv: () => ({}),
    log: () => {},
    abort: new AbortController(),
    installedSkills: new Set(),
    sandbox,
    nodeState: () => ns,
    blocks: BLOCKS,
    cleanup: [],
  } as unknown as RunContext;
}

describe("Checks block", () => {
  const node = { id: "c", type: "block" as const, position: { x: 0, y: 0 }, data: { blockId: "checks" } };
  const cfg = (commands: ResolvedConfig["checks"]["commands"], reuse = true): ResolvedConfig => ({ ...DEFAULT_CONFIG, kind: "auto", autoAction: "checks", checks: { commands, reuse } });

  it("passes when every required check passes; an advisory failure is only reported", async () => {
    const { sandbox } = fakeSandbox({ git: "abc", exits: { "npm run lint": 1 } });
    const ns: NodeRunState = { status: "running", executions: 1 };
    const r = await runChecks(checksCtx(sandbox, ns), node, cfg([{ name: "lint", run: "npm run lint", required: false }, { name: "tests", run: "npm test" }]), {});
    expect(r.exit).toBe("pass");
    expect(r.outputs.artifact).toMatch(/Checks: PASS/);
    expect(r.outputs.artifact).toMatch(/lint — failed \(advisory\)/);
  });

  it("fails on a required check and hands its output on as the steer", async () => {
    const { sandbox } = fakeSandbox({ git: "abc", exits: { "npm test": 2 } });
    const ns: NodeRunState = { status: "running", executions: 1 };
    const r = await runChecks(checksCtx(sandbox, ns), node, cfg([{ name: "tests", run: "npm test" }]), {});
    expect(r.exit).toBe("fail");
    expect(r.outputs.steer).toMatch(/1\. tests:/);
    expect(r.outputs.steer).toMatch(/boom/);
    expect(ns.checks?.passed).toBe(false);
  });

  it("reuses passing results while nothing changed, and runs again once something did", async () => {
    const state = { git: "abc", exits: {} as Record<string, number> };
    const { sandbox, ran } = fakeSandbox(state);
    const ns: NodeRunState = { status: "running", executions: 1 };
    const c = checksCtx(sandbox, ns);
    const list = cfg([{ name: "tests", run: "npm test" }]);
    await runChecks(c, node, list, {});
    const again = await runChecks(c, node, list, {});
    expect(ran).toEqual(["npm test"]);
    expect(again.exit).toBe("pass");
    expect(again.outputs.artifact).toMatch(/results reused/);
    state.git = "def";
    await runChecks(c, node, list, {});
    expect(ran).toEqual(["npm test", "npm test"]);
    await runChecks(c, node, cfg(list.checks.commands, false), {});
    expect(ran).toHaveLength(3);
  });

  it("refuses an empty command list", async () => {
    const { sandbox } = fakeSandbox({ git: "abc", exits: {} });
    await expect(runChecks(checksCtx(sandbox, { status: "running", executions: 1 }), node, cfg([]), {})).rejects.toThrow(/no commands/);
  });
});
