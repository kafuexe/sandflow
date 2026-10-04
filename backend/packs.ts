// Installed packs: fetch (GitHub, GitLab, folder, zip) → stage + preview (risks, dependencies, changes)
// → install into `<data>/packs/<id>/`, pinned in `<data>/packs.json`. Loaded blocks/flows are qualified
// (`base/plan`) and merged into the app data by storage.ts. Packs are data + files: nothing in a pack runs
// until a Script / Shell block that uses it runs (sandboxed unless the pack is trusted, see runners/script.ts).

import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { unzipSync, zipSync } from "fflate";
import semver from "semver";
import {
  BASE_PACK,
  BASE_PACK_URL,
  CORE_PACK,
  PACK_ID_RE,
  PACK_ITEM_ID_RE,
  manifestProblems,
  packOf,
  packSourceUrl,
  parsePackUrl,
  qualify,
  safeRelPath,
  satisfies,
} from "../shared/packs";
import type {
  BlockDef,
  Flow,
  PackInfo,
  PackManifest,
  PackPreview,
  PackRequirement,
  PackRisk,
  PackSource,
  SkillRef,
} from "../shared/types";

export const BUNDLED_PACKS_DIR = fileURLToPath(new URL("../packs", import.meta.url));

const MAX_FILES = 5000;
const MAX_TOTAL = 200 * 1024 * 1024;
const MAX_FILE = 100 * 1024 * 1024;
/** Never copied from a folder: VCS data and things a setup step would (re)create. */
const SKIP_DIRS = new Set([".git", "node_modules", ".venv", "__pycache__", ".DS_Store"]);
const STAGING_TTL = 60 * 60_000;

export type FileMap = Map<string, Uint8Array>;

// ---------- reading a pack ----------

/** Read access to a pack's files, from memory (staged) or from a folder (installed / linked). */
interface PackReader {
  read(rel: string): Uint8Array | undefined;
  /** Files directly or indirectly under `prefix/`. */
  list(prefix: string): string[];
}

const mapReader = (files: FileMap): PackReader => ({
  read: (rel) => files.get(rel),
  list: (prefix) => [...files.keys()].filter((k) => k.startsWith(`${prefix}/`)),
});

const dirReader = (root: string): PackReader => ({
  read(rel) {
    try {
      return fs.readFileSync(path.join(root, ...rel.split("/")));
    } catch {
      return undefined;
    }
  },
  list(prefix) {
    const base = path.join(root, ...prefix.split("/"));
    if (!fs.existsSync(base)) return [];
    return walkDir(base).map((p) => `${prefix}/${p}`);
  },
});

function walkDir(root: string, rel = ""): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
    if (SKIP_DIRS.has(e.name)) continue;
    const p = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...walkDir(root, p));
    else if (e.isFile()) out.push(p);
  }
  return out;
}

export interface LoadedPack {
  manifest: PackManifest;
  blocks: BlockDef[];
  flows: Flow[];
  /** Skill directories (relative to `skills/`) that have a SKILL.md. */
  skills: string[];
  risks: PackRisk[];
  problems: string[];
}

const text = (b: Uint8Array) => new TextDecoder().decode(b);

function parseJson(reader: PackReader, rel: string): unknown {
  const b = reader.read(rel);
  if (!b) throw new Error(`${rel} is missing`);
  try {
    return JSON.parse(text(b).replace(/^﻿/, ""));
  } catch (e) {
    throw new Error(`${rel}: invalid JSON (${(e as Error).message})`);
  }
}

/** Qualify every reference a pack block makes (`extends`, file skills) with its pack id. */
export function qualifyBlock(b: BlockDef, pack: string): BlockDef {
  const skills = b.config.skills?.map((s): SkillRef => (s.file?.store === "pack" ? { ...s, file: { ...s.file, pack: s.file.pack ?? pack } } : s));
  const config = { ...b.config, ...(skills ? { skills } : {}) };
  if (config.subflow?.flowId) config.subflow = { ...config.subflow, flowId: qualify(config.subflow.flowId, pack) };
  return { ...b, id: qualify(b.id, pack), extends: b.extends ? qualify(b.extends, pack) : b.extends, pack, builtin: undefined, config };
}

/** Qualify a pack flow's id, the blocks its nodes use and the flows its subflow nodes run. */
export function qualifyFlow(f: Flow, pack: string, markPack = true): Flow {
  return {
    ...f,
    id: markPack ? qualify(f.id, pack) : f.id,
    ...(markPack ? { pack, active: false } : {}),
    nodes: f.nodes.map((n) => {
      const overrides = n.data.overrides?.subflow?.flowId
        ? { ...n.data.overrides, subflow: { ...n.data.overrides.subflow, flowId: qualify(n.data.overrides.subflow.flowId, pack) } }
        : n.data.overrides;
      return { ...n, data: { ...n.data, blockId: qualify(n.data.blockId, pack), ...(overrides ? { overrides } : {}) } };
    }),
  };
}

function asList(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [v];
}

