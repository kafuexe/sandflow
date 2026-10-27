// Claude Code integration: the bridge that follows mcp.json, and installing / removing the MCP registration and
// skills — always against temp homes, never the real ~/.claude.

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { MCP_BRIDGE } from "../backend/assistantAgents";
import { BRIDGE_FILE, SKILL_MARKER, syncClaudeCode, type ClaudeCodeOptions } from "../backend/claudeCode";

const dirs: string[] = [];
const tmp = (name = "sandflow-cc-") => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), name));
  dirs.push(d);
  return d;
};
const servers: Server[] = [];
afterEach(() => {
  servers.splice(0).forEach((s) => (s.closeAllConnections(), s.close()));
  dirs.splice(0).forEach((d) => fs.rmSync(d, { recursive: true, force: true }));
});

/** An MCP endpoint that records the URLs it was called on and answers with its own name. */
async function fakeSandflow(name: string, seen: string[]) {
  const s = createServer((req, res) => {
    seen.push(`${name} ${req.url}`);
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const id = (JSON.parse(body) as { id: number }).id;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ jsonrpc: "2.0", id, result: { from: name } }));
    });
  });
  servers.push(s);
  s.listen(0, "127.0.0.1");
  await new Promise((r) => s.once("listening", r));
  return `http://127.0.0.1:${(s.address() as AddressInfo).port}/api/mcp`;
}

const writeMcpJson = (file: string, url: string) => fs.writeFileSync(file, JSON.stringify({ mcpServers: { sandflow: { type: "http", url } } }));

