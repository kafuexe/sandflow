// Container-runtime helpers for air-gapped use: the sandbox image is loaded from an offline bundle and
// must already exist locally — Sandflow never pulls it. The installers ship that bundle, so the default
// image is loaded from it automatically.

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { AGENT_TOOLS_MOUNT, DEFAULT_SANDBOX_IMAGE } from "../shared/settings";
import type { Settings } from "../shared/types";
import { runTree } from "./proc";

export type Exec = (cmd: string, args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;

/** Run a command without a shell; never throws for a non-zero exit. */
export const execCli: Exec = (cmd, args) =>
  new Promise((resolve) => {
    execFile(cmd, args, { windowsHide: true, maxBuffer: 10 * 1024 * 1024, timeout: 10 * 60_000 }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : 1) : 0;
      resolve({ code, stdout: String(stdout), stderr: String(stderr || (err && code === 1 ? err.message : "")) });
    });
  });

export interface SandboxImageStatus {
  runtime: "docker" | "podman";
  runtimeAvailable: boolean;
  image: string;
  imagePresent: boolean;
  /** The app ships a bundle for this image (it's the default image), so it can be loaded without picking a file. */
  bundled: boolean;
}

const runtimeOf = (s: Settings): "docker" | "podman" => (s.sandbox === "podman" ? "podman" : "docker");
export const imageOf = (s: Settings) => s.sandboxImage?.trim() || DEFAULT_SANDBOX_IMAGE;

let bundledImageFile: string | undefined;
let bundledLoad: Promise<string> | undefined;

/** The `sandflow-agent:<version>` bundle shipped inside the installed app (resources/sandbox/). */
export function setBundledSandboxImage(file: string | undefined) {
  bundledImageFile = file && fs.existsSync(file) ? file : undefined;
}

/** Only the default image comes with the app — a custom image is the user's to provide. */
function bundledFileFor(s: Settings) {
  return s.sandbox !== "none" && imageOf(s) === DEFAULT_SANDBOX_IMAGE ? bundledImageFile : undefined;
}

/** Load the shipped bundle (one load at a time — a run and the startup check may both ask for it). */
export function loadBundledSandboxImage(s: Settings, exec: Exec = execCli): Promise<string> {
  const file = bundledFileFor(s);
  if (!file) return Promise.reject(new Error("This build doesn't ship a bundle for the configured image"));
  bundledLoad ??= importSandboxImage(s, file, exec).finally(() => (bundledLoad = undefined));
  return bundledLoad;
}

export async function sandboxImageStatus(s: Settings, exec: Exec = execCli): Promise<SandboxImageStatus> {
  const runtime = runtimeOf(s);
  const image = imageOf(s);
  const version = await exec(runtime, ["version", "--format", "{{.Server.Version}}"]).catch(() => ({ code: 1 }));
  const bundled = !!bundledFileFor(s);
  if (version.code !== 0) return { runtime, runtimeAvailable: false, image, imagePresent: false, bundled };
  const inspect = await exec(runtime, ["image", "inspect", image, "--format", "{{.Id}}"]);
  return { runtime, runtimeAvailable: true, image, imagePresent: inspect.code === 0, bundled };
}

/** `docker load -i <file>` (accepts .tar and .tar.gz). Returns the runtime's "Loaded image: …" output. */
export async function importSandboxImage(s: Settings, file: string, exec: Exec = execCli): Promise<string> {
  if (s.sandbox === "none") throw new Error("Set Settings → Sandbox to Docker or Podman first");
  if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile()) throw new Error(`Bundle file not found: ${file}`);
  const r = await exec(runtimeOf(s), ["load", "-i", file]);
  if (r.code !== 0) throw new Error(`${runtimeOf(s)} load failed: ${(r.stderr || r.stdout).trim()}`);
  return r.stdout.trim();
}

/**
 * Fail fast with an actionable message instead of letting `docker run` try to pull the image. A missing
 * default image is first loaded from the bundle shipped with the app.
 */
