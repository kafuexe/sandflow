import { describe, expect, it } from "vitest";
import { agentSandboxKind, hostChoiceOwner, runAi } from "../backend/runners/ai";
import type { RunContext } from "../backend/engine";
import { validateFlow } from "../shared/flowOps";
import { CORE_BLOCKS, SUBFLOW_BLOCK } from "../shared/core";
import { BUILTIN_BLOCKS } from "../shared/library";
import { flowRequirements, resolveBlock, resolveNode } from "../shared/resolve";
import { hostAgentEnv, resolveRunOn, runOnProblem, settingsRunOn } from "../shared/runOn";
import type { BlockDef, Flow, FlowNode, ResolvedConfig, Settings } from "../shared/types";
import { missingInputs, validateBlocks } from "../shared/validate";

const node = (id: string, blockId: string, overrides?: FlowNode["data"]["overrides"]): FlowNode => ({
  id,
  type: "block",
  position: { x: 0, y: 0 },
  data: { blockId, ...(overrides ? { overrides } : {}) },
});
const flowOf = (nodes: FlowNode[], extra: Partial<Flow> = {}): Flow => ({ id: "f", name: "F", nodes, edges: [], ...extra });

describe("resolveRunOn", () => {
  it("takes the first explicit choice, most specific first", () => {
    expect(resolveRunOn(["host", "sandbox"], "docker")).toBe("host");
    expect(resolveRunOn(["inherit", "sandbox"], "none")).toBe("sandbox");
    expect(resolveRunOn([undefined, "inherit", "host"], "docker")).toBe("host");
  });
  it("falls back to Settings → Sandbox (None = this computer), or undefined without settings", () => {
    expect(resolveRunOn(["inherit"], "docker")).toBe("sandbox");
    expect(resolveRunOn([], "podman")).toBe("sandbox");
    expect(resolveRunOn([undefined], "none")).toBe("host");
    expect(resolveRunOn(["inherit"])).toBeUndefined();
    expect(settingsRunOn("none")).toBe("host");
  });
  it("ignores unknown values", () => {
    expect(resolveRunOn(["laptop" as never], "docker")).toBe("sandbox");
  });
  it("runOnProblem accepts the three values (flows: two)", () => {
    expect(runOnProblem(undefined)).toBeUndefined();
    expect(runOnProblem("inherit")).toBeUndefined();
    expect(runOnProblem("host")).toBeUndefined();
    expect(runOnProblem("laptop")).toMatch(/runOn/);
    expect(runOnProblem("inherit", false)).toMatch(/runOn/);
  });
});

describe("runOn in block resolution and validation", () => {
  const mine: BlockDef = { id: "local-plan", name: "Local plan", isTemplate: false, extends: "plan", config: { runOn: "host" } };
  const blocks = [...BUILTIN_BLOCKS, mine];

  it("defaults to inherit, is set by a block and overridden by a node", () => {
    expect(resolveBlock("plan", BUILTIN_BLOCKS).runOn).toBe("inherit");
    expect(resolveBlock("local-plan", blocks).runOn).toBe("host");
    expect(resolveNode(node("n", "local-plan", { runOn: "inherit" }), blocks).runOn).toBe("inherit");
    expect(resolveNode(node("n", "plan", { runOn: "sandbox" }), blocks).runOn).toBe("sandbox");
  });

  it("rejects invalid values on blocks, nodes and flows", () => {
    expect(validateBlocks([...BUILTIN_BLOCKS, { ...mine, config: { runOn: "pc" as never } }]).join()).toMatch(/Local plan.*runOn/);
    const f = flowOf([node("p", "plan", { runOn: "pc" as never })], { runOn: "inherit" as never });
    const errors = validateFlow(f, BUILTIN_BLOCKS).errors.join("\n");
    expect(errors).toMatch(/Node "p".*runOn/);
    expect(errors).toMatch(/Flow:.*runOn/);
    expect(validateFlow(flowOf([node("p", "plan", { runOn: "host" })], { runOn: "host" }), BUILTIN_BLOCKS).errors).toEqual([]);
  });
});

