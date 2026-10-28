// Claude Code integration (desktop app): registers Sandflow's MCP server with Claude Code at user scope and installs
// the Sandflow skills into ~/.claude/skills, so any Claude Code session can design, start and watch flows.
//
// Claude Code reaches Sandflow through the stdio bridge (assistantAgents.ts MCP_BRIDGE), which reads the current URL
// from <data>/mcp.json — the desktop app's port changes every launch, the registration doesn't.
// Only what Sandflow wrote is replaced or removed: a `sandflow` server entry that isn't the bridge, and skill folders
// without Sandflow's marker or changed since Sandflow wrote them, are left alone.

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { MCP_BRIDGE } from "./assistantAgents";
import { resolveCli } from "./chats";
import { execCli, type Exec } from "./sandbox";

export const SERVER_NAME = "sandflow";
export const BRIDGE_FILE = "sandflow-mcp-bridge.cjs";
/** In each installed skill folder: the version and a hash of the files as Sandflow wrote them. */
export const SKILL_MARKER = ".sandflow-skill.json";

export interface ClaudeCli {
  cmd: string;
  args: string[];
}

export interface ClaudeCodeOptions {
  /** The user's home: ~/.claude (present = Claude Code is installed) and ~/.claude.json. */
  home: string;
  /** Sandflow's data folder: the bridge script goes there, next to mcp.json. */
  dataDir: string;
  /** Skills shipped with Sandflow (agent-skills/), one folder each. */
  skillsDir: string;
  /** What runs the bridge: node, or the Electron binary with ELECTRON_RUN_AS_NODE=1. */
  node: { command: string; env?: Record<string, string> };
  /** The claude CLI; null = edit ~/.claude.json directly. Default: looked up on PATH. */
  claude?: ClaudeCli | null;
  exec?: Exec;
  version: string;
}

export interface ClaudeCodeStatus {
  /** Claude Code is installed (~/.claude exists). */
  present: boolean;
  enabled: boolean;
  /** What was done (or why not), one line each. */
  notes: string[];
}

interface ServerEntry {
  type?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
}

/** The claude CLI on PATH. A Windows .cmd shim we can't see through counts as absent (it needs a shell). */
export function findClaude(env: NodeJS.ProcessEnv = process.env): ClaudeCli | null {
  const r = resolveCli(["claude"], env);
  if (r.viaCmd) return null;
  if (path.isAbsolute(r.cmd) || env.SANDFLOW_CLAUDE_PATH?.trim()) return { cmd: r.cmd, args: r.args };
  const dirs = (env.PATH ?? env.Path ?? "").split(path.delimiter).filter(Boolean);
  return dirs.some((d) => fs.existsSync(path.join(d, "claude"))) ? { cmd: "claude", args: [] } : null;
}

/** Write the file via a temp file in the same folder, flushed, then renamed over it — never half-written. */
function writeAtomic(file: string, content: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  const fd = fs.openSync(tmp, "w");
  try {
    fs.writeFileSync(fd, content);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
}

const isOurs = (e: ServerEntry | undefined) => !!e && (e.args ?? []).some((a) => String(a).includes(BRIDGE_FILE));

/**
 * The `sandflow` CLI's registration (`claude mcp add sandflow -- sandflow mcp`, written by its installer). Left as it
 * is: Claude Code then uses the CLI's own background Sandflow instead of this app.
 */
export const isCliEntry = (e: ServerEntry | undefined) =>
  !!e && /(^|[\\/])sandflow(\.cmd|\.ps1|\.exe)?$/i.test(e.command ?? "") && (e.args ?? []).includes("mcp");

const sameServer = (a: ServerEntry | undefined, b: ServerEntry) =>
  !!a && a.command === b.command && JSON.stringify(a.args ?? []) === JSON.stringify(b.args ?? []) && JSON.stringify(a.env ?? {}) === JSON.stringify(b.env ?? {});

/** ~/.claude.json, or undefined when it's missing; throws when it can't be parsed (then it's never written). */
function readClaudeJson(file: string): Record<string, unknown> | undefined {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw e;
  }
  const v = JSON.parse(text) as unknown;
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("not a JSON object");
  return v as Record<string, unknown>;
}

const userServer = (cfg: Record<string, unknown> | undefined) => (cfg?.mcpServers as Record<string, ServerEntry> | undefined)?.[SERVER_NAME];

/** Change only mcpServers.sandflow, re-reading right before the write (Claude Code writes this file too). */
function editServer(file: string, entry: ServerEntry | undefined) {
  const cfg = readClaudeJson(file) ?? {};
  const servers = { ...((cfg.mcpServers as Record<string, ServerEntry> | undefined) ?? {}) };
  if (entry) servers[SERVER_NAME] = entry;
  else delete servers[SERVER_NAME];
  writeAtomic(file, `${JSON.stringify({ ...cfg, mcpServers: servers }, null, 2)}\n`);
}

