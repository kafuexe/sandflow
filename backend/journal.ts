// Server side of the run journal (see shared/journal.ts): fingerprints, redaction, the one-driver-per-run lock and
// cleanup of what a crashed run left behind. Modelled on MEOW (`_safe`, `DriverLock`, `process_identity`).

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveNode } from "../shared/resolve";
import type { BlockDef, Flow, NodeIO, RunState, Settings } from "../shared/types";
import type { Exec } from "./sandbox";

/** JSON with object keys sorted, so equal values hash equal whatever order their keys were written in. */
function stableJson(v: unknown): string {
  return JSON.stringify(v, (_k, x) =>
    x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, (x as Record<string, unknown>)[k]])) : x,
  );
}
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/**
 * sha256 of the flow and everything it reaches: each node's block and its template chain, and the flows of its
 * subflows and Box Stacks (recursively). Layout, names and the flow's own switches are left out — moving a node
 * or renaming a flow doesn't stop a run from continuing.
 */
export function flowFingerprint(flow: Flow, flows: Flow[], blocks: BlockDef[]): string {
  const byBlock = new Map(blocks.map((b) => [b.id, b]));
  const byFlow = new Map(flows.map((f) => [f.id, f]));
  const seenBlocks = new Map<string, unknown>();
  const seenFlows = new Map<string, unknown>();
  const addBlock = (id: string | null | undefined) => {
    for (let i = 0; id && !seenBlocks.has(id) && i < 50; i++) {
      const b = byBlock.get(id);
      seenBlocks.set(id, b ? { extends: b.extends ?? null, isTemplate: b.isTemplate, config: b.config } : null);
      id = b?.extends;
    }
  };
  const addFlow = (f: Flow | undefined, id: string) => {
    if (seenFlows.has(id)) return;
    if (!f) return void seenFlows.set(id, null);
    seenFlows.set(id, {
      runOn: f.runOn ?? null,
      nodes: [...f.nodes].sort((a, b) => a.id.localeCompare(b.id)).map((n) => ({ id: n.id, blockId: n.data.blockId, overrides: n.data.overrides ?? null })),
      edges: [...f.edges]
        .map((e) => ({ s: e.source, t: e.target, sh: e.sourceHandle, th: e.targetHandle }))
        .sort((a, b) => stableJson(a).localeCompare(stableJson(b))),
    });
    for (const n of f.nodes) {
      addBlock(n.data.blockId);
      let ref: string | undefined;
      try {
        const cfg = resolveNode(n, blocks);
        ref = cfg.kind === "subflow" ? cfg.subflow.flowId : cfg.kind === "stack" ? cfg.stack.flowId : undefined;
      } catch {
        /* a broken chain is part of the fingerprint through its blocks */
      }
      if (ref) addFlow(byFlow.get(ref), ref);
    }
  };
  addFlow(flow, flow.id);
  return sha256(stableJson({ flows: Object.fromEntries(seenFlows), blocks: Object.fromEntries(seenBlocks) }));
}

/** The settings that change how a run behaves. */
export const settingsFingerprintOf = (s: Settings) => ({ sandbox: s.sandbox, sandboxImage: s.sandboxImage?.trim() || null, maxSteps: s.maxSteps });
export const settingsFingerprint = (s: Settings): string => sha256(stableJson(settingsFingerprintOf(s)));

// ---------- redaction (MEOW `_safe`) ----------

/** Env var names whose values are secrets: they never go into a journal. */
export const SECRET_NAME_RE = /token|secret|password|passwd|credential|api.?key|authorization|private.?key/i;
/** Longest text kept per input / output in the journal (the full text stays in the run's artifact files). */
export const JOURNAL_MAX_TEXT = 256 * 1024;
const REDACTED = "[redacted]";

/** Values of secret-named variables (short values are left alone: replacing "1" everywhere would wreck the journal). */
export function secretValues(...envs: Record<string, string | undefined>[]): string[] {
  const out = new Set<string>();
  for (const env of envs) for (const [k, v] of Object.entries(env)) if (SECRET_NAME_RE.test(k) && v && v.trim().length >= 6) out.add(v.trim());
  // Longest first, so a secret containing another is replaced whole.
  return [...out].sort((a, b) => b.length - a.length);
}

const capText = (s: string) => (s.length > JOURNAL_MAX_TEXT ? `${s.slice(0, JOURNAL_MAX_TEXT)}\n…(cut in the journal — full text in the run's artifact files)` : s);
const capIO = (io: NodeIO | undefined) => io && Object.fromEntries(Object.entries(io).map(([k, v]) => [k, typeof v === "string" ? capText(v) : v]));

/** The journal as written to disk: secrets replaced, very long inputs / outputs capped. */
export function redactJournal(run: RunState, secrets: string[]): RunState {
  let json = JSON.stringify(run);
  for (const s of secrets) {
    const enc = JSON.stringify(s).slice(1, -1);
    if (json.includes(enc)) json = json.split(enc).join(REDACTED);
  }
  const out = JSON.parse(json) as RunState;
  for (const ns of Object.values(out.nodes)) {
    if (ns.inputs) ns.inputs = capIO(ns.inputs);
    if (ns.outputs) ns.outputs = capIO(ns.outputs);
  }
  for (const q of Object.values(out.queues ?? {})) for (const s of q) s.inputs = capIO(s.inputs) ?? {};
  return out;
}

// ---------- process identity (MEOW `process_identity`) ----------

