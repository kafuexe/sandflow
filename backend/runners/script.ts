// Script blocks: run a command that comes with a pack (any language, scripts, executables).
//
// Contract: the script gets its inputs as JSON on stdin (also in the file $SANDFLOW_INPUT) and writes
// `{"artifact": …, "steer": …, "exit": "<name>"}` to $SANDFLOW_OUTPUT — or just prints the artifact.
// $PACK_DIR is a writable copy of the pack where its `setup` already ran and its `bin` executables are on PATH,
// so each pack's dependencies stay inside its own copy and never clash with another pack's.
//
// Where it runs:
//  - in the run's sandbox (`docker exec` into the same container the agents use) when the block needs the repo
//    (declares REPO_PATH) and the pack uses the default image — git works there;
//  - in a throwaway container (`docker run --rm`) otherwise, e.g. a pack that brings its own image / Dockerfile;
//  - on this machine only for `where: "host"` or Sandbox: None, and only for your own blocks and trusted packs.

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { platformKey } from "../../shared/packs";
import { nodeLabel } from "../../shared/resolve";
import type { FlowNode, NodeIO, PackManifest, ResolvedConfig, Settings } from "../../shared/types";
import type { NodeResult, RunContext } from "../engine";
import type { PackRuntimeInfo } from "../packs";
import { tail } from "../prompt";
import { imageOf } from "../sandbox";
import { getSandbox, type SandboxLike } from "./ai";
import { codeOwner, filesPack, trustedOnHost } from "./trust";

const DEFAULT_TIMEOUT_S = 30 * 60;
const SETUP_TIMEOUT_MS = 30 * 60_000;
const SANDBOX_PACKS = "/opt/sandflow/packs";

/** Single-quote for POSIX sh. */
export const shQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** Turn what a script wrote into node outputs. */
export function parseScriptOutput(outputFile: string | undefined, stdout: string): NodeResult {
  const text = outputFile?.trim();
  if (text) {
    let j: unknown;
    try {
      j = JSON.parse(text);
    } catch {
      throw new Error(`$SANDFLOW_OUTPUT isn't valid JSON: ${tail(text, 200)}`);
    }
    if (!j || typeof j !== "object" || Array.isArray(j)) throw new Error("$SANDFLOW_OUTPUT must hold a JSON object like {\"artifact\": \"…\"}");
    const o = j as Record<string, unknown>;
    const str = (v: unknown) => (v === undefined || v === null ? undefined : typeof v === "string" ? v : JSON.stringify(v, null, 2));
    const exit = str(o.exit ?? o.route);
    return { outputs: { artifact: str(o.artifact) ?? (stdout.trim() || undefined), steer: str(o.steer) }, exit };
  }
  return { outputs: { artifact: stdout.trim() } };
}

