// File-based skills: bundled with the app (`skills/`) or uploaded by the user (`<data>/skills/`).

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SKILL_CATALOG } from "../shared/library";
import { SKILL_DIR_RE, SKILL_NAME_RE } from "../shared/skills";
import type { SkillFileRef, SkillRef } from "../shared/types";

export interface SkillFile {
  /** Path relative to the skill directory, `/`-separated. */
  path: string;
  content: string;
}

export const BUNDLED_SKILLS_DIR = fileURLToPath(new URL("../skills", import.meta.url));

const MAX_FILES = 200;
const MAX_BYTES = 2 * 1024 * 1024;
/** Safe relative file path: segments of [\w.-], no `.`/`..` segments, not absolute. */
export const SKILL_FILE_PATH_RE = /^(?!.*(^|\/)\.\.?(\/|$))[\w.-]+(\/[\w.-]+)*$/;

function frontmatter(md: string): Record<string, string> {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(md);
  if (!m) return {};
  const out: Record<string, string> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([\w-]+):\s*(.*)$/.exec(line);
    if (kv) out[kv[1]] = kv[2].replace(/^["']|["']$/g, "").trim();
  }
  return out;
}

async function walk(root: string, rel = ""): Promise<string[]> {
  const entries = await fs.readdir(path.join(root, rel), { withFileTypes: true });
  const out: string[] = [];
  for (const e of entries) {
    const p = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...(await walk(root, p)));
    else if (e.isFile()) out.push(p);
  }
  return out;
}

async function exists(p: string) {
  return fs.stat(p).then(
    () => true,
    () => false,
  );
}

export type SkillStore = ReturnType<typeof createSkillStore>;

export function createSkillStore(dataDir: string, bundledDir = BUNDLED_SKILLS_DIR) {
  const userDir = path.join(dataDir, "skills");
  const rootOf = (store: SkillFileRef["store"]) => (store === "bundled" ? bundledDir : userDir);

  function locate(ref: SkillFileRef): string {
    if ((ref.store !== "bundled" && ref.store !== "user") || !SKILL_DIR_RE.test(ref.dir)) {
      throw new Error(`Invalid skill location "${ref.store}:${ref.dir}"`);
    }
    const root = rootOf(ref.store);
    const dir = path.resolve(root, ref.dir);
    if (!dir.startsWith(path.resolve(root) + path.sep)) throw new Error(`Invalid skill location "${ref.dir}"`);
    return dir;
  }

  async function describe(store: SkillFileRef["store"], dir: string): Promise<SkillRef> {
    const md = await fs.readFile(path.join(rootOf(store), dir, "SKILL.md"), "utf8");
    const fm = frontmatter(md);
    const name = SKILL_NAME_RE.test(fm.name ?? "") ? fm.name : path.basename(dir);
    const known = SKILL_CATALOG.find((s) => s.file?.store === store && s.file.dir === dir);
    return known ?? { name, file: { store, dir }, why: fm.description?.slice(0, 200) || undefined };
  }

  return {
    userDir,

    /** All files of a file skill. */
    async read(ref: SkillFileRef): Promise<SkillFile[]> {
      const dir = locate(ref);
      if (!(await exists(path.join(dir, "SKILL.md")))) throw new Error(`Skill not found: ${ref.store}:${ref.dir}`);
      const files = await walk(dir);
      return Promise.all(files.map(async (p) => ({ path: p, content: await fs.readFile(path.join(dir, p), "utf8") })));
    },

    /** Every bundled (`<origin>/<name>`) and uploaded (`<name>`) skill. */
    async list(): Promise<SkillRef[]> {
      const out: SkillRef[] = [];
      const dirs = async (root: string) =>
        (await fs.readdir(root, { withFileTypes: true }).catch(() => [])).filter((e) => e.isDirectory()).map((e) => e.name);
      for (const origin of await dirs(bundledDir)) {
        for (const name of await dirs(path.join(bundledDir, origin))) {
          if (await exists(path.join(bundledDir, origin, name, "SKILL.md"))) out.push(await describe("bundled", `${origin}/${name}`));
        }
      }
      for (const name of await dirs(userDir)) {
        if (await exists(path.join(userDir, name, "SKILL.md"))) out.push(await describe("user", name));
      }
      return out;
    },

    /** Save (or replace) an uploaded skill. Must contain a top-level SKILL.md. */
    async save(name: string, files: SkillFile[]): Promise<SkillRef> {
      if (!SKILL_NAME_RE.test(name)) throw new Error(`Invalid skill name "${name}"`);
      if (!Array.isArray(files) || !files.length) throw new Error("No files uploaded");
      if (files.length > MAX_FILES) throw new Error(`Too many files (max ${MAX_FILES})`);
      let bytes = 0;
      for (const f of files) {
        if (typeof f?.path !== "string" || typeof f.content !== "string" || !SKILL_FILE_PATH_RE.test(f.path)) {
          throw new Error(`Invalid file path "${f?.path}"`);
        }
        bytes += Buffer.byteLength(f.content);
      }
      if (bytes > MAX_BYTES) throw new Error("Skill is too large (max 2 MB)");
      if (!files.some((f) => f.path === "SKILL.md")) throw new Error("A skill needs a SKILL.md at its top level");

      const dest = path.join(userDir, name);
      const tmp = path.join(userDir, `.${name}.${Date.now()}.tmp`);
      await fs.mkdir(tmp, { recursive: true });
      try {
        for (const f of files) {
          const p = path.join(tmp, ...f.path.split("/"));
          await fs.mkdir(path.dirname(p), { recursive: true });
          await fs.writeFile(p, f.content);
        }
        await fs.rm(dest, { recursive: true, force: true });
        await fs.rename(tmp, dest);
      } catch (e) {
        await fs.rm(tmp, { recursive: true, force: true });
        throw e;
      }
      return describe("user", name);
    },
  };
}
