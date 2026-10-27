import fs from "node:fs";
import path from "node:path";
import { CORE_BLOCKS } from "../shared/core";
import { BUILTIN_BLOCKS, DEFAULT_FLOW, SKILL_CATALOG } from "../shared/library";
import { sanitizeFlowColor } from "../shared/flows";
import { BASE_PACK, CORE_PACK } from "../shared/packs";
import { journalProblem } from "../shared/journal";
import { summarize } from "../shared/runs";
import type { AppData, BlockDef, EnvValues, Flow, RunState, RunSummary, Settings } from "../shared/types";
import { createIntegrationStore } from "./integrations";
import { redactJournal, secretValues } from "./journal";
import { createPackStore, qualifyFlow, type PackStore, type PackStoreOptions } from "./packs";

export const DEFAULT_SETTINGS: Settings = { startingPrompt: "", sandbox: "docker", maxSteps: 40 };

const RUN_ID_RE = /^[\w-]+$/;

let tmpSeq = 0;

/** Temp file in the same folder → write → fsync → rename (MEOW `_write`): a crash leaves the old file or the new one. */
export function writeAtomic(file: string, content: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.${tmpSeq++}.tmp`;
  try {
    const fd = fs.openSync(tmp, "w");
    try {
      fs.writeSync(fd, content);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, file);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
}

function readJson<T>(file: string): T | undefined {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw e;
  }
}

/** Built-in blocks seeded before skills were bundled referenced them on GitHub — point them at the bundled files. */
function upgradeBuiltinSkills(blocks: BlockDef[]): { blocks: BlockDef[]; changed: boolean } {
  let changed = false;
  const out = blocks.map((b) => {
    if (!b.builtin || !b.config.skills?.length) return b;
    const skills = b.config.skills.map((s) => {
      if (s.file) return s;
      const bundled = SKILL_CATALOG.find((c) => c.name === s.name && c.source === s.source);
      if (!bundled) return s;
      changed = true;
      return bundled;
    });
    return { ...b, config: { ...b.config, skills } };
  });
  return { blocks: out, changed };
}

/** JSON with object keys sorted, so two equal definitions compare equal whatever order their keys were written in. */
function stableJson(v: unknown): string {
  return JSON.stringify(v, (_k, x) =>
    x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, (x as Record<string, unknown>)[k]])) : x,
  );
}

/**
 * Before packs, the built-in blocks were copied into library.json and flows referenced them by short id
 * (`plan`). They now live in the base pack (`base/plan`): unchanged copies are dropped and every reference
 * re-pointed; a built-in you edited stays as one of your own blocks (same id, so your flows keep using it).
 */
export function migrateLegacy(blocks: BlockDef[], flows: Flow[]): { blocks: BlockDef[]; flows: Flow[]; changed: boolean } {
  if (!blocks.some((b) => b.builtin)) return { blocks, flows, changed: false };
  const legacy = new Map(BUILTIN_BLOCKS.map((b) => [b.id, b]));
  const shape = (b: BlockDef) => stableJson({ name: b.name, isTemplate: b.isTemplate, extends: b.extends ?? null, config: b.config });
  const idMap = new Map<string, string>();
  const kept: BlockDef[] = [];
  for (const b of upgradeBuiltinSkills(blocks).blocks) {
    const original = b.builtin ? legacy.get(b.id) : undefined;
    if (original && shape(b) === shape(original)) idMap.set(b.id, `${BASE_PACK}/${b.id}`);
    else kept.push(b.builtin ? (({ builtin: _drop, ...rest }) => rest)(b) : b);
  }
  const remap = (id: string) => idMap.get(id) ?? id;
  return {
    blocks: kept.map((b) => (b.extends ? { ...b, extends: remap(b.extends) } : b)),
    flows: flows.map((f) => ({ ...f, nodes: f.nodes.map((n) => ({ ...n, data: { ...n.data, blockId: remap(n.data.blockId) } })) })),
    changed: true,
  };
}

/** A pack block you may edit (Sandflow's own engine blocks stay as they are). */
export const editablePackBlock = (b: BlockDef): boolean => !!b.pack && b.pack !== CORE_PACK;

/**
 * Pack blocks with your edits applied. An edit is kept in library.json as the whole block with `pack` set; it
 * keeps the pack's id and pack (so its files, runtime and trust still come from the pack). Edits of blocks the
 * pack no longer has are ignored.
 */
export function applyPackEdits(packBlocks: BlockDef[], saved: BlockDef[]): BlockDef[] {
  const edits = new Map(saved.filter(editablePackBlock).map((b) => [b.id, b]));
  return packBlocks.map((b) => {
    const e = editablePackBlock(b) ? edits.get(b.id) : undefined;
    return e ? { ...e, id: b.id, pack: b.pack, modified: true } : b;
  });
}

export type Storage = ReturnType<typeof createStorage>;

const INTERRUPTED_FLAG = "interrupted";

/**
 * A saved run without `finishedAt` was active when Sandflow last stopped (e.g. a crash) — nothing will
 * ever finish it, so report it as cancelled instead of forever "running".
 */
export function settleInterrupted(r: RunState): RunState {
  // A journal says itself where it is (its phase); the continue pass deals with ones Sandflow was running.
  if (r.finishedAt || r.schemaVersion !== undefined) return r;
  const last = r.logs.at(-1)?.ts ?? r.startedAt;
  const error = r.error ?? "Interrupted — Sandflow stopped while this run was active";
  const flags = r.flags ?? [];
  return {
    ...r,
    status: "cancelled",
    finishedAt: last,
    pendingQuestion: undefined,
    error,
    // A stack task's interruption shows on its top-level run, which was interrupted too.
    flags: r.parent || flags.some((f) => f.id === INTERRUPTED_FLAG) ? flags : [...flags, { id: INTERRUPTED_FLAG, severity: "error", message: error, at: last }],
  };
}

/** Mark one of the run's flags as looked at. False when the run has no such flag. */
export function dismissFlag(r: RunState, flagId: string): boolean {
  const f = r.flags?.find((x) => x.id === flagId);
  if (!f) return false;
  f.dismissed = true;
  return true;
}

/**
 * The newest `limit` top-level runs plus every child run under them. `runs` must be newest first; a child always
 * starts after its parent, so it comes before it.
 */
export function limitRuns(runs: RunSummary[], limit: number): RunSummary[] {
  const parentOf = new Map(runs.filter((r) => r.parent).map((r) => [r.id, r.parent!.runId]));
  const rootOf = (id: string) => {
    let cur = id;
    for (let i = 0; i < 20 && parentOf.has(cur); i++) cur = parentOf.get(cur)!;
    return cur;
  };
  const roots = new Set(runs.filter((r) => !r.parent).slice(0, limit).map((r) => r.id));
  return runs.filter((r) => roots.has(r.parent ? rootOf(r.id) : r.id));
}

export { summarize };

/** A run file that can't be read or isn't a valid journal: never continued, left as it is, listed with a flag. */
export function corruptSummary(id: string, file: string, problem: string): RunSummary {
  const at = Date.parse(id.slice(0, 24).replace(/^(\d{4}-\d{2}-\d{2}T\d{2})-(\d{2})-(\d{2})-(\d{3})Z/, "$1:$2:$3.$4Z"));
  return {
    id,
    flowId: "",
    flowName: "Unreadable run",
    status: "failed",
    startedAt: Number.isFinite(at) ? at : 0,
    flags: { warning: 0, error: 1 },
    hold: { reason: "corrupt", problems: [`Journal corrupt (${problem}) — preserved at ${file}`], at: Date.now() },
  };
}

export interface StorageOptions extends PackStoreOptions {
  /** Use this pack store instead of creating one over `<dir>/packs`. */
  packs?: PackStore;
}

export function createStorage(dir = path.resolve(".sandflow"), opts: StorageOptions = {}) {
  const file = (name: string) => path.join(dir, name);
  // Private pack repos: tokens from the Inputs tab's env values, else the process environment.
  const tokens = () => {
    const env = readJson<EnvValues>(file("env.json")) ?? {};
    return {
      github: env.GITHUB_TOKEN || env.GH_TOKEN || process.env.GITHUB_TOKEN || process.env.GH_TOKEN,
      gitlab: env.GITLAB_TOKEN || process.env.GITLAB_TOKEN,
    };
  };
  const packs = opts.packs ?? createPackStore(dir, { tokens, ...opts });
  const integrations = createIntegrationStore(dir, packs);
  let baseChecked = false;
  const write = (name: string, value: unknown) => writeAtomic(file(name), JSON.stringify(value, null, 2));
  /** Secret values to keep out of journals: from Inputs (re-read when env.json changes) and this process's env. */
  let secretCache: { mtimeMs: number; values: string[] } | undefined;
  const secrets = () => {
    const mtimeMs = fs.statSync(file("env.json"), { throwIfNoEntry: false })?.mtimeMs ?? 0;
    if (secretCache?.mtimeMs !== mtimeMs) secretCache = { mtimeMs, values: secretValues(readJson<EnvValues>(file("env.json")) ?? {}, process.env) };
    return secretCache.values;
  };
  /** Run summaries by file name, with the file's mtime/size when it was read. */
  const summaryCache = new Map<string, { mtimeMs: number; size: number; summary: RunSummary }>();
  const runFile = (id: string) => {
    if (!RUN_ID_RE.test(id)) throw new Error("Invalid run id");
    return path.join(dir, "runs", `${id}.json`);
  };

  /** Blocks you don't own: every pack's, plus your own integrations' actions. */
  const packBlocks = () => [...packs.load().blocks, ...integrations.ownBlocks()];

  return {
    dir,
    packs,
    integrations,
    packBlocks,
    /** Your own blocks/flows merged with Sandflow's core blocks and every installed pack's blocks/flows. */
    load(): AppData {
      if (!baseChecked) {
        // First start: the base pack shipped with the app, so there's always something to build with.
        baseChecked = true;
        try {
          packs.ensureBundledBase();
        } catch (e) {
          console.warn(`[packs] couldn't install the shipped base pack: ${(e as Error).message}`);
        }
      }
      let blocks = readJson<BlockDef[]>(file("library.json"));
      let flows = readJson<Flow[]>(file("flows.json"))?.map(sanitizeFlowColor);
      if (!blocks) {
        blocks = [];
        write("library.json", blocks);
      }
      if (!flows) {
        flows = [qualifyFlow(DEFAULT_FLOW, BASE_PACK, false)];
        write("flows.json", flows);
      }
      const migrated = migrateLegacy(blocks, flows);
      if (migrated.changed) {
        ({ blocks, flows } = migrated);
        write("library.json", blocks);
        write("flows.json", flows);
      }
      let settings = readJson<Settings>(file("settings.json"));
      if (!settings) {
        settings = DEFAULT_SETTINGS;
        write("settings.json", settings);
      }
      const env = readJson<EnvValues>(file("env.json")) ?? {};
      const p = packs.load();
      return {
        blocks: [...CORE_BLOCKS, ...applyPackEdits(packBlocks(), blocks), ...blocks.filter((b) => !b.pack)],
        flows: [...flows.filter((f) => !f.pack), ...p.flows],
        settings: { ...DEFAULT_SETTINGS, ...settings },
        env,
        packs: p.infos,
        integrations: integrations.list(),
      };
    },
    /** Saves your own blocks and your edits of pack blocks (`modified`); other pack and core blocks are ignored. */
    saveBlocks: (blocks: BlockDef[]) =>
      write(
        "library.json",
        blocks.filter((b) => !b.pack || (b.modified && editablePackBlock(b))).map(({ modified: _m, ...b }) => b),
      ),
    /** Saves your own flows; pack flows in the list are ignored. */
    saveFlows: (flows: Flow[]) => write("flows.json", flows.filter((f) => !f.pack)),
    saveSettings: (settings: Settings) => write("settings.json", settings),
    saveEnv: (env: EnvValues) => write("env.json", env),
    /** Writes the run's journal: atomic + fsynced, secrets redacted (from Inputs and this process's env). */
    saveRun: (run: RunState) => writeAtomic(runFile(run.id), JSON.stringify(redactJournal(run, secrets()), null, 2)),
    loadRun: (id: string) => (RUN_ID_RE.test(id) ? readJson<RunState>(runFile(id)) : undefined),
    runFile,
    /**
     * Strict load of a journal (fail closed): `problem` says why it can't be trusted; the file is left untouched.
     * `legacy`: a run saved before journals existed (no schemaVersion) — readable, never continued.
     */
    loadJournal(id: string): { run?: RunState; problem?: string; legacy?: boolean; file: string } {
      const f = runFile(id);
      let raw: unknown;
      try {
        raw = JSON.parse(fs.readFileSync(f, "utf8"));
      } catch (e) {
        return { file: f, problem: (e as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : `unreadable: ${(e as Error).message}` };
      }
      if (raw && typeof raw === "object" && (raw as RunState).schemaVersion === undefined && typeof (raw as RunState).id === "string") {
        return { file: f, run: raw as RunState, legacy: true };
      }
      const problem = journalProblem(raw, id);
      return problem ? { file: f, problem } : { file: f, run: raw as RunState };
    },
    /** Ids of every saved run, oldest first. */
    runIds(): string[] {
      try {
        return fs.readdirSync(path.join(dir, "runs")).filter((n) => n.endsWith(".json")).map((n) => n.slice(0, -5)).filter((id) => RUN_ID_RE.test(id)).sort();
      } catch {
        return [];
      }
    },

    /** Most recent saved runs (ids start with an ISO timestamp, so name order = time order). */
    listRuns(limit = 50): RunSummary[] {
      let names: string[];
      try {
        names = fs.readdirSync(path.join(dir, "runs")).filter((n) => n.endsWith(".json"));
      } catch {
        return [];
      }
      const out: RunSummary[] = [];
      let roots = 0;
      // Newest first; stop at the limit-th top-level run — anything older can't be a child of the ones we keep.
      for (const n of names.sort().reverse()) {
        try {
          const file = path.join(dir, "runs", n);
          // The UI polls this list: only parse run files that changed since last time.
          const st = fs.statSync(file);
          let s = summaryCache.get(n);
          if (!s || s.mtimeMs !== st.mtimeMs || s.size !== st.size) {
            let summary: RunSummary;
            try {
              const raw = JSON.parse(fs.readFileSync(file, "utf8")) as RunState;
              const problem = raw?.schemaVersion === undefined ? undefined : journalProblem(raw, n.slice(0, -5));
              summary = problem ? corruptSummary(n.slice(0, -5), file, problem) : summarize(settleInterrupted(raw));
            } catch (e) {
              summary = corruptSummary(n.slice(0, -5), file, (e as Error).message);
            }
            s = { mtimeMs: st.mtimeMs, size: st.size, summary };
            summaryCache.set(n, s);
          }
          out.push(s.summary);
          if (!s.summary.parent && ++roots >= limit) break;
        } catch {
          /* vanished meanwhile */
        }
      }
      return limitRuns(out, limit);
    },
    saveArtifact(runId: string, nodeId: string, n: number, text: string) {
      runFile(runId);
      const safeNode = nodeId.replace(/[^\w-]/g, "_");
      writeAtomic(path.join(dir, "runs", runId, `${safeNode}-${n}.md`), text);
    },
  };
}
