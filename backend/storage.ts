import fs from "node:fs";
import path from "node:path";
import { BUILTIN_BLOCKS, DEFAULT_FLOW } from "../shared/library";
import type { AppData, BlockDef, EnvValues, Flow, RunState, Settings } from "../shared/types";

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

export type Storage = ReturnType<typeof createStorage>;

export function createStorage(dir = path.resolve(".sandflow")) {
  const file = (name: string) => path.join(dir, name);
  const write = (name: string, value: unknown) => writeAtomic(file(name), JSON.stringify(value, null, 2));
  const runFile = (id: string) => {
    if (!RUN_ID_RE.test(id)) throw new Error("Invalid run id");
    return path.join(dir, "runs", `${id}.json`);
  };

  return {
    dir,
    load(): AppData {
      let blocks = readJson<BlockDef[]>(file("library.json"));
      if (!blocks) {
        blocks = BUILTIN_BLOCKS;
        write("library.json", blocks);
      } else {
        const missing = BUILTIN_BLOCKS.filter((b) => !blocks!.some((x) => x.id === b.id));
        if (missing.length) {
          blocks = [...blocks, ...missing];
          write("library.json", blocks);
        }
      }
      let flows = readJson<Flow[]>(file("flows.json"));
      if (!flows) {
        flows = [DEFAULT_FLOW];
        write("flows.json", flows);
      }
      let settings = readJson<Settings>(file("settings.json"));
      if (!settings) {
        settings = DEFAULT_SETTINGS;
        write("settings.json", settings);
      }
      const env = readJson<EnvValues>(file("env.json")) ?? {};
      return { blocks, flows, settings: { ...DEFAULT_SETTINGS, ...settings }, env };
    },
    saveBlocks: (blocks: BlockDef[]) => write("library.json", blocks),
    saveFlows: (flows: Flow[]) => write("flows.json", flows),
    saveSettings: (settings: Settings) => write("settings.json", settings),
    saveEnv: (env: EnvValues) => write("env.json", env),
    saveRun: (run: RunState) => writeAtomic(runFile(run.id), JSON.stringify(run, null, 2)),
    loadRun: (id: string) => (RUN_ID_RE.test(id) ? readJson<RunState>(runFile(id)) : undefined),
    saveArtifact(runId: string, nodeId: string, n: number, text: string) {
      runFile(runId);
      const safeNode = nodeId.replace(/[^\w-]/g, "_");
      writeAtomic(path.join(dir, "runs", runId, `${safeNode}-${n}.md`), text);
    },
  };
}