/** Read and check a pack. Throws only when the manifest is unusable; other problems are collected. */
export function readPack(reader: PackReader): LoadedPack {
  const manifest = parseJson(reader, "manifest.json") as PackManifest;
  const bad = manifestProblems(manifest);
  if (bad.length) throw new Error(`manifest.json: ${bad.join("; ")}`);
  const pack = manifest.id;
  const problems: string[] = [];
  const blocks: BlockDef[] = [];
  const flows: Flow[] = [];

  for (const rel of reader.list("boxes").filter((p) => p.endsWith(".json")).sort()) {
    try {
      for (const raw of asList(parseJson(reader, rel))) {
        const b = raw as BlockDef;
        if (!b || typeof b !== "object" || typeof b.id !== "string" || !PACK_ITEM_ID_RE.test(b.id)) throw new Error("each block needs an id (letters, digits, _ and -)");
        if (typeof b.name !== "string" || !b.config || typeof b.config !== "object") throw new Error(`block "${b.id}" needs a name and a config object`);
        if (blocks.some((x) => x.id === qualify(b.id, pack))) throw new Error(`duplicate block id "${b.id}"`);
        blocks.push(qualifyBlock({ id: b.id, name: b.name, isTemplate: !!b.isTemplate, extends: b.extends ?? null, config: b.config }, pack));
      }
    } catch (e) {
      problems.push(`${rel}: ${(e as Error).message}`);
    }
  }
  for (const rel of reader.list("flows").filter((p) => p.endsWith(".json")).sort()) {
    try {
      for (const raw of asList(parseJson(reader, rel))) {
        const f = raw as Flow;
        if (!f || typeof f !== "object" || typeof f.id !== "string" || !PACK_ITEM_ID_RE.test(f.id)) throw new Error("each flow needs an id (letters, digits, _ and -)");
        if (!Array.isArray(f.nodes) || !Array.isArray(f.edges)) throw new Error(`flow "${f.id}" needs nodes and edges arrays`);
        flows.push(qualifyFlow({ id: f.id, name: String(f.name ?? f.id), description: f.description, nodes: f.nodes, edges: f.edges }, pack));
      }
    } catch (e) {
      problems.push(`${rel}: ${(e as Error).message}`);
    }
  }
  const skills = reader
    .list("skills")
    .filter((p) => p.endsWith("/SKILL.md"))
    .map((p) => p.slice("skills/".length, -"/SKILL.md".length))
    .sort();

  // References that point nowhere inside this pack (other packs are checked once everything is loaded).
  const ownBlocks = new Set(blocks.map((b) => b.id));
  for (const b of blocks) {
    if (b.extends && packOf(b.extends) === pack && !ownBlocks.has(b.extends)) problems.push(`block "${b.name}" extends unknown "${b.extends}"`);
    for (const s of b.config.skills ?? []) {
      if (s.file?.store === "pack" && s.file.pack === pack && !skills.includes(s.file.dir)) problems.push(`block "${b.name}" uses missing skill folder skills/${s.file.dir}`);
    }
  }
  return { manifest, blocks, flows, skills, risks: packRisks(manifest, blocks), problems };
}

/** Everything in a pack that runs code. */
export function packRisks(m: PackManifest, blocks: BlockDef[]): PackRisk[] {
  const risks: PackRisk[] = [];
  if (m.setup?.trim()) risks.push({ kind: "setup", where: "manifest.json", detail: m.setup.trim() });
  if (m.sandbox?.dockerfile) risks.push({ kind: "dockerfile", where: "manifest.json", detail: `Builds a container image from ${m.sandbox.dockerfile}` });
  if (m.sandbox?.image) risks.push({ kind: "image", where: "manifest.json", detail: `Runs its scripts in image ${m.sandbox.image}` });
  for (const [name, plats] of Object.entries(m.bin ?? {})) risks.push({ kind: "bin", where: "manifest.json", detail: `${name}: ${Object.keys(plats).join(", ")}` });
  for (const b of blocks) {
    const run = b.config.script?.run?.trim();
    if (run) risks.push({ kind: b.config.script?.where === "host" ? "host-script" : "script", where: b.name, detail: run });
    const sh = b.config.shellCommand?.trim();
    if (sh && (b.config.autoAction === "shell" || !b.config.autoAction)) risks.push({ kind: "shell", where: b.name, detail: sh });
  }
  return risks;
}

/** sha256 over sorted paths and file contents. */
export function hashFiles(files: Iterable<[string, Uint8Array]>): string {
  const entries = [...files].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const h = createHash("sha256");
  for (const [p, data] of entries) h.update(`${p}\0${createHash("sha256").update(data).digest("hex")}\n`);
  return h.digest("hex");
}

export function hashDir(dir: string): string {
  return hashFiles(walkDir(dir).map((p) => [p, fs.readFileSync(path.join(dir, ...p.split("/")))] as [string, Uint8Array]));
}

// ---------- fetching ----------

export type Fetch = typeof fetch;

export interface FetchedPack {
  files: FileMap;
  commit?: string;
  /** The ref that was resolved (a release tag or the default branch) when none was given. */
  ref?: string;
}

