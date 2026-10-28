// `sandflow serve`: the backend without Electron — the same server as the desktop app (UI + /api on 127.0.0.1) over
// ~/.sandflow/data, announced in ~/.sandflow/daemon.json. It doesn't register itself with Claude Code: the installer
// registers `sandflow mcp` (see backend/claudeCode.ts for how the desktop app leaves that entry alone).

import type { NodeRunner } from "../engine";
import type { TriageRunner } from "../recovery";
import { startAppServer, type AppServer } from "../server";
import { cliVersion, removeDaemonInfo, resources, writeDaemonInfo, type DaemonInfo, type HomePaths } from "./home";

export type Runners = { auto: NodeRunner; ai: NodeRunner; script?: NodeRunner; integration?: NodeRunner; triage?: TriageRunner };

export async function realRunners(): Promise<Runners> {
  const [{ runAi }, { runAuto }, { runIntegration }, { runScript }, { claudeTriage }] = await Promise.all([
    import("../runners/ai"),
    import("../runners/auto"),
    import("../runners/integration"),
    import("../runners/script"),
    import("../triage"),
  ]);
  return { auto: runAuto, ai: runAi, script: runScript, integration: runIntegration, triage: claudeTriage };
}

export interface Daemon {
  server: AppServer;
  info: DaemonInfo;
  /** Pause runs, stop the server, drop daemon.json. */
  stop(): Promise<void>;
}

/** Start the server and write daemon.json. `onShutdown` is what `POST /api/shutdown` (`sandflow shutdown`) triggers. */
export async function startDaemon(
  paths: HomePaths,
  o: { port?: number; runners: Runners; fetchBasePack?: boolean; onShutdown?: () => void; pauseGraceMs?: number },
): Promise<Daemon> {
  const res = resources();
  let stopping: Promise<void> | undefined;
  const server = await startAppServer({
    dataDir: paths.data,
    webRoot: res.web,
    runners: o.runners,
    bundledSkillsDir: res.skills,
    bundledPacksDir: res.packs,
    fetchBasePack: o.fetchBasePack,
    pauseGraceMs: o.pauseGraceMs,
    port: o.port,
    history: { file: paths.history, source: "cli" },
    onShutdownRequest: () => o.onShutdown?.(),
  });
  const info: DaemonInfo = { url: server.url, pid: process.pid, port: server.port, version: cliVersion() };
  writeDaemonInfo(paths.daemon, info);
  return {
    server,
    info,
    stop: () =>
      (stopping ??= (async () => {
        try {
          await server.close("quit");
        } finally {
          removeDaemonInfo(paths.daemon);
        }
      })()),
  };
}
