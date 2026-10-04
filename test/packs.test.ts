import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { zipSync, strToU8 } from "fflate";
import { afterEach, describe, expect, it } from "vitest";
import { buildPack, createPackStore, packRoot, readFolder, unzipLimited, zipFiles, type Fetch } from "../backend/packs";
import { createStorage } from "../backend/storage";
import { manifestProblems, parsePackUrl, qualify, satisfies } from "../shared/packs";
import type { BlockDef, Flow, PackManifest } from "../shared/types";

const dirs: string[] = [];
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "sandflow-packs-"));
  dirs.push(d);
  return d;
};
afterEach(() => dirs.splice(0).forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

/** Write a pack folder: manifest + boxes + flows + extra files. */
function writePack(dir: string, manifest: Partial<PackManifest> & { id: string }, files: Record<string, unknown> = {}) {
  const all: Record<string, unknown> = { "manifest.json": { name: manifest.id, version: "1.0.0", ...manifest }, ...files };
  for (const [rel, v] of Object.entries(all)) {
    const p = path.join(dir, ...rel.split("/"));
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, typeof v === "string" ? v : JSON.stringify(v));
  }
  return dir;
}

const box = (id: string, extra: Partial<BlockDef> = {}): BlockDef => ({ id, name: id, isTemplate: false, config: {}, ...extra });

describe("pack helpers", () => {
  it("reads GitHub / GitLab links, refs and subfolders", () => {
    expect(parsePackUrl("https://github.com/kafuexe/sandflow-base-boxes")).toEqual({ type: "github", repo: "kafuexe/sandflow-base-boxes" });
    expect(parsePackUrl("https://github.com/a/b.git")).toEqual({ type: "github", repo: "a/b" });
    expect(parsePackUrl("https://github.com/a/b/tree/v1.2.0/packs/review")).toEqual({ type: "github", repo: "a/b", ref: "v1.2.0", subdir: "packs/review" });
    expect(parsePackUrl("github:a/b#main")).toEqual({ type: "github", repo: "a/b", ref: "main" });
    expect(parsePackUrl("https://gitlab.com/grp/sub/proj/-/tree/dev/x")).toEqual({ type: "gitlab", project: "grp/sub/proj", ref: "dev", subdir: "x" });
    expect(parsePackUrl("https://gitlab.corp.local/team/packs")).toEqual({ type: "gitlab", project: "team/packs", host: "gitlab.corp.local" });
    expect(parsePackUrl("gitlab:git.corp.local/team/packs")).toEqual({ type: "gitlab", project: "team/packs", host: "git.corp.local" });
    expect(parsePackUrl("https://example.com/a/b")).toBeUndefined();
    expect(parsePackUrl("not a url")).toBeUndefined();
  });

  it("checks manifests", () => {
    expect(manifestProblems({ id: "ok-pack", name: "OK", version: "1.2.3" })).toEqual([]);
    expect(manifestProblems({ id: "Bad Id", name: "", version: "one" }).length).toBe(3);
    expect(manifestProblems({ id: "sandflow", name: "x", version: "1.0.0" }).join()).toMatch(/reserved/);
    expect(manifestProblems({ id: "x", name: "x", version: "1.0.0", bin: { t: { "linux-x64": "../escape" } } }).join()).toMatch(/inside the pack/);
    expect(manifestProblems({ id: "x", name: "x", version: "1.0.0", requires: [{ id: "base", version: "not a range" }] }).join()).toMatch(/range/);
  });

  it("qualifies ids and compares versions", () => {
    expect(qualify("plan", "base")).toBe("base/plan");
    expect(qualify("other/plan", "base")).toBe("other/plan");
    expect(satisfies("1.4.0", "^1.0.0")).toBe(true);
    expect(satisfies("2.0.0", "^1.0.0")).toBe(false);
    expect(satisfies("2.0.0", undefined)).toBe(true);
  });

  it("finds the pack inside archives and refuses paths that escape", () => {
    const wrapped = unzipLimited(zipSync({ "owner-repo-abc123/manifest.json": strToU8("{}"), "owner-repo-abc123/boxes/a.json": strToU8("{}") }));
    expect([...packRoot(wrapped).keys()].sort()).toEqual(["boxes/a.json", "manifest.json"]);
    const sub = unzipLimited(zipSync({ "repo-x/packs/review/manifest.json": strToU8("{}"), "repo-x/README.md": strToU8("") }));
    expect([...packRoot(sub, "packs/review").keys()]).toEqual(["manifest.json"]);
    expect(() => packRoot(sub)).toThrow(/No manifest.json/);
    expect(() => unzipLimited(zipSync({ "../evil.sh": strToU8("x") }))).toThrow(/Unsafe path/);
  });
});

