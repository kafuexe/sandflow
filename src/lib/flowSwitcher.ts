/** Pure logic behind the top-bar flow switcher: search, ranking, grouping, recents. No React, no DOM. */
import type { Flow, FlowColor } from "../../shared/types";

/** Swatch for each palette colour — mid-tone, readable as a dot on both light and dark surfaces. */
export const FLOW_COLOR_SWATCH: Record<FlowColor, string> = {
  red: "#ef4444",
  orange: "#f97316",
  amber: "#f59e0b",
  green: "#22c55e",
  teal: "#14b8a6",
  blue: "#3b82f6",
  violet: "#8b5cf6",
  pink: "#ec4899",
};

/** Half-open [start, end) character ranges of `text` that a search hit. */
export type Range = [number, number];

export interface FlowItem {
  flow: Flow;
  /** Parts of the flow's name the query matched (empty when the hit was elsewhere, or there is no query). */
  ranges: Range[];
}

export interface FlowSection {
  key: "recent" | "own" | "pack" | "results";
  label: string;
  items: FlowItem[];
}

const words = (q: string) => q.toLowerCase().split(/\s+/).filter(Boolean);

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
export const byName = (a: Flow, b: Flow) => collator.compare(a.name, b.name) || a.id.localeCompare(b.id);

function mergeRanges(ranges: Range[]): Range[] {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  const out: Range[] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else out.push([r[0], r[1]]);
  }
  return out;
}

function locate(text: string, query: string): { ranges: Range[]; wordStarts: boolean } | null {
  const ws = words(query);
  if (!ws.length) return { ranges: [], wordStarts: true };
  const lower = text.toLowerCase();
  const ranges: Range[] = [];
  let wordStarts = true;
  for (const w of ws) {
    // Prefer a hit at a word start ("pipe" in "Feature pipeline"), else the first hit anywhere.
    const re = new RegExp(`(^|[^\\p{L}\\p{N}])${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "u");
    const m = re.exec(lower);
    const at = m ? m.index + m[1].length : lower.indexOf(w);
    if (at < 0) return null;
    if (!m) wordStarts = false;
    ranges.push([at, at + w.length]);
  }
  return { ranges: mergeRanges(ranges), wordStarts };
}

/** Where each query word occurs in `text` (case-insensitive), or null when any word is missing. */
export function matchRanges(text: string, query: string): Range[] | null {
  return locate(text, query)?.ranges ?? null;
}

/** Text a flow can be found by besides its name: its pack and description. */
const extraText = (f: Flow) => [f.pack, f.description].filter(Boolean).join(" ").toLowerCase();

/** Lower is better; null = not a match. */
export function scoreFlow(flow: Flow, query: string): { score: number; ranges: Range[] } | null {
  const q = query.trim().toLowerCase();
  if (!q) return { score: 0, ranges: [] };
  const name = flow.name.toLowerCase();
  const hit = locate(flow.name, q);
  if (hit) {
    // exact > prefix > every word starts a word in the name > hits inside words
    const score = name === q ? 0 : name.startsWith(q) ? 1 : hit.wordStarts ? 2 : 3;
    return { score, ranges: hit.ranges };
  }
  // Every word must hit somewhere: the name or the extra text.
  const extra = extraText(flow);
  if (words(q).every((w) => name.includes(w) || extra.includes(w))) return { score: 4, ranges: matchRanges(flow.name, words(q).filter((w) => name.includes(w)).join(" ")) ?? [] };
  return null;
}

/** Flows matching `query`, best first; ties go to the more recently opened flow, then by name. */
export function filterFlows(flows: Flow[], query: string, recent: string[] = []): FlowItem[] {
  const rank = (id: string) => {
    const i = recent.indexOf(id);
    return i < 0 ? Number.MAX_SAFE_INTEGER : i;
  };
  return flows
    .map((flow) => ({ flow, hit: scoreFlow(flow, query) }))
    .filter((x): x is { flow: Flow; hit: { score: number; ranges: Range[] } } => x.hit !== null)
    .sort((a, b) => a.hit.score - b.hit.score || rank(a.flow.id) - rank(b.flow.id) || byName(a.flow, b.flow))
    .map(({ flow, hit }) => ({ flow, ranges: hit.ranges }));
}

/**
 * What the switcher lists. Searching: one ranked "results" section. Otherwise: recently opened flows
 * (only once there are enough flows for that to help), then your own flows A–Z, then pack flows A–Z.
 * Every flow appears exactly once.
 */
export function buildSections(flows: Flow[], query: string, recent: string[] = [], opts: { recentLimit?: number; recentMinFlows?: number } = {}): FlowSection[] {
  const { recentLimit = 4, recentMinFlows = 6 } = opts;
  if (query.trim()) {
    const items = filterFlows(flows, query, recent);
    return items.length ? [{ key: "results", label: "Results", items }] : [];
  }
  const byId = new Map(flows.map((f) => [f.id, f]));
  const recentFlows =
    flows.length >= recentMinFlows
      ? recent
          .map((id) => byId.get(id))
          .filter((f): f is Flow => !!f)
          .slice(0, recentLimit)
      : [];
  const taken = new Set(recentFlows.map((f) => f.id));
  const rest = flows.filter((f) => !taken.has(f.id)).sort(byName);
  const item = (flow: Flow): FlowItem => ({ flow, ranges: [] });
  const sections: FlowSection[] = [
    { key: "recent", label: "Recent", items: recentFlows.map(item) },
    { key: "own", label: recentFlows.length ? "All flows" : "Your flows", items: rest.filter((f) => !f.pack).map(item) },
    { key: "pack", label: "From packs", items: rest.filter((f) => f.pack).map(item) },
  ];
  return sections.filter((s) => s.items.length);
}

/** Split `text` into plain and matched runs for rendering a highlight. */
export function highlightSegments(text: string, ranges: Range[]): { text: string; match: boolean }[] {
  const out: { text: string; match: boolean }[] = [];
  let at = 0;
  for (const [s, e] of mergeRanges(ranges)) {
    const start = Math.max(at, Math.min(s, text.length));
    const end = Math.min(e, text.length);
    if (start > at) out.push({ text: text.slice(at, start), match: false });
    if (end > start) out.push({ text: text.slice(start, end), match: true });
    at = Math.max(at, end);
  }
  if (at < text.length) out.push({ text: text.slice(at), match: false });
  return out;
}

/** Move `id` to the front of the recent list (most recent first), capped at `max`. */
export function pushRecent(recent: string[], id: string, max = 12): string[] {
  return [id, ...recent.filter((x) => x !== id)].slice(0, max);
}

/** Next active index for an arrow / Home / End key, wrapping at the ends. */
export function moveActive(index: number, count: number, key: string): number {
  if (count <= 0) return -1;
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  if (key === "ArrowDown") return index < 0 ? 0 : (index + 1) % count;
  if (key === "ArrowUp") return index < 0 ? count - 1 : (index - 1 + count) % count;
  return index;
}

// ---------- recents, per browser (a viewing convenience, not flow data) ----------

const RECENT_KEY = "sandflow.flowSwitcher.recent";

export function loadRecent(): string[] {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]");
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export function saveRecent(recent: string[]): void {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(recent));
  } catch {
    /* storage unavailable — recents just won't survive a reload */
  }
}
