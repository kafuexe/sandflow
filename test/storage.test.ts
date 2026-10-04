import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createStorage } from "../backend/storage";
import { BUILTIN_BLOCKS } from "../shared/library";

const dirs: string[] = [];
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "sandflow-"));
  dirs.push(d);
  return d;
};
afterEach(() => dirs.splice(0).forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

describe("storage", () => {
  it("installs the shipped base pack on first load and seeds the default flow from it", () => {
    const s = createStorage(tmp());
    const data = s.load();
    // Your own library starts empty; the blocks come from Sandflow's core and the base pack.
    expect(data.blocks.filter((b) => !b.pack)).toEqual([]);
    for (const b of BUILTIN_BLOCKS) expect(data.blocks.some((x) => x.id === `base/${b.id}` && x.pack === "base")).toBe(true);
    expect(data.blocks.some((b) => b.id === "sandflow/subflow")).toBe(true);
    expect(data.packs?.find((p) => p.id === "base")).toMatchObject({ source: { type: "bundled" }, trustHost: true, problems: [] });
    expect(data.flows[0].id).toBe("feature-pipeline");
    expect(data.flows[0].pack).toBeUndefined();
    expect(data.flows[0].nodes.every((n) => n.data.blockId.startsWith("base/"))).toBe(true);
    expect(data.flows.some((f) => f.id === "base/review-until-approved" && f.pack === "base")).toBe(true);
    expect(data.settings).toEqual({ startingPrompt: "", sandbox: "docker", maxSteps: 40 });
    expect(data.env).toEqual({});
  });

  it("saves only your own blocks and flows — pack items stay read-only", () => {
    const dir = tmp();
    const s = createStorage(dir);
    const data = s.load();
    const mine = { id: "mine", name: "Mine", isTemplate: false, extends: "base/tpl-ai-agent", config: {} };
    s.saveBlocks([...data.blocks.map((b) => (b.id === "base/plan" ? { ...b, name: "Hacked" } : b)), mine]);
    s.saveFlows(data.flows.map((f) => ({ ...f, name: `${f.name}!` })));
    const saved = JSON.parse(fs.readFileSync(path.join(dir, "library.json"), "utf8"));
    expect(saved).toEqual([mine]);
    const again = createStorage(dir).load();
    expect(again.blocks.find((b) => b.id === "base/plan")?.name).toBe("Plan");
    expect(again.flows.find((f) => f.id === "feature-pipeline")?.name).toBe("Feature pipeline!");
    expect(again.flows.find((f) => f.id === "base/feature-pipeline")?.name).toBe("Feature pipeline");
  });

  it("migrates pre-pack libraries: unchanged built-ins move to the base pack, edited ones stay yours", () => {
    const dir = tmp();
    const plan = BUILTIN_BLOCKS.find((b) => b.id === "plan")!;
    const cr = BUILTIN_BLOCKS.find((b) => b.id === "cr")!;
    const custom = { id: "sec", name: "Security", isTemplate: false, extends: "tpl-reviewer", config: {} };
    const editedCr = { ...cr, config: { ...cr.config, extraInstructions: "Be strict." } };
    fs.writeFileSync(path.join(dir, "library.json"), JSON.stringify([plan, editedCr, ...BUILTIN_BLOCKS.filter((b) => b.id !== "plan" && b.id !== "cr"), custom]));
    const flow = { id: "f", name: "F", nodes: [{ id: "a", type: "block", position: { x: 0, y: 0 }, data: { blockId: "plan" } }, { id: "b", type: "block", position: { x: 0, y: 0 }, data: { blockId: "cr" } }], edges: [] };
    fs.writeFileSync(path.join(dir, "flows.json"), JSON.stringify([flow]));
    const data = createStorage(dir).load();
    const own = data.blocks.filter((b) => !b.pack);
    expect(own.map((b) => b.id).sort()).toEqual(["cr", "sec"]);
    expect(own.find((b) => b.id === "sec")!.extends).toBe("base/tpl-reviewer");
    expect(own.find((b) => b.id === "cr")!.extends).toBe("base/tpl-reviewer");
    expect(own.find((b) => b.id === "cr")!.builtin).toBeUndefined();
    expect(data.flows.find((f) => f.id === "f")!.nodes.map((n) => n.data.blockId)).toEqual(["base/plan", "cr"]);
  });

  it("upgrades built-in GitHub skill refs to the bundled file skills, leaving custom ones alone", () => {
    const dir = tmp();
    const plan = BUILTIN_BLOCKS.find((b) => b.id === "plan")!;
    const old = {
      ...plan,
      config: {
        ...plan.config,
        skills: [
          { name: "writing-plans", source: "obra/superpowers", why: "old" },
          { name: "mine", source: "me/skills" },
        ],
      },
    };
    fs.writeFileSync(path.join(dir, "library.json"), JSON.stringify([old]));
    const blocks = createStorage(dir).load().blocks;
    const skills = blocks.find((b) => b.id === "plan")!.config.skills!;
    expect(skills[0].file).toEqual({ store: "bundled", dir: "obra-superpowers/writing-plans" });
    expect(skills[1]).toEqual({ name: "mine", source: "me/skills" });
    const saved = JSON.parse(fs.readFileSync(path.join(dir, "library.json"), "utf8"));
    expect(saved[0].config.skills[0].file).toBeTruthy();
  });

  it("saves runs and artifacts", () => {
    const dir = tmp();
    const s = createStorage(dir);
    s.saveRun({ id: "r1", flowId: "f", flowName: "F", status: "done", startedAt: 1, nodes: {}, logs: [] });
    s.saveArtifact("r1", "n1", 2, "hello");
    expect(s.loadRun("r1")?.status).toBe("done");
    expect(fs.readFileSync(path.join(dir, "runs", "r1", "n1-2.md"), "utf8")).toBe("hello");
    expect(s.loadRun("nope")).toBeUndefined();
  });
});
