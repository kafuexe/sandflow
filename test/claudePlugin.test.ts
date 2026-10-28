// The Claude Code plugin (claude-plugin/) and its marketplace: versions follow package.json, every skill has the
// frontmatter Claude Code needs, and the files skills link to exist.

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(__dirname, "..");
const readJson = (rel: string) => JSON.parse(fs.readFileSync(path.join(root, rel), "utf8"));
const pluginDir = path.join(root, "claude-plugin");
const skillsDir = path.join(pluginDir, "skills");

describe("claude plugin", () => {
  it("plugin and marketplace entries match package.json", () => {
    const version = readJson("package.json").version;
    const plugin = readJson("claude-plugin/.claude-plugin/plugin.json");
    const market = readJson(".claude-plugin/marketplace.json");
    expect(plugin.name).toBe("sand");
    expect(plugin.version).toBe(version);
    expect(market.name).toBe("sandflow");
    const entry = market.plugins.find((p: { name: string }) => p.name === "sand");
    expect(entry).toMatchObject({ source: "./claude-plugin", version });
  });

  const skills = fs.readdirSync(skillsDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);

  it("ships the flow, schedule and edit skills", () => {
    expect(skills.sort()).toEqual(["edit", "flow", "schedule"]);
  });

  it.each(skills)("skill %s has a name and description and only links to files that exist", (name) => {
    const dir = path.join(skillsDir, name);
    const text = fs.readFileSync(path.join(dir, "SKILL.md"), "utf8");
    const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1] ?? "";
    expect(front).toMatch(new RegExp(`^name: ${name}$`, "m"));
    expect(front).toMatch(/^description: .{40,}$/m);
    const files = [path.join(dir, "SKILL.md"), ...(fs.existsSync(path.join(dir, "references")) ? fs.readdirSync(path.join(dir, "references")).map((f) => path.join(dir, "references", f)) : [])];
    for (const file of files) {
      const body = fs.readFileSync(file, "utf8");
      for (const m of body.matchAll(/\]\(([^)#\s]+)(#[^)]*)?\)/g)) {
        const target = m[1];
        if (/^[a-z]+:/i.test(target)) continue;
        expect(fs.existsSync(path.resolve(path.dirname(file), target)), `${path.relative(root, file)} → ${target}`).toBe(true);
      }
    }
  });
});