interface Captured {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run a command (argv, or a shell string when `args` is null) with stdin, streaming stdout lines. */
function spawnCapture(
  cmd: string,
  args: string[] | null,
  o: { cwd?: string; env?: NodeJS.ProcessEnv; stdin?: string; timeoutMs?: number; signal?: AbortSignal; onLine?: (l: string) => void },
): Promise<Captured> {
  return new Promise((resolve, reject) => {
    const child = args === null
      ? spawn(cmd, { shell: true, cwd: o.cwd, env: o.env, windowsHide: true })
      : spawn(cmd, args, { cwd: o.cwd, env: o.env, windowsHide: true });
    let stdout = "";
    let stderr = "";
    let partial = "";
    let killed = "";
    const kill = (why: string) => {
      killed = why;
      child.kill("SIGKILL");
    };
    const timer = o.timeoutMs ? setTimeout(() => kill(`timed out after ${Math.round(o.timeoutMs! / 1000)}s`), o.timeoutMs) : undefined;
    const onAbort = () => kill("cancelled");
    o.signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout.on("data", (d: Buffer) => {
      const s = d.toString();
      stdout += s;
      if (stdout.length > 20 * 1024 * 1024) kill("printed more than 20 MB");
      if (o.onLine) {
        const lines = (partial + s).split(/\r?\n/);
        partial = lines.pop() ?? "";
        lines.forEach((l) => l.trim() && o.onLine!(l));
      }
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr = (stderr + d.toString()).slice(-64 * 1024);
    });
    child.stdin.on("error", () => {
      /* the command didn't read its stdin */
    });
    child.stdin.end(o.stdin ?? "");
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      o.signal?.removeEventListener("abort", onAbort);
      if (partial.trim() && o.onLine) o.onLine(partial);
      if (killed) reject(new Error(`Script ${killed}`));
      else resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

function binLines(m: PackManifest, dir: string, archVar = "$A"): string[] {
  const lines: string[] = [];
  for (const [name, plats] of Object.entries(m.bin ?? {})) {
    for (const [plat, rel] of Object.entries(plats)) {
      const [os_, arch] = plat.split("-");
      if (os_ !== "linux") continue;
      lines.push(`[ "${archVar}" = ${shQuote(arch)} ] && chmod +x ${shQuote(rel)} && ln -sf "${dir}/"${shQuote(rel)} .sandflow-bin/${shQuote(name)}`);
    }
  }
  return lines;
}

/** Shell script that prepares a pack's writable copy at `$D` from `src` once (setup + executables). */
export function prepareScript(m: PackManifest, src: string, dirExpr: string): string {
  return [
    `D=${dirExpr}`,
    `if [ ! -f "$D/.sandflow-ready" ]; then`,
    `  rm -rf "$D" && mkdir -p "$D" && cp -a ${shQuote(src)}/. "$D"/ || exit 1`,
    `  cd "$D" || exit 1`,
    ...(m.setup?.trim() ? [`  ( ${m.setup.trim()} ) || { echo "setup failed" >&2; exit 1; }`] : []),
    `  mkdir -p .sandflow-bin`,
    `  A=$(uname -m); case "$A" in x86_64|amd64) A=x64;; aarch64|arm64) A=arm64;; esac`,
    ...binLines(m, "$D").map((l) => `  ${l}`),
    `  touch .sandflow-ready`,
    `fi`,
  ].join("\n");
}

const preparing = new Map<string, Promise<string>>();

/** A prepared copy of the pack on this machine: `<runtimeRoot>/<id>-<hash>` with setup done and executables in `.sandflow-bin`. */
async function prepareOnHost(ctx: RunContext, info: PackRuntimeInfo, nodeId: string): Promise<string> {
  const root = ctx.packs!.runtimeRoot;
  const dir = path.join(root, `${info.id}-${info.hash.slice(0, 12)}`);
  const key = dir;
  const existing = preparing.get(key);
  if (existing) return existing;
  const p = (async () => {
    if (fs.existsSync(path.join(dir, ".sandflow-ready"))) return dir;
    ctx.log("info", `Preparing pack ${info.id} on this machine…`, nodeId);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    fs.cpSync(info.dir, dir, { recursive: true, filter: (s) => !/[\\/](\.git|node_modules)([\\/]|$)/.test(path.relative(info.dir, s)) });
    if (info.manifest.setup?.trim()) {
      ctx.log("info", `Setup: ${info.manifest.setup.trim()}`, nodeId);
      const r = await spawnCapture(info.manifest.setup.trim(), null, { cwd: dir, env: process.env, timeoutMs: SETUP_TIMEOUT_MS, signal: ctx.abort.signal, onLine: (l) => ctx.log("agent", l, nodeId) });
      if (r.code !== 0) {
        fs.rmSync(dir, { recursive: true, force: true });
        throw new Error(`Pack setup failed (exit ${r.code}): ${tail(r.stderr, 1000)}`);
      }
    }
    const bin = path.join(dir, ".sandflow-bin");
    fs.mkdirSync(bin, { recursive: true });
    const plat = platformKey(process.platform, process.arch);
    for (const [name, plats] of Object.entries(info.manifest.bin ?? {})) {
      const rel = plats[plat];
      if (!rel) continue;
      const from = path.join(dir, ...rel.split("/"));
      const to = path.join(bin, name + (process.platform === "win32" ? path.extname(rel) : ""));
      fs.copyFileSync(from, to);
      fs.chmodSync(to, 0o755);
    }
    fs.writeFileSync(path.join(dir, ".sandflow-ready"), new Date().toISOString());
    // Older copies of this pack aren't used any more.
    for (const name of fs.readdirSync(root)) {
      if (name.startsWith(`${info.id}-`) && name !== path.basename(dir)) fs.rmSync(path.join(root, name), { recursive: true, force: true });
    }
    return dir;
  })().finally(() => preparing.delete(key));
  preparing.set(key, p);
  return p;
}

const runtimeOf = (s: Settings) => (s.sandbox === "podman" ? "podman" : "docker");

async function cli(ctx: RunContext, args: string[], nodeId: string, o: { stdin?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number; onLine?: (l: string) => void } = {}) {
  return spawnCapture(runtimeOf(ctx.settings), args, { env: o.env ?? process.env, stdin: o.stdin, timeoutMs: o.timeoutMs, signal: ctx.abort.signal, onLine: o.onLine ?? ((l) => ctx.log("agent", l, nodeId)) });
}

/** The image a pack's scripts run in, building its Dockerfile the first time. */
async function packImage(ctx: RunContext, info: PackRuntimeInfo | undefined, nodeId: string): Promise<string> {
  const sb = info?.manifest.sandbox;
  if (sb?.image) return sb.image;
  if (!sb?.dockerfile || !info) return imageOf(ctx.settings);
  const tag = `sandflow-pack-${info.id}:${info.hash.slice(0, 12)}`;
  const present = await cli(ctx, ["image", "inspect", tag, "--format", "{{.Id}}"], nodeId, { onLine: () => {} });
  if (present.code === 0) return tag;
  ctx.log("info", `Building image ${tag} from ${sb.dockerfile}…`, nodeId);
  const r = await cli(ctx, ["build", "-t", tag, "-f", path.join(info.dir, ...sb.dockerfile.split("/")), info.dir], nodeId, { timeoutMs: SETUP_TIMEOUT_MS });
  if (r.code !== 0) throw new Error(`Building ${tag} failed: ${tail(r.stderr, 1000)}`);
  return tag;
}

interface Invocation {
  ctx: RunContext;
  node: FlowNode;
  cfg: ResolvedConfig;
  command: string;
  input: string;
  env: Record<string, string>;
  info?: PackRuntimeInfo;
  needsRepo: boolean;
  timeoutS: number;
}

async function runOnHost(x: Invocation): Promise<{ stdout: string; output?: string }> {
  const { ctx, node } = x;
  const packDir = x.info ? await prepareOnHost(ctx, x.info, node.id) : undefined;
  const io = fs.mkdtempSync(path.join(os.tmpdir(), "sandflow-script-"));
  try {
    const inFile = path.join(io, "input.json");
    const outFile = path.join(io, "output.json");
    fs.writeFileSync(inFile, x.input);
    const worktree = (ctx.sandbox as { worktreePath?: string } | undefined)?.worktreePath;
    const cwd = x.needsRepo ? worktree || x.env.REPO_PATH : packDir ?? io;
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...x.env,
      SANDFLOW_INPUT: inFile,
      SANDFLOW_OUTPUT: outFile,
      ...(packDir ? { PACK_DIR: packDir, PATH: `${path.join(packDir, ".sandflow-bin")}${path.delimiter}${process.env.PATH ?? ""}` } : {}),
    };
    const r = await spawnCapture(x.command, null, { cwd, env, stdin: x.input, timeoutMs: x.timeoutS * 1000, signal: ctx.abort.signal, onLine: (l) => ctx.log("agent", l, node.id) });
    if (r.code !== 0) throw new Error(`Script exited with code ${r.code}${r.stderr.trim() ? `: ${tail(r.stderr.trim(), 2000)}` : ""}`);
    return { stdout: r.stdout, output: fs.existsSync(outFile) ? fs.readFileSync(outFile, "utf8") : undefined };
  } finally {
    fs.rmSync(io, { recursive: true, force: true });
  }
}

/** In the run's own sandbox, where the repo (with git) already is. */
async function runInRunSandbox(x: Invocation): Promise<{ stdout: string; output?: string }> {
  const { ctx, node } = x;
  const sandbox: SandboxLike = await getSandbox(ctx);
  let packDir = "";
  if (x.info) {
    packDir = `$HOME/.sandflow/packs/${x.info.id}-${x.info.hash.slice(0, 12)}`;
    if (!ctx.preparedPacks.has(x.info.id)) {
      ctx.log("info", `Preparing pack ${x.info.id} in the sandbox…`, node.id);
      const r = await sandbox.exec(prepareScript(x.info.manifest, `${SANDBOX_PACKS}/${x.info.id}`, `"${packDir}"`), { onLine: (l) => ctx.log("agent", l, node.id) });
      if (r.exitCode !== 0) throw new Error(`Pack setup failed (exit ${r.exitCode}): ${tail(r.stderr ?? "", 1000)}`);
      ctx.preparedPacks.add(x.info.id);
    }
  }
  const io = `/tmp/sandflow-io/${randomUUID()}`;
  const w = await sandbox.exec(`mkdir -p ${io} && cat > ${io}/input.json`, { stdin: x.input });
  if (w.exitCode !== 0) throw new Error(`Couldn't hand the script its input (exit ${w.exitCode})`);
  const exports = [
    ...Object.entries(x.env).map(([k, v]) => `export ${k}=${shQuote(v)}`),
    `export SANDFLOW_INPUT=${io}/input.json SANDFLOW_OUTPUT=${io}/output.json`,
    ...(packDir ? [`export PACK_DIR="${packDir}"`, `export PATH="$PACK_DIR/.sandflow-bin:$PATH"`] : []),
  ];
  const r = await sandbox.exec(`${exports.join("\n")}\ntimeout ${x.timeoutS} sh -c ${shQuote(x.command)} < ${io}/input.json`, {
    onLine: (l) => ctx.log("agent", l, node.id),
  });
  const out = await sandbox.exec(`cat ${io}/output.json 2>/dev/null; rm -rf ${io}`);
  if (r.exitCode === 124) throw new Error(`Script timed out after ${x.timeoutS}s`);
  if (r.exitCode !== 0) throw new Error(`Script exited with code ${r.exitCode}${r.stderr?.trim() ? `: ${tail(r.stderr.trim(), 2000)}` : ""}`);
  return { stdout: r.stdout ?? "", output: out.stdout || undefined };
}

/** In a throwaway container (the pack's own image, or no repo needed). */
async function runInContainer(x: Invocation): Promise<{ stdout: string; output?: string }> {
  const { ctx, node } = x;
  const image = await packImage(ctx, x.info, node.id);
  const args = ["run", "--rm", "-i", "--name", `sandflow-script-${randomUUID().slice(0, 12)}`];
  if (x.info) {
    // The prepared copy lives in a volume per pack version, so setup runs once, not every time.
    const volume = `sandflow-pack-${x.info.id}-${x.info.hash.slice(0, 12)}`;
    const prep = await cli(
      ctx,
      ["run", "--rm", "--user", "0:0", "-v", `${volume}:/opt/sandflow/pack`, "-v", `${x.info.dir}:/opt/sandflow/pack-src:ro`, "--entrypoint", "sh", image, "-c",
        `${prepareScript(x.info.manifest, "/opt/sandflow/pack-src", "/opt/sandflow/pack")}\nchmod -R a+rwX /opt/sandflow/pack`],
      node.id,
      { timeoutMs: SETUP_TIMEOUT_MS },
    );
    if (prep.code !== 0) throw new Error(`Pack setup failed (exit ${prep.code}): ${tail(prep.stderr, 1000)}`);
    args.push("-v", `${volume}:/opt/sandflow/pack`, "-e", "PACK_DIR=/opt/sandflow/pack");
  }
  const io = fs.mkdtempSync(path.join(os.tmpdir(), "sandflow-script-"));
  try {
    fs.writeFileSync(path.join(io, "input.json"), x.input);
    args.push("-v", `${io}:/opt/sandflow/io`, "-e", "SANDFLOW_INPUT=/opt/sandflow/io/input.json", "-e", "SANDFLOW_OUTPUT=/opt/sandflow/io/output.json");
    if (process.platform === "linux" && process.getuid && process.getgid) args.push("--user", `${process.getuid()}:${process.getgid()}`);
    if (x.needsRepo) {
      const worktree = (ctx.sandbox as { worktreePath?: string } | undefined)?.worktreePath || x.env.REPO_PATH;
      args.push("-v", `${worktree}:/work`, "-w", "/work");
    } else {
      args.push("-w", x.info ? "/opt/sandflow/pack" : "/tmp");
    }
    // Values travel in the CLI's environment (`-e NAME`), not on its command line.
    for (const k of Object.keys(x.env)) args.push("-e", k);
    args.push("--entrypoint", "sh", image, "-c", `export PATH="/opt/sandflow/pack/.sandflow-bin:$PATH"\n${x.command}`);
    const r = await cli(ctx, args, node.id, { stdin: x.input, env: { ...process.env, ...x.env }, timeoutMs: x.timeoutS * 1000 });
    if (r.code !== 0) throw new Error(`Script exited with code ${r.code}${r.stderr.trim() ? `: ${tail(r.stderr.trim(), 2000)}` : ""}`);
    const outFile = path.join(io, "output.json");
    return { stdout: r.stdout, output: fs.existsSync(outFile) ? fs.readFileSync(outFile, "utf8") : undefined };
  } finally {
    fs.rmSync(io, { recursive: true, force: true });
  }
}

export async function runScript(ctx: RunContext, node: FlowNode, cfg: ResolvedConfig, inputs: NodeIO): Promise<NodeResult> {
  const command = cfg.script.run.trim();
  if (!command) throw new Error("Script block has no command (set Script → Run)");
  const owner = codeOwner(ctx, node, (c) => c.script?.run);
  const pack = filesPack(ctx, node);
  const info = pack ? ctx.packs?.runtime(pack) : undefined;
  if (pack && !info) throw new Error(`Pack "${pack}" isn't installed`);
  const env = ctx.blockEnv(cfg);
  const needsRepo = cfg.env.includes("REPO_PATH");
  if (needsRepo && !env.REPO_PATH?.trim()) throw new Error("Missing env var REPO_PATH");

  const onHost = cfg.script.where === "host" || ctx.settings.sandbox === "none";
  if (onHost && !trustedOnHost(ctx, owner)) {
    throw new Error(
      cfg.script.where === "host"
        ? `Pack "${owner}" isn't allowed to run code on this machine (Packs → ${owner} → Allow running on this machine)`
        : `Sandbox is off (Settings → Sandbox: None) and pack "${owner}" isn't allowed to run code on this machine — turn the sandbox on or trust the pack`,
    );
  }
  // Preparing a pack on this machine runs its setup / installs its executables — that's the pack's code too.
  if (onHost && info && !info.trustHost && (info.manifest.setup?.trim() || info.manifest.bin)) {
    throw new Error(`Pack "${info.id}" has a setup step / executables and isn't allowed to run code on this machine (Packs → ${info.id})`);
  }

  const input = JSON.stringify({
    artifact: inputs.artifact ?? null,
    steer: inputs.steer ?? null,
    startingPrompt: ctx.settings.startingPrompt,
    trigger: ctx.run.trigger ?? null,
    node: { id: node.id, label: nodeLabel(node, ctx.blocks) },
    run: { id: ctx.run.id, branch: ctx.run.branch ?? null },
    env,
  });
  const x: Invocation = { ctx, node, cfg, command, input, env, info, needsRepo, timeoutS: cfg.script.timeoutSeconds ?? DEFAULT_TIMEOUT_S };
  const where = onHost ? "this machine" : needsRepo && !info?.manifest.sandbox ? "the run's sandbox" : "a container";
  ctx.log("info", `$ ${command}  (${where}${pack ? `, pack ${pack}` : ""})`, node.id);

  const r = onHost ? await runOnHost(x) : needsRepo && !info?.manifest.sandbox ? await runInRunSandbox(x) : await runInContainer(x);
  return parseScriptOutput(r.output, r.stdout);
}
