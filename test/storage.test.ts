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
  it("seeds builtins, default flow and settings on first load", () => {
    const s = createStorage(tmp());
    const data = s.load();
    expect(data.blocks.length).toBe(BUILTIN_BLOCKS.length);
    expect(data.flows[0].id).toBe("feature-pipeline");
    expect(data.settings).toEqual({ startingPrompt: "", sandbox: "docker", maxSteps: 40 });
    expect(data.env).toEqual({});
  });

  it("persists edits and re-adds missing builtins without overwriting user edits", () => {
    const dir = tmp();
    const s = createStorage(dir);
    const data = s.load();
    const edited = data.blocks
      .filter((b) => b.id !== "shell")
      .map((b) => (b.id === "plan" ? { ...b, name: "My plan" } : b));
    s.saveBlocks(edited);
    s.saveEnv({ REPO_PATH: "/repo" });
    const again = createStorage(dir).load();
    expect(again.blocks.find((b) => b.id === "plan")?.name).toBe("My plan");
    expect(again.blocks.some((b) => b.id === "shell")).toBe(true);
    expect(again.env).toEqual({ REPO_PATH: "/repo" });
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
