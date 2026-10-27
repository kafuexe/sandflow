// Child processes that can be stopped as a whole: a shell command's own children (and theirs) die with it.
//
// Killing just the process Node spawned isn't enough — `sh -c "npm test"` leaves npm, node, … running, and
// they keep the stdout pipe open, so the command never even "finishes". On POSIX each command gets its own
// process group (`detached`) and the whole group is killed; on Windows `taskkill /T /F` kills the tree.

import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams, type SpawnOptions } from "node:child_process";

const isWindows = process.platform === "win32";

/** Process groups still running — killed if Sandflow itself exits, so nothing is left behind. */
const live = new Set<number>();

function killLive() {
  for (const p of live) {
    try {
      process.kill(-p, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
  live.clear();
}

// Own process groups no longer get the terminal's Ctrl+C, and a signal ends Node without its "exit" event: kill
// them on those signals too. Installed only while something runs, and re-raised when nobody else handles the
// signal, so Sandflow still exits the way it would have.
const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
const onSignal = (sig: NodeJS.Signals) => {
  killLive();
  detach();
  if (process.listenerCount(sig) === 0) process.kill(process.pid, sig);
};
let attached = false;
function attach() {
  if (attached) return;
  attached = true;
  process.on("exit", killLive);
  for (const s of SIGNALS) process.on(s, onSignal);
}
function detach() {
  if (!attached) return;
  attached = false;
  process.removeListener("exit", killLive);
  for (const s of SIGNALS) process.removeListener(s, onSignal);
}

function track(child: ChildProcess) {
  const pid = child.pid;
  if (!pid || isWindows) return;
  live.add(pid);
  attach();
  child.once("exit", () => {
    live.delete(pid);
    if (!live.size) detach();
  });
}

/** For tests: whether Sandflow currently listens for exit signals on behalf of running process groups. */
export const exitHooksInstalled = () => attached;

/** Kill a process and everything it started. Safe to call more than once / after it exited. */
export function killTree(child: ChildProcess): void {
  const pid = child.pid;
  if (!pid) return;
  if (isWindows) {
    try {
      spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }).on("error", () => child.kill());
    } catch {
      child.kill();
    }
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  }
}

/** Kill a process tree by pid (a process left over by an earlier Sandflow — its own process group on POSIX). */
export function killPidTree(pid: number): void {
  if (isWindows) {
    spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }).on("error", () => {});
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    process.kill(pid, "SIGKILL");
  }
}

/** spawn() (stdio piped) in its own process group (POSIX) so `killTree` reaches every descendant. */
export function spawnTree(cmd: string, args: string[] | null, opts: Omit<SpawnOptions, "stdio" | "detached"> = {}): ChildProcessWithoutNullStreams {
  const o: SpawnOptions = { windowsHide: true, ...opts, stdio: "pipe", detached: !isWindows };
  const child = (args === null ? spawn(cmd, { ...o, shell: true }) : spawn(cmd, args, o)) as ChildProcessWithoutNullStreams;
  track(child);
  return child;
}

export interface TreeResult {
  code: number;
  stdout: string;
  stderr: string;
  /** Why it was killed ("cancelled", "timed out after 30s", …), if it was. */
  killed?: string;
}

export interface RunTreeOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  stdin?: string;
  /** Kills the whole tree when aborted; an already-aborted signal never starts the command. */
  signal?: AbortSignal;
  timeoutMs?: number;
  /** stdout beyond this kills the command (default 20 MB). */
  maxBuffer?: number;
  /** Keep only the last N chars of stdout instead (no size limit) — for long-running agents that stream via onLine. */
  stdoutTail?: number;
  windowsVerbatimArguments?: boolean;
  /** Keep only the last N chars of stderr (default 64 KB). */
  stderrTail?: number;
  onLine?: (line: string) => void;
  /** Called once when the command is killed (e.g. to also remove a container it started). */
  onKill?: (why: string) => void;
  /** Called with the pid once the command started (a run journals it, so a crash's leftovers can be found). */
  onSpawn?: (pid: number) => void;
}

/** How long to wait for the pipes to close after a kill before giving up on them (a descendant may have escaped). */
const PIPE_GRACE_MS = 1500;

/**
 * Run a command (argv, or a shell string when `args` is null) and capture its output. Never rejects for a
 * non-zero exit; rejects only when it can't be started, or with "cancelled" when the signal was already aborted.
 */
export function runTree(cmd: string, args: string[] | null, o: RunTreeOptions = {}): Promise<TreeResult> {
  if (o.signal?.aborted) return Promise.reject(new Error("Run cancelled"));
  const maxBuffer = o.maxBuffer ?? 20 * 1024 * 1024;
  const stderrTail = o.stderrTail ?? 64 * 1024;
  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawnTree(cmd, args, { cwd: o.cwd, env: o.env, windowsVerbatimArguments: o.windowsVerbatimArguments });
    } catch (e) {
      reject(e as Error);
      return;
    }
    if (child.pid) {
      try {
        o.onSpawn?.(child.pid);
      } catch {
        /* informational */
      }
    }
    let stdout = "";
    let stderr = "";
    let partial = "";
    let killed: string | undefined;
    let settled = false;
    let exitCode: number | null = null;
    let graceTimer: NodeJS.Timeout | undefined;

    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(graceTimer);
      o.signal?.removeEventListener("abort", onAbort);
      if (partial.trim() && o.onLine) o.onLine(partial);
      resolve({ code: code ?? 1, stdout, stderr, killed });
    };
    const kill = (why: string) => {
      if (killed || settled) return;
      killed = why;
      killTree(child);
      try {
        o.onKill?.(why);
      } catch {
        /* best effort */
      }
      // Normally the pipes close right away; if something escaped the group and holds them, stop waiting.
      graceTimer = setTimeout(() => {
        child.stdout?.destroy();
        child.stderr?.destroy();
        finish(exitCode);
      }, PIPE_GRACE_MS);
      graceTimer.unref?.();
    };
    const timer = o.timeoutMs ? setTimeout(() => kill(`timed out after ${Math.round(o.timeoutMs! / 1000)}s`), o.timeoutMs) : undefined;
    const onAbort = () => kill("cancelled");
    o.signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout!.on("data", (d: Buffer) => {
      const s = d.toString();
      if (o.stdoutTail !== undefined) stdout = (stdout + s).slice(-o.stdoutTail);
      else stdout += s;
      if (o.stdoutTail === undefined && stdout.length > maxBuffer) kill(`printed more than ${Math.round(maxBuffer / 1024 / 1024)} MB`);
      if (o.onLine) {
        const lines = (partial + s).split(/\r?\n/);
        partial = lines.pop() ?? "";
        lines.forEach((l) => l.trim() && o.onLine!(l));
      }
    });
    child.stderr!.on("data", (d: Buffer) => {
      stderr = (stderr + d.toString()).slice(-stderrTail);
    });
    child.stdin!.on("error", () => {
      /* the command didn't read its stdin */
    });
    child.stdin!.end(o.stdin ?? "");
    child.on("error", (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(graceTimer);
      o.signal?.removeEventListener("abort", onAbort);
      reject(e);
    });
    child.on("exit", (code) => {
      exitCode = code;
    });
    child.on("close", (code) => finish(code));
  });
}
