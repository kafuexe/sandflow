// Container-runtime helpers for air-gapped use: the sandbox image is loaded from an offline bundle and
// must already exist locally — Sandflow never pulls it.

import { execFile } from "node:child_process";
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
}

const runtimeOf = (s: Settings): "docker" | "podman" => (s.sandbox === "podman" ? "podman" : "docker");
export const imageOf = (s: Settings) => s.sandboxImage?.trim() || DEFAULT_SANDBOX_IMAGE;

export async function sandboxImageStatus(s: Settings, exec: Exec = execCli): Promise<SandboxImageStatus> {
  const runtime = runtimeOf(s);
  const image = imageOf(s);
  const version = await exec(runtime, ["version", "--format", "{{.Server.Version}}"]).catch(() => ({ code: 1 }));
  if (version.code !== 0) return { runtime, runtimeAvailable: false, image, imagePresent: false };
  const inspect = await exec(runtime, ["image", "inspect", image, "--format", "{{.Id}}"]);
  return { runtime, runtimeAvailable: true, image, imagePresent: inspect.code === 0 };
}

/** `docker load -i <file>` (accepts .tar and .tar.gz). Returns the runtime's "Loaded image: …" output. */
export async function importSandboxImage(s: Settings, file: string, exec: Exec = execCli): Promise<string> {
  if (s.sandbox === "none") throw new Error("Set Settings → Sandbox to Docker or Podman first");
  if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile()) throw new Error(`Bundle file not found: ${file}`);
  const r = await exec(runtimeOf(s), ["load", "-i", file]);
  if (r.code !== 0) throw new Error(`${runtimeOf(s)} load failed: ${(r.stderr || r.stdout).trim()}`);
  return r.stdout.trim();
}

/** Fail fast with an actionable message instead of letting `docker run` try to pull the image. */
export async function ensureSandboxReady(s: Settings, exec: Exec = execCli): Promise<void> {
  if (s.sandbox === "none") return;
  const st = await sandboxImageStatus(s, exec);
  if (!st.runtimeAvailable) throw new Error(`${st.runtime} isn't available — is it installed and running?`);
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
      runExec = async (command, o) => {
        const r = await runTree(win ? "cmd.exe" : "sh", win ? ["/d", "/s", "/c", command] : ["-c", command], {
          cwd: o?.cwd ?? worktree,
          env,
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
      runExec = (command, o) => handle.exec(command, o);
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
