// `sandflow setup`: what the one-line installers do in Claude Code, for an `npm i -g sandflow` install — add the
// `sand` plugin from the sandflow marketplace and register `sandflow mcp` as the user-scope `sandflow` MCP server.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface SetupDeps {
  /** Run `claude <args>`; null when Claude Code isn't installed. */
  claude(args: string[]): { code: number; stdout: string } | null;
  /** ~/.claude.json (where Claude Code keeps user-scope MCP servers). */
  claudeJson: string;
  platform: NodeJS.Platform;
}

export const MARKETPLACE = "kafuexe/sandflow";

export function realSetupDeps(env: NodeJS.ProcessEnv = process.env): SetupDeps {
  return {
    claude(args) {
      // npm puts claude.cmd on Windows, which needs a shell.
      const r = spawnSync("claude", args, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], shell: process.platform === "win32", env });
      if (r.error) return null;
      return { code: r.status ?? 1, stdout: r.stdout ?? "" };
    },
    claudeJson: path.join(env.CLAUDE_CONFIG_DIR || os.homedir(), ".claude.json"),
    platform: process.platform,
  };
}

interface ServerEntry {
  command?: string;
  args?: string[];
}

/** The MCP server entry for the `sandflow` on PATH (Windows runs the npm .cmd shim through cmd). */
export const mcpCommand = (platform: NodeJS.Platform) => (platform === "win32" ? ["cmd", "/c", "sandflow", "mcp"] : ["sandflow", "mcp"]);

/** none | same | sandflow (an older Sandflow entry: CLI or desktop bridge) | foreign | unreadable */
export function mcpState(file: string, want: string[]): "none" | "same" | "sandflow" | "foreign" | "unreadable" {
  let cfg: { mcpServers?: Record<string, ServerEntry> };
  try {
    cfg = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ENOENT" ? "none" : "unreadable";
  }
  const e = cfg?.mcpServers?.sandflow;
  if (!e) return "none";
  const parts = [e.command ?? "", ...(Array.isArray(e.args) ? e.args : [])].map(String);
  if (JSON.stringify(parts) === JSON.stringify(want)) return "same";
  if (parts.some((p) => p.includes("sandflow-mcp-bridge.cjs"))) return "sandflow";
  if (parts.includes("mcp") && parts.some((p) => /(^|[\\/])sandflow(\.cmd|\.ps1|\.mjs|\.exe)?$/i.test(p))) return "sandflow";
  return "foreign";
}

const hasName = (json: string, name: string) => {
  try {
    const l = JSON.parse(json) as { name?: string; id?: string }[];
    return Array.isArray(l) && l.some((m) => m && (m.name === name || m.id === name));
  } catch {
    return false;
  }
};

/** Returns the lines to print and the commands left for the user to run; ok=false when something failed. */
export function setup(opts: { plugin: boolean; mcp: boolean }, d: SetupDeps): { ok: boolean; notes: string[]; later: string[] } {
  const notes: string[] = [];
  const later: string[] = [];
  const want = mcpCommand(d.platform);
  const addLine = `claude mcp add --scope user sandflow -- ${want.join(" ")}`;
  let ok = true;

  if (!d.claude(["--version"])) {
    if (opts.plugin) later.push(`claude plugin marketplace add ${MARKETPLACE}`, "claude plugin install sand@sandflow");
    if (opts.mcp) later.push(addLine);
    notes.push("Claude Code (claude) was not found on PATH; after installing it run the commands below (or sandflow setup again).");
    return { ok: false, notes, later };
  }

  if (opts.plugin) {
    const markets = d.claude(["plugin", "marketplace", "list", "--json"]);
    const marketCmd = markets && hasName(markets.stdout, "sandflow") ? ["plugin", "marketplace", "update", "sandflow"] : ["plugin", "marketplace", "add", MARKETPLACE];
    if (d.claude(marketCmd)?.code === 0) {
      const plugins = d.claude(["plugin", "list", "--json"]);
      const pluginCmd = plugins && hasName(plugins.stdout, "sand@sandflow") ? ["plugin", "update", "sand@sandflow"] : ["plugin", "install", "sand@sandflow"];
      if (d.claude(pluginCmd)?.code === 0) notes.push("Claude Code plugin sand@sandflow installed: /sand:flow, /sand:schedule, /sand:edit.");
      else {
        ok = false;
        notes.push("Couldn't install the sand plugin.");
        later.push("claude plugin install sand@sandflow");
      }
    } else {
      ok = false;
      notes.push("Couldn't add the sandflow marketplace.");
      later.push(`claude plugin marketplace add ${MARKETPLACE}`, "claude plugin install sand@sandflow");
    }
  }

  if (opts.mcp) {
    const state = mcpState(d.claudeJson, want);
    if (state === "same") notes.push("The sandflow MCP server was already registered with Claude Code.");
    else if (state === "foreign") {
      notes.push('Claude Code already has a different MCP server named "sandflow"; left it as it is.');
      later.push("claude mcp remove --scope user sandflow   # only if you no longer need it", addLine);
    } else if (state === "unreadable") {
      ok = false;
      notes.push(`Couldn't read ${d.claudeJson}; MCP server not registered.`);
      later.push(addLine);
    } else {
      if (state === "sandflow") d.claude(["mcp", "remove", "--scope", "user", "sandflow"]);
      if (d.claude(["mcp", "add", "--scope", "user", "sandflow", "--", ...want])?.code === 0) {
        notes.push(`${state === "sandflow" ? "Updated" : "Registered"} the sandflow MCP server with Claude Code (user scope).`);
      } else {
        ok = false;
        notes.push("Couldn't register the MCP server.");
        later.push(addLine);
      }
    }
  }
  return { ok, notes, later };
}