describe("bridge with --config", () => {
  it("reads the URL from mcp.json for every request and says it's Claude Code, with the project folder", async () => {
    const seen: string[] = [];
    const first = await fakeSandflow("one", seen);
    const second = await fakeSandflow("two", seen);
    const data = tmp();
    const project = path.join(tmp(), "webapp");
    fs.mkdirSync(project);
    const bridge = path.join(data, BRIDGE_FILE);
    const config = path.join(data, "mcp.json");
    fs.writeFileSync(bridge, MCP_BRIDGE);
    writeMcpJson(config, first);
    const child = spawn(process.execPath, [bridge, "--config", config, "--client", "claude-code"], { cwd: project, stdio: ["pipe", "pipe", "inherit"] });
    const lines: { id: number; result?: { from: string }; error?: { message: string } }[] = [];
    let buf = "";
    child.stdout.on("data", (d: Buffer) => {
      buf += d.toString();
      for (let i; (i = buf.indexOf("\n")) >= 0; buf = buf.slice(i + 1)) lines.push(JSON.parse(buf.slice(0, i)));
    });
    const until = async (n: number) => {
      for (let t = 0; lines.length < n; t++) {
        if (t > 300) throw new Error("timed out");
        await new Promise((r) => setTimeout(r, 10));
      }
    };
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" })}\n`);
    await until(1);
    // Sandflow restarted on another port: the next request follows mcp.json.
    writeMcpJson(config, second);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ping" })}\n`);
    await until(2);
    fs.rmSync(config);
    child.stdin.end(`${JSON.stringify({ jsonrpc: "2.0", id: 3, method: "ping" })}\n`);
    await new Promise((r) => child.once("close", r));
    expect(lines.map((l) => l.result?.from ?? l.error?.message)).toEqual(["one", "two", expect.stringMatching(/Sandflow isn't running/)]);
    expect(seen).toEqual(["one /api/mcp?client=claude-code&label=webapp", "two /api/mcp?client=claude-code&label=webapp"]);
  });
});

describe("syncClaudeCode", () => {
  function setup(o: { claudeDir?: boolean; claude?: ClaudeCodeOptions["claude"] } = {}) {
    const home = tmp("sandflow-home-");
    if (o.claudeDir !== false) fs.mkdirSync(path.join(home, ".claude"));
    const dataDir = tmp();
    const skillsDir = tmp();
    for (const name of ["sandflow-flows", "sandflow-runs"]) {
      fs.mkdirSync(path.join(skillsDir, name));
      fs.writeFileSync(path.join(skillsDir, name, "SKILL.md"), `---\nname: ${name}\n---\nv1\n`);
    }
    const calls: string[][] = [];
    const opts: ClaudeCodeOptions = {
      home,
      dataDir,
      skillsDir,
      node: { command: "/apps/Sandflow", env: { ELECTRON_RUN_AS_NODE: "1" } },
      claude: o.claude === undefined ? null : o.claude,
      exec: async (cmd, args) => {
        calls.push([cmd, ...args]);
        return { code: 1, stdout: "", stderr: "unavailable" };
      },
      version: "1.2.3",
    };
    const claudeJson = path.join(home, ".claude.json");
    const read = () => JSON.parse(fs.readFileSync(claudeJson, "utf8"));
    const skill = (name: string) => path.join(home, ".claude", "skills", name);
    return { opts, home, dataDir, skillsDir, calls, claudeJson, read, skill };
  }

  it("does nothing when Claude Code isn't installed", async () => {
    const t = setup({ claudeDir: false });
    const s = await syncClaudeCode(t.opts, true);
    expect(s.present).toBe(false);
    expect(fs.readdirSync(t.home)).toEqual([]);
    expect(fs.readdirSync(t.dataDir)).toEqual([]);
  });

  it("registers the bridge in ~/.claude.json without touching other settings or servers, and installs the skills; idempotent", async () => {
    const t = setup();
    fs.writeFileSync(t.claudeJson, JSON.stringify({ numStartups: 7, mcpServers: { other: { type: "http", url: "http://x" } }, projects: { "/p": {} } }));
    const s = await syncClaudeCode(t.opts, true);
    expect(s.present).toBe(true);
    const bridge = path.join(t.dataDir, BRIDGE_FILE);
    expect(fs.readFileSync(bridge, "utf8")).toBe(MCP_BRIDGE);
    expect(t.read()).toEqual({
      numStartups: 7,
      projects: { "/p": {} },
      mcpServers: {
        other: { type: "http", url: "http://x" },
        sandflow: {
          type: "stdio",
          command: "/apps/Sandflow",
          args: [bridge, "--config", path.join(t.dataDir, "mcp.json"), "--client", "claude-code"],
          env: { ELECTRON_RUN_AS_NODE: "1" },
        },
      },
    });
    for (const name of ["sandflow-flows", "sandflow-runs"]) {
      expect(fs.readFileSync(path.join(t.skill(name), "SKILL.md"), "utf8")).toContain(`name: ${name}`);
      expect(JSON.parse(fs.readFileSync(path.join(t.skill(name), SKILL_MARKER), "utf8")).version).toBe("1.2.3");
    }
    expect(s.notes.join("\n")).toMatch(/Registered the sandflow MCP server.*~\/\.claude\.json/);

    const before = fs.statSync(t.claudeJson).mtimeMs;
    const again = await syncClaudeCode(t.opts, true);
    expect(fs.statSync(t.claudeJson).mtimeMs).toBe(before);
    expect(again.notes).toEqual([
      "The sandflow MCP server is registered with Claude Code",
      "The sandflow-flows skill is installed in Claude Code",
      "The sandflow-runs skill is installed in Claude Code",
    ]);
  });

  it("uses `claude mcp add --scope user` when the CLI is there, replacing an older Sandflow entry", async () => {
    const t = setup({ claude: { cmd: "claude", args: [] } });
    fs.writeFileSync(t.claudeJson, JSON.stringify({ mcpServers: { sandflow: { type: "stdio", command: "/old/Sandflow", args: [`/old/${BRIDGE_FILE}`, "http://127.0.0.1:1/api/mcp"] } } }));
    // The fake CLI does what Claude Code does: writes the user-scope entry.
    t.opts.exec = async (cmd, args) => {
      t.calls.push([cmd, ...args]);
      const cfg = JSON.parse(fs.readFileSync(t.claudeJson, "utf8"));
      if (args[1] === "remove") delete cfg.mcpServers.sandflow;
      if (args[1] === "add") {
        const sep = args.indexOf("--");
        cfg.mcpServers.sandflow = { type: "stdio", command: args[sep + 1], args: args.slice(sep + 2), env: { ELECTRON_RUN_AS_NODE: "1" } };
      }
      fs.writeFileSync(t.claudeJson, JSON.stringify(cfg));
      return { code: 0, stdout: "", stderr: "" };
    };
    const s = await syncClaudeCode(t.opts, true);
    const bridge = path.join(t.dataDir, BRIDGE_FILE);
    expect(t.calls).toEqual([
      ["claude", "mcp", "remove", "sandflow", "--scope", "user"],
      ["claude", "mcp", "add", "sandflow", "--scope", "user", "-e", "ELECTRON_RUN_AS_NODE=1", "--", "/apps/Sandflow", bridge, "--config", path.join(t.dataDir, "mcp.json"), "--client", "claude-code"],
    ]);
    expect(t.read().mcpServers.sandflow.command).toBe("/apps/Sandflow");
    expect(s.notes[0]).toMatch(/Updated the sandflow MCP server.*claude mcp add/);
  });

  it("falls back to editing ~/.claude.json when the CLI fails", async () => {
    const t = setup({ claude: { cmd: "claude", args: [] } });
    await syncClaudeCode(t.opts, true);
    expect(t.calls[0].slice(0, 3)).toEqual(["claude", "mcp", "add"]);
    expect(t.read().mcpServers.sandflow.command).toBe("/apps/Sandflow");
  });

  it("leaves a user's own sandflow server, an unreadable ~/.claude.json and skills that aren't Sandflow's copy alone", async () => {
    const t = setup();
    fs.writeFileSync(t.claudeJson, JSON.stringify({ mcpServers: { sandflow: { type: "http", url: "http://127.0.0.1:5173/api/mcp" } } }));
    fs.mkdirSync(t.skill("sandflow-flows"), { recursive: true });
    fs.writeFileSync(path.join(t.skill("sandflow-flows"), "SKILL.md"), "my own");
    const s = await syncClaudeCode(t.opts, true);
    expect(t.read().mcpServers.sandflow).toEqual({ type: "http", url: "http://127.0.0.1:5173/api/mcp" });
    expect(fs.readFileSync(path.join(t.skill("sandflow-flows"), "SKILL.md"), "utf8")).toBe("my own");
    expect(s.notes.join("\n")).toMatch(/Left your own "sandflow" MCP server/);
    expect(s.notes.join("\n")).toMatch(/Left the sandflow-flows skill/);

    fs.writeFileSync(t.claudeJson, "{ broken");
    const broken = await syncClaudeCode(t.opts, true);
    expect(fs.readFileSync(t.claudeJson, "utf8")).toBe("{ broken");
    expect(broken.notes[0]).toMatch(/Left .*\.claude\.json alone/);
  });

  it("updates an unchanged older copy of a skill but keeps one the user edited", async () => {
    const t = setup();
    await syncClaudeCode(t.opts, true);
    fs.writeFileSync(path.join(t.skillsDir, "sandflow-runs", "SKILL.md"), "---\nname: sandflow-runs\n---\nv2\n");
    fs.writeFileSync(path.join(t.skillsDir, "sandflow-flows", "SKILL.md"), "---\nname: sandflow-flows\n---\nv2\n");
    fs.appendFileSync(path.join(t.skill("sandflow-flows"), "SKILL.md"), "my note\n");
    const s = await syncClaudeCode({ ...t.opts, version: "1.2.4" }, true);
    expect(fs.readFileSync(path.join(t.skill("sandflow-runs"), "SKILL.md"), "utf8")).toContain("v2");
    expect(JSON.parse(fs.readFileSync(path.join(t.skill("sandflow-runs"), SKILL_MARKER), "utf8")).version).toBe("1.2.4");
    expect(fs.readFileSync(path.join(t.skill("sandflow-flows"), "SKILL.md"), "utf8")).toMatch(/v1\nmy note/);
    expect(s.notes).toContain("Updated the sandflow-runs skill in Claude Code");
  });

  it("turned off, removes only what Sandflow added", async () => {
    const t = setup();
    fs.writeFileSync(t.claudeJson, JSON.stringify({ mcpServers: { other: { type: "http", url: "http://x" } } }));
    await syncClaudeCode(t.opts, true);
    fs.appendFileSync(path.join(t.skill("sandflow-flows"), "SKILL.md"), "edited\n");
    const s = await syncClaudeCode(t.opts, false);
    expect(t.read().mcpServers).toEqual({ other: { type: "http", url: "http://x" } });
    expect(fs.existsSync(t.skill("sandflow-runs"))).toBe(false);
    expect(fs.existsSync(t.skill("sandflow-flows"))).toBe(true);
    expect(s.notes).toEqual(["Removed the sandflow MCP server from Claude Code", "Removed the sandflow-runs skill from Claude Code"]);
    // Off again: nothing left to do.
    expect((await syncClaudeCode(t.opts, false)).notes).toEqual([]);
  });
});

describe("Claude Code integration in the app", () => {
  it("installs on start, and the Settings toggle removes it and puts it back", async () => {
    const { createApi } = await import("../backend/api");
    const { createStorage } = await import("../backend/storage");
    const home = tmp("sandflow-home-");
    fs.mkdirSync(path.join(home, ".claude"));
    const dataDir = tmp();
    const skillsDir = path.join(import.meta.dirname, "../agent-skills");
    const noop = async () => ({ outputs: {} });
    const api = createApi(createStorage(dataDir), { auto: noop, ai: noop }, {
      exec: async () => ({ code: 1, stdout: "", stderr: "" }),
      claudeCode: { home, dataDir, skillsDir, node: { command: process.execPath }, claude: null, version: "9.9.9" },
    });
    const s = createServer((req, res) => api(req, res, () => ((res.statusCode = 404), res.end())));
    servers.push(s);
    s.listen(0, "127.0.0.1");
    await new Promise((r) => s.once("listening", r));
    const base = `http://127.0.0.1:${(s.address() as AddressInfo).port}/api`;
    const status = async () => (await (await fetch(`${base}/claude-code`)).json()) as { available: boolean; present: boolean; enabled: boolean };
    const claudeJson = () => JSON.parse(fs.readFileSync(path.join(home, ".claude.json"), "utf8"));
    const setEnabled = async (enabled: boolean) => {
      const data = (await (await fetch(`${base}/data`)).json()) as { settings: object };
      const r = await fetch(`${base}/settings`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...data.settings, claudeCode: { enabled } }) });
      expect(r.status).toBe(200);
    };

    expect(await status()).toMatchObject({ available: true, present: true, enabled: true });
    expect(claudeJson().mcpServers.sandflow.args[0]).toBe(path.join(dataDir, BRIDGE_FILE));
    expect(fs.existsSync(path.join(home, ".claude", "skills", "sandflow-runs", "SKILL.md"))).toBe(true);
    expect(fs.existsSync(path.join(home, ".claude", "skills", "sandflow-flows", "SKILL.md"))).toBe(true);

    await setEnabled(false);
    expect(await status()).toMatchObject({ enabled: false });
    expect(claudeJson().mcpServers.sandflow).toBeUndefined();
    expect(fs.existsSync(path.join(home, ".claude", "skills", "sandflow-runs"))).toBe(false);

    await setEnabled(true);
    expect(await status()).toMatchObject({ enabled: true });
    expect(claudeJson().mcpServers.sandflow).toBeDefined();
    await api.shutdown(1000);
  });
});