describe("pack store", () => {
  const store = (data = tmp(), opts: { fetch?: Fetch; bundledDir?: string } = {}) => createPackStore(data, { bundledDir: opts.bundledDir ?? tmp(), fetch: opts.fetch });

  it("previews, installs and loads a folder pack with its ids qualified", () => {
    const src = writePack(tmp(), { id: "review" }, {
      "boxes/tpl.json": box("tpl", { isTemplate: true, extends: "base/tpl-ai-agent", config: { skills: [{ name: "s", file: { store: "pack", dir: "s" } }] } }),
      "boxes/strict.json": [box("strict", { extends: "tpl" }), box("lint", { config: { kind: "script", script: { run: "sh lint.sh" } } })],
      "flows/loop.json": { id: "loop", name: "Loop", nodes: [{ id: "a", type: "block", position: { x: 0, y: 0 }, data: { blockId: "strict" } }], edges: [] },
      "skills/s/SKILL.md": "---\nname: s\n---",
      "lint.sh": "echo ok",
    });
    const s = store();
    const p = s.previewFolder(src, false);
    expect(p.manifest.id).toBe("review");
    expect(p.blocks.map((b) => b.id).sort()).toEqual(["review/lint", "review/strict", "review/tpl"]);
    expect(p.risks).toEqual([{ kind: "script", where: "lint", detail: "sh lint.sh" }]);
    expect(p.needsHost).toBe(false);
    expect(p.existing).toBeUndefined();
    const info = s.install(p.token);
    expect(info).toMatchObject({ id: "review", trustHost: false, hasCode: true, blockCount: 3, flowCount: 1, skillCount: 1 });
    // base isn't installed in this store, so the template it extends is reported.
    expect(info.problems.join()).toMatch(/base\/tpl-ai-agent/);

    const loaded = s.load();
    const strict = loaded.blocks.find((b) => b.id === "review/strict")!;
    expect(strict).toMatchObject({ pack: "review", extends: "review/tpl" });
    expect(loaded.blocks.find((b) => b.id === "review/tpl")!.config.skills![0].file).toEqual({ store: "pack", dir: "s", pack: "review" });
    expect(loaded.flows[0]).toMatchObject({ id: "review/loop", pack: "review" });
    expect(loaded.flows[0].nodes[0].data.blockId).toBe("review/strict");
    // Installed as a copy: changing the source doesn't change it.
    fs.writeFileSync(path.join(src, "lint.sh"), "rm -rf /");
    expect(fs.readFileSync(path.join(s.runtime("review")!.dir, "lint.sh"), "utf8")).toBe("echo ok");
  });

  it("shows what an update changes and asks for trust again when code changed", () => {
    const src = writePack(tmp(), { id: "tools" }, { "boxes/sh.json": box("sh", { config: { kind: "auto", autoAction: "shell", shellCommand: "echo 1" } }) });
    const s = store();
    const first = s.previewFolder(src, false);
    expect(first.needsHost).toBe(true);
    s.install(first.token, { trustHost: true });

    const same = s.previewUpdate("tools");
    return same.then((p) => {
      expect(p.existing).toMatchObject({ version: "1.0.0", trustHost: true });
      expect(p.hash).toBe(p.existing!.hash);
      expect(p.changes).toEqual({ added: [], changed: [], removed: [], codeChanged: false });

      writePack(src, { id: "tools", version: "1.1.0" }, { "boxes/sh.json": box("sh", { config: { kind: "auto", autoAction: "shell", shellCommand: "echo 2" } }), "README.md": "hi" });
      return s.previewUpdate("tools").then((u) => {
        expect(u.changes!.changed.sort()).toEqual(["boxes/sh.json", "manifest.json"]);
        expect(u.changes!.added).toEqual(["README.md"]);
        expect(u.changes!.codeChanged).toBe(true);
        const info = s.install(u.token, { trustHost: false });
        expect(info).toMatchObject({ version: "1.1.0", trustHost: false });
      });
    });
  });

  it("reports missing and conflicting dependencies, and packs a new version would break", () => {
    const s = store();
    s.install(s.previewFolder(writePack(tmp(), { id: "lib", version: "1.5.0" }), false).token);
    s.install(s.previewFolder(writePack(tmp(), { id: "app", requires: [{ id: "lib", version: "^1.0.0" }] }), false).token);
    expect(s.load().infos.find((i) => i.id === "app")!.problems).toEqual([]);

    const p = s.previewFolder(writePack(tmp(), { id: "x", requires: [{ id: "lib", version: "^2.0.0" }, { id: "ghost", version: "^1.0.0", source: "https://github.com/a/ghost" }] }), false);
    expect(p.conflicts).toEqual([{ id: "lib", installed: "1.5.0", required: "^2.0.0" }]);
    expect(p.missing).toEqual([{ id: "ghost", version: "^1.0.0", source: "https://github.com/a/ghost" }]);

    const lib2 = s.previewFolder(writePack(tmp(), { id: "lib", version: "2.0.0" }), false);
    expect(lib2.breaks).toEqual([{ id: "app", requires: "^1.0.0" }]);
  });

  it("won't silently replace a pack with the same id from somewhere else", () => {
    const s = store();
    s.install(s.previewFolder(writePack(tmp(), { id: "dup" }), false).token);
    const other = s.previewFolder(writePack(tmp(), { id: "dup", version: "9.0.0" }), false);
    expect(() => s.install(other.token)).toThrow(/Replace/);
    const again = s.previewFolder(writePack(tmp(), { id: "dup", version: "9.0.0" }), false);
    expect(s.install(again.token, { replace: true }).version).toBe("9.0.0");
  });

  it("reads linked folders in place, and removes packs", () => {
    const src = writePack(tmp(), { id: "dev" }, { "boxes/a.json": box("a") });
    const s = store();
    s.install(s.previewFolder(src, true).token);
    expect(s.load().blocks.map((b) => b.id)).toEqual(["dev/a"]);
    fs.writeFileSync(path.join(src, "boxes", "b.json"), JSON.stringify(box("b")));
    expect(s.reload().blocks.map((b) => b.id)).toEqual(["dev/a", "dev/b"]);
    s.remove("dev");
    expect(s.load().blocks).toEqual([]);
    expect(fs.existsSync(src)).toBe(true); // a linked folder is yours — never deleted
  });

  it("keeps going when one pack is broken", () => {
    const s = store();
    s.install(s.previewFolder(writePack(tmp(), { id: "good" }, { "boxes/a.json": box("a"), "boxes/bad.json": "{ nope" }), false).token);
    const info = s.load().infos[0];
    expect(info.blockCount).toBe(1);
    expect(info.problems.join()).toMatch(/bad.json: invalid JSON/);
  });

  it("fetches GitHub packs pinned to the latest release's commit", async () => {
    const zip = zipSync({ "o-r-1234567/manifest.json": strToU8(JSON.stringify({ id: "gh", name: "GH", version: "2.0.0" })) });
    const calls: string[] = [];
    const fake: Fetch = async (input) => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith("/releases/latest")) return Response.json({ tag_name: "v2.0.0" });
      if (url.endsWith("/commits/v2.0.0")) return Response.json({ sha: "1234567890abcdef" });
      if (url.endsWith("/zipball/1234567890abcdef")) return new Response(zip);
      return new Response("nope", { status: 404 });
    };
    const s = store(tmp(), { fetch: fake });
    const p = await s.previewUrl("https://github.com/o/r");
    expect(p).toMatchObject({ manifest: { id: "gh", version: "2.0.0" }, commit: "1234567890abcdef", source: { type: "github", repo: "o/r" } });
    expect(calls[0]).toBe("https://api.github.com/repos/o/r/releases/latest");
    expect(s.install(p.token).commit).toBe("1234567890abcdef");
  });

  it("on first start installs the shipped base pack, then swaps in the online one when it's newer", async () => {
    const bundled = tmp();
    writePack(path.join(bundled, "base"), { id: "base", version: "1.0.0" }, { "boxes/a.json": box("a") });
    const zip = zipSync({ "k-b-1/manifest.json": strToU8(JSON.stringify({ id: "base", name: "Base", version: "1.1.0" })), "k-b-1/boxes/b.json": strToU8(JSON.stringify(box("b"))) });
    const fake: Fetch = async (input) => {
      const url = String(input);
      if (url.endsWith("/releases/latest")) return Response.json({ tag_name: "v1.1.0" });
      if (url.includes("/commits/")) return Response.json({ sha: "abc" });
      return new Response(zip);
    };
    const data = tmp();
    const s = createPackStore(data, { bundledDir: bundled, fetch: fake });
    s.ensureBundledBase();
    expect(s.load().infos[0]).toMatchObject({ id: "base", version: "1.0.0", source: { type: "bundled" }, trustHost: true });
    expect(await s.refreshBaseOnline()).toMatch(/installed base pack 1.1.0/);
    expect(s.load().infos[0]).toMatchObject({ version: "1.1.0", source: { type: "github", repo: "kafuexe/sandflow-base-boxes" }, trustHost: true });
    expect(s.load().blocks.map((b) => b.id)).toEqual(["base/b"]);
    expect(await s.refreshBaseOnline()).toMatch(/already installed/);
    // Offline: keeps the shipped copy.
    const offline = createPackStore(tmp(), { bundledDir: bundled, fetch: async () => { throw new Error("offline"); } });
    offline.ensureBundledBase();
    await expect(offline.refreshBaseOnline()).rejects.toThrow(/offline/);
    expect(offline.load().infos[0].version).toBe("1.0.0");
  });
});