describe("flowRequirements: agents on this computer use their own login", () => {
  const env = { REPO_PATH: "/r" };
  const all = [...BUILTIN_BLOCKS, ...CORE_BLOCKS];
  const names = (f: Flow, flows: Flow[] = []) => flowRequirements(f, all, flows).env.map((e) => e.name);

  it("needs the API key for container agents", () => {
    expect(names(flowOf([node("p", "plan")]))).toContain("ANTHROPIC_API_KEY");
    expect(names(flowOf([node("p", "plan", { runOn: "sandbox" })], { runOn: "host" }))).toContain("ANTHROPIC_API_KEY");
  });
  it("drops it for a node or flow set to run on this computer", () => {
    expect(names(flowOf([node("p", "plan", { runOn: "host" })]))).not.toContain("ANTHROPIC_API_KEY");
    const f = flowOf([node("p", "plan")], { runOn: "host" });
    expect(names(f)).toEqual(["REPO_PATH"]);
    expect(missingInputs(f, BUILTIN_BLOCKS, env, "x")).toEqual([]);
  });
  it("keeps it when the agent uses a custom endpoint", () => {
    expect(names(flowOf([node("p", "plan", { runOn: "host", agent: { endpoint: "https://llm.corp" } })]))).toContain("ANTHROPIC_API_KEY");
  });
  it("subflows inherit the parent flow's choice", () => {
    const child = flowOf([node("p", "plan")], { id: "child" });
    const parent = flowOf([node("s", SUBFLOW_BLOCK, { subflow: { flowId: "child" } })], { id: "parent", runOn: "host" });
    expect(names(parent, [parent, child])).not.toContain("ANTHROPIC_API_KEY");
    expect(names({ ...parent, runOn: undefined }, [parent, child])).toContain("ANTHROPIC_API_KEY");
  });
});

describe("hostAgentEnv", () => {
  it("drops blank values and login vars unless a custom endpoint needs them", () => {
    const env = { ANTHROPIC_API_KEY: "k", REPO_PATH: "/r", EMPTY: " " };
    expect(hostAgentEnv(env)).toEqual({ REPO_PATH: "/r" });
    expect(hostAgentEnv(env, true)).toEqual({ ANTHROPIC_API_KEY: "k", REPO_PATH: "/r" });
  });
});

// ---------- runner ----------

function fakeSandbox(stdout = "<artifact>done</artifact>") {
  const calls = { exec: [] as string[], run: [] as Record<string, unknown>[] };
  return {
    calls,
    sandbox: {
      exec: async (cmd: string) => (calls.exec.push(cmd), { exitCode: 0, stdout: "", stderr: "" }),
      run: async (o: Record<string, unknown>) => (calls.run.push(o), { stdout, commits: [], iterations: [] }),
      close: async () => ({}),
    },
  };
}

function ctx(opts: { settings?: Partial<Settings>; flow?: Flow; flows?: Flow[]; trusted?: boolean } = {}) {
  const env: Record<string, string> = { REPO_PATH: "/r", ANTHROPIC_API_KEY: "k" };
  const container = fakeSandbox("<artifact>container</artifact>");
  const host = fakeSandbox("<artifact>host</artifact>");
  const logs: string[] = [];
  const flow = opts.flow ?? flowOf([]);
  const c = {
    settings: { startingPrompt: "", sandbox: "docker", maxSteps: 10, ...opts.settings },
    env,
    flow,
    flows: opts.flows ?? [flow],
    blocks: BUILTIN_BLOCKS,
    sandbox: container.sandbox,
    sandboxes: { none: host.sandbox },
    run: { id: "r", flowId: (opts.flows ?? [flow])[0].id, flowName: "F", status: "running", startedAt: 0, nodes: {}, logs: [] },
    blockEnv: (cfg: ResolvedConfig) => Object.fromEntries(cfg.env.filter((k) => k in env).map((k) => [k, env[k]])),
    log: (_l: string, m: string) => void logs.push(m),
    ask: async () => "",
    abort: new AbortController(),
    installedSkills: new Set(),
    preparedPacks: new Set(),
    cleanup: [],
    packs: { runtime: (id: string) => ({ id, dir: `/packs/${id}`, trustHost: !!opts.trusted }), dirs: () => [], runtimeRoot: "/rt" },
  } as unknown as RunContext;
  return { c, container: container.calls, host: host.calls, logs };
}

const noSkills = (cfg: ResolvedConfig): ResolvedConfig => ({ ...cfg, skills: [] });

