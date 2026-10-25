/** Pure sizing logic for resizable panels: clamping, drag/keyboard math and localStorage persistence.
 *  Kept free of React and the DOM so it can be unit-tested. */

/** Which edge of the panel the handle sits on. A handle on the panel's right/bottom edge grows the panel
 *  when dragged right/down; one on the left/top edge grows it when dragged left/up. */
export type HandleEdge = "left" | "right" | "top" | "bottom";

export interface SizeBounds {
  min: number;
  max: number;
}

export interface PanelSizeSpec extends SizeBounds {
  /** Stable id; the size is stored under `sandflow.panel.<id>`. */
  id: string;
  defaultSize: number;
}

export const STORAGE_PREFIX = "sandflow.panel.";
/** Arrow-key step, and the bigger one used with Shift. */
export const KEY_STEP = 16;
export const KEY_STEP_LARGE = 64;

/** Minimal Storage surface we need, so tests can pass a fake. */
export type SizeStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export function clampSize(value: number, { min, max }: SizeBounds): number {
  const lo = Math.min(min, max);
  const hi = Math.max(min, max);
  if (!Number.isFinite(value)) return lo;
  return Math.round(Math.min(hi, Math.max(lo, value)));
}

export const isVerticalEdge = (edge: HandleEdge) => edge === "left" || edge === "right";

/** New size after the pointer moved from `startPos` to `pos` (clientX for left/right edges, clientY for top/bottom). */
export function dragSize(startSize: number, startPos: number, pos: number, edge: HandleEdge, bounds: SizeBounds): number {
  const delta = pos - startPos;
  const grows = edge === "right" || edge === "bottom";
  return clampSize(startSize + (grows ? delta : -delta), bounds);
}

/** New size for a key press on the focused handle, or `null` when the key isn't ours.
 *  Arrows move the handle in their direction (so the panel grows or shrinks depending on its edge);
 *  Home/End jump to min/max. */
export function keyboardSize(key: string, size: number, edge: HandleEdge, bounds: SizeBounds, large = false): number | null {
  const step = large ? KEY_STEP_LARGE : KEY_STEP;
  if (key === "Home") return clampSize(bounds.min, bounds);
  if (key === "End") return clampSize(bounds.max, bounds);
  const horizontal = isVerticalEdge(edge);
  const towards: Record<string, number> = horizontal ? { ArrowLeft: -1, ArrowRight: 1 } : { ArrowUp: -1, ArrowDown: 1 };
  const dir = towards[key];
  if (dir === undefined) return null;
  const grows = edge === "right" || edge === "bottom";
  return clampSize(size + dir * step * (grows ? 1 : -1), bounds);
}

export const storageKey = (id: string) => STORAGE_PREFIX + id;

/** The browser's localStorage, or undefined when it's unavailable (SSR, sandboxed iframe, blocked). */
export function defaultStorage(): SizeStorage | undefined {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

/** Stored size for the panel, clamped to its bounds; the default when missing, unreadable or invalid. */
export function loadSize(spec: PanelSizeSpec, storage: SizeStorage | undefined = defaultStorage()): number {
  let raw: string | null = null;
  try {
    raw = storage?.getItem(storageKey(spec.id)) ?? null;
  } catch {
    raw = null;
  }
  const n = raw === null || raw.trim() === "" ? NaN : Number(raw);
  return clampSize(Number.isFinite(n) ? n : spec.defaultSize, spec);
}

/** Persists the size; storing the default clears the entry so a later default change applies. Never throws. */
export function saveSize(spec: PanelSizeSpec, size: number, storage: SizeStorage | undefined = defaultStorage()): void {
  try {
    const value = clampSize(size, spec);
    if (value === clampSize(spec.defaultSize, spec)) storage?.removeItem(storageKey(spec.id));
    else storage?.setItem(storageKey(spec.id), String(value));
  } catch {
    /* quota exceeded / storage disabled — the size just won't survive a reload */
  }
}

/** Every resizable panel in the app, in one place so ids stay unique. */
export const PANELS = {
  palette: { id: "palette", defaultSize: 260, min: 200, max: 520 },
  side: { id: "side", defaultSize: 360, min: 280, max: 760 },
  chat: { id: "chat", defaultSize: 380, min: 300, max: 800 },
  runList: { id: "runList", defaultSize: 288, min: 200, max: 520 },
  runLogs: { id: "runLogs", defaultSize: 320, min: 120, max: 1200 },
  runActivity: { id: "runActivity", defaultSize: 360, min: 120, max: 1200 },
} as const satisfies Record<string, PanelSizeSpec>;