describe("export", () => {
  it("builds a pack from your own blocks and flows that installs elsewhere", async () => {
    const storage = createStorage(tmp());
    const data = storage.load();
    const tpl: BlockDef = { id: "my-tpl", name: "My template", isTemplate: true, extends: "base/tpl-ai-agent", config: { instructions: "Be brief." } };
    const blk: BlockDef = { id: "my-blk", name: "Mine", isTemplate: false, extends: "my-tpl", config: {} };
    const child: Flow = { id: "child", name: "Child", nodes: [{ id: "in", type: "block", position: { x: 0, y: 0 }, data: { blockId: "sandflow/flow-input" } }], edges: [] };
    const parent: Flow = {
      id: "parent",
      name: "Parent",
      nodes: [
        { id: "a", type: "block", position: { x: 0, y: 0 }, data: { blockId: "my-blk" } },
        { id: "b", type: "block", position: { x: 0, y: 0 }, data: { blockId: "base/plan" } },
        { id: "c", type: "block", position: { x: 0, y: 0 }, data: { blockId: "sandflow/subflow", overrides: { subflow: { flowId: "child" } } } },
      ],
      edges: [],
    };
    const req = (blocks: BlockDef[], flows: Flow[]) => ({
      manifest: { id: "shared", name: "Shared", version: "0.1.0" },
      blocks,
      flows,
      allBlocks: [...data.blocks, tpl, blk],
      allFlows: [...data.flows, child, parent],
      installed: data.packs ?? [],
      readSkill: async () => [],
    });
    await expect(buildPack(req([blk], [parent, child]))).rejects.toThrow(/my-tpl/);
    await expect(buildPack(req([tpl, blk], [parent]))).rejects.toThrow(/export that flow too/);
    const files = await buildPack(req([tpl, blk], [parent, child]));
    const manifest = JSON.parse(new TextDecoder().decode(files.get("manifest.json")));
    expect(manifest.requires).toEqual([{ id: "base", version: "^1.0.0", source: "https://github.com/kafuexe/sandflow-base-boxes" }]);
    expect([...files.keys()].sort()).toEqual(["README.md", "boxes/my-blk.json", "boxes/my-tpl.json", "flows/child.json", "flows/parent.json", "manifest.json"]);

    // …and the zip installs on another machine that has the base pack.
    const other = createStorage(tmp());
    other.load();
    const p = other.packs.previewZip("shared.zip", zipFiles(files, "shared"));
    expect(p.missing).toEqual([]);
    other.packs.install(p.token);
    const after = other.load();
    expect(after.blocks.find((b) => b.id === "shared/my-blk")!.extends).toBe("shared/my-tpl");
    const sharedParent = after.flows.find((f) => f.id === "shared/parent")!;
    expect(sharedParent.nodes.map((n) => n.data.blockId)).toEqual(["shared/my-blk", "base/plan", "sandflow/subflow"]);
    expect(sharedParent.nodes[2].data.overrides?.subflow?.flowId).toBe("shared/child");
    expect(after.packs!.find((x) => x.id === "shared")!.problems).toEqual([]);
  });

  it("copies a folder pack's files exactly", () => {
    const src = writePack(tmp(), { id: "f" }, { "a/b.txt": "x" });
    expect([...readFolder(src).keys()].sort()).toEqual(["a/b.txt", "manifest.json"]);
  });
});