/** Unzip with limits checked *before* inflating (zip bombs), rejecting paths that escape the root. */
export function unzipLimited(data: Uint8Array): FileMap {
  let count = 0;
  let total = 0;
  const entries = unzipSync(data, {
    filter: (f) => {
      if (f.name.endsWith("/")) return false;
      if (++count > MAX_FILES) throw new Error(`Too many files (more than ${MAX_FILES})`);
      if (f.originalSize > MAX_FILE) throw new Error(`${f.name} is too large (${Math.round(f.originalSize / 1e6)} MB)`);
      total += f.originalSize;
      if (total > MAX_TOTAL) throw new Error(`Pack is too large (more than ${MAX_TOTAL / 1e6} MB unpacked)`);
      return true;
    },
  });
  const files: FileMap = new Map();
  for (const [name, content] of Object.entries(entries)) {
    const rel = name.replace(/\\/g, "/").replace(/^\.\//, "");
    if (!safeRelPath(rel)) throw new Error(`Unsafe path in zip: ${name}`);
    files.set(rel, content);
  }
  return files;
}

/**
 * The pack root inside an archive: `subdir` when given, else the folder holding `manifest.json`
 * (archives from GitHub/GitLab wrap everything in one top-level folder).
 */
export function packRoot(files: FileMap, subdir?: string): FileMap {
  const strip = (prefix: string) => {
    const out: FileMap = new Map();
    for (const [k, v] of files) if (!prefix || k.startsWith(prefix)) out.set(k.slice(prefix.length), v);
    return out;
  };
  const tops = new Set([...files.keys()].map((k) => k.split("/")[0]));
  const wrapper = !files.has("manifest.json") && tops.size === 1 && [...files.keys()].every((k) => k.includes("/")) ? `${[...tops][0]}/` : "";
  const sub = subdir ? `${subdir.replace(/^\/+|\/+$/g, "")}/` : "";
  let root = strip(wrapper + sub);
  if (!root.has("manifest.json") && !sub) {
    // One level down, e.g. a zip of a folder that holds the pack.
    const cands = [...new Set([...root.keys()].filter((k) => k.endsWith("/manifest.json") && k.split("/").length === 2))];
    if (cands.length === 1) root = strip(wrapper + cands[0].slice(0, -"manifest.json".length));
  }
  if (!root.has("manifest.json")) throw new Error(`No manifest.json found${subdir ? ` in ${subdir}` : " at the top of the pack"}`);
  return root;
}

export function readFolder(dir: string): FileMap {
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new Error(`Folder not found: ${dir}`);
  const files: FileMap = new Map();
  let total = 0;
  for (const rel of walkDir(dir)) {
    if (files.size >= MAX_FILES) throw new Error(`Too many files (more than ${MAX_FILES})`);
    const data = fs.readFileSync(path.join(dir, ...rel.split("/")));
    total += data.length;
    if (total > MAX_TOTAL) throw new Error(`Folder is too large (more than ${MAX_TOTAL / 1e6} MB)`);
    files.set(rel, data);
  }
  return files;
}

interface Tokens {
  github?: string;
  gitlab?: string;
}

async function getJson<T>(f: Fetch, url: string, headers: Record<string, string>, what: string): Promise<T> {
  const res = await f(url, { headers, signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new HttpStatusError(res.status, `${what}: ${res.status} ${res.statusText}`);
  return (await res.json()) as T;
}

class HttpStatusError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function download(f: Fetch, url: string, headers: Record<string, string>): Promise<Uint8Array> {
  const res = await f(url, { headers, signal: AbortSignal.timeout(180_000), redirect: "follow" });
  if (!res.ok) throw new Error(`Download failed: ${res.status} ${res.statusText}`);
  const len = Number(res.headers.get("content-length") ?? 0);
  if (len > MAX_TOTAL) throw new Error("Archive is too large");
  return new Uint8Array(await res.arrayBuffer());
}

/**
 * GitHub without its API: `releases/latest` redirects to the newest tag, and an archive link redirects to a URL
 * holding the commit it resolved to — so this is pinned too.
 */
async function fetchGithubWithoutApi(repo: string, ref: string | undefined, subdir: string | undefined, f: Fetch): Promise<FetchedPack> {
  const headers = { "user-agent": "sandflow" };
  if (!ref) {
    const res = await f(`https://github.com/${repo}/releases/latest`, { headers, redirect: "manual", signal: AbortSignal.timeout(30_000) });
    const tag = /\/releases\/tag\/([^/?#]+)$/.exec(res.headers.get("location") ?? "")?.[1];
    if (tag) ref = decodeURIComponent(tag);
  }
  const res = await f(`https://github.com/${repo}/archive/${ref ? encodeURIComponent(ref) : "HEAD"}.zip`, { headers, redirect: "follow", signal: AbortSignal.timeout(180_000) });
  if (!res.ok) throw new Error(`Download failed: ${res.status} ${res.statusText}`);
  const commit = /\/zip\/([0-9a-f]{40})$/.exec(res.url)?.[1];
  return { files: packRoot(unzipLimited(new Uint8Array(await res.arrayBuffer())), subdir), commit, ref: ref ?? "HEAD" };
}

/** Fetch a pack from GitHub / GitLab, pinned to the commit its ref (or latest release / default branch) points at. */
export async function fetchGit(source: Extract<PackSource, { type: "github" | "gitlab" }>, tokens: Tokens = {}, f: Fetch = fetch): Promise<FetchedPack> {
  if (source.type === "github") {
    const api = source.host ? `https://${source.host}/api/v3` : "https://api.github.com";
    const headers: Record<string, string> = { accept: "application/vnd.github+json", "user-agent": "sandflow" };
    if (tokens.github) headers.authorization = `Bearer ${tokens.github}`;
    const repo = `${api}/repos/${source.repo}`;
    try {
      let ref = source.ref;
      if (!ref) {
        try {
          ref = (await getJson<{ tag_name: string }>(f, `${repo}/releases/latest`, headers, "Latest release")).tag_name;
        } catch (e) {
          if (!(e instanceof HttpStatusError) || e.status !== 404) throw e;
          ref = (await getJson<{ default_branch: string }>(f, repo, headers, `Repository ${source.repo}`)).default_branch;
        }
      }
      const commit = (await getJson<{ sha: string }>(f, `${repo}/commits/${encodeURIComponent(ref)}`, headers, `Ref ${ref}`)).sha;
      const zip = await download(f, `${repo}/zipball/${commit}`, headers);
      return { files: packRoot(unzipLimited(zip), source.subdir), commit, ref };
    } catch (e) {
      // The anonymous API allows 60 requests an hour; a public github.com repo can still be fetched from the website.
      const limited = e instanceof HttpStatusError && (e.status === 403 || e.status === 429);
      if (!limited || tokens.github || source.host) throw e;
      return fetchGithubWithoutApi(source.repo, source.ref, source.subdir, f);
    }
  }
  const api = `https://${source.host ?? "gitlab.com"}/api/v4/projects/${encodeURIComponent(source.project)}`;
  const headers: Record<string, string> = { "user-agent": "sandflow" };
  if (tokens.gitlab) headers["private-token"] = tokens.gitlab;
  let ref = source.ref;
  if (!ref) {
    const releases = await getJson<{ tag_name: string }[]>(f, `${api}/releases?order_by=released_at&sort=desc&per_page=1`, headers, "Releases").catch(() => []);
    ref = releases[0]?.tag_name ?? (await getJson<{ default_branch: string }>(f, api, headers, `Project ${source.project}`)).default_branch;
  }
  const commit = (await getJson<{ id: string }>(f, `${api}/repository/commits/${encodeURIComponent(ref)}`, headers, `Ref ${ref}`)).id;
  const zip = await download(f, `${api}/repository/archive.zip?sha=${commit}`, headers);
  return { files: packRoot(unzipLimited(zip), source.subdir), commit, ref };
}

// ---------- the store ----------

/**
 * Rename a folder, riding out Windows' transient locks (antivirus, file watchers): retry briefly, then copy and
 * delete instead.
 */
export function moveDir(from: string, to: string) {
  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== "EPERM" && code !== "EACCES" && code !== "EBUSY") throw e;
      if (attempt < 5) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100 * (attempt + 1));
        continue;
      }
      fs.cpSync(from, to, { recursive: true });
      fs.rmSync(from, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      return;
    }
  }
}

interface LockEntry {
  id: string;
  version: string;
  source: PackSource;
  commit?: string;
  hash: string;
  installedAt: number;
  trustHost: boolean;
}

interface StagedMeta {
  id: string;
  source: PackSource;
  commit?: string;
  hash: string;
  createdAt: number;
}

export interface LoadedPacks {
  blocks: BlockDef[];
  flows: Flow[];
  infos: PackInfo[];
}

/** What install-time callers need about a pack at run time (script runner, AI runner). */
export interface PackRuntimeInfo {
  id: string;
  dir: string;
  hash: string;
  trustHost: boolean;
  manifest: PackManifest;
}

export type PackStore = ReturnType<typeof createPackStore>;

export interface PackStoreOptions {
  /** Folder with packs shipped inside the app (`<bundledDir>/<id>/manifest.json`). */
  bundledDir?: string;
  fetch?: Fetch;
  /** Tokens for private GitHub / GitLab repos. */
  tokens?: () => Tokens;
}

export function createPackStore(dataDir: string, opts: PackStoreOptions = {}) {
  const packsDir = path.join(dataDir, "packs");
  const stagingDir = path.join(dataDir, "packs-staging");
  const lockFile = path.join(dataDir, "packs.json");
  const bundledDir = opts.bundledDir ?? BUNDLED_PACKS_DIR;
  const f = opts.fetch ?? fetch;
  let cache: LoadedPacks | undefined;
  const listeners = new Set<() => void>();
  const watchers = new Map<string, fs.FSWatcher>();

  function readLock(): LockEntry[] {
    try {
      const j = JSON.parse(fs.readFileSync(lockFile, "utf8")) as { packs?: LockEntry[] };
      return Array.isArray(j.packs) ? j.packs.filter((p) => p && PACK_ID_RE.test(p.id)) : [];
    } catch {
      return [];
    }
  }
  function writeLock(entries: LockEntry[]) {
    fs.mkdirSync(dataDir, { recursive: true });
    const tmp = `${lockFile}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ packs: entries }, null, 2));
    fs.renameSync(tmp, lockFile);
  }

  /** Linked folders are read in place; everything else lives under `<data>/packs/<id>`. */
  const dirOf = (e: LockEntry) => (e.source.type === "folder" && e.source.link ? e.source.path : path.join(packsDir, e.id));

  function changed() {
    cache = undefined;
    listeners.forEach((fn) => fn());
  }

  function watchLinked(entries: LockEntry[]) {
    const linked = new Map(entries.filter((e) => e.source.type === "folder" && e.source.link).map((e) => [e.id, dirOf(e)]));
    for (const [id, w] of watchers) {
      if (!linked.has(id)) {
        w.close();
        watchers.delete(id);
      }
    }
    for (const [id, dir] of linked) {
      if (watchers.has(id) || !fs.existsSync(dir)) continue;
      try {
        let t: ReturnType<typeof setTimeout> | undefined;
        const w = fs.watch(dir, { recursive: true }, () => {
          clearTimeout(t);
          t = setTimeout(changed, 300);
        });
        w.on("error", () => w.close());
        w.unref?.();
        watchers.set(id, w);
      } catch {
        /* no recursive watch here — the Reload button still works */
      }
    }
  }

  function load(): LoadedPacks {
    if (cache) return cache;
    const entries = readLock();
    const loaded: { entry: LockEntry; pack?: LoadedPack; error?: string }[] = entries.map((entry) => {
      try {
        const pack = readPack(dirReader(dirOf(entry)));
        if (pack.manifest.id !== entry.id) throw new Error(`manifest id "${pack.manifest.id}" doesn't match installed id "${entry.id}"`);
        return { entry, pack };
      } catch (e) {
        return { entry, error: (e as Error).message };
      }
    });
    const versions = new Map(loaded.filter((l) => l.pack).map((l) => [l.entry.id, l.pack!.manifest.version]));
    const allBlockIds = new Set(loaded.flatMap((l) => l.pack?.blocks.map((b) => b.id) ?? []));
    const infos: PackInfo[] = loaded.map(({ entry, pack, error }) => {
      const problems = error ? [error] : [...pack!.problems];
      for (const r of pack?.manifest.requires ?? []) {
        const v = versions.get(r.id);
        if (!v) problems.push(`needs pack "${r.id}"${r.version ? ` ${r.version}` : ""}, which isn't installed`);
        else if (!satisfies(v, r.version)) problems.push(`needs ${r.id} ${r.version}, but ${v} is installed`);
      }
      for (const b of pack?.blocks ?? []) {
        if (b.extends && packOf(b.extends) !== entry.id && packOf(b.extends) !== CORE_PACK && !allBlockIds.has(b.extends)) {
          problems.push(`block "${b.name}" extends "${b.extends}", which isn't installed`);
        }
      }
      return {
        id: entry.id,
        name: pack?.manifest.name ?? entry.id,
        version: pack?.manifest.version ?? entry.version,
        description: pack?.manifest.description,
        author: pack?.manifest.author,
        homepage: pack?.manifest.homepage ?? packSourceUrl(entry.source),
        source: entry.source,
        commit: entry.commit,
        hash: entry.hash,
        installedAt: entry.installedAt,
        trustHost: entry.trustHost,
        hasCode: (pack?.risks.length ?? 0) > 0,
        requires: pack?.manifest.requires ?? [],
        blockCount: pack?.blocks.length ?? 0,
        flowCount: pack?.flows.length ?? 0,
        skillCount: pack?.skills.length ?? 0,
        problems,
      };
    });
    watchLinked(entries);
    cache = {
      blocks: loaded.flatMap((l) => l.pack?.blocks ?? []),
      flows: loaded.flatMap((l) => l.pack?.flows ?? []),
      infos,
    };
    return cache;
  }

  function cleanStaging() {
    if (!fs.existsSync(stagingDir)) return;
    for (const name of fs.readdirSync(stagingDir)) {
      const p = path.join(stagingDir, name);
      try {
        if (Date.now() - fs.statSync(p).mtimeMs > STAGING_TTL) fs.rmSync(p, { recursive: true, force: true });
      } catch {
        /* in use */
      }
    }
  }

  function writeFiles(dir: string, files: FileMap) {
    for (const [rel, data] of files) {
      const p = path.join(dir, ...rel.split("/"));
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, data);
    }
  }

  /** Compare staged files with what's installed. Code = anything that isn't JSON/markdown/text docs. */
  function diff(files: FileMap, installedDir: string) {
    const old = new Map(fs.existsSync(installedDir) ? walkDir(installedDir).map((p) => [p, fs.readFileSync(path.join(installedDir, ...p.split("/")))] as const) : []);
    const added: string[] = [];
    const changedFiles: string[] = [];
    for (const [p, data] of files) {
      const prev = old.get(p);
      if (!prev) added.push(p);
      else if (Buffer.compare(Buffer.from(prev), Buffer.from(data)) !== 0) changedFiles.push(p);
    }
    const removed = [...old.keys()].filter((p) => !files.has(p));
    const isDoc = (p: string) => /\.(md|txt|png|jpe?g|gif|svg|webp)$/i.test(p) || /(^|\/)LICENSE[^/]*$/i.test(p);
    // Block/flow JSON can change shell commands and scripts, so it counts as code too.
    const codeChanged = [...added, ...changedFiles, ...removed].some((p) => !isDoc(p));
    return { added, changed: changedFiles, removed, codeChanged };
  }

  function preview(token: string, files: FileMap, source: PackSource, commit?: string): PackPreview {
    const pack = readPack(mapReader(files));
    const m = pack.manifest;
    const hash = hashFiles(files);
    const lock = readLock();
    const existing = lock.find((e) => e.id === m.id);
    const installed = load();
    const installedVersions = new Map(installed.infos.map((i) => [i.id, i.version]));
    const missing: PackRequirement[] = [];
    const conflicts: PackPreview["conflicts"] = [];
    for (const r of m.requires ?? []) {
      const v = installedVersions.get(r.id);
      if (!v) missing.push(r);
      else if (!satisfies(v, r.version)) conflicts.push({ id: r.id, installed: v, required: r.version ?? "*" });
    }
    const breaks = installed.infos
      .filter((i) => i.id !== m.id)
      .flatMap((i) => i.requires.filter((r) => r.id === m.id && !satisfies(m.version, r.version)).map((r) => ({ id: i.id, requires: r.version ?? "*" })));
    const totalBytes = [...files.values()].reduce((a, b) => a + b.length, 0);
    return {
      token,
      manifest: m,
      source,
      commit,
      hash,
      blocks: pack.blocks.map((b) => ({ id: b.id, name: b.name, kind: b.config.kind, isTemplate: b.isTemplate })),
      flows: pack.flows.map((fl) => ({ id: fl.id, name: fl.name })),
      skills: pack.skills,
      fileCount: files.size,
      totalBytes,
      risks: pack.risks,
      needsHost: pack.risks.some((r) => r.kind === "host-script" || r.kind === "shell"),
      existing: existing && { version: existing.version, source: existing.source, hash: existing.hash, trustHost: existing.trustHost },
      changes: existing ? diff(files, dirOf(existing)) : undefined,
      missing,
      conflicts,
      breaks,
      problems: pack.problems,
    };
  }

  /** Stage a pack's files and describe what installing it would do. */
  function stage(files: FileMap, source: PackSource, commit?: string): PackPreview {
    cleanStaging();
    const token = randomUUID();
    const p = preview(token, files, source, commit);
    const dir = path.join(stagingDir, token);
    // A linked folder isn't copied — installing just records where it is.
    if (!(source.type === "folder" && source.link)) writeFiles(path.join(dir, "files"), files);
    else fs.mkdirSync(dir, { recursive: true });
    const meta: StagedMeta = { id: p.manifest.id, source, commit, hash: p.hash, createdAt: Date.now() };
    fs.writeFileSync(path.join(dir, "meta.json"), JSON.stringify(meta));
    return p;
  }

  function tokensNow(): Tokens {
    return opts.tokens?.() ?? { github: process.env.GITHUB_TOKEN || process.env.GH_TOKEN, gitlab: process.env.GITLAB_TOKEN };
  }

  function installEntry(entry: LockEntry, filesDir?: string) {
    const target = path.join(packsDir, entry.id);
    if (filesDir) {
      fs.mkdirSync(packsDir, { recursive: true });
      const old = `${target}.old-${Date.now()}`;
      if (fs.existsSync(target)) moveDir(target, old);
      try {
        moveDir(filesDir, target);
      } catch (e) {
        if (fs.existsSync(old)) moveDir(old, target);
        throw e;
      }
      fs.rmSync(old, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } else if (fs.existsSync(target)) {
      // Switched to a linked folder: drop the old copy.
      fs.rmSync(target, { recursive: true, force: true });
    }
    writeLock([...readLock().filter((e) => e.id !== entry.id), entry]);
    changed();
  }

  return {
    packsDir,
    onChange(fn: () => void) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    load,
    reload() {
      changed();
      return load();
    },

    /** Directory, hash, trust and manifest of an installed pack (for running its scripts). */
    runtime(id: string): PackRuntimeInfo | undefined {
      const e = readLock().find((x) => x.id === id);
      if (!e) return undefined;
      const dir = dirOf(e);
      try {
        const manifest = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8").replace(/^﻿/, "")) as PackManifest;
        // Linked folders change under us — hash their current contents.
        const hash = e.source.type === "folder" && e.source.link ? hashDir(dir) : e.hash;
        return { id, dir, hash, trustHost: e.trustHost, manifest };
      } catch {
        return undefined;
      }
    },

    /** Every installed pack directory (mounted read-only into agent sandboxes). */
    dirs(): { id: string; dir: string }[] {
      return readLock().map((e) => ({ id: e.id, dir: dirOf(e) }));
    },

    /** Fetch from a GitHub / GitLab URL and stage it. */
    async previewUrl(url: string): Promise<PackPreview> {
      const src = parsePackUrl(url);
      if (!src) throw new Error(`"${url}" isn't a GitHub or GitLab link`);
      const fetched = await fetchGit(src, tokensNow(), f);
      // Pin what "latest" meant at install time so Update can tell something changed.
      return stage(fetched.files, src, fetched.commit);
    },

    previewFolder(dir: string, link: boolean): PackPreview {
      const abs = path.resolve(dir);
      return stage(readFolder(abs), { type: "folder", path: abs, link });
    },

    previewZip(name: string, data: Uint8Array): PackPreview {
      return stage(packRoot(unzipLimited(data)), { type: "zip", name: path.basename(name) });
    },

    /** Re-fetch an installed pack from where it came from (latest release / its ref, or the folder again). */
    async previewUpdate(id: string): Promise<PackPreview> {
      const e = readLock().find((x) => x.id === id);
      if (!e) throw new Error(`Pack "${id}" isn't installed`);
      const s = e.source;
      if (s.type === "github" || s.type === "gitlab") {
        // A source pinned to a tag stays on it; a branch or "latest release" moves.
        const fetched = await fetchGit(s, tokensNow(), f);
        return stage(fetched.files, s, fetched.commit);
      }
      if (s.type === "folder") return stage(readFolder(s.path), s);
      if (s.type === "bundled") return this.previewBundled(id);
      throw new Error("Packs installed from a zip are updated by adding the new zip");
    },

    previewBundled(id: string): PackPreview {
      const dir = path.join(bundledDir, id);
      return stage(readFolder(dir), { type: "bundled" });
    },

    /** Install a staged pack. `trustHost` lets its code run on this machine; `replace` swaps a pack from another source. */
    install(token: string, o: { trustHost?: boolean; replace?: boolean } = {}): PackInfo {
      if (!/^[\w-]+$/.test(token)) throw new Error("Invalid token");
      const dir = path.join(stagingDir, token);
      let meta: StagedMeta;
      try {
        meta = JSON.parse(fs.readFileSync(path.join(dir, "meta.json"), "utf8")) as StagedMeta;
      } catch {
        throw new Error("This preview has expired — add the pack again");
      }
      const existing = readLock().find((e) => e.id === meta.id);
      const sameSource = existing && JSON.stringify({ ...existing.source, ref: undefined }) === JSON.stringify({ ...meta.source, ref: undefined });
      if (existing && !sameSource && !o.replace && existing.source.type !== "bundled") {
        throw new Error(`A pack with id "${meta.id}" is already installed from somewhere else — choose Replace to swap it`);
      }
      const linked = meta.source.type === "folder" && meta.source.link;
      const filesDir = linked ? undefined : path.join(dir, "files");
      const manifest = readPack(linked ? dirReader((meta.source as { path: string }).path) : dirReader(filesDir!)).manifest;
      installEntry(
        {
          id: meta.id,
          version: manifest.version,
          source: meta.source,
          commit: meta.commit,
          hash: meta.hash,
          installedAt: Date.now(),
          trustHost: !!o.trustHost,
        },
        filesDir,
      );
      fs.rmSync(dir, { recursive: true, force: true });
      return load().infos.find((i) => i.id === meta.id)!;
    },

    remove(id: string) {
      const lock = readLock();
      const e = lock.find((x) => x.id === id);
      if (!e) throw new Error(`Pack "${id}" isn't installed`);
      writeLock(lock.filter((x) => x.id !== id));
      if (!(e.source.type === "folder" && e.source.link)) fs.rmSync(path.join(packsDir, id), { recursive: true, force: true });
      changed();
    },

    setTrust(id: string, trustHost: boolean) {
      const lock = readLock();
      if (!lock.some((x) => x.id === id)) throw new Error(`Pack "${id}" isn't installed`);
      writeLock(lock.map((x) => (x.id === id ? { ...x, trustHost } : x)));
      changed();
    },

    /** First start (and every start while it's still the shipped copy): make sure the base pack is there. */
    ensureBundledBase() {
      if (readLock().some((e) => e.id === BASE_PACK)) return;
      const dir = path.join(bundledDir, BASE_PACK);
      if (!fs.existsSync(path.join(dir, "manifest.json"))) return;
      const files = readFolder(dir);
      const target = path.join(stagingDir, `bundled-${randomUUID()}`);
      writeFiles(target, files);
      const manifest = readPack(mapReader(files)).manifest;
      installEntry({ id: BASE_PACK, version: manifest.version, source: { type: "bundled" }, hash: hashFiles(files), installedAt: Date.now(), trustHost: true }, target);
    },

    /**
     * Pull the base pack from GitHub when the installed copy is the one shipped with the app (or missing).
     * Keeps the shipped copy when offline. Returns what happened, for the log.
     */
    async refreshBaseOnline(): Promise<string> {
      const e = readLock().find((x) => x.id === BASE_PACK);
      if (e && e.source.type !== "bundled") return "base pack already installed from GitHub";
      const src = parsePackUrl(BASE_PACK_URL)!;
      const fetched = await fetchGit(src, tokensNow(), f);
      const p = stage(fetched.files, src, fetched.commit);
      if (e && semver.lt(p.manifest.version, e.version)) return `online base pack ${p.manifest.version} is older than the shipped ${e.version} — kept the shipped one`;
      this.install(p.token, { trustHost: true, replace: true });
      return `installed base pack ${p.manifest.version} from ${BASE_PACK_URL} (${fetched.ref ?? ""} ${fetched.commit?.slice(0, 7) ?? ""})`.trim();
    },

    close() {
      for (const w of watchers.values()) w.close();
      watchers.clear();
      listeners.clear();
    },
  };
}

