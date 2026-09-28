import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BUNDLED_SKILLS_DIR, createSkillStore } from "../backend/skills";
import { SKILL_CATALOG } from "../shared/library";

const dirs: string[] = [];
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "sandflow-skills-"));
  dirs.push(d);
  return d;
};
afterEach(() => dirs.splice(0).forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

describe("skill store", () => {
  it("every catalog skill is bundled in the codebase with a SKILL.md", async () => {
    const store = createSkillStore(tmp());
    for (const s of SKILL_CATALOG) {
      expect(s.file?.store).toBe("bundled");
      const files = await store.read(s.file!);
      expect(files.map((f) => f.path)).toContain("SKILL.md");
    }
    expect(fs.existsSync(path.join(BUNDLED_SKILLS_DIR, "obra-superpowers", "LICENSE"))).toBe(true);
  });

  it("lists bundled and user skills with their frontmatter", async () => {
    const store = createSkillStore(tmp());
    await store.save("my-skill", [{ path: "SKILL.md", content: "---\nname: my-skill\ndescription: Does things\n---\nbody" }]);
    const list = await store.list();
    expect(list.find((s) => s.name === "tdd")?.file).toEqual({ store: "bundled", dir: "mattpocock-skills/tdd" });
    expect(list.find((s) => s.name === "my-skill")).toMatchObject({ file: { store: "user", dir: "my-skill" }, why: "Does things" });
  });

  it("saves and reads back a multi-file user skill", async () => {
    const store = createSkillStore(tmp());
    const ref = await store.save("pack", [
      { path: "SKILL.md", content: "# Pack" },
      { path: "scripts/run.sh", content: "#!/bin/sh\necho hi" },
    ]);
    expect(ref).toMatchObject({ name: "pack", file: { store: "user", dir: "pack" } });
    const files = await store.read(ref.file!);
    expect(files).toEqual(
      expect.arrayContaining([{ path: "SKILL.md", content: "# Pack" }, { path: "scripts/run.sh", content: "#!/bin/sh\necho hi" }]),
    );
  });

  it("rejects unsafe names, paths, missing SKILL.md and oversize uploads", async () => {
    const store = createSkillStore(tmp());
    await expect(store.save("../x", [{ path: "SKILL.md", content: "" }])).rejects.toThrow(/name/i);
    await expect(store.save("x", [{ path: "../SKILL.md", content: "" }])).rejects.toThrow(/path/i);
    await expect(store.save("x", [{ path: "/abs/SKILL.md", content: "" }])).rejects.toThrow(/path/i);
    await expect(store.save("x", [{ path: "README.md", content: "" }])).rejects.toThrow(/SKILL\.md/);
    await expect(store.save("x", [{ path: "SKILL.md", content: "x".repeat(3 * 1024 * 1024) }])).rejects.toThrow(/large/i);
    await expect(store.read({ store: "bundled", dir: "../backend" })).rejects.toThrow(/invalid/i);
    await expect(store.read({ store: "user", dir: "nope" })).rejects.toThrow(/not found/i);
  });
});
