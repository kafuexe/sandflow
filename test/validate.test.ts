import { describe, expect, it } from "vitest";
import { BUILTIN_BLOCKS, DEFAULT_FLOW } from "../shared/library";
import { flowRequirements } from "../shared/resolve";
import { missingInputs, validateBlocks } from "../shared/validate";
import type { BlockDef, Flow } from "../shared/types";

describe("validateBlocks", () => {
  it("accepts the builtins", () => {
    expect(validateBlocks(BUILTIN_BLOCKS)).toEqual([]);
  });
  it("rejects duplicate ids", () => {
    expect(validateBlocks([...BUILTIN_BLOCKS, BUILTIN_BLOCKS[0]]).join()).toMatch(/duplicate/i);
  });
  it("rejects extending a non-template", () => {
    const bad: BlockDef = { id: "x", name: "X", isTemplate: false, extends: "plan", config: {} };
    expect(validateBlocks([...BUILTIN_BLOCKS, bad]).join()).toMatch(/not a template/i);
  });
  it("rejects missing parents and cycles", () => {
    const a: BlockDef = { id: "a", name: "A", isTemplate: true, extends: "b", config: {} };
    const b: BlockDef = { id: "b", name: "B", isTemplate: true, extends: "a", config: {} };
    expect(validateBlocks([a, b]).join()).toMatch(/cycle/i);
    const c: BlockDef = { id: "c", name: "C", isTemplate: false, extends: "nope", config: {} };
    expect(validateBlocks([c]).join()).toMatch(/unknown/i);
  });
  it("validates the agent endpoint and its env var name", () => {
    const ok: BlockDef = { id: "e", name: "E", isTemplate: false, config: { agent: { endpoint: "https://llm.corp:8443/v1" } } };
    expect(validateBlocks([ok])).toEqual([]);
    const badUrl: BlockDef = { id: "e", name: "E", isTemplate: false, config: { agent: { endpoint: "ftp://x" } } };
    expect(validateBlocks([badUrl]).join()).toMatch(/endpoint/i);
    const badVar: BlockDef = { id: "e", name: "E", isTemplate: false, config: { agent: { endpointEnv: "bad-name" } } };
    expect(validateBlocks([badVar]).join()).toMatch(/bad-name/);
  });

  it("requires every skill to have a valid GitHub source or a file", () => {
    const mk = (skills: BlockDef["config"]["skills"]): BlockDef[] => [{ id: "s", name: "S", isTemplate: false, config: { skills } }];
    expect(validateBlocks(mk([{ name: "a", source: "o/r" }]))).toEqual([]);
    expect(validateBlocks(mk([{ name: "a", file: { store: "user", dir: "a" } }]))).toEqual([]);
    expect(validateBlocks(mk([{ name: "a" }])).join()).toMatch(/skill "a"/i);
    expect(validateBlocks(mk([{ name: "a", source: "bad source" }])).join()).toMatch(/skill "a"/i);
    expect(validateBlocks(mk([{ name: "a", file: { store: "user", dir: "../x" } }])).join()).toMatch(/skill "a"/i);
  });

  it("validates trigger and condition settings", () => {
    const mk = (config: BlockDef["config"]): BlockDef[] => [{ id: "x", name: "X", isTemplate: false, config }];
    expect(validateBlocks(mk({ kind: "trigger", trigger: { type: "schedule", schedule: { kind: "cron", expr: "nope" } } })).join()).toMatch(/cron/i);
    expect(validateBlocks(mk({ trigger: { type: "github", repo: "not a repo" } })).join()).toMatch(/repository/i);
    expect(validateBlocks(mk({ trigger: { type: "gitlab", repo: "grp/sub/app", mode: "poll", pollSeconds: 5 } })).join()).toMatch(/15/);
    expect(validateBlocks(mk({ trigger: { type: "gitlab", secretEnv: "bad-name" } })).join()).toMatch(/bad-name/);
    expect(validateBlocks(mk({ trigger: { type: "github", events: ["issue.deleted" as never] } })).join()).toMatch(/event/i);
    expect(validateBlocks(mk({ condition: { match: "all", rules: [{ field: "text", op: "matches", value: "(" }] } })).join()).toMatch(/regex/i);
    expect(validateBlocks(mk({ kind: "trigger", trigger: { type: "gitlab", repo: "grp/sub/app", host: "gitlab.corp.local", mode: "poll", pollSeconds: 30 } }))).toEqual([]);
  });

  it("rejects invalid env names", () => {
    const d: BlockDef = { id: "d", name: "D", isTemplate: false, config: { env: ["BAD-NAME"] } };
    expect(validateBlocks([d]).join()).toMatch(/BAD-NAME/);
  });
});