export async function ensureSandboxReady(s: Settings, exec: Exec = execCli): Promise<void> {
  if (s.sandbox === "none") return;
  let st = await sandboxImageStatus(s, exec);
  if (!st.runtimeAvailable) throw new Error(`${st.runtime} isn't available — is it installed and running?`);
  if (!st.imagePresent && st.bundled) {
    await loadBundledSandboxImage(s, exec);
    st = await sandboxImageStatus(s, exec);
  }
  if (!st.imagePresent) {
    throw new Error(
      `Sandbox image "${st.image}" isn't loaded. Import the offline bundle in Settings → Sandbox (Sandflow never pulls images).`,
    );
  }
}

/** Options for sandcastle's docker()/podman() providers. `extra` = more read-only mounts (e.g. installed packs). */
export function sandboxProviderOptions(s: Settings, extra: { hostPath: string; sandboxPath: string }[] = []) {
  const mounts: { hostPath: string; sandboxPath: string; readonly: boolean }[] = extra.map((m) => ({ ...m, readonly: true }));
  const tools = s.agentToolsDir?.trim();
  if (tools) {
    if (!fs.existsSync(tools) || !fs.statSync(tools).isDirectory()) {
      throw new Error(`Agent tools folder not found: ${tools} (Settings → Sandbox)`);
    }
    mounts.push({ hostPath: tools, sandboxPath: AGENT_TOOLS_MOUNT, readonly: true });
  }
  return { imageName: imageOf(s), mounts };
}

/** The bits of a sandcastle provider handle that `stoppableProvider` wraps. */
interface ProviderHandleLike {
  exec(command: string, opts?: { onLine?: (line: string) => void; cwd?: string; sudo?: boolean; stdin?: string }): Promise<{ stdout: string; stderr: string; exitCode: number }>;
  close(): Promise<unknown>;
}
interface ProviderLike {
  create(options: { env?: Record<string, string> } & Record<string, unknown>): Promise<ProviderHandleLike>;
}

const STREAM_TAIL = 64 * 1024;

// An agent's own env (its block's Inputs, gateway settings, pinned models). sandcastle's `sandbox.run` only gives the
// agent process the env the sandbox was created with — the agent provider's `env` is dropped — and one sandbox is
// shared by every node of a run. So the agent's command carries a marker, and the sandbox's exec (below) swaps it
// for that agent's env: in the process env on this computer; through a private file in a container. Values never go
// on a command line.
const execEnvs = new Map<string, Record<string, string>>();
const EXEC_ENV_RE = /^: sandflow-env:([0-9a-f-]{36}); /;
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * The agent provider, with `env` given to the agent's process whenever it runs in a sandbox made by
 * `stoppableProvider`. Call `release` once the agent is done.
 */
export function withAgentEnv<A extends object>(agent: A, env: Record<string, string>): { agent: A; release(): void } {
  const token = randomUUID();
  execEnvs.set(token, Object.fromEntries(Object.entries(env).filter(([k]) => ENV_KEY_RE.test(k))));
  const wrapped = new Proxy(agent, {
    get(target, key, receiver) {
      const v = Reflect.get(target, key, receiver);
      if (key !== "buildPrintCommand" || typeof v !== "function") return v;
      return (...args: unknown[]) => {
        const c = v.apply(target, args) as { command: string };
        return { ...c, command: `: sandflow-env:${token}; ${c.command}` };
      };
    },
  });
  return { agent: wrapped, release: () => void execEnvs.delete(token) };
}

/** A command without its env marker, and the env it asks for (if any). */
export function takeAgentEnv(command: string): { command: string; env?: Record<string, string> } {
  const m = EXEC_ENV_RE.exec(command);
  return m ? { command: command.slice(m[0].length), env: execEnvs.get(m[1]) } : { command };
}

/** Shell lines exporting `env` (sourced from a file inside a container). */
export const exportLines = (env: Record<string, string>) =>
  Object.entries(env)
    .filter(([k]) => ENV_KEY_RE.test(k))
    .map(([k, v]) => `export ${k}=${shq(v)}\n`)
    .join("");

/** A docker / podman container id as the container sees it in /etc/hostname (short 12 or full 64 hex). */
export const CONTAINER_ID_RE = /^[0-9a-f]{12,64}$/;