// ---------- export ----------

export interface ExportRequest {
  manifest: PackManifest;
  blocks: BlockDef[];
  flows: Flow[];
  /** All blocks/flows (to find which other packs the exported ones depend on). */
  allBlocks: BlockDef[];
  allFlows: Flow[];
  installed: PackInfo[];
  /** Reads a file skill so it can be copied into the pack. */
  readSkill: (ref: NonNullable<SkillRef["file"]>) => Promise<{ path: string; content: string }[]>;
}

/**
 * Build a pack from your own blocks and flows. Their ids stay short inside the pack, references to other packs
 * become `requires`, and file skills are copied into `skills/`.
 */
export async function buildPack(req: ExportRequest): Promise<FileMap> {
  const bad = manifestProblems(req.manifest);
  if (bad.length) throw new Error(bad.join("; "));
  const files: FileMap = new Map();
  const enc = (v: unknown) => new TextEncoder().encode(`${JSON.stringify(v, null, 2)}\n`);
  const deps = new Set<string>();
  const note = (id: string | undefined | null) => {
    const p = id ? packOf(id) : undefined;
    if (p && p !== CORE_PACK) deps.add(p);
  };
  const exportedFlowIds = new Set(req.flows.map((x) => x.id));

  for (const b of req.blocks) {
    if (b.pack) throw new Error(`"${b.name}" comes from the ${b.pack} pack — only your own blocks can be exported`);
    note(b.extends);
    const skills: SkillRef[] = [];
    for (const s of b.config.skills ?? []) {
      if (!s.file || s.file.store === "pack") {
        if (s.file?.pack) deps.add(s.file.pack);
        skills.push(s);
        continue;
      }
      const dir = s.file.dir;
      for (const file of await req.readSkill(s.file)) files.set(`skills/${dir}/${file.path}`, new TextEncoder().encode(file.content));
      skills.push({ ...s, file: { store: "pack", dir } });
    }
    const config = { ...b.config, ...(b.config.skills ? { skills } : {}) };
    if (config.subflow?.flowId) note(config.subflow.flowId);
    const out: BlockDef = { id: b.id, name: b.name, isTemplate: b.isTemplate, ...(b.extends ? { extends: b.extends } : {}), config };
    files.set(`boxes/${b.id}.json`, enc(out));
  }
  for (const fl of req.flows) {
    if (fl.pack) throw new Error(`"${fl.name}" comes from the ${fl.pack} pack — duplicate it to export your own copy`);
    for (const n of fl.nodes) {
      note(n.data.blockId);
      const sub = n.data.overrides?.subflow?.flowId;
      if (sub) {
        if (!sub.includes("/") && !exportedFlowIds.has(sub)) throw new Error(`"${fl.name}" runs flow "${sub}" as a subflow — export that flow too`);
        note(sub);
      }
      if (!n.data.blockId.includes("/") && !req.blocks.some((b) => b.id === n.data.blockId)) {
        throw new Error(`"${fl.name}" uses your block "${n.data.blockId}" — export that block too`);
      }
    }
    files.set(`flows/${fl.id}.json`, enc({ id: fl.id, name: fl.name, ...(fl.description ? { description: fl.description } : {}), nodes: fl.nodes, edges: fl.edges }));
  }
  for (const b of req.blocks) {
    if (b.extends && !b.extends.includes("/") && !req.blocks.some((x) => x.id === b.extends)) throw new Error(`"${b.name}" extends your template "${b.extends}" — export it too`);
  }
  const requires: PackRequirement[] = [...deps].sort().map((id) => {
    const inst = req.installed.find((i) => i.id === id);
    const major = inst ? semver.major(inst.version) : undefined;
    const url = inst ? packSourceUrl(inst.source) ?? (id === BASE_PACK ? BASE_PACK_URL : undefined) : undefined;
    return { id, ...(inst ? { version: major === 0 ? `~${inst.version}` : `^${major}.0.0` } : {}), ...(url ? { source: url } : {}) };
  });
  files.set("manifest.json", enc({ ...req.manifest, ...(requires.length ? { requires } : {}) }));
  if (!files.has("README.md")) {
    files.set(
      "README.md",
      new TextEncoder().encode(`# ${req.manifest.name}\n\n${req.manifest.description ?? ""}\n\nA [Sandflow](https://github.com/kafuexe/sandflow) pack. Add it in Sandflow → Packs → Add pack.\n`),
    );
  }
  return files;
}

export function zipFiles(files: FileMap, top?: string): Uint8Array {
  const entries: Record<string, Uint8Array> = {};
  for (const [p, data] of files) entries[top ? `${top}/${p}` : p] = data;
  return zipSync(entries, { level: 6 });
}

export function writePackFolder(dir: string, files: FileMap) {
  if (fs.existsSync(dir) && fs.readdirSync(dir).length) throw new Error(`${dir} isn't empty — pick an empty or new folder`);
  for (const [rel, data] of files) {
    const p = path.join(dir, ...rel.split("/"));
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, data);
  }
}
