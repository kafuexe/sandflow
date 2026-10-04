import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startRun, type NodeRunner, type RunPacks } from "../backend/engine";
import { createPackStore, type PackStore } from "../backend/packs";
import { runAuto } from "../backend/runners/auto";
import { parseScriptOutput, prepareScript, runScript } from "../backend/runners/script";
import { CORE_BLOCKS, SCRIPT_BLOCK } from "../shared/core";
import type { BlockConfig, BlockDef, Flow } from "../shared/types";

const dirs: string[] = [];
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "sandflow-script-"));
  dirs.push(d);
  return d;
};
afterEach(() => dirs.splice(0).forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

const idle: NodeRunner = async () => ({ outputs: {} });

/** A one-node flow running `blockId` on this machine (Sandbox: None). */
async function runOne(blockId: string, blocks: BlockDef[], store?: PackStore, overrides?: BlockConfig, env: Record<string, string> = {}) {
  const flow: Flow = { id: "f", name: "F", nodes: [{ id: "s", type: "block", position: { x: 0, y: 0 }, data: { blockId, ...(overrides ? { overrides } : {}) } }], edges: [] };
  const packs: RunPacks | undefined = store && { runtime: (id) => store.runtime(id), dirs: () => store.dirs(), runtimeRoot: tmp() };
  return startRun({
    flow,
    blocks: [...CORE_BLOCKS, ...blocks],
    env,
    settings: { startingPrompt: "hello", sandbox: "none", maxSteps: 5 },
    runners: { auto: runAuto, ai: idle, script: runScript },
    packs,
  }).done;
}

function installPack(trustHost: boolean, files: Record<string, unknown>, manifest: Record<string, unknown> = {}) {
  const src = tmp();
  const all: Record<string, unknown> = { "manifest.json": { id: "tools", name: "Tools", version: "1.0.0", ...manifest }, ...files };
  for (const [rel, v] of Object.entries(all)) {
    fs.mkdirSync(path.dirname(path.join(src, rel)), { recursive: true });
    fs.writeFileSync(path.join(src, rel), typeof v === "string" ? v : JSON.stringify(v));
  }
  const store = createPackStore(tmp(), { bundledDir: tmp() });
  store.install(store.previewFolder(src, false).token, { trustHost });
  return { store, blocks: store.load().blocks };
}

const node = (js: string) => `node -e "${js}"`;

describe("script output", () => {
  it("reads $SANDFLOW_OUTPUT, or uses what was printed", () => {
    expect(parseScriptOutput('{"artifact":"a","steer":"s","exit":"pass"}', "ignored")).toEqual({ outputs: { artifact: "a", steer: "s" }, exit: "pass" });
    expect(parseScriptOutput('{"artifact":{"n":1}}', "")).toEqual({ outputs: { artifact: '{\n  "n": 1\n}', steer: undefined }, exit: undefined });
    expect(parseScriptOutput(undefined, "  printed\n")).toEqual({ outputs: { artifact: "printed" } });
    expect(() => parseScriptOutput("nope", "")).toThrow(/valid JSON/);
  });

  it("prepares a pack copy once: setup, then executables for the container's architecture", () => {
    const sh = prepareScript({ id: "t", name: "t", version: "1.0.0", setup: "pip install -r req.txt -t .deps", bin: { tool: { "linux-x64": "bin/x64/tool", "win32-x64": "bin/tool.exe" } } }, "/src", '"$HOME/p"');
    expect(sh).toContain("( pip install -r req.txt -t .deps ) ||");
    expect(sh).toContain(`[ "$A" = 'x64' ] && chmod +x 'bin/x64/tool' && ln -sf "$D/"'bin/x64/tool' .sandflow-bin/'tool'`);
    expect(sh).not.toContain("tool.exe");
    expect(sh).toContain(`if [ ! -f "$D/.sandflow-ready" ]`);
  });
});

describe("running scripts on this machine", () => {
  it("your own script gets its inputs on stdin and picks an exit", async () => {
    const js = "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const i=JSON.parse(s);require('fs').writeFileSync(process.env.SANDFLOW_OUTPUT,JSON.stringify({artifact:'got '+i.startingPrompt,exit:'b'}))})";
    const final = await runOne(SCRIPT_BLOCK, [], undefined, { script: { run: node(js), exits: ["a", "b"] } });
    expect(final.error).toBeUndefined();
    expect(final.nodes.s).toMatchObject({ status: "done", exit: "b", outputs: { artifact: "got hello" } });
  });

  it("fails with the script's error output", async () => {
    const final = await runOne(SCRIPT_BLOCK, [], undefined, { script: { run: node("console.error('boom');process.exit(3)") } });
    expect(final.status).toBe("failed");
    expect(final.error).toMatch(/exited with code 3: boom/);
  });

  it("a trusted pack's script runs in its prepared copy, after its setup", async () => {
    const { store, blocks } = installPack(true, {
      "boxes/report.json": { id: "report", name: "Report", isTemplate: false, config: { kind: "script", outputs: { artifact: true }, script: { run: node("process.stdout.write(require('fs').readFileSync(require('path').join(process.env.PACK_DIR,'made.txt'),'utf8'))") } } },
    }, { setup: node("require('fs').writeFileSync('made.txt','by setup')") });
    const final = await runOne("tools/report", blocks, store);
    expect(final.error).toBeUndefined();
    expect(final.nodes.s.outputs).toEqual({ artifact: "by setup" });
    // The installed pack itself is untouched.
    expect(fs.existsSync(path.join(store.runtime("tools")!.dir, "made.txt"))).toBe(false);
  });

  it("an untrusted pack's code never runs on this machine", async () => {
    const { store, blocks } = installPack(false, {
      "boxes/report.json": { id: "report", name: "Report", isTemplate: false, config: { kind: "script", script: { run: node("1") } } },
      "boxes/sh.json": { id: "sh", name: "Sh", isTemplate: false, config: { kind: "auto", autoAction: "shell", outputs: { artifact: true }, env: ["REPO_PATH"], shellCommand: node("1") } },
    }, { setup: node("1") });
    let final = await runOne("tools/report", blocks, store);
    expect(final.status).toBe("failed");
    expect(final.error).toMatch(/isn't allowed to run code on this machine/);
    final = await runOne("tools/sh", blocks, store, undefined, { REPO_PATH: tmp() });
    expect(final.error).toMatch(/comes from pack "tools", which isn't allowed/);
    // A command you typed yourself on the node is yours — but the pack's setup still can't run here.
    final = await runOne("tools/report", blocks, store, { script: { run: node("process.stdout.write('mine')") } });
    expect(final.error).toMatch(/setup step/);
    final = await runOne("tools/sh", blocks, store, { shellCommand: node("process.stdout.write('mine')") }, { REPO_PATH: tmp() });
    expect(final.nodes.s.outputs).toEqual({ artifact: "mine" });
  });
});
