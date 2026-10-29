import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isCliEntry } from "../backend/claudeCode";
import { parseArgs, parseAt, parseEnv, parsePort, UsageError } from "../backend/cli/args";
import { exitCodeFor, changeLines, newSeen, summaryLine } from "../backend/cli/follow";
import { homePaths, liveDaemon, readDaemonInfo, releaseLock, removeDaemonInfo, takeLock, writeDaemonInfo } from "../backend/cli/home";
import { keyOf, pickerRow, renderPicker, step } from "../backend/cli/picker";
import { mcpCommand, setup, type SetupDeps } from "../backend/cli/setup";
import { appendHistory, compactHistory, createHistoryRecorder, readHistory, type HistoryEntry } from "../backend/history";
import type { RunState } from "../shared/types";

const dirs: string[] = [];
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "sandflow-cli-"));
  dirs.push(d);
  return d;
};
afterEach(() => dirs.splice(0).forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

describe("cli args", () => {
  it("parses positionals, bool / string / repeated flags, = values and -- rest", () => {
    const p = parseArgs(["flow", "do it", "--env", "A=1", "--env=B=2", "--repo", "/x", "--json", "--", "run", "--env", "C=3"], {
      env: "multi",
      repo: "string",
      json: "bool",
    });
    expect(p.positionals).toEqual(["flow", "do it"]);
    expect(p.flags).toEqual({ env: ["A=1", "B=2"], repo: "/x", json: true });
    expect(p.rest).toEqual(["run", "--env", "C=3"]);
  });

  it("rejects unknown flags, missing values and values on bool flags", () => {
    expect(() => parseArgs(["--nope"], {})).toThrow(UsageError);
    expect(() => parseArgs(["--repo"], { repo: "string" })).toThrow(/needs a value/);
    expect(() => parseArgs(["--repo", "--json"], { repo: "string", json: "bool" })).toThrow(/needs a value/);
    expect(() => parseArgs(["--json=1"], { json: "bool" })).toThrow(/takes no value/);
  });

  it("maps -h to --help and keeps -r as a word", () => {
    expect(parseArgs(["-h"], { help: "bool" }).flags.help).toBe(true);
    expect(parseArgs(["-r"], {}).positionals).toEqual(["-r"]);
  });

  it("parses --env pairs, ports and --at times", () => {
    expect(parseEnv(["A=1", "B=x=y", "C="])).toEqual({ A: "1", B: "x=y", C: "" });
    expect(() => parseEnv(["nope"])).toThrow(UsageError);
    expect(parsePort("8080")).toBe(8080);
    expect(parsePort(undefined)).toBeUndefined();
    expect(() => parsePort("80x")).toThrow(UsageError);

    const now = new Date(2026, 9, 28, 14, 30, 0);
    expect(parseAt("15:05", now)).toEqual(new Date(2026, 9, 28, 15, 5, 0));
    expect(parseAt("09:00", now)).toEqual(new Date(2026, 9, 29, 9, 0, 0)); // passed today → tomorrow
    expect(parseAt("2026-11-01T10:00:00", now)).toEqual(new Date(2026, 10, 1, 10, 0, 0));
    expect(() => parseAt("2020-01-01T00:00:00Z", now)).toThrow(/past/);
    expect(() => parseAt("25:00", now)).toThrow(UsageError);
    expect(() => parseAt("soon", now)).toThrow(UsageError);
  });
});

const run = (o: Partial<RunState> = {}): RunState => ({
  id: "r1",
  flowId: "f",
  flowName: "Flow",
  status: "running",
  startedAt: 1000,
  nodes: {},
  logs: [],
  ...o,
});

describe("history.jsonl", () => {
  it("keeps the latest line per run, newest start first, skipping broken lines", () => {
    const file = path.join(tmp(), "history.jsonl");
    const e = (runId: string, status: HistoryEntry["status"], startedAt: number): HistoryEntry => ({
      runId,
      flowId: "f",
      flowName: "F",
      status,
      startedAt,
      dataDir: "/d",
      source: "cli",
    });
    appendHistory(file, e("a", "running", 1));
    appendHistory(file, e("b", "running", 2));
    fs.appendFileSync(file, '{"runId":"c","sta\n'); // a writer cut off mid-line
    appendHistory(file, e("a", "done", 1));
    expect(readHistory(file).map((x) => [x.runId, x.status])).toEqual([
      ["b", "running"],
      ["a", "done"],
    ]);
    expect(readHistory(path.join(tmp(), "missing.jsonl"))).toEqual([]);
  });

  it("compacts to the latest line per run once it grows past the limit", () => {
    const file = path.join(tmp(), "history.jsonl");
    for (let i = 0; i < 30; i++) appendHistory(file, { runId: `r${i % 5}`, flowId: "f", flowName: "F", status: i < 25 ? "running" : "done", startedAt: i % 5, dataDir: "/d", source: "cli" });
    const before = readHistory(file);
    expect(compactHistory(file, 100)).toBe(false);
    expect(compactHistory(file, 10, 3)).toBe(true);
    const lines = fs.readFileSync(file, "utf8").trim().split("\n");
    expect(lines).toHaveLength(3);
    expect(readHistory(file)).toEqual(before.slice(0, 3));
  });

  it("the recorder appends on start and status changes only, never for stack tasks", () => {
    const file = path.join(tmp(), "history.jsonl");
    const rec = createHistoryRecorder({ file, source: "desktop", dataDir: "/data" });
    const r = run({ prompt: `  ${"p".repeat(500)}`, workspace: { repo: "/repo" } as RunState["workspace"] });
    rec(r);
    rec(r); // journal save, nothing changed
    rec({ ...r, logs: [{ ts: 1, level: "info", msg: "x" }] });
    rec({ ...r, status: "done", finishedAt: 2000 });
    rec(run({ id: "child", parent: { runId: "r1", nodeKey: "s" } }));
    const lines = fs.readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(lines.map((l) => l.status)).toEqual(["running", "done"]);
    expect(lines[1]).toMatchObject({ runId: "r1", flowId: "f", flowName: "Flow", repo: "/repo", startedAt: 1000, endedAt: 2000, dataDir: "/data", source: "desktop" });
    expect(lines[1].prompt).toHaveLength(300);
  });
});

describe("run picker", () => {
  it("maps keys", () => {
    expect(keyOf("\x1b[A")).toBe("up");
    expect(keyOf("j")).toBe("down");
    expect(keyOf("\r")).toBe("enter");
    expect(keyOf("\x1b")).toBe("cancel");
    expect(keyOf("q")).toBe("cancel");
    expect(keyOf("\x03")).toBe("cancel");
    expect(keyOf("x")).toBe("other");
  });

  it("moves within bounds, scrolls the window, picks and cancels", () => {
    let s = { index: 0, offset: 0 };
    expect(step(s, "up", 5, 3)).toEqual({ state: { index: 0, offset: 0 } });
    for (const _ of [1, 2, 3]) s = (step(s, "down", 5, 3) as { state: typeof s }).state;
    expect(s).toEqual({ index: 3, offset: 1 });
    expect(step(s, "end", 5, 3)).toEqual({ state: { index: 4, offset: 2 } });
    expect(step(s, "home", 5, 3)).toEqual({ state: { index: 0, offset: 0 } });
    expect(step(s, "enter", 5, 3)).toEqual({ pick: 3 });
    expect(step(s, "cancel", 5, 3)).toEqual({ cancel: true });
    expect(step(s, "enter", 0, 3)).toEqual({ cancel: true });
  });

  it("renders rows with flow, status, age, repo and prompt, the selected one marked", () => {
    const now = 10 * 60_000;
    const e: HistoryEntry = { runId: "x", flowId: "f", flowName: "Feature pipeline", status: "paused", startedAt: now - 5 * 60_000, repo: "/w/my-repo", dataDir: "/d", source: "cli", prompt: "Add\n dark mode" };
    const row = pickerRow(e, now, 120);
    expect(row).toMatch(/^Feature pipeline\s+paused\s+5m ago\s+my-repo\s+Add dark mode$/);
    expect(pickerRow({ ...e, repo: undefined, source: "desktop" }, now, 120)).toContain("(desktop)");
    expect(pickerRow(e, now, 30).length).toBeLessThanOrEqual(30);
    const lines = renderPicker(["a", "b", "c", "d"], { index: 2, offset: 1 }, 2, 80);
    expect(lines[0]).toMatch(/Continue which run/);
    expect(lines.slice(1)).toEqual(["  b", "\x1b[7m› c\x1b[0m", "  (3/4)"]);
  });
});

describe("following a run", () => {
  it("prints new log lines and flags once; agent lines only when asked", () => {
    const seen = newSeen();
    const r = run({ logs: [{ ts: 0, level: "info", msg: "▶ Plan (ai)" }, { ts: 1, level: "agent", nodeId: "plan", msg: "thinking" }] });
    expect(changeLines(r, seen)).toEqual([expect.stringMatching(/▶ Plan \(ai\)$/)]);
    r.logs.push({ ts: 2, level: "warn", msg: "careful" });
    r.flags = [{ id: "f1", severity: "error", message: "Broke", at: 2 }];
    expect(changeLines(r, seen)).toEqual([expect.stringMatching(/warn {2}careful$/), "⚑ error: Broke"]);
    expect(changeLines(r, seen)).toEqual([]);
    expect(changeLines(run({ logs: r.logs }), newSeen(), true)[1]).toMatch(/agent \[plan\] thinking/);
  });

  it("maps statuses to the contract's exit codes", () => {
    expect(exitCodeFor({ status: "done" })).toBe(0);
    expect(exitCodeFor({ status: "failed" })).toBe(1);
    expect(exitCodeFor({ status: "cancelled" })).toBe(1);
    expect(exitCodeFor({ status: "waiting" })).toBe(3);
    expect(exitCodeFor({ status: "paused" })).toBe(75);
    expect(summaryLine(run({ status: "paused", pauseReason: "quit" }))).toMatch(/paused \(sandflow was closed\).*sandflow resume r1/);
    expect(summaryLine(run({ status: "waiting", pendingQuestion: { nodeId: "n", question: "Which DB?" } }))).toMatch(/Which DB\?[\s\S]*sandflow answer r1/);
  });
});

describe("the desktop app and the CLI's Claude Code registration", () => {
  it("recognises `sandflow mcp` entries (left alone) apart from its own bridge", () => {
    expect(isCliEntry({ command: "sandflow", args: ["mcp"] })).toBe(true);
    expect(isCliEntry({ command: "C:\\Users\\a\\.sandflow\\bin\\sandflow.cmd", args: ["mcp"] })).toBe(true);
    expect(isCliEntry({ command: "node", args: ["/d/sandflow-mcp-bridge.cjs"] })).toBe(false);
    expect(isCliEntry({ command: "sandflow", args: ["serve"] })).toBe(false);
  });
});

describe("daemon.json and the start lock", () => {
  it("is alive only while its process lives and it answers", async () => {
    const p = homePaths(tmp());
    expect(await liveDaemon(p.daemon)).toBeUndefined();
    writeDaemonInfo(p.daemon, { url: "http://127.0.0.1:1", pid: process.pid, port: 1, version: "1" });
    expect(readDaemonInfo(p.daemon)?.pid).toBe(process.pid);
    const answering = (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch;
    const silent = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    expect(await liveDaemon(p.daemon, answering)).toMatchObject({ port: 1 });
    expect(await liveDaemon(p.daemon, silent)).toBeUndefined();
    writeDaemonInfo(p.daemon, { url: "http://127.0.0.1:1", pid: 2 ** 22 + 12345, port: 1, version: "1" }); // no such pid
    expect(await liveDaemon(p.daemon, answering)).toBeUndefined();
    removeDaemonInfo(p.daemon); // not ours: kept
    expect(fs.existsSync(p.daemon)).toBe(true);
  });

  it("lets one process take the lock and takes over a stale one", () => {
    const p = homePaths(tmp());
    expect(takeLock(p.daemonLock)).toBe(true);
    expect(takeLock(p.daemonLock)).toBe(false); // held (by us, alive, fresh)
    expect(takeLock(p.daemonLock, Date.now() + 120_000)).toBe(true); // stale
    releaseLock(p.daemonLock);
    expect(fs.existsSync(p.daemonLock)).toBe(false);
    fs.writeFileSync(p.daemonLock, JSON.stringify({ pid: 2 ** 22 + 12345, at: Date.now() })); // dead holder
    expect(takeLock(p.daemonLock)).toBe(true);
  });
});

describe("cli setup", () => {
  const deps = (claudeJson: string, opts: { missing?: boolean; failMcp?: boolean } = {}) => {
    const calls: string[] = [];
    const d: SetupDeps = {
      claude(args) {
        if (opts.missing) return null;
        calls.push(args.join(" "));
        if (args.join(" ").endsWith("list --json")) return { code: 0, stdout: "[]" };
        return { code: opts.failMcp && args[1] === "add" && args[0] === "mcp" ? 1 : 0, stdout: "" };
      },
      claudeJson,
      platform: "linux",
    };
    return { d, calls };
  };

  it("adds the marketplace, the plugin and the MCP server", () => {
    const { d, calls } = deps(path.join(tmp(), ".claude.json"));
    const r = setup({ plugin: true, mcp: true }, d);
    expect(r.ok).toBe(true);
    expect(calls).toContain("plugin marketplace add kafuexe/sandflow");
    expect(calls).toContain("plugin install sand@sandflow");
    expect(calls).toContain("mcp add --scope user sandflow -- sandflow mcp");
  });

  it("replaces an older Sandflow entry, keeps someone else's and an identical one", () => {
    const file = path.join(tmp(), ".claude.json");
    const write = (e: object) => fs.writeFileSync(file, JSON.stringify({ mcpServers: { sandflow: e } }));
    write({ command: "/home/me/.sandflow/bin/sandflow", args: ["mcp"] });
    let { d, calls } = deps(file);
    setup({ plugin: false, mcp: true }, d);
    expect(calls).toEqual(["--version", "mcp remove --scope user sandflow", "mcp add --scope user sandflow -- sandflow mcp"]);

    write({ command: "sandflow", args: ["mcp"] });
    ({ d, calls } = deps(file));
    expect(setup({ plugin: false, mcp: true }, d).notes[0]).toMatch(/already registered/);
    expect(calls).toEqual(["--version"]);

    write({ command: "other", args: [] });
    ({ d, calls } = deps(file));
    const r = setup({ plugin: false, mcp: true }, d);
    expect(calls).toEqual(["--version"]);
    expect(r.later.at(-1)).toBe("claude mcp add --scope user sandflow -- sandflow mcp");
  });

  it("registers through cmd on Windows and lists the commands when claude is missing or fails", () => {
    expect(mcpCommand("win32")).toEqual(["cmd", "/c", "sandflow", "mcp"]);
    const file = path.join(tmp(), ".claude.json");
    const missing = setup({ plugin: true, mcp: true }, deps(file, { missing: true }).d);
    expect(missing.ok).toBe(false);
    expect(missing.later).toEqual(["claude plugin marketplace add kafuexe/sandflow", "claude plugin install sand@sandflow", "claude mcp add --scope user sandflow -- sandflow mcp"]);
    expect(setup({ plugin: false, mcp: true }, deps(file, { failMcp: true }).d).ok).toBe(false);
  });
});
