import type { SkillRef } from "./types";

export const SKILL_NAME_RE = /^[\w.-]+$/;
/** GitHub `owner/repo`. */
export const SKILL_SOURCE_RE = /^[\w.-]+\/[\w.-]+$/;
/** Directory inside a skill store: safe segments, no `..`. */
export const SKILL_DIR_RE = /^(?!.*(^|\/)\.\.?(\/|$))[\w.-]+(\/[\w.-]+)*$/;

/** Stable identity of a skill (file skills by location, GitHub skills by repo + name). */
export function skillKey(s: SkillRef): string {
  return s.file ? `${s.file.store}:${s.file.dir}` : `${s.source ?? ""}/${s.name}`;
}

/** Why a skill ref is unusable, or undefined when it's fine. */
export function skillProblem(s: SkillRef): string | undefined {
  if (!SKILL_NAME_RE.test(s.name)) return "name may only contain letters, digits, '.', '_' and '-'";
  if (s.file) {
    if (s.file.store !== "bundled" && s.file.store !== "user") return "unknown file store";
    if (!SKILL_DIR_RE.test(s.file.dir)) return "invalid file location";
    return undefined;
  }
  if (!s.source || !SKILL_SOURCE_RE.test(s.source)) return "needs a GitHub source (owner/repo) or a file";
  return undefined;
}
