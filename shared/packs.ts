// Pack helpers shared by the UI and the server: ids, source URLs, manifest checks, version ranges.
//
// A pack is a folder (or git repo / zip) with `manifest.json`, `boxes/*.json` (blocks and templates),
// `flows/*.json`, `skills/<dir>/` and any other files its Script blocks use. Inside a pack ids are short (`plan`); once loaded they're
// qualified with the pack id (`base/plan`). Your own blocks and flows never contain a `/`.

import semver from "semver";
import type { PackManifest, PackSource } from "./types";

export const PACK_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
/** A block / flow id inside a pack (before qualification). */
export const PACK_ITEM_ID_RE = /^[\w-]{1,96}$/;
/** Pack id used by the blocks built into Sandflow itself (subflows, script, flow input/output). */
export const CORE_PACK = "sandflow";
export const BASE_PACK = "base";
export const BASE_PACK_URL = "https://github.com/kafuexe/sandflow-base-boxes";

/** `base/plan` → `base`; local ids have no pack. */
export const packOf = (id: string): string | undefined => (id.includes("/") ? id.slice(0, id.indexOf("/")) : undefined);

/** Qualify a reference made inside `pack`: `plan` → `base/plan`; already-qualified ids are kept. */
export const qualify = (id: string, pack: string): string => (id.includes("/") ? id : `${pack}/${id}`);

/** `base/plan` → `plan` (the id inside its pack). */
export const localId = (id: string): string => (id.includes("/") ? id.slice(id.indexOf("/") + 1) : id);

/** Platform key used by a manifest's `bin` map, e.g. `linux-x64`, `win32-x64`, `darwin-arm64`. */
export const platformKey = (platform: string, arch: string) => `${platform}-${arch}`;

/** Does `version` satisfy `range`? An empty range accepts anything. */
export function satisfies(version: string, range: string | undefined): boolean {
  if (!range?.trim()) return true;
  return semver.satisfies(version, range, { includePrerelease: true });
}

/** Problems with a manifest (empty = valid). */
export function manifestProblems(m: unknown): string[] {
  if (!m || typeof m !== "object" || Array.isArray(m)) return ["manifest.json must be a JSON object"];
  const x = m as Partial<PackManifest>;
  const errors: string[] = [];
  if (typeof x.id !== "string" || !PACK_ID_RE.test(x.id)) errors.push(`"id" must be lowercase letters, digits and dashes (got ${JSON.stringify(x.id)})`);
  if (x.id === CORE_PACK) errors.push(`"${CORE_PACK}" is reserved for Sandflow's built-in blocks`);
  if (typeof x.name !== "string" || !x.name.trim()) errors.push(`"name" is required`);
  if (typeof x.version !== "string" || !semver.valid(x.version)) errors.push(`"version" must be a semver version like 1.0.0 (got ${JSON.stringify(x.version)})`);
  if (x.requires !== undefined) {
    if (!Array.isArray(x.requires)) errors.push(`"requires" must be a list`);
    else
      for (const r of x.requires) {
        if (!r || typeof r.id !== "string" || !PACK_ID_RE.test(r.id)) errors.push(`"requires" has an entry with an invalid id`);
        else if (r.version !== undefined && !semver.validRange(r.version)) errors.push(`"requires" ${r.id}: invalid version range "${r.version}"`);
        else if (r.source !== undefined && !parsePackUrl(r.source)) errors.push(`"requires" ${r.id}: "${r.source}" isn't a GitHub or GitLab URL`);
      }
  }
  if (x.setup !== undefined && typeof x.setup !== "string") errors.push(`"setup" must be a command string`);
  if (x.sandbox !== undefined) {
    const sb = x.sandbox;
    if (!sb || typeof sb !== "object") errors.push(`"sandbox" must be an object`);
    else {
      if (sb.image !== undefined && (typeof sb.image !== "string" || !/^[\w./:@-]+$/.test(sb.image))) errors.push(`"sandbox.image" is not a valid image name`);
      if (sb.dockerfile !== undefined && (typeof sb.dockerfile !== "string" || !safeRelPath(sb.dockerfile))) errors.push(`"sandbox.dockerfile" must be a relative path inside the pack`);
    }
  }
  if (x.bin !== undefined) {
    if (!x.bin || typeof x.bin !== "object") errors.push(`"bin" must be an object`);
    else
      for (const [name, platforms] of Object.entries(x.bin)) {
        if (!/^[\w.-]+$/.test(name)) errors.push(`"bin": invalid executable name "${name}"`);
        if (!platforms || typeof platforms !== "object") errors.push(`"bin.${name}" must map platforms to paths`);
        else
          for (const [plat, p] of Object.entries(platforms)) {
            if (!/^[a-z0-9]+-[a-z0-9]+$/.test(plat)) errors.push(`"bin.${name}": invalid platform "${plat}" (use e.g. linux-x64)`);
            if (typeof p !== "string" || !safeRelPath(p)) errors.push(`"bin.${name}.${plat}" must be a relative path inside the pack`);
          }
      }
  }
  return errors;
}