describe("missingInputs", () => {
  it("lists missing env vars and starting prompt", () => {
    const missing = missingInputs(DEFAULT_FLOW, BUILTIN_BLOCKS, { REPO_PATH: "/r" }, "  ");
    expect(missing).toContain("Starting prompt");
    expect(missing).toContain("ANTHROPIC_API_KEY");
    expect(missing).not.toContain("REPO_PATH");
  });
  it("takes ANTHROPIC_AUTH_TOKEN (a gateway's bearer token, e.g. LiteLLM) in place of ANTHROPIC_API_KEY", () => {
    const env = Object.fromEntries(["REPO_PATH", "ANTHROPIC_AUTH_TOKEN", "BRANCH_NAME", "BASE_BRANCH", "MR_PROVIDER"].map((k) => [k, "x"]));
    expect(missingInputs(DEFAULT_FLOW, BUILTIN_BLOCKS, env, "do it")).toEqual([]);
  });
  it("is empty when all filled", () => {
    const env = Object.fromEntries(
      ["REPO_PATH", "ANTHROPIC_API_KEY", "BRANCH_NAME", "BASE_BRANCH", "MR_PROVIDER"].map((k) => [k, "x"]),
    );
    expect(missingInputs(DEFAULT_FLOW, BUILTIN_BLOCKS, env, "do it")).toEqual([]);
  });
});

describe("missingInputs for trigger-started runs", () => {
  const node = (id: string, blockId: string, overrides?: Record<string, unknown>) => ({
    id,
    type: "block" as const,
    position: { x: 0, y: 0 },
    data: { blockId, ...(overrides ? { overrides } : {}) },
  });
  const flow: Flow = { id: "f", name: "F", nodes: [node("t", "gitlab-trigger"), node("p", "plan")], edges: [] };
  const env = { ANTHROPIC_API_KEY: "k", GITLAB_WEBHOOK_SECRET: "s" };

  it("doesn't require a starting prompt (the event stands in for it); manual runs still do", () => {
    expect(missingInputs(flow, BUILTIN_BLOCKS, env, "", [], { triggered: true })).toEqual([]);
    expect(missingInputs(flow, BUILTIN_BLOCKS, env, "")).toEqual(["Starting prompt"]);
  });

  it("still requires env vars and the webhook secret — also when the mode is left at its webhook default", () => {
    expect(missingInputs(flow, BUILTIN_BLOCKS, {}, "", [], { triggered: true })).toEqual(["ANTHROPIC_API_KEY", "GITLAB_WEBHOOK_SECRET"]);
    const noMode = { ...flow, nodes: [node("t", "gitlab-trigger", { trigger: { mode: undefined } }), flow.nodes[1]] };
    const blocks = BUILTIN_BLOCKS.map((b) => (b.id === "gitlab-trigger" ? { ...b, config: { ...b.config, trigger: { ...b.config.trigger!, mode: undefined } } } : b));
    expect(missingInputs(noMode, blocks, { ANTHROPIC_API_KEY: "k" }, "", [], { triggered: true })).toEqual(["GITLAB_WEBHOOK_SECRET"]);
    const poll = { ...flow, nodes: [node("t", "gitlab-trigger", { trigger: { mode: "poll" } }), flow.nodes[1]] };
    expect(missingInputs(poll, BUILTIN_BLOCKS, { ANTHROPIC_API_KEY: "k" }, "", [], { triggered: true })).toEqual([]);
  });
});

describe("optional project path for agents", () => {
  const flowOf = (...blockIds: string[]): Flow => ({
    id: "f",
    name: "F",
    nodes: blockIds.map((blockId, i) => ({ id: `n${i}`, type: "block" as const, position: { x: 0, y: 0 }, data: { blockId } })),
    edges: [],
  });

  it("doesn't require REPO_PATH when only agent blocks use it", () => {
    const flow = flowOf("plan", "manager");
    const req = flowRequirements(flow, BUILTIN_BLOCKS);
    expect(req.env.find((e) => e.name === "REPO_PATH")?.optional).toBe(true);
    expect(req.env.find((e) => e.name === "ANTHROPIC_API_KEY")?.optional).toBe(false);
    expect(missingInputs(flow, BUILTIN_BLOCKS, { ANTHROPIC_API_KEY: "k" }, "do it")).toEqual([]);
  });

  it("still requires REPO_PATH when an auto block needs it", () => {
    const flow = flowOf("plan", "shell");
    expect(flowRequirements(flow, BUILTIN_BLOCKS).env.find((e) => e.name === "REPO_PATH")?.optional).toBe(false);
    expect(missingInputs(flow, BUILTIN_BLOCKS, { ANTHROPIC_API_KEY: "k" }, "do it")).toEqual(["REPO_PATH"]);
  });

  it("keeps other env vars of agent blocks required", () => {
    expect(missingInputs(flowOf("plan"), BUILTIN_BLOCKS, {}, "do it")).toEqual(["ANTHROPIC_API_KEY"]);
  });
});
