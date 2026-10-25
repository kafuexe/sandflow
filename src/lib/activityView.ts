/** Pure helpers for the run views' "AI activity" and collapsible sections: filtering, grouping and remembered
 *  preferences. Free of React so they can be unit-tested. */

import type { AgentActivity } from "../../shared/activity";
import { defaultStorage, type SizeStorage } from "./panelSize";

export interface ActivityFilter {
  thinking: boolean;
  /** The agent's replies. */
  text: boolean;
  /** Tool calls and their results. */
  tools: boolean;
}

export const DEFAULT_FILTER: ActivityFilter = { thinking: true, text: true, tools: true };

export function shown(a: AgentActivity, f: ActivityFilter): boolean {
  if (a.kind === "thinking") return f.thinking;
  if (a.kind === "text") return f.text;
  if (a.kind === "tool" || a.kind === "tool_result") return f.tools;
  return true;
}

export interface ActivityGroup {
  nodeKey: string;
  items: AgentActivity[];
  /** When the node first showed activity (groups are ordered by it). */
  firstTs: number;
}

/** Activity per node, filtered, in the order the nodes started showing activity. Empty groups are left out. */
export function groupActivity(activity: Record<string, AgentActivity[]> | undefined, f: ActivityFilter = DEFAULT_FILTER): ActivityGroup[] {
  return Object.entries(activity ?? {})
    .map(([nodeKey, all]) => ({ nodeKey, items: all.filter((a) => shown(a, f)), firstTs: all[0]?.ts ?? 0 }))
    .filter((g) => g.items.length)
    .sort((a, b) => a.firstTs - b.firstTs);
}

/** One node's activity during one execution (items saved before executions were tracked count for every one). */
export const activityOf = (activity: Record<string, AgentActivity[]> | undefined, nodeKey: string, exec: number) =>
  (activity?.[nodeKey] ?? []).filter((a) => a.exec === undefined || a.exec === exec);

const SECTION_PREFIX = "sandflow.section.";
const FILTER_KEY = "sandflow.activityFilter";

/** Whether a collapsible section is open; `fallback` when nothing (valid) is stored. Never throws. */
export function loadOpen(id: string, fallback: boolean, storage: SizeStorage | undefined = defaultStorage()): boolean {
  try {
    const v = storage?.getItem(SECTION_PREFIX + id);
    return v === "1" ? true : v === "0" ? false : fallback;
  } catch {
    return fallback;
  }
}

export function saveOpen(id: string, open: boolean, storage: SizeStorage | undefined = defaultStorage()): void {
  try {
    storage?.setItem(SECTION_PREFIX + id, open ? "1" : "0");
  } catch {
    /* storage unavailable — it just won't be remembered */
  }
}

export function loadFilter(storage: SizeStorage | undefined = defaultStorage()): ActivityFilter {
  try {
    const raw = storage?.getItem(FILTER_KEY);
    const v = raw ? (JSON.parse(raw) as Partial<ActivityFilter>) : {};
    const pick = (k: keyof ActivityFilter) => (typeof v?.[k] === "boolean" ? v[k]! : DEFAULT_FILTER[k]);
    return { thinking: pick("thinking"), text: pick("text"), tools: pick("tools") };
  } catch {
    return { ...DEFAULT_FILTER };
  }
}

export function saveFilter(f: ActivityFilter, storage: SizeStorage | undefined = defaultStorage()): void {
  try {
    storage?.setItem(FILTER_KEY, JSON.stringify(f));
  } catch {
    /* not remembered */
  }
}