describe("the shipped base pack", () => {
  it("has every pre-pack built-in block, unchanged, and flows that validate", async () => {
    const { BUILTIN_BLOCKS } = await import("../shared/library");
    const { validateFlow } = await import("../shared/flowOps");
    const { validateBlocks } = await import("../shared/validate");
    const { CORE_BLOCKS } = await import("../shared/core");
    const s = createPackStore(tmp());
    s.ensureBundledBase();
    const { blocks, flows, infos } = s.load();
    expect(infos[0].problems).toEqual([]);
    for (const b of BUILTIN_BLOCKS) {
      const packed = blocks.find((x) => x.id === `base/${b.id}`)!;
      expect(packed.name).toBe(b.name);
      expect(packed.extends ?? null).toBe(b.extends ? `base/${b.extends}` : null);
      const strip = (c: BlockDef["config"]) => JSON.stringify({ ...c, skills: c.skills?.map((k) => k.name) });
      expect(strip(packed.config)).toBe(strip(b.config));
    }
    const all = [...CORE_BLOCKS, ...blocks];
    expect(validateBlocks(all)).toEqual([]);
    for (const f of flows) expect(validateFlow(f, all, flows).errors, f.id).toEqual([]);
  });
});

describe("GitHub rate limits", () => {
  it("falls back to the plain archive when the anonymous API is rate limited", async () => {
    const zip = zipSync({ "r-main/manifest.json": strToU8(JSON.stringify({ id: "rl", name: "RL", version: "1.0.0" })) });
    const urls: string[] = [];
    const sha = "a".repeat(40);
    const fake: Fetch = async (input) => {
      const url = String(input);
      urls.push(url);
      if (url === "https://github.com/o/r/releases/latest") return new Response(null, { status: 302, headers: { location: "https://github.com/o/r/releases/tag/v3.1.0" } });
      if (url === "https://github.com/o/r/archive/v3.1.0.zip") {
        const res = new Response(zip);
        Object.defineProperty(res, "url", { value: `https://codeload.github.com/o/r/zip/${sha}` });
        return res;
      }
      return new Response("rate limit exceeded", { status: 403, statusText: "rate limit exceeded" });
    };
    const s = createPackStore(tmp(), { bundledDir: tmp(), fetch: fake, tokens: () => ({}) });
    const p = await s.previewUrl("https://github.com/o/r");
    expect(p.manifest.id).toBe("rl");
    expect(p.commit).toBe(sha);
    expect(urls.at(-1)).toBe("https://github.com/o/r/archive/v3.1.0.zip");
  });
});
