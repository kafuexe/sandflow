// An agent block's dev server (MEOW's tester dev_server): started in the run's worktree before the agent, polled
// until `readyUrl` answers, and stopped when the agent is done. In a container it runs in the run's sandbox (so the
// agent reaches it on its own localhost); with Sandbox: None, on this machine.

import { randomUUID } from "node:crypto";
import type { ResolvedConfig } from "../../shared/types";
import type { RunContext } from "../engine";
import { tail } from "../prompt";
import { killTree, spawnTree } from "../proc";
import type { SandboxLike } from "./ai";
import { shQuote } from "./script";

/** Without a ready URL: how long the server gets before the agent starts. */
const NO_URL_WAIT_MS = 3000;
const POLL_MS = 1000;

export interface DevServerHandle {
  stop(): Promise<void>;
}

/** Answers with any status below 500. */
export async function urlReady(url: string, signal?: AbortSignal): Promise<boolean> {
  try {
    const r = await fetch(url, { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(5000)]) : AbortSignal.timeout(5000) });
    return r.status < 500;
  } catch {
    return false;
  }
}

const delay = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => (clearTimeout(t), resolve()), { once: true });
  });

/** Start the block's dev server, or do nothing (undefined) when it has none. Throws when it never gets ready. */
export async function startDevServer(
  ctx: RunContext,
  nodeId: string,
  cfg: ResolvedConfig,
  sandbox: SandboxLike,
  onHost: boolean,
  env: Record<string, string>,
): Promise<DevServerHandle | undefined> {
  const command = cfg.devServer.command.trim();
  if (!command) return undefined;
  const url = cfg.devServer.readyUrl.trim();
  const timeoutMs = Math.max(1, cfg.devServer.startupTimeoutSeconds || 60) * 1000;
  ctx.log("info", `Starting the dev server: ${command}${url ? ` (waiting for ${url})` : ""}`, nodeId);
  const handle = onHost ? startOnHost(ctx, command, env, sandbox) : await startInSandbox(sandbox, command, env);
  try {
    const signal = ctx.abort.signal;
    if (!url) await delay(NO_URL_WAIT_MS, signal);
    else {
      const until = Date.now() + timeoutMs;
      for (;;) {
        if (signal.aborted) throw new Error("Run cancelled");
        if (await handle.ready(url)) break;
        const exited = await handle.exited();
        if (exited !== undefined) throw new Error(`The dev server stopped before it was ready (${exited}). Its output:\n${tail(await handle.output(), 2000)}`);
        if (Date.now() > until) throw new Error(`The dev server wasn't ready at ${url} after ${timeoutMs / 1000}s. Its output:\n${tail(await handle.output(), 2000)}`);
        await delay(POLL_MS, signal);
      }
    }
    if (signal.aborted) throw new Error("Run cancelled");
    ctx.log("info", "Dev server ready", nodeId);
  } catch (e) {
    await handle.stop().catch(() => {});
    throw e;
  }
  return {
    async stop() {
      await handle.stop();
      ctx.log("info", "Dev server stopped", nodeId);
    },
  };
}

interface Running {
  ready(url: string): Promise<boolean>;
  /** Why it ended, if it already did. */
  exited(): Promise<string | undefined>;
  output(): Promise<string>;
  stop(): Promise<void>;
}

function startOnHost(ctx: RunContext, command: string, env: Record<string, string>, sandbox: SandboxLike): Running {
  const cwd = (sandbox as { worktreePath?: string }).worktreePath;
  // Its own process tree: stopping it kills npm and the server it started, not just the shell.
  const child = spawnTree(command, null, { cwd, env: { ...process.env, ...env } });
  let out = "";
  let ended: string | undefined;
  const take = (b: Buffer) => {
    out = (out + b.toString()).slice(-20_000);
  };
  child.stdout.on("data", take);
  child.stderr.on("data", take);
  child.on("exit", (code, sig) => (ended = sig ? `killed by ${sig}` : `exit code ${code}`));
  child.on("error", (e) => (ended = e.message));
  const kill = () => killTree(child);
  // Stopped with the run too, should the step end some way that skips `stop`.
  ctx.cleanup.push(async () => kill());
  return {
    ready: (url) => urlReady(url, ctx.abort.signal),
    exited: async () => ended,
    output: async () => out,
    async stop() {
      if (ended === undefined) kill();
    },
  };
}

async function startInSandbox(sandbox: SandboxLike, command: string, env: Record<string, string>): Promise<Running> {
  const dir = `/tmp/sandflow-dev/${randomUUID().slice(0, 12)}`;
  const exports = Object.entries(env).map(([k, v]) => `export ${k}=${shQuote(v)}`).join("\n");
  // setsid: its own process group, so stopping it stops everything it started.
  const r = await sandbox.exec(
    `mkdir -p ${dir}\n${exports}\nif command -v setsid >/dev/null 2>&1; then setsid sh -c ${shQuote(command)} > ${dir}/log 2>&1 < /dev/null & else sh -c ${shQuote(command)} > ${dir}/log 2>&1 < /dev/null & fi\necho $! > ${dir}/pid`,
  );
  if (r.exitCode !== 0) throw new Error(`Couldn't start the dev server (exit ${r.exitCode}): ${tail(r.stderr ?? "", 1000)}`);
  const alive = `kill -0 "$(cat ${dir}/pid)" 2>/dev/null`;
  return {
    async ready(url) {
      // Inside the container: that's where the server listens.
      const probe = `node -e ${shQuote(`fetch(${JSON.stringify(url)},{signal:AbortSignal.timeout(5000)}).then(r=>process.exit(r.status<500?0:1),()=>process.exit(1))`)}`;
      const p = await sandbox.exec(`command -v node >/dev/null 2>&1 && ${probe} || curl -s -o /dev/null --max-time 5 ${shQuote(url)}`);
      return p.exitCode === 0;
    },
    async exited() {
      const p = await sandbox.exec(alive);
      return p.exitCode === 0 ? undefined : "it exited";
    },
    async output() {
      return (await sandbox.exec(`cat ${dir}/log 2>/dev/null`)).stdout ?? "";
    },
    async stop() {
      const pid = `"$(cat ${dir}/pid)"`;
      await sandbox.exec(`kill -TERM -- -${pid} 2>/dev/null || kill -TERM ${pid} 2>/dev/null; sleep 1; kill -KILL -- -${pid} 2>/dev/null; kill -KILL ${pid} 2>/dev/null; rm -rf ${dir}; true`);
    },
  };
}
