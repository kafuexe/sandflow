// Integrations: definitions → blocks, option templates → argv, packs that bring them, and the runner driving a
// real process (node stands in for the harness).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startRun } from "../backend/engine";
import { createIntegrationStore } from "../backend/integrations";
import { createPackStore } from "../backend/packs";
import { runIntegration } from "../backend/runners/integration";
import { createStorage } from "../backend/storage";
import { CORE_BLOCKS } from "../shared/core";
import {
  actionExits,
  buildArgs,
  integrationBlocks,
  integrationInfo,
  integrationProblems,
  outputMatches,
  parseChoices,
  parseVersion,
} from "../shared/integrations";
import { manifestProblems } from "../shared/packs";
import { resolveNode } from "../shared/resolve";
import type { BlockDef, Flow, IntegrationDef, IntegrationInfo, Settings } from "../shared/types";

const dirs: string[] = [];
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "sandflow-int-"));
  dirs.push(d);
  return d;
};
afterEach(() => dirs.splice(0).forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

/** A MEOW-like harness definition. */
const harness = (over: Partial<IntegrationDef> = {}): IntegrationDef => ({
  id: "cat",
  name: "Cat harness",
  command: "cat-cli",
  env: ["REPO_PATH"],
  options: [{ id: "from", label: "From", type: "string", args: ["--from", "{{value}}"] }],
  actions: [
    {
      id: "run",
      name: "Cat: run",
      args: ["run", "{{input}}", "--work-dir", "{{env.REPO_PATH}}", "{{option.extra}}"],
      options: [
        { id: "workflow", label: "Workflow", type: "select", choices: ["default", "quick"], args: ["--workflow", "{{value}}"] },
        { id: "test", label: "Test", type: "boolean", args: ["--test"] },
        { id: "max", label: "Max", type: "number", default: 3, args: ["--max", "{{value}}"] },
        { id: "extra", label: "Extra", type: "string" },
      ],
      exitCodes: { "0": "delivered", "3": "no-mr" },
      failExit: "failed",
      matches: { mr: "(https://\\S+/pull/\\d+)" },
    },
    { id: "plan", name: "Cat: plan", args: ["plan", "{{input}}"], options: [{ id: "name", label: "Name", type: "string", required: true, args: ["--name", "{{value}}"] }] },
  ],
  ...over,
});

describe("integration definitions", () => {
  it("accepts a good one and names what's wrong with a bad one", () => {
    expect(integrationProblems(harness())).toEqual([]);
    expect(integrationProblems({ id: "Bad", name: "", command: "/usr/bin/x y", actions: [] }).length).toBeGreaterThanOrEqual(4);
    const bad = harness({ actions: [{ id: "run", name: "R", args: ["x"], exitCodes: { zero: "ok", "1": "bad name!" }, matches: { m: "(" } }] });
    const p = integrationProblems(bad).join("\n");
    expect(p).toMatch(/exit code "zero"/);
    expect(p).toMatch(/exit name/);
    expect(p).toMatch(/invalid regex/);
    expect(integrationProblems(harness({ options: [{ id: "x", label: "X", type: "string", choices: ["a"] }] })).join()).toMatch(/only apply to type "select"/);
  });

  it("makes one block per action, with its exits and the merged env", () => {
    const blocks = integrationBlocks(integrationInfo(harness({ env: ["REPO_PATH"] }), "pets", true));
    expect(blocks.map((b) => b.id)).toEqual(["pets/cat-run", "pets/cat-plan"]);
    expect(blocks[0].config).toMatchObject({ kind: "integration", env: ["REPO_PATH"], integration: { ref: "pets/cat", action: "run", exits: ["delivered", "no-mr", "failed"] } });
    expect(blocks[1].config.integration?.exits).toEqual([]);
    expect(actionExits(harness().actions[0])).toEqual(["delivered", "no-mr", "failed"]);
  });

  it("reserves the local pack id for your own integrations", () => {
    expect(manifestProblems({ id: "local", name: "x", version: "1.0.0" }).join()).toMatch(/reserved/);
  });

  it("node option values merge over the block's, one by one", () => {
    const blocks: BlockDef[] = [{ id: "b", name: "b", isTemplate: false, config: { kind: "integration", integration: { ref: "p/cat", action: "run", options: { workflow: "quick", test: true } } } }];
    const cfg = resolveNode({ id: "n", type: "block", position: { x: 0, y: 0 }, data: { blockId: "b", overrides: { integration: { options: { test: false } } } } }, blocks);
    expect(cfg.integration).toEqual({ ref: "p/cat", action: "run", exits: [], options: { workflow: "quick", test: false } });
  });
});

describe("arguments from options", () => {
  const def = harness();
  const run = def.actions[0];
  const vars = { input: "Add dark mode", "env.REPO_PATH": "/repo" };

  it("adds each set option's args; unset placeholders drop out; defaults apply", () => {
    expect(buildArgs(def, run, {}, vars)).toEqual(["run", "Add dark mode", "--work-dir", "/repo", "--max", "3"]);
    expect(buildArgs(def, run, { workflow: "quick", test: true, from: "dev", extra: "-v", max: 5 }, vars)).toEqual([
      "run", "Add dark mode", "--work-dir", "/repo", "-v", "--from", "dev", "--workflow", "quick", "--test", "--max", "5",
    ]);
    expect(buildArgs(def, run, { test: false }, vars)).not.toContain("--test");
  });

  it("passes a prompt as one argument, however it's written", () => {
    const tricky = 'Fix "quotes" && rm -rf / ; $(whoami) %PATH%\nsecond line';
    expect(buildArgs(def, run, {}, { ...vars, input: tricky })[1]).toBe(tricky);
  });

  it("refuses a missing required option and a non-number", () => {
    expect(() => buildArgs(def, def.actions[1], {}, vars)).toThrow(/"Name" — it's required/);
    expect(() => buildArgs(def, run, { max: "lots" }, vars)).toThrow(/must be a number/);
  });

  it("reads versions, choices and matches from a harness's output", () => {
    expect(parseVersion("meow 0.1.20\n")).toBe("0.1.20");
    expect(parseVersion("meow v2.0.0-rc.1", "meow\\s+v?(\\S+)")).toBe("2.0.0-rc.1");
    const list = "default (builtin): Plan, implement, review, check, and deliver.\nquick (builtin): Short plan.\nmine (project): Mine.\nWorkflow x overrides y\n";
    expect(parseChoices(list, "^([a-z0-9][\\w-]*) \\([^)]*\\): (.*)$")).toEqual([
      { value: "default", label: "Plan, implement, review, check, and deliver." },
      { value: "quick", label: "Short plan." },
      { value: "mine", label: "Mine." },
    ]);
    expect(parseChoices("a\n\nb\na\n")).toEqual([{ value: "a" }, { value: "b" }]);
    expect(outputMatches(run, "opened https://github.com/a/b/pull/1\nfinal https://github.com/a/b/pull/7")).toEqual({ "match.mr": "https://github.com/a/b/pull/7" });
  });
});

/** A pack folder that brings an integration. */
function writePack(dir: string, files: Record<string, unknown>) {
  for (const [rel, v] of Object.entries({ "manifest.json": { id: "pets", name: "Pets", version: "1.0.0" }, ...files })) {
    const p = path.join(dir, ...rel.split("/"));
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(v));
  }
  return dir;
}

describe("integrations in packs", () => {
  it("previews what it runs, installs its blocks, and runs only once the pack is trusted", () => {
    const data = tmp();
    const store = createPackStore(data, { bundledDir: tmp() });
    const p = store.previewFolder(writePack(tmp(), { "integrations/cat.json": harness() }), false);
    expect(p.integrations).toEqual([{ id: "cat", name: "Cat harness", command: "cat-cli", actions: ["Cat: run", "Cat: plan"] }]);
    expect(p.blocks.map((b) => b.id)).toEqual(["pets/cat-run", "pets/cat-plan"]);
    expect(p.risks.filter((r) => r.kind === "integration").map((r) => r.detail)).toContain("cat-cli run {{input}} --work-dir {{env.REPO_PATH}} {{option.extra}}");
    expect(p.needsHost).toBe(true);

    store.install(p.token, { trustHost: false });
    const loaded = store.load();
    expect(loaded.integrations.map((i) => [i.id, i.trusted])).toEqual([["pets/cat", false]]);
    expect(loaded.infos[0].integrationCount).toBe(1);
    store.setTrust("pets", true);
    expect(store.load().integrations[0].trusted).toBe(true);
  });

  it("reports a bad integration file as a problem and adds none of its blocks", () => {
    const store = createPackStore(tmp(), { bundledDir: tmp() });
    const p = store.previewFolder(writePack(tmp(), { "integrations/cat.json": { ...harness(), command: "two words" } }), false);
    expect(p.problems.join()).toMatch(/integrations\/cat.json: "command"/);
    expect(p.blocks).toEqual([]);
  });

  it("keeps your own integrations next to the packs', with their blocks under local/", () => {
    const dir = tmp();
    const storage = createStorage(dir, { bundledDir: tmp() });
    storage.integrations.save(harness());
    const data = storage.load();
    expect(data.integrations?.map((i) => [i.id, i.pack, i.trusted])).toEqual([["local/cat", "local", true]]);
    expect(data.blocks.filter((b) => b.pack === "local").map((b) => b.id)).toEqual(["local/cat-run", "local/cat-plan"]);
    expect(() => storage.integrations.save(harness())).toThrow(/already have/);
    storage.integrations.save({ ...harness(), id: "dog" }, "cat");
    expect(storage.load().integrations?.map((i) => i.id)).toEqual(["local/dog"]);
    storage.integrations.remove("dog");
    expect(storage.load().integrations).toEqual([]);
  });
});

// ---------- running ----------

/** A stand-in harness: prints how it was called, then exits with the code in its first argument. */
const FAKE = `
const [code, ...args] = process.argv.slice(2);
console.log(JSON.stringify({ args, cwd: process.cwd(), token: process.env.CAT_TOKEN ?? null }));
if (code === "3") console.log("pushed; open it at https://github.com/a/b/pull/42");
if (code !== "0") console.error("boom " + code);
process.exit(Number(code));
`;

function nodeHarness(script: string): IntegrationDef {
  return {
    id: "fake",
    name: "Fake",
    command: "node",
    env: ["REPO_PATH", "FAKE_SCRIPT", "EXIT"],
    actions: [
      {
        id: "run",
        name: "Fake run",
        args: ["{{env.FAKE_SCRIPT}}", "{{env.EXIT}}", "{{input}}"],
        options: [{ id: "mode", label: "Mode", type: "select", choices: ["fast"], args: ["--mode", "{{value}}"] }],
        exitCodes: { "0": "delivered", "3": "no-mr" },
        failExit: "failed",
        matches: { mr: "(https://\\S+/pull/\\d+)" },
        artifact: "MR: {{match.mr}}\n{{stdout}}",
      },
      { id: "strict", name: "Strict", args: ["{{env.FAKE_SCRIPT}}", "{{env.EXIT}}"] },
    ],
  };
}

describe("running an integration block", () => {
  const settings: Settings = { startingPrompt: "Add a dark mode toggle", sandbox: "none", maxSteps: 20 };

  function setup(trusted = true) {
    const repo = tmp();
    const script = path.join(tmp(), "fake.cjs");
    fs.writeFileSync(script, FAKE);
    const info: IntegrationInfo = integrationInfo(nodeHarness(script), "pets", trusted);
    const blocks = [...CORE_BLOCKS, ...integrationBlocks(info)];
    const flow: Flow = {
      id: "f",
      name: "F",
      nodes: [
        { id: "cat", type: "block", position: { x: 0, y: 0 }, data: { blockId: "pets/fake-run", overrides: { integration: { options: { mode: "fast" } } } } },
        { id: "ok", type: "block", position: { x: 0, y: 0 }, data: { blockId: "sandflow/flow-output", overrides: { flowOutput: { name: "ok" } } } },
        { id: "bad", type: "block", position: { x: 0, y: 0 }, data: { blockId: "sandflow/flow-output", overrides: { flowOutput: { name: "bad" } } } },
      ],
      edges: [
        { id: "e1", source: "cat", target: "ok", sourceHandle: "exit:delivered", targetHandle: "artifact" },
        { id: "e2", source: "cat", target: "ok", sourceHandle: "exit:no-mr", targetHandle: "artifact" },
        { id: "e3", source: "cat", target: "bad", sourceHandle: "exit:failed", targetHandle: "artifact" },
      ],
    };
    const go = (exit: string, f = flow) =>
      startRun({
        flow: f,
        blocks,
        env: { REPO_PATH: repo, FAKE_SCRIPT: script, EXIT: exit, CAT_TOKEN: "secret" },
        settings,
        runners: { auto: async () => ({ outputs: {} }), ai: async () => ({ outputs: {} }), integration: runIntegration },
        integrations: { get: (id) => (id === info.id ? info : undefined) },
      }).done;
    return { repo, go, flow };
  }

  it("runs the harness with the prompt as one argument, in REPO_PATH, and leaves through the exit its code maps to", async () => {
    const { repo, go } = setup();
    const r = await go("0");
    expect(r.status).toBe("done");
    expect(r.nodes.cat.exit).toBe("delivered");
    const printed = JSON.parse(r.nodes.cat.outputs!.artifact!.split("\n")[1]);
    expect(printed.args).toEqual(["Add a dark mode toggle", "--mode", "fast"]);
    expect(fs.realpathSync(printed.cwd)).toBe(fs.realpathSync(repo));
    // Only the env vars the block declares are added to your own environment.
    expect(printed.token).toBeNull();
    expect(r.logs.some((l) => l.msg.startsWith("$ node ") && l.msg.includes('"Add a dark mode toggle"'))).toBe(true);
    expect(r.nodes.ok.status).toBe("done");
  });

  it("maps another code to its exit and pulls matches into the artifact", async () => {
    const r = await (setup().go)("3");
    expect(r.nodes.cat.exit).toBe("no-mr");
    expect(r.nodes.cat.outputs?.artifact).toMatch(/^MR: https:\/\/github.com\/a\/b\/pull\/42\n/);
  });

  it("an unmapped failure takes the fail exit and raises a warning with the harness's error", async () => {
    const r = await (setup().go)("1");
    expect(r.status).toBe("done");
    expect(r.nodes.cat.exit).toBe("failed");
    expect(r.nodes.bad.status).toBe("done");
    expect(r.flags?.[0]).toMatchObject({ severity: "warning", message: "Fake run exited with code 1" });
    expect(r.flags?.[0].details).toMatch(/boom 1/);
  });

  it("without a fail exit, a failure fails the block", async () => {
    const { go, flow } = setup();
    const strict: Flow = { ...flow, nodes: [{ ...flow.nodes[0], data: { blockId: "pets/fake-strict" } }], edges: [] };
    const r = await go("2", strict);
    expect(r.status).toBe("failed");
    expect(r.nodes.cat.error).toMatch(/node exited with code 2: boom 2/);
  });

  it("won't run a pack's harness until the pack may run code on this machine", async () => {
    const r = await (setup(false).go)("0");
    expect(r.status).toBe("failed");
    expect(r.nodes.cat.error).toMatch(/isn't allowed to run code on this machine/);
  });
});

describe("checking a harness", () => {
  it("finds the version, and says when it isn't installed", async () => {
    const data = tmp();
    const packs = createPackStore(data, { bundledDir: tmp() });
    const store = createIntegrationStore(data, packs);
    store.save({ ...nodeHarness("x"), id: "node-cli", detect: { args: ["--version"] } });
    store.save({ ...nodeHarness("x"), id: "missing", command: "surely-not-installed-cli" });
    const ok = await store.status("local/node-cli");
    expect(ok.installed).toBe(true);
    expect(ok.version).toBe(process.versions.node);
    const missing = await store.status("local/missing");
    expect(missing).toMatchObject({ installed: false });
    expect(missing.error).toMatch(/isn't installed/);
  });

  it("loads an option's choices by running the harness", async () => {
    const data = tmp();
    const store = createIntegrationStore(data, createPackStore(data, { bundledDir: tmp() }));
    const script = path.join(tmp(), "list.cjs");
    fs.writeFileSync(script, `console.log("default (builtin): The full pipeline.\\nquick (builtin): Short.\\n" + process.env.REPO_PATH)`);
    const def = nodeHarness("x");
    def.actions[0].options = [{ id: "workflow", label: "Workflow", type: "select", choicesFrom: { args: ["{{env.FAKE_SCRIPT}}"], pattern: "^([a-z]+) \\([^)]*\\): (.*)$" } }];
    store.save(def);
    const choices = await store.choices("local/fake", "run", "workflow", { FAKE_SCRIPT: script, REPO_PATH: "/nowhere" });
    expect(choices).toEqual([
      { value: "default", label: "The full pipeline." },
      { value: "quick", label: "Short." },
    ]);
  });
});
