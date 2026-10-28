// ~/.sandflow (or $SANDFLOW_HOME): the CLI's home — its daemon's data dir, the shared run history, daemon.json,
// schedules and the installed CLI. Also read by the desktop app (it appends to history.jsonl).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function sandflowHome(env: NodeJS.ProcessEnv = process.env): string {
  return path.resolve(env.SANDFLOW_HOME?.trim() || path.join(os.homedir(), ".sandflow"));
}

export function homePaths(home = sandflowHome()) {
  return {
    home,
    data: path.join(home, "data"),
    history: path.join(home, "history.jsonl"),
    daemon: path.join(home, "daemon.json"),
    daemonLock: path.join(home, "daemon.lock"),
    daemonLog: path.join(home, "daemon.log"),
    schedules: path.join(home, "schedules"),
    bin: path.join(home, "bin"),
  };
}
export type HomePaths = ReturnType<typeof homePaths>;

/** Same folder? (Windows paths are case-insensitive.) */
export function samePath(a: string, b: string): boolean {
  const n = (p: string) => (process.platform === "win32" ? path.resolve(p).toLowerCase() : path.resolve(p));
  return n(a) === n(b);
}

/**
 * Where the UI, packs and skills are: next to the bundle (dist-cli/sandflow.mjs → dist-cli/web, …), or the repo when
 * run from source (backend/cli/ → repo root, UI in dist/).
 */
export function resources() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const bundled = fs.existsSync(path.join(here, "web"));
  const root = bundled ? here : path.resolve(here, "..", "..");
  return {
    root,
    web: path.join(root, bundled ? "web" : "dist"),
    packs: path.join(root, "packs"),
    skills: path.join(root, "skills"),
    agentSkills: path.join(root, "agent-skills"),
  };
}

let version: string | undefined;
/** dist-cli/package.json when bundled, the repo's package.json from source. */
export function cliVersion(): string {
  if (version) return version;
  try {
    version = String(JSON.parse(fs.readFileSync(path.join(resources().root, "package.json"), "utf8")).version ?? "0.0.0");
  } catch {
    version = "0.0.0";
  }
  return version;
}

// ---------- daemon.json ----------

export interface DaemonInfo {
  url: string;
  pid: number;
  port: number;
  version: string;
}

export function readDaemonInfo(file: string): DaemonInfo | undefined {
  try {
    const d = JSON.parse(fs.readFileSync(file, "utf8")) as DaemonInfo;
    return typeof d?.url === "string" && typeof d.pid === "number" ? d : undefined;
  } catch {
    return undefined;
  }
}

export function writeDaemonInfo(file: string, d: DaemonInfo) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(d, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

/** Removes daemon.json only while it still names this process (a newer daemon may have replaced it). */
export function removeDaemonInfo(file: string, pid = process.pid) {
  if (readDaemonInfo(file)?.pid === pid) fs.rmSync(file, { force: true });
}

export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Whether a Sandflow server answers at `base` (http://127.0.0.1:port). */
export async function answers(base: string, timeoutMs = 1500, fetchFn: typeof fetch = fetch): Promise<boolean> {
  try {
    const r = await fetchFn(`${base}/api/health`, { signal: AbortSignal.timeout(timeoutMs) });
    if (r.ok) return true;
    // An older desktop app has no /api/health; /api/runs answers on every version.
    if (r.status !== 404) return false;
    return (await fetchFn(`${base}/api/runs`, { signal: AbortSignal.timeout(timeoutMs) })).ok;
  } catch {
    return false;
  }
}

/** The running daemon from daemon.json: its process is alive and it answers. */
export async function liveDaemon(file: string, fetchFn: typeof fetch = fetch): Promise<DaemonInfo | undefined> {
  const d = readDaemonInfo(file);
  if (!d || !pidAlive(d.pid)) return undefined;
  return (await answers(d.url, 1500, fetchFn)) ? d : undefined;
}

// ---------- start lock: one client starts the daemon, the others wait for it ----------

const LOCK_STALE_MS = 60_000;

/** Take the lock (true), or false while another live process holds a fresh one. A stale lock is taken over. */
export function takeLock(file: string, now = Date.now()): boolean {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  for (let i = 0; i < 2; i++) {
    try {
      fs.writeFileSync(file, JSON.stringify({ pid: process.pid, at: now }), { flag: "wx" });
      return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      let held: { pid?: number; at?: number } = {};
      try {
        held = JSON.parse(fs.readFileSync(file, "utf8"));
      } catch {
        /* half-written: treat as stale */
      }
      if (held.pid && pidAlive(held.pid) && now - (held.at ?? 0) < LOCK_STALE_MS) return false;
      fs.rmSync(file, { force: true });
    }
  }
  return false;
}

export function releaseLock(file: string) {
  try {
    if (JSON.parse(fs.readFileSync(file, "utf8")).pid === process.pid) fs.rmSync(file, { force: true });
  } catch {
    /* gone */
  }
}

/** The shim the installer puts on PATH, when it's there. */
export function installedShim(p: HomePaths): string | undefined {
  const f = path.join(p.bin, process.platform === "win32" ? "sandflow.cmd" : "sandflow");
  return fs.existsSync(f) ? f : undefined;
}