/**
 * Make a sandcastle sandbox provider stop for real when the run is stopped. sandcastle's own abort only stops
 * *waiting* for the agent: the `sh -c <agent>` it started on this computer, or the agent inside the container
 * (killing a `docker exec` client doesn't kill what it runs), keeps going. So:
 *  - `none` (this computer): commands run in their own process group, killed as a tree when the run is stopped;
 *  - docker / podman: the container is removed (`rm -f`) when the run is stopped, which kills everything in it.
 * After the run is stopped no new command starts in the sandbox.
 */
export function stoppableProvider<P>(provider: P, kind: "none" | "docker" | "podman", signal: AbortSignal, exec: Exec = execCli): P {
  const p = provider as unknown as ProviderLike;
  const create: ProviderLike["create"] = async (options) => {
    const handle = await p.create(options);
    let closing: Promise<unknown> | undefined;
    const close = () => (closing ??= handle.close());
    const cancelled = () => Promise.reject(new Error("Run cancelled"));
    let kill: () => void;
    let runExec: ProviderHandleLike["exec"];
    if (kind === "none") {
      const env = { ...process.env, ...(options.env ?? {}) };
      const worktree = (handle as unknown as { worktreePath: string }).worktreePath;
      const win = process.platform === "win32";
      runExec = async (cmd, o) => {
        const { command, env: agentEnv } = takeAgentEnv(cmd);
        const r = await runTree(win ? "cmd.exe" : "sh", win ? ["/d", "/s", "/c", command] : ["-c", command], {
          cwd: o?.cwd ?? worktree,
          env: agentEnv ? { ...env, ...agentEnv } : env,
          stdin: o?.stdin,
          signal,
          onLine: o?.onLine,
          stdoutTail: o?.onLine ? STREAM_TAIL : undefined,
          windowsVerbatimArguments: win,
        });
        return { stdout: r.stdout, stderr: r.stderr, exitCode: r.killed ? 137 : r.code };
      };
      kill = () => {}; // runTree kills its own trees on abort
    } else {
      runExec = async (cmd, o) => {
        const { command, env: agentEnv } = takeAgentEnv(cmd);
        if (!agentEnv || !Object.keys(agentEnv).length) return handle.exec(command, o);
        // Readable only by the sandbox user, read and removed as the agent's command starts.
        const file = `/tmp/.sandflow-env-${randomUUID()}`;
        const w = await handle.exec(`umask 077 && cat > ${file}`, { stdin: exportLines(agentEnv) });
        if (w.exitCode !== 0) return { stdout: "", stderr: `Couldn't hand the agent its environment: ${w.stderr}`, exitCode: w.exitCode || 1 };
        return handle.exec(`. ${file}; rm -f ${file}; ${command}`, o);
      };
      // The container's hostname is its (short) id. Read it now, before anything of the agent's runs in there: by
      // the time Stop comes, whatever is inside could have rewritten /etc/hostname (e.g. to another run's container).
      const id = signal.aborted ? "" : await handle.exec("cat /etc/hostname").then((r) => r.stdout.trim(), () => "");
      kill = () => {
        // Remove the container: everything in it dies and the `docker exec` clients return. Only ever a container
        // id (hex) — never something that could be read as an option — and passed as one argv entry, no shell.
        void (CONTAINER_ID_RE.test(id) ? exec(kind, ["rm", "-f", id]) : close()).catch(() => {});
      };
    }
    const onAbort = () => kill();
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
    return new Proxy(handle, {
      get(target, key, receiver) {
        if (key === "exec") return (command: string, o?: Parameters<ProviderHandleLike["exec"]>[1]) => (signal.aborted ? cancelled() : runExec(command, o));
        if (key === "close") {
          return () => {
            signal.removeEventListener("abort", onAbort);
            return close();
          };
        }
        return Reflect.get(target, key, receiver);
      },
    });
  };
  return new Proxy(p, { get: (target, key, receiver) => (key === "create" ? create : Reflect.get(target, key, receiver)) }) as unknown as P;
}
