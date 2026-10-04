import fs from "node:fs";
import path from "node:path";
import { CORE_BLOCKS } from "../shared/core";
import { BUILTIN_BLOCKS, DEFAULT_FLOW, SKILL_CATALOG } from "../shared/library";
import { BASE_PACK } from "../shared/packs";
import type { AppData, BlockDef, EnvValues, Flow, RunState, RunSummary, Settings } from "../shared/types";
import { createPackStore, qualifyFlow, type PackStore, type PackStoreOptions } from "./packs";

export const DEFAULT_SETTINGS: Settings = { startingPrompt: "", sandbox: "docker", maxSteps: 40 };

const RUN_ID_RE = /^[\w-]+$/;

function writeAtomic(file: string, content: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, file);
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

export type Storage = ReturnType<typeof createStorage>;

/**
 * A saved run without `finishedAt` was active when Sandflow last stopped (e.g. a crash) — nothing will
 * ever finish it, so report it as cancelled instead of forever "running".
 */
export function settleInterrupted(r: RunState): RunState {
  if (r.finishedAt) return r;
  const last = r.logs.at(-1)?.ts ?? r.startedAt;
  return {
    ...r,
    status: "cancelled",
    finishedAt: last,
    pendingQuestion: undefined,
    error: r.error ?? "Interrupted — Sandflow stopped while this run was active",
  };
}

export function summarize(r: RunState): RunSummary {
  const t = r.trigger;
  return {
    id: r.id,
    flowId: r.flowId,
    flowName: r.flowName,
    status: r.status,
    startedAt: r.startedAt,
    finishedAt: r.finishedAt,
    trigger: t ? { source: t.source, type: t.type, author: t.author, title: t.title } : undefined,
    prompt: r.prompt,
    pendingQuestion: r.pendingQuestion,
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
  let baseChecked = false;
  const write = (name: string, value: unknown) => writeAtomic(file(name), JSON.stringify(value, null, 2));
  const runFile = (id: string) => {
    if (!RUN_ID_RE.test(id)) throw new Error("Invalid run id");
    return path.join(dir, "runs", `${id}.json`);
  };

  return {
    dir,
    packs,
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
      let flows = readJson<Flow[]>(file("flows.json"));
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
        blocks: [...CORE_BLOCKS, ...p.blocks, ...blocks.filter((b) => !b.pack)],
        flows: [...flows.filter((f) => !f.pack), ...p.flows],
        settings: { ...DEFAULT_SETTINGS, ...settings },
        env,
        packs: p.infos,
      };
    },
    /** Saves your own blocks; pack and core blocks in the list are ignored (they're read-only). */
    saveBlocks: (blocks: BlockDef[]) => write("library.json", blocks.filter((b) => !b.pack)),
    /** Saves your own flows; pack flows in the list are ignored. */
    saveFlows: (flows: Flow[]) => write("flows.json", flows.filter((f) => !f.pack)),
    saveSettings: (settings: Settings) => write("settings.json", settings),
    saveEnv: (env: EnvValues) => write("env.json", env),
    saveRun: (run: RunState) => writeAtomic(runFile(run.id), JSON.stringify(run, null, 2)),
    loadRun: (id: string) => (RUN_ID_RE.test(id) ? readJson<RunState>(runFile(id)) : undefined),

    /** Most recent saved runs (ids start with an ISO timestamp, so name order = time order). */
    listRuns(limit = 50): RunSummary[] {
      let names: string[];
      try {
        names = fs.readdirSync(path.join(dir, "runs")).filter((n) => n.endsWith(".json"));
      } catch {
        return [];
      }
      return names
        .sort()
        .reverse()
        .slice(0, limit)
        .flatMap((n) => {
          try {
            return [summarize(settleInterrupted(JSON.parse(fs.readFileSync(path.join(dir, "runs", n), "utf8")) as RunState))];
          } catch {
            return [];
          }
        });
    },
    saveArtifact(runId: string, nodeId: string, n: number, text: string) {
      runFile(runId);
      const safeNode = nodeId.replace(/[^\w-]/g, "_");
      writeAtomic(path.join(dir, "runs", runId, `${safeNode}-${n}.md`), text);
    },
  };
}