async function syncServer(o: ClaudeCodeOptions, enabled: boolean, notes: string[]) {
  const file = path.join(o.home, ".claude.json");
  let current: ServerEntry | undefined;
  try {
    current = userServer(readClaudeJson(file));
  } catch (e) {
    notes.push(`Left ${file} alone: it couldn't be read (${(e as Error).message})`);
    return;
  }
  const exec = o.exec ?? execCli;
  const cli = o.claude === undefined ? findClaude() : o.claude;
  const claude = (args: string[]) => (cli ? exec(cli.cmd, [...cli.args, ...args]) : Promise.resolve({ code: 1, stdout: "", stderr: "no CLI" }));

  if (!enabled) {
    if (!isOurs(current)) return;
    const r = await claude(["mcp", "remove", SERVER_NAME, "--scope", "user"]);
    if (r.code !== 0 || isOurs(userServer(readClaudeJson(file)))) editServer(file, undefined);
    notes.push("Removed the sandflow MCP server from Claude Code");
    return;
  }

  const bridge = path.join(o.dataDir, BRIDGE_FILE);
  // The bridge is rewritten every start so an app update brings its new version.
  writeAtomic(bridge, MCP_BRIDGE);
  const want: ServerEntry = {
    type: "stdio",
    command: o.node.command,
    args: [bridge, "--config", path.join(o.dataDir, "mcp.json"), "--client", "claude-code"],
    env: o.node.env ?? {},
  };
  if (current && !isOurs(current)) {
    notes.push(
      isCliEntry(current)
        ? `Claude Code uses the sandflow CLI's MCP server ("sandflow mcp") — left as it is; remove it with "claude mcp remove ${SERVER_NAME} --scope user" to use this app instead`
        : `Left your own "${SERVER_NAME}" MCP server in Claude Code as it is`,
    );
    return;
  }
  if (sameServer(current, want)) {
    notes.push("The sandflow MCP server is registered with Claude Code");
    return;
  }
  // `claude mcp add` refuses a name that exists: drop the older Sandflow entry first.
  if (current) await claude(["mcp", "remove", SERVER_NAME, "--scope", "user"]);
  const envArgs = Object.entries(want.env ?? {}).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
  const r = await claude(["mcp", "add", SERVER_NAME, "--scope", "user", ...envArgs, "--", want.command!, ...want.args!]);
  let how = "claude mcp add";
  if (r.code !== 0 || !sameServer(userServer(readClaudeJson(file)), want)) {
    editServer(file, want);
    how = "~/.claude.json";
  }
  notes.push(`${current ? "Updated" : "Registered"} the sandflow MCP server in Claude Code (${how})`);
}

/** Every file of a skill folder (relative path → content), without the marker. */
function skillFiles(dir: string, rel = ""): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) for (const [k, v] of skillFiles(dir, r)) out.set(k, v);
    else if (r !== SKILL_MARKER) out.set(r, fs.readFileSync(path.join(dir, r)));
  }
  return out;
}

function hashFiles(files: Map<string, Buffer>): string {
  const h = createHash("sha256");
  for (const k of [...files.keys()].sort()) h.update(`${k}\0${files.get(k)!.length}\0`).update(files.get(k)!);
  return h.digest("hex");
}

/** Whether `dest` is Sandflow's copy, unchanged since Sandflow wrote it (so it may be replaced or removed). */
function ownedUnchanged(dest: string): boolean {
  try {
    const marker = JSON.parse(fs.readFileSync(path.join(dest, SKILL_MARKER), "utf8")) as { hash?: string };
    return marker.hash === hashFiles(skillFiles(dest));
  } catch {
    return false;
  }
}

function syncSkills(o: ClaudeCodeOptions, enabled: boolean, notes: string[]) {
  let names: string[];
  try {
    names = fs.readdirSync(o.skillsDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    notes.push(`No skills to install (${o.skillsDir} is missing)`);
    return;
  }
  for (const name of names) {
    const dest = path.join(o.home, ".claude", "skills", name);
    const exists = fs.existsSync(dest);
    if (!enabled) {
      if (exists && ownedUnchanged(dest)) {
        fs.rmSync(dest, { recursive: true, force: true });
        notes.push(`Removed the ${name} skill from Claude Code`);
      }
      continue;
    }
    const files = skillFiles(path.join(o.skillsDir, name));
    const hash = hashFiles(files);
    if (exists && !ownedUnchanged(dest)) {
      notes.push(`Left the ${name} skill in Claude Code alone (it isn't Sandflow's copy, or you changed it)`);
      continue;
    }
    if (exists && hashFiles(skillFiles(dest)) === hash) {
      notes.push(`The ${name} skill is installed in Claude Code`);
      continue;
    }
    // Write next to it, then swap, so Claude Code never sees half a skill.
    const tmp = `${dest}.${process.pid}.tmp`;
    fs.rmSync(tmp, { recursive: true, force: true });
    for (const [rel, content] of files) {
      fs.mkdirSync(path.dirname(path.join(tmp, rel)), { recursive: true });
      fs.writeFileSync(path.join(tmp, rel), content);
    }
    fs.writeFileSync(path.join(tmp, SKILL_MARKER), `${JSON.stringify({ version: o.version, hash }, null, 2)}\n`);
    fs.rmSync(dest, { recursive: true, force: true });
    fs.renameSync(tmp, dest);
    notes.push(`${exists ? "Updated" : "Installed"} the ${name} skill in Claude Code`);
  }
}

/** Install (enabled) or remove (disabled) the integration. Does nothing when Claude Code isn't installed. Idempotent. */
export async function syncClaudeCode(o: ClaudeCodeOptions, enabled: boolean): Promise<ClaudeCodeStatus> {
  const present = fs.existsSync(path.join(o.home, ".claude"));
  const notes: string[] = [];
  if (!present) return { present, enabled, notes: ["Claude Code isn't installed (no ~/.claude folder)"] };
  try {
    await syncServer(o, enabled, notes);
  } catch (e) {
    notes.push(`Couldn't ${enabled ? "register" : "remove"} the sandflow MCP server: ${(e as Error).message}`);
  }
  try {
    syncSkills(o, enabled, notes);
  } catch (e) {
    notes.push(`Couldn't ${enabled ? "install" : "remove"} the skills: ${(e as Error).message}`);
  }
  return { present, enabled, notes };
}
