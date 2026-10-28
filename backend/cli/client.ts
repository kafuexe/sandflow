// Talking to a Sandflow backend over HTTP, and making sure the CLI daemon runs (auto-started, detached).

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { readHistory } from "../history";
import { liveDaemon, releaseLock, samePath, takeLock, answers, type DaemonInfo, type HomePaths } from "./home";

export interface Ctx {
  paths: HomePaths;
  /** stdout / stderr, one call per line (or chunk when `raw`). */
  out(s: string): void;
  err(s: string): void;
  env: NodeJS.ProcessEnv;
  /** stdin and stdout are a terminal (prompts, the picker). */
  isTTY: boolean;
  stdin: NodeJS.ReadableStream & { setRawMode?: (on: boolean) => unknown; isTTY?: boolean };
  fetch: typeof fetch;
  /** Start the detached daemon (tests replace it). */
  spawnDaemon(port?: number): void;
  openBrowser(url: string): void;
  platform: NodeJS.Platform;
}

export class ApiError extends Error {
  constructor(public status: number, message: string, public body: Record<string, unknown> = {}) {
    super(message);
  }
}

export async function request<T>(ctx: Pick<Ctx, "fetch">, base: string, method: string, p: string, body?: unknown): Promise<T> {
  let r: Response;
  try {
    r = await ctx.fetch(`${base}/api${p}`, {
      method,
      headers: body === undefined ? {} : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (e) {
    throw new ApiError(0, `Sandflow isn't reachable at ${base}: ${(e as Error).message}`);
  }
  const text = await r.text();
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = undefined;
  }
  if (!r.ok) {
    const b = (json && typeof json === "object" ? json : {}) as Record<string, unknown>;
    throw new ApiError(r.status, String(b.error ?? `${method} ${p} answered ${r.status}`), b);
  }
  return json as T;
}

/** Run the CLI itself detached as `serve --daemon`, its output going to daemon.log. */
export function spawnDaemonProcess(paths: HomePaths, env: NodeJS.ProcessEnv, port?: number) {
  fs.mkdirSync(paths.home, { recursive: true });
  const log = fs.openSync(paths.daemonLog, "a");
  const script = path.resolve(process.argv[1]);
  const child = spawn(process.execPath, [script, "serve", "--daemon", ...(port ? ["--port", String(port)] : [])], {
    detached: true,
    stdio: ["ignore", log, log],
    windowsHide: true,
    env,
  });
  child.unref();
  fs.closeSync(log);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The running daemon, started first when daemon.json isn't alive. One client starts it; others wait (daemon.lock). */
export async function ensureDaemon(ctx: Ctx, o: { port?: number; timeoutMs?: number } = {}): Promise<DaemonInfo> {
  const live = await liveDaemon(ctx.paths.daemon, ctx.fetch);
  if (live) return live;
  const deadline = Date.now() + (o.timeoutMs ?? 30_000);
  const mine = takeLock(ctx.paths.daemonLock);
  try {
    if (mine) {
      // Someone may have finished starting it between the check and the lock.
      const again = await liveDaemon(ctx.paths.daemon, ctx.fetch);
      if (again) return again;
      ctx.err("Starting the Sandflow daemon…");
      ctx.spawnDaemon(o.port);
    }
    while (Date.now() < deadline) {
      await sleep(250);
      const d = await liveDaemon(ctx.paths.daemon, ctx.fetch);
      if (d) return d;
    }
  } finally {
    if (mine) releaseLock(ctx.paths.daemonLock);
  }
  throw new Error(`The Sandflow daemon didn't start in time — see ${ctx.paths.daemonLog}`);
}

/** The desktop app's URL from `<dataDir>/mcp.json` (it writes its random port there). */
export function instanceUrl(dataDir: string): string | undefined {
  try {
    const url = JSON.parse(fs.readFileSync(path.join(dataDir, "mcp.json"), "utf8")).mcpServers.sandflow.url as string;
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}

/**
 * Which Sandflow drives a run: the CLI daemon, or — for a run of the desktop app (another data dir in history.jsonl) —
 * that app while it's running.
 */
export async function instanceFor(ctx: Ctx, runId: string): Promise<{ base: string; desktop?: boolean }> {
  const e = readHistory(ctx.paths.history).find((x) => x.runId === runId);
  if (e && !samePath(e.dataDir, ctx.paths.data)) {
    const base = instanceUrl(e.dataDir);
    if (base && (await answers(base, 1500, ctx.fetch))) return { base, desktop: true };
    throw new ApiError(
      0,
      `Run ${runId} belongs to the Sandflow ${e.source === "desktop" ? "desktop app" : "instance"} with data in ${e.dataDir}, which isn't running. ` +
        "Open the desktop app to continue it (it picks up paused runs when it starts).",
    );
  }
  return { base: (await ensureDaemon(ctx)).url };
}