describe("agentSandboxKind", () => {
  const cfg = resolveBlock("plan", BUILTIN_BLOCKS);
  it("follows node/block, then the flow, then the top-level flow, then Settings", () => {
    expect(agentSandboxKind(ctx().c, cfg)).toBe("docker");
    expect(agentSandboxKind(ctx({ settings: { sandbox: "podman" } }).c, cfg)).toBe("podman");
    expect(agentSandboxKind(ctx({ settings: { sandbox: "none" } }).c, cfg)).toBe("none");
    expect(agentSandboxKind(ctx().c, { ...cfg, runOn: "host" })).toBe("none");
    expect(agentSandboxKind(ctx({ flow: flowOf([], { runOn: "host" }) }).c, cfg)).toBe("none");
    expect(agentSandboxKind(ctx({ flow: flowOf([], { runOn: "host" }) }).c, { ...cfg, runOn: "sandbox" })).toBe("docker");
    const root = flowOf([], { id: "root", runOn: "host" });
    expect(agentSandboxKind(ctx({ flow: flowOf([], { id: "sub" }), flows: [root] }).c, cfg)).toBe("none");
  });
  it("uses Docker for a container agent when Settings → Sandbox is None", () => {
    expect(agentSandboxKind(ctx({ settings: { sandbox: "none" } }).c, { ...cfg, runOn: "sandbox" })).toBe("docker");
  });
});

describe("runAi on this computer", () => {
  const plan = noSkills(resolveBlock("plan", BUILTIN_BLOCKS));

  it("runs a host block in the host sandbox even when Settings use Docker, without the container's API key", async () => {
    const { c, container, host, logs } = ctx();
    const res = await runAi(c, node("p", "plan", { runOn: "host" }), { ...plan, runOn: "host" }, {});
    expect(res.outputs.artifact).toBe("host");
    expect(container.run).toHaveLength(0);
    expect(host.run).toHaveLength(1);
    const agent = host.run[0].agent as { env?: Record<string, string> };
    expect(JSON.stringify(agent)).not.toContain("ANTHROPIC_API_KEY");
    expect(logs.join("\n")).toMatch(/this computer/i);
  });

  it("keeps using the run's container for other blocks", async () => {
    const { c, container, host } = ctx();
    expect((await runAi(c, node("p", "plan"), plan, {})).outputs.artifact).toBe("container");
    expect(container.run).toHaveLength(1);
    expect(JSON.stringify(container.run[0].agent)).toContain("ANTHROPIC_API_KEY");
    expect(host.run).toHaveLength(0);
  });

  it("installs a skill separately for the container and this computer", async () => {
    const { c, container, host } = ctx();
    const withSkill = { ...plan, skills: [{ name: "tdd", source: "mattpocock/skills" }] };
    await runAi(c, node("a", "plan"), withSkill, {});
    await runAi(c, node("b", "plan"), { ...withSkill, runOn: "host" }, {});
    await runAi(c, node("c", "plan"), { ...withSkill, runOn: "host" }, {});
    expect(container.exec.filter((x) => x.includes("skills@latest add"))).toHaveLength(1);
    expect(host.exec.filter((x) => x.includes("skills@latest add"))).toHaveLength(1);
  });

  it("refuses when an untrusted pack chose this computer", async () => {
    const packBlock: BlockDef = { id: "acme/local", name: "Local", isTemplate: false, extends: "plan", pack: "acme", config: { runOn: "host" } };
    const blocks = [...BUILTIN_BLOCKS, packBlock];
    const n = node("p", "acme/local");
    const cfg = noSkills(resolveNode(n, blocks));
    const untrusted = ctx();
    untrusted.c.blocks = blocks;
    expect(hostChoiceOwner(untrusted.c, n, cfg)).toBe("acme");
    await expect(runAi(untrusted.c, n, cfg, {})).rejects.toThrow(/Pack "acme".*trust/);
    expect(untrusted.host.run).toHaveLength(0);

    const trusted = ctx({ trusted: true });
    trusted.c.blocks = blocks;
    expect((await runAi(trusted.c, n, cfg, {})).outputs.artifact).toBe("host");

    // Your own choice on the node is always fine.
    const own = node("p", "acme/local", { runOn: "host" });
    expect(hostChoiceOwner(untrusted.c, own, cfg)).toBeUndefined();
  });
});