/** A relative `/`-separated path that stays inside its root. */
export function safeRelPath(p: string): boolean {
  return /^(?!.*(^|\/)\.\.?(\/|$))[\w .@+-]+(\/[\w .@+-]+)*$/.test(p) && !p.startsWith("/");
}

/**
 * Read a GitHub / GitLab link into a pack source:
 * `https://github.com/owner/repo`, `…/tree/<ref>/<subdir>`, `github:owner/repo`,
 * `https://gitlab.com/group/sub/project`, `…/-/tree/<ref>/<subdir>`, `gitlab:group/project`, self-hosted hosts too
 * (anything with `gitlab` in the host name, or a `gitlab:` prefix: `gitlab:git.corp.local/group/project`).
 */
export function parsePackUrl(input: string): Extract<PackSource, { type: "github" | "gitlab" }> | undefined {
  const raw = input.trim().replace(/\.git$/, "").replace(/\/+$/, "");
  let m = /^github:([\w.-]+\/[\w.-]+)(?:#(.+))?$/.exec(raw);
  if (m) return { type: "github", repo: m[1], ...(m[2] ? { ref: m[2] } : {}) };
  m = /^gitlab:(?:([a-z0-9.-]+\.[a-z]{2,}(?::\d+)?)\/)?([\w.-]+(?:\/[\w.-]+)+)(?:#(.+))?$/i.exec(raw);
  if (m) return { type: "gitlab", project: m[2], ...(m[1] ? { host: m[1] } : {}), ...(m[3] ? { ref: m[3] } : {}) };

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
  const host = url.host.toLowerCase();
  const segs = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);

  if (host === "github.com" || host === "www.github.com" || host.startsWith("github.")) {
    if (segs.length < 2) return undefined;
    const src: Extract<PackSource, { type: "github" }> = { type: "github", repo: `${segs[0]}/${segs[1]}` };
    if (host !== "github.com" && host !== "www.github.com") src.host = host;
    if ((segs[2] === "tree" || segs[2] === "blob") && segs[3]) {
      src.ref = segs[3];
      if (segs.length > 4) src.subdir = segs.slice(4).join("/");
    }
    return src;
  }
  if (host.includes("gitlab")) {
    const dash = segs.indexOf("-");
    const projectSegs = dash >= 0 ? segs.slice(0, dash) : segs;
    if (projectSegs.length < 2) return undefined;
    const src: Extract<PackSource, { type: "gitlab" }> = { type: "gitlab", project: projectSegs.join("/") };
    if (host !== "gitlab.com") src.host = host;
    if (dash >= 0 && segs[dash + 1] === "tree" && segs[dash + 2]) {
      src.ref = segs[dash + 2];
      if (segs.length > dash + 3) src.subdir = segs.slice(dash + 3).join("/");
    }
    return src;
  }
  return undefined;
}

/** Link back to a git source (for "Update" and the UI). */
export function packSourceUrl(s: PackSource): string | undefined {
  if (s.type === "github") {
    const base = `https://${s.host ?? "github.com"}/${s.repo}`;
    return s.ref ? `${base}/tree/${s.ref}${s.subdir ? `/${s.subdir}` : ""}` : base;
  }
  if (s.type === "gitlab") {
    const base = `https://${s.host ?? "gitlab.com"}/${s.project}`;
    return s.ref ? `${base}/-/tree/${s.ref}${s.subdir ? `/${s.subdir}` : ""}` : base;
  }
  return undefined;
}

/** Short human label for a source. */
export function packSourceLabel(s: PackSource): string {
  switch (s.type) {
    case "github":
      return `GitHub ${s.host ? `${s.host}/` : ""}${s.repo}${s.ref ? `@${s.ref}` : ""}${s.subdir ? `/${s.subdir}` : ""}`;
    case "gitlab":
      return `GitLab ${s.host ? `${s.host}/` : ""}${s.project}${s.ref ? `@${s.ref}` : ""}${s.subdir ? `/${s.subdir}` : ""}`;
    case "folder":
      return `${s.link ? "Linked folder" : "Folder"} ${s.path}`;
    case "zip":
      return `Zip ${s.name}`;
    case "bundled":
      return "Shipped with Sandflow";
  }
}
