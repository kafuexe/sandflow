/** Remembers which flow is open across reloads: `?flow=<id>` in the URL (per tab, survives refresh in the
 *  browser and Electron) with localStorage as the fallback (fresh tab / app restart). */

const PARAM = "flow";
const KEY = "sandflow.currentFlowId";

/** The first candidate id that still names a flow, else the first flow, else null. Pure. */
export function pickFlowId(flows: readonly { id: string }[], candidates: readonly (string | null | undefined)[]): string | null {
  for (const id of candidates) if (id && flows.some((f) => f.id === id)) return id;
  return flows[0]?.id ?? null;
}

/** Saved ids in priority order (URL first, then localStorage). Never throws. */
export function savedFlowIds(): string[] {
  const ids: string[] = [];
  try {
    const fromUrl = new URLSearchParams(window.location.search).get(PARAM);
    if (fromUrl) ids.push(fromUrl);
  } catch {
    /* no window (tests) */
  }
  try {
    const stored = window.localStorage.getItem(KEY);
    if (stored) ids.push(stored);
  } catch {
    /* storage blocked */
  }
  return ids;
}

/** Record the open flow in the URL (without adding history entries) and localStorage. Never throws. */
export function saveFlowId(id: string | null): void {
  try {
    const url = new URL(window.location.href);
    if (id) url.searchParams.set(PARAM, id);
    else url.searchParams.delete(PARAM);
    if (url.href !== window.location.href) window.history.replaceState(window.history.state, "", url);
  } catch {
    /* no window (tests) */
  }
  try {
    if (id) window.localStorage.setItem(KEY, id);
    else window.localStorage.removeItem(KEY);
  } catch {
    /* storage blocked */
  }
}