/** Whether a process with this pid exists (EPERM: it does, it just isn't ours). */
export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** When this process started (ms since epoch). */
export const OWN_START = Math.round(Date.now() - process.uptime() * 1000);
/** Start times from different clocks / APIs differ a little; a reused pid differs by much more. */
const START_TOLERANCE_MS = 5_000;

/**
 * When the process with this pid started (ms since epoch), or undefined when it can't be told. Only called when a
 * pid recorded earlier is alive — to tell the same process from a new one that got the pid.
 */
export function processStartTime(pid: number): number | undefined {
  if (pid === process.pid) return OWN_START;
  try {
    if (process.platform === "linux") {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
      const ticks = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19]);
      const btime = Number(/^btime (\d+)/m.exec(fs.readFileSync("/proc/stat", "utf8"))?.[1]);
      return Number.isFinite(ticks) && Number.isFinite(btime) ? btime * 1000 + Math.round((ticks / 100) * 1000) : undefined;
    }
    if (process.platform === "win32") {
      const out = execFileSync(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().ToString('o')`],
        { encoding: "utf8", timeout: 10_000, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] },
      );
      const t = Date.parse(out.trim());
      return Number.isFinite(t) ? t : undefined;
    }
    const out = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", timeout: 5_000, stdio: ["ignore", "pipe", "ignore"] });
    const t = Date.parse(out.trim());
    return Number.isFinite(t) ? t : undefined;
  } catch {
    return undefined;
  }
}

/** Whether `pid` is still the process that started at `startedAt` (unknown start time: it can't be told — false). */
export function sameProcess(pid: number, startedAt: number): boolean {
  if (!pidAlive(pid)) return false;
  const t = processStartTime(pid);
  return t !== undefined && Math.abs(t - startedAt) <= START_TOLERANCE_MS;
}

// ---------- one driver per run (MEOW `DriverLock`) ----------

export interface LockHolder {
  pid: number;
  startedAt: number;
  host: string;
  at: number;
}

const lockFile = (runsDir: string, id: string) => path.join(runsDir, `${id}.lock`);

/** Whether the lock's owner is alive: its pid exists and is still the same process (or that can't be told). */
function holderAlive(h: LockHolder): boolean {
  if (h.host !== os.hostname()) return true; // another machine on a shared folder: never steal it
  if (!pidAlive(h.pid)) return false;
  const t = processStartTime(h.pid);
  return t === undefined || Math.abs(t - h.startedAt) <= START_TOLERANCE_MS;
}

export function readLock(runsDir: string, id: string): LockHolder | undefined {
  try {
    const h = JSON.parse(fs.readFileSync(lockFile(runsDir, id), "utf8")) as LockHolder;
    return typeof h?.pid === "number" ? h : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Take `runs/<id>.lock` for this Sandflow: created exclusively, holding our pid and start time. A lock whose owner
 * is dead (pid gone, or reused by another process) is reclaimed once; a live owner keeps it (`holder` is returned).
 */
export function acquireRunLock(runsDir: string, id: string): { ok: true } | { ok: false; holder?: LockHolder } {
  const file = lockFile(runsDir, id);
  const mine: LockHolder = { pid: process.pid, startedAt: OWN_START, host: os.hostname(), at: Date.now() };
  fs.mkdirSync(runsDir, { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(file, "wx");
      try {
        fs.writeSync(fd, JSON.stringify(mine));
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      return { ok: true };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
    const holder = readLock(runsDir, id);
    // Unreadable: someone is writing it right now, or it's junk — only junk older than a minute is reclaimed.
    if (!holder) {
      const age = Date.now() - (fs.statSync(file, { throwIfNoEntry: false })?.mtimeMs ?? 0);
      if (age < 60_000) return { ok: false };
    } else if (holderAlive(holder)) return { ok: false, holder };
    if (attempt === 0) fs.rmSync(file, { force: true });
  }
  return { ok: false, holder: readLock(runsDir, id) };
}

/** Release our lock (never someone else's). */
export function releaseRunLock(runsDir: string, id: string) {
  const h = readLock(runsDir, id);
  if (h && h.pid === process.pid && h.startedAt === OWN_START) fs.rmSync(lockFile(runsDir, id), { force: true });
}

// ---------- leftovers of a crashed run ----------

const CONTAINER_ID_RE = /^[0-9a-f]{12,64}$/;

/**
 * Remove the containers and kill the agent processes a run recorded, when they still exist and are the same ones
 * (container id matches; process start time matches). Nothing is touched unless its recorded identity matches.
 * Returns what was removed, for the log.
 */
export async function cleanupLeftovers(run: Pick<RunState, "sandboxes" | "processes">, exec: Exec, killPid: (pid: number) => void): Promise<string[]> {
  const done: string[] = [];
  for (const c of run.sandboxes ?? []) {
    if (!CONTAINER_ID_RE.test(c.containerId) || (c.kind !== "docker" && c.kind !== "podman")) continue;
    const r = await exec(c.kind, ["inspect", "--format", "{{.Id}}", c.containerId]).catch(() => ({ code: 1, stdout: "" }));
    if (r.code !== 0 || !r.stdout.trim().startsWith(c.containerId)) continue;
    const rm = await exec(c.kind, ["rm", "-f", c.containerId]).catch(() => ({ code: 1 }));
    if (rm.code === 0) done.push(`container ${c.containerId.slice(0, 12)}`);
  }
  for (const p of run.processes ?? []) {
    if (p.pid === process.pid || !sameProcess(p.pid, p.startedAt)) continue;
    try {
      killPid(p.pid);
      done.push(`process ${p.pid}`);
    } catch {
      /* gone meanwhile */
    }
  }
  return done;
}
