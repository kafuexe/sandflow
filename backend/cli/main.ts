// The `sandflow` command: dispatch + every command. Exit codes: 0 ok/done, 1 failed/error, 2 usage error,
// 3 run waiting on a question, 75 run paused/held (can continue later).

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { RunState, RunSummary } from "../../shared/types";
import { readHistory, type HistoryEntry } from "../history";
import { parseArgs, parseAt, parseEnv, parsePort, UsageError, type FlagSpec, type Parsed } from "./args";
import { ApiError, ensureDaemon, instanceFor, request, spawnDaemonProcess, type Ctx } from "./client";
import { EXIT, followRun, logLine, money, runEvents, newSeen, changeLines, runResult } from "./follow";
import { cliVersion, homePaths, liveDaemon, pidAlive, readDaemonInfo, sandflowHome } from "./home";
import { ago, pick } from "./picker";
import { realSetupDeps, setup, type SetupDeps } from "./setup";
import {
  appendLog,
  installTrigger,
  listRecords,
  loadRecord,
  logFile,
  newScheduleId,
  realOs,
  removeTrigger,
  saveRecord,
  ScheduleError,
  triggerInstalled,
  type OsDeps,
  type ScheduleRecord,
} from "./schedule";

const HELP = `sandflow — run Sandflow flows from the terminal

Usage: sandflow <command> [options]

  flows [--json]                         List flows and the inputs they need
  run <flow> [prompt] [options]          Start a run and follow it (--detach to not wait)
  runs [--all] [--json]                  Recent runs (CLI and desktop app)
  status <runId> [--json]                A run's status, steps, question, flags, cost
  -r, resume [runId]                     Continue a run (no id: pick one); --paused continues every paused run
  answer <runId> <text>                  Answer a run's pending question
  stop <runId>                           Stop a run
  logs <runId> [--follow]                A run's log
  schedule add|list|edit|cancel          Run a flow later (OS scheduler)
  checker install|uninstall|status       Hourly task that continues paused runs
  serve [--port N] [--daemon]            Run the backend (the other commands start it when needed)
  shutdown                               Stop the backend (running flows pause and continue on the next start)
  mcp                                    Stdio MCP server for Claude Code
  setup [--no-plugin] [--no-mcp]         Add the Claude Code plugin and MCP server (after npm i -g sandflow)
  ui, --ui [--port N]                    Open the Sandflow UI in your browser
  --version                              Print the version

Exit codes: 0 done, 1 failed, 2 usage error, 3 waiting on a question, 75 paused (continue later).
Home: ~/.sandflow (or $SANDFLOW_HOME). "sandflow <command> --help" for details.`;

interface Command {
  help: string;
  flags: FlagSpec;
  run(ctx: Ctx, a: Parsed): Promise<number>;
}

const json = (ctx: Ctx, v: unknown) => ctx.out(JSON.stringify(v, null, 2));
const enc = encodeURIComponent;

/** A table with columns padded to their widest cell (the last column isn't padded). */
function table(rows: string[][]): string[] {
  const w = rows[0]?.map((_, i) => Math.max(...rows.map((r) => (r[i] ?? "").length))) ?? [];
  return rows.map((r) => r.map((c, i) => (i === r.length - 1 ? c : c.padEnd(w[i]))).join("  ").trimEnd());
}

const short = (s: string | undefined, n: number) => {
  const t = (s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

interface FlowInfo {
  id: string;
  name: string;
  description?: string;
  pack?: string;
  inputs: { name: string; optional: boolean; set: boolean }[];
  prompt: "set" | "needed" | "unused";
}

/** A flow by id, or by name (case-insensitive) when that's unambiguous. */
function findFlow(flows: FlowInfo[], q: string): FlowInfo {
  const exact = flows.find((f) => f.id === q);
  if (exact) return exact;
  const byName = flows.filter((f) => f.name.toLowerCase() === q.toLowerCase());
  if (byName.length === 1) return byName[0];
  if (byName.length > 1) throw new UsageError(`Several flows are called "${q}" — use the id: ${byName.map((f) => f.id).join(", ")}`);
  throw new UsageError(`No flow "${q}" — sandflow flows lists them`);
}

const backend = async (ctx: Ctx) => (await ensureDaemon(ctx)).url;

// ---------- flows / runs / status ----------

const flowsCmd: Command = {
  help: `sandflow flows [--json]

List flows: id, name, description and the inputs they need (env vars set in the Inputs tab, or passed with
"sandflow run --env NAME=value"; "prompt" = it needs a starting prompt).`,
  flags: { json: "bool" },
  async run(ctx, a) {
    const flows = await request<FlowInfo[]>(ctx, await backend(ctx), "GET", "/flows");
    if (a.flags.json) return json(ctx, flows), EXIT.ok;
    if (!flows.length) return ctx.out("No flows yet — open the UI with: sandflow --ui"), EXIT.ok;
    const needs = (f: FlowInfo) =>
      [
        ...(f.prompt === "unused" ? [] : [`prompt${f.prompt === "set" ? " (set)" : ""}`]),
        ...f.inputs.filter((i) => !i.optional).map((i) => `${i.name}${i.set ? " (set)" : ""}`),
      ].join(", ") || "-";
    for (const l of table([["ID", "NAME", "NEEDS", "DESCRIPTION"], ...flows.map((f) => [f.id, f.name, needs(f), short(f.description, 60)])])) ctx.out(l);
    return EXIT.ok;
  },
};

const runsCmd: Command = {
  help: `sandflow runs [--all] [--json]

Recent runs from ~/.sandflow/history.jsonl — the CLI's and the desktop app's — newest first. Shows the 20 latest;
--all shows every run in the history.`,
  flags: { all: "bool", json: "bool" },
  async run(ctx, a) {
    const all = readHistory(ctx.paths.history);
    const list = a.flags.all ? all : all.slice(0, 20);
    if (a.flags.json) return json(ctx, list), EXIT.ok;
    if (!list.length) return ctx.out('No runs yet — start one with: sandflow run <flow> "<prompt>"'), EXIT.ok;
    const now = Date.now();
    const rows = list.map((e) => [e.runId, e.status, ago(now - e.startedAt), short(e.flowName, 28), e.source === "desktop" ? "desktop" : "cli", e.repo ? path.basename(e.repo) : "", short(e.prompt, 50)]);
    for (const l of table([["RUN", "STATUS", "STARTED", "FLOW", "WHERE", "REPO", "PROMPT"], ...rows])) ctx.out(l);
    if (!a.flags.all && all.length > list.length) ctx.out(`(${all.length - list.length} older — sandflow runs --all)`);
    return EXIT.ok;
  },
};

function statusLines(r: RunState): string[] {
  const lines = [`Run ${r.id} — ${r.flowName}`, `Status: ${r.status}${r.phase && r.phase !== r.status ? ` (${r.phase})` : ""} · started ${ago(Date.now() - r.startedAt)}${r.costUsd ? ` · cost ${money(r.costUsd)}` : ""}`];
  if (r.workspace?.repo) lines.push(`Repo: ${r.workspace.repo}${r.branch ? ` · branch ${r.branch}` : ""}`);
  const icon: Record<string, string> = { done: "✓", failed: "✗", running: "▶", waiting: "?", queued: "·", idle: " " };
  const steps = Object.entries(r.nodes).filter(([, n]) => n.status !== "idle");
  if (steps.length) {
    lines.push("Steps:");
    for (const [k, n] of steps) lines.push(`  ${icon[n.status] ?? " "} ${k} — ${n.status}${n.executions > 1 ? ` ×${n.executions}` : ""}${n.error ? `: ${short(n.error, 120)}` : ""}`);
  }
  if (r.pendingQuestion) lines.push(`Question (${r.pendingQuestion.nodeId}): ${r.pendingQuestion.question}`, `  answer with: sandflow answer ${r.id} "<your answer>"`);
  const flags = (r.flags ?? []).filter((f) => !f.dismissed);
  if (flags.length) lines.push("Flags:", ...flags.map((f) => `  ⚑ ${f.severity}: ${f.message}`));
  if (r.hold) lines.push(`Held (${r.hold.reason}): ${r.hold.problems.join("; ")}`);
  if (r.error) lines.push(`Error: ${r.error}`);
  return lines;
}

const statusCmd: Command = {
  help: `sandflow status <runId> [--json]

A run's status, its steps, the pending question, flags, cost and error.`,
  flags: { json: "bool" },
  async run(ctx, a) {
    const id = a.positionals[0];
    if (!id) throw new UsageError("Which run? sandflow status <runId> (sandflow runs lists them)");
    const { base } = await instanceFor(ctx, id);
    const r = await request<RunState>(ctx, base, "GET", `/runs/${enc(id)}`);
    if (a.flags.json) {
      const nodes = Object.fromEntries(Object.entries(r.nodes).map(([k, n]) => [k, { status: n.status, executions: n.executions, ...(n.error ? { error: n.error } : {}) }]));
      return json(ctx, { ...runResult(r), startedAt: r.startedAt, finishedAt: r.finishedAt, repo: r.workspace?.repo, nodes, flags: (r.flags ?? []).filter((f) => !f.dismissed) }), EXIT.ok;
    }
    statusLines(r).forEach((l) => ctx.out(l));
    return EXIT.ok;
  },
};

// ---------- run / resume ----------

const runCmd: Command = {
  help: `sandflow run <flow id|name> [prompt] [--env NAME=value]... [--repo PATH] [--detach] [--json]

Start a run of a flow and follow it: step events stream to the terminal; when it asks a question you answer it
here (on a terminal — otherwise it exits with 3 and "sandflow answer" answers it). Ctrl+C detaches: the run
keeps going in the background.

  --env NAME=value   Input for this run only (repeatable); adds to / overrides the saved inputs
  --repo PATH        The project to work in (sets REPO_PATH for this run)
  --detach           Start it and return (prints the run id)
  --json             Print {runId, status, ...} (with --detach right away, else when it ends)
  --agent            Also print the agents' output`,
  flags: { env: "multi", repo: "string", detach: "bool", json: "bool", agent: "bool" },
  async run(ctx, a) {
    const [q, ...words] = a.positionals;
    if (!q) throw new UsageError('Which flow? sandflow run <flow> "<prompt>" (sandflow flows lists them)');
    const env = parseEnv(a.flags.env as string[] | undefined);
    if (a.flags.repo) {
      const repo = path.resolve(String(a.flags.repo));
      if (!fs.existsSync(repo)) throw new UsageError(`--repo ${repo} doesn't exist`);
      env.REPO_PATH = repo;
    }
    const base = await backend(ctx);
    const flow = findFlow(await request<FlowInfo[]>(ctx, base, "GET", "/flows"), q);
    const prompt = [...words, ...a.rest].join(" ").trim() || undefined;
    let started: { runId: string; warning?: string };
    try {
      started = await request(ctx, base, "POST", "/runs", { flowId: flow.id, prompt, ...(Object.keys(env).length ? { env } : {}) });
    } catch (e) {
      const missing = e instanceof ApiError ? (e.body.missing as string[] | undefined) : undefined;
      if (missing?.length) {
        const hint = missing.map((m) => (m === "Starting prompt" ? '"<prompt>"' : `--env ${m}=…`)).join(" ");
        throw new UsageError(`${flow.name} needs: ${missing.join(", ")} — pass ${hint} (or set them in the UI's Inputs tab)`);
      }
      throw e;
    }
    if (started.warning) ctx.err(`warning: ${started.warning}`);
    if (a.flags.detach) {
      if (a.flags.json) json(ctx, { runId: started.runId, flowId: flow.id, flowName: flow.name, status: "running", url: `${base}/` });
      else ctx.out(`Started run ${started.runId} (${flow.name}). Follow it: sandflow resume ${started.runId}`);
      return EXIT.ok;
    }
    (a.flags.json ? ctx.err : ctx.out)(`Started run ${started.runId} (${flow.name}) — Ctrl+C detaches`);
    return followRun(ctx, base, started.runId, { json: !!a.flags.json, interactive: ctx.isTTY && !a.flags.json, agent: !!a.flags.agent });
  },
};

/** Continue a run the way the UI does: paused → Continue (same run); failed / stopped → Retry (a new run). */
async function continueAndFollow(ctx: Ctx, id: string, o: { json?: boolean }): Promise<number> {
  const { base, desktop } = await instanceFor(ctx, id);
  if (desktop) ctx.err(`(run ${id} is the desktop app's — continuing it there)`);
  const run = await request<RunState>(ctx, base, "GET", `/runs/${enc(id)}`);
  let follow = id;
  try {
    if (run.status === "paused") {
      await request(ctx, base, "POST", `/runs/${enc(id)}/continue`, {});
      ctx.err(`Continuing run ${id} (${run.flowName})`);
    } else if (run.status === "failed" || run.status === "cancelled") {
      const r = await request<{ runId: string; warning?: string }>(ctx, base, "POST", `/runs/${enc(id)}/resume`, {});
      if (r.warning) ctx.err(`warning: ${r.warning}`);
      follow = r.runId;
      ctx.err(`Retrying ${run.flowName} from where run ${id} stopped — new run ${follow}`);
    } else if (run.status === "done") {
      ctx.out(`Run ${id} (${run.flowName}) already finished.`);
      if (o.json) json(ctx, runResult(run));
      return EXIT.ok;
    }
  } catch (e) {
    if (!(e instanceof ApiError) || e.status !== 409) throw e;
    const problems = (e.body.problems as string[] | undefined) ?? [];
    ctx.err(`Can't continue run ${id}: ${e.message}`);
    if (e.body.repairable) ctx.err(`What it needs changed can be adopted with Repair in the UI (sandflow --ui).`);
    if (o.json) json(ctx, { ...runResult(run), error: e.message, problems });
    return run.status === "paused" ? EXIT.paused : EXIT.failed;
  }
  return followRun(ctx, base, follow, { json: o.json, interactive: ctx.isTTY && !o.json });
}

/** `resume --paused` (the checker): continue every paused run of the daemon that isn't held for a person. */
async function continuePaused(ctx: Ctx, asJson: boolean): Promise<number> {
  const base = await backend(ctx);
  const runs = await request<RunSummary[]>(ctx, base, "GET", "/runs");
  const continued: string[] = [];
  const skipped: { runId: string; reason: string }[] = [];
  for (const r of runs.filter((x) => x.status === "paused" && !x.parent)) {
    if (r.hold) {
      skipped.push({ runId: r.id, reason: `held (${r.hold.reason}): ${r.hold.problems[0] ?? ""}`.trim() });
      continue;
    }
    try {
      await request(ctx, base, "POST", `/runs/${enc(r.id)}/continue`, {});
      continued.push(r.id);
    } catch (e) {
      // 409 also when the daemon's own start-up pass is continuing it right now.
      skipped.push({ runId: r.id, reason: (e as Error).message });
    }
  }
  const summary = `continued ${continued.length}${continued.length ? ` (${continued.join(", ")})` : ""}, skipped ${skipped.length}`;
  try {
    appendLog(ctx.paths, "checker", summary);
  } catch {
    /* informational */
  }
  if (asJson) json(ctx, { continued, skipped });
  else {
    ctx.out(`Paused runs: ${summary}`);
    for (const s of skipped) ctx.out(`  ${s.runId}: ${s.reason}`);
  }
  return EXIT.ok;
}

const resumeCmd: Command = {
  help: `sandflow resume [runId] [--json]      (also: sandflow -r [runId])
sandflow resume --paused [--json]

Continue a run and follow it like "sandflow run": a paused or held run continues where it was; a failed or stopped
one is retried from the failed step (a new run, as the UI's Retry does); a running one is just followed.
Without an id, pick the run from a list (terminal only; newest first).

  --paused   Continue every paused run that can continue by itself (not held for you) — non-interactive;
             this is what "sandflow checker" runs every hour`,
  flags: { paused: "bool", json: "bool" },
  async run(ctx, a) {
    if (a.flags.paused) return continuePaused(ctx, !!a.flags.json);
    let id = a.positionals[0];
    if (!id) {
      if (!ctx.isTTY) throw new UsageError("Pass a run id: sandflow resume <runId> (sandflow runs lists them)");
      const entries = readHistory(ctx.paths.history).filter((e) => e.status !== "done");
      if (!entries.length) return ctx.out("No runs to continue (sandflow runs --all lists every run)."), EXIT.ok;
      const chosen: HistoryEntry | undefined = await pick(entries, { stdin: ctx.stdin, out: process.stderr });
      if (!chosen) return EXIT.ok;
      id = chosen.runId;
    }
    return continueAndFollow(ctx, id, { json: !!a.flags.json });
  },
};

// ---------- answer / stop / logs ----------

const answerCmd: Command = {
  help: `sandflow answer <runId> <text>

Answer the question a run is waiting on.`,
  flags: {},
  async run(ctx, a) {
    const [id, ...words] = a.positionals;
    const text = [...words, ...a.rest].join(" ").trim();
    if (!id || !text) throw new UsageError('sandflow answer <runId> "<answer>"');
    const { base } = await instanceFor(ctx, id);
    await request(ctx, base, "POST", `/runs/${enc(id)}/answer`, { answer: text });
    ctx.out(`Answered — run ${id} goes on.`);
    return EXIT.ok;
  },
};

const stopCmd: Command = {
  help: `sandflow stop <runId>

Stop a run for good (running steps are cancelled; a paused run won't be continued). To pause instead, use
"sandflow shutdown" — paused runs continue on the next start.`,
  flags: {},
  async run(ctx, a) {
    const id = a.positionals[0];
    if (!id) throw new UsageError("sandflow stop <runId>");
    const { base } = await instanceFor(ctx, id);
    const r = await request<{ status: string }>(ctx, base, "POST", `/runs/${enc(id)}/cancel`, {});
    ctx.out(`Run ${id}: ${r.status === "running" || r.status === "waiting" ? "stopping" : r.status}`);
    return EXIT.ok;
  },
};

const logsCmd: Command = {
  help: `sandflow logs <runId> [--follow]

A run's log (agents' output included). --follow keeps printing until the run ends or pauses (Ctrl+C stops
watching; the run goes on).`,
  flags: { follow: "bool" },
  async run(ctx, a) {
    const id = a.positionals[0];
    if (!id) throw new UsageError("sandflow logs <runId> [--follow]");
    const { base } = await instanceFor(ctx, id);
    if (!a.flags.follow) {
      const r = await request<RunState>(ctx, base, "GET", `/runs/${enc(id)}`);
      for (const l of r.logs) ctx.out(logLine(l, true)!);
      return EXIT.ok;
    }
    const seen = newSeen();
    const ac = new AbortController();
    const stop = () => ac.abort();
    process.once("SIGINT", stop);
    try {
      for await (const s of runEvents(ctx, base, id, ac.signal)) changeLines(s, seen, true).forEach((l) => ctx.out(l));
    } catch (e) {
      if (!ac.signal.aborted) throw e;
    } finally {
      process.removeListener("SIGINT", stop);
    }
    return EXIT.ok;
  },
};

// ---------- serve / shutdown / ui / mcp ----------

const serveCmd: Command = {
  help: `sandflow serve [--port N] [--daemon]

Run the Sandflow backend (UI + API on 127.0.0.1) over ~/.sandflow/data. In the foreground, Ctrl+C stops it
(running flows pause and continue on the next start). --daemon is how the other commands start it in the
background (they do that by themselves); it writes ~/.sandflow/daemon.json.`,
  flags: { port: "string", daemon: "bool" },
  async run(ctx, a) {
    const port = parsePort(a.flags.port);
    const live = await liveDaemon(ctx.paths.daemon, ctx.fetch);
    if (live) {
      if (a.flags.daemon) return EXIT.ok; // lost a start race: the other one serves
      ctx.err(`Sandflow is already running at ${live.url} (pid ${live.pid}) — "sandflow shutdown" stops it.`);
      return EXIT.failed;
    }
    const { realRunners, startDaemon } = await import("./daemon");
    let stop: () => Promise<void> = async () => {};
    let exiting = false;
    const exit = () => {
      if (exiting) return;
      exiting = true;
      void stop().finally(() => process.exit(0));
    };
    const d = await startDaemon(ctx.paths, { port, runners: await realRunners(), onShutdown: exit });
    stop = d.stop;
    for (const s of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(s, exit);
    ctx.out(`Sandflow ${d.info.version} is listening on ${d.info.url} (data: ${ctx.paths.data}, pid ${process.pid})`);
    return new Promise<number>(() => {}); // runs until shut down
  },
};

const shutdownCmd: Command = {
  help: `sandflow shutdown

Stop the background Sandflow. Running flows pause (sandboxes are closed) and continue when it starts again.`,
  flags: {},
  async run(ctx) {
    const d = readDaemonInfo(ctx.paths.daemon);
    if (!d || !(await liveDaemon(ctx.paths.daemon, ctx.fetch))) {
      ctx.out("Sandflow isn't running.");
      return EXIT.ok;
    }
    await request(ctx, d.url, "POST", "/shutdown", {});
    ctx.err("Pausing runs and stopping…");
    // Pausing waits for running steps (bounded at ~45 s by the server).
    const deadline = Date.now() + 90_000;
    while (pidAlive(d.pid) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 300));
    if (pidAlive(d.pid)) {
      ctx.err(`It's still stopping (pid ${d.pid}).`);
      return EXIT.failed;
    }
    ctx.out("Sandflow stopped.");
    return EXIT.ok;
  },
};

const uiCmd: Command = {
  help: `sandflow ui [--port N]  (or sandflow --ui)

Make sure Sandflow runs (on port N when it has to start) and open its UI in your browser.`,
  flags: { port: "string", ui: "bool" },
  async run(ctx, a) {
    const port = parsePort(a.flags.port);
    const d = await ensureDaemon(ctx, { port });
    if (port && d.port !== port) ctx.err(`(already running on port ${d.port} — "sandflow shutdown" first to change it)`);
    ctx.out(`Sandflow: ${d.url}/`);
    ctx.openBrowser(`${d.url}/`);
    return EXIT.ok;
  },
};

const mcpCmd: Command = {
  help: `sandflow mcp

A stdio MCP server for Claude Code (the same tools as the desktop app's: list_flows, start_run, watch_run, …).
It talks to the background Sandflow, starting it when needed. Register it with:
  claude mcp add --scope user sandflow -- sandflow mcp`,
  flags: {},
  async run(ctx) {
    const { mcpProxy } = await import("./mcp");
    return mcpProxy(ctx);
  },
};

const setupFor = new WeakMap<Ctx, SetupDeps>();
export const setSetupDeps = (ctx: Ctx, d: SetupDeps) => setupFor.set(ctx, d);

const setupCmd: Command = {
  help: `sandflow setup [--no-plugin] [--no-mcp]

Set Sandflow up in Claude Code (what the one-line installers do; run it after "npm i -g sandflow"):
add the sand plugin (/sand:flow, /sand:schedule, /sand:edit) from the sandflow marketplace, and register
"sandflow mcp" as the user-scope sandflow MCP server. Safe to run again (it updates both).`,
  flags: { "no-plugin": "bool", "no-mcp": "bool" },
  async run(ctx, a) {
    const r = setup({ plugin: !a.flags["no-plugin"], mcp: !a.flags["no-mcp"] }, setupFor.get(ctx) ?? realSetupDeps(ctx.env));
    for (const n of r.notes) ctx.out(`- ${n}`);
    if (r.later.length) ctx.out(["", "Run later:", ...r.later.map((l) => `  ${l}`)].join("\n"));
    if (r.ok) ctx.out("\nRestart Claude Code, then ask it: /sand:flow <your task>");
    return r.ok ? EXIT.ok : EXIT.failed;
  },
};

// ---------- schedule / checker ----------

function describeRecord(r: ScheduleRecord): string[] {
  return [r.id, new Date(r.at).toLocaleString(), r.state + (r.runId ? ` (run ${r.runId})` : r.error ? ` (${short(r.error, 40)})` : ""), r.args.join(" ")];
}

const scheduleCmd: Command = {
  help: `sandflow schedule add --at <ISO time|HH:MM> [--repo PATH] -- run <flow> [prompt] [--env NAME=value]...
sandflow schedule list [--json]
sandflow schedule edit <id> --at <time>
sandflow schedule cancel <id>

Run a flow later through the OS scheduler (Windows Task Scheduler for your user; systemd user timers on Linux).
HH:MM means the next time it's that o'clock. Runs start detached; their output goes to
~/.sandflow/schedules/<id>.log, and "sandflow runs" lists them.`,
  flags: { at: "string", repo: "string", json: "bool" },
  async run(ctx, a) {
    const [sub, id] = a.positionals;
    const osd = scheduleOs(ctx);
    if (sub === "add") {
      if (!a.flags.at) throw new UsageError("schedule add needs --at <time>");
      const at = parseAt(String(a.flags.at));
      if (a.rest[0] !== "run" || !a.rest[1]) throw new UsageError("schedule add … -- run <flow> [prompt] [--env NAME=value]...");
      // Checked now, so a typo doesn't surface only when it fires.
      const checked = parseArgs(a.rest.slice(1), runCmd.flags);
      parseEnv(checked.flags.env as string[] | undefined);
      const args = [...a.rest];
      if (a.flags.repo) args.push("--repo", path.resolve(String(a.flags.repo)));
      const rec: ScheduleRecord = { id: newScheduleId(), at: at.toISOString(), state: "scheduled", args, createdAt: new Date().toISOString() };
      await installTrigger(osd, ctx.paths, rec.id, { at }, ["schedule", "fire", rec.id], ctx.env);
      saveRecord(ctx.paths, rec);
      json(ctx, { id: rec.id, at: rec.at, state: rec.state });
      return EXIT.ok;
    }
    if (sub === "list") {
      const recs = listRecords(ctx.paths);
      if (a.flags.json) return json(ctx, recs), EXIT.ok;
      if (!recs.length) return ctx.out("Nothing scheduled."), EXIT.ok;
      for (const l of table([["ID", "AT", "STATE", "COMMAND"], ...recs.map(describeRecord)])) ctx.out(l);
      return EXIT.ok;
    }
    if (sub === "edit" || sub === "cancel" || sub === "fire") {
      if (!id) throw new UsageError(`sandflow schedule ${sub} <id>`);
      const rec = loadRecord(ctx.paths, id);
      if (!rec) throw new UsageError(`No schedule "${id}" — sandflow schedule list shows them`);
      if (sub === "fire") return fireSchedule(ctx, osd, rec);
      if (rec.state !== "scheduled") throw new UsageError(`Schedule ${id} has already ${rec.state === "cancelled" ? "been cancelled" : "fired"}`);
      if (sub === "cancel") {
        await removeTrigger(osd, rec.id);
        saveRecord(ctx.paths, { ...rec, state: "cancelled" });
        json(ctx, { id: rec.id, at: rec.at, state: "cancelled" });
        return EXIT.ok;
      }
      if (!a.flags.at) throw new UsageError("schedule edit needs --at <time>");
      const at = parseAt(String(a.flags.at));
      await installTrigger(osd, ctx.paths, rec.id, { at }, ["schedule", "fire", rec.id], ctx.env);
      saveRecord(ctx.paths, { ...rec, at: at.toISOString() });
      json(ctx, { id: rec.id, at: at.toISOString(), state: rec.state });
      return EXIT.ok;
    }
    throw new UsageError("sandflow schedule add|list|edit|cancel (sandflow schedule --help)");
  },
};

/** What the OS trigger runs: start the run detached, record it, remove the one-shot trigger. */
async function fireSchedule(ctx: Ctx, osd: OsDeps, rec: ScheduleRecord): Promise<number> {
  if (rec.state !== "scheduled") return EXIT.ok; // cancelled / already fired (a late duplicate trigger)
  const lines: string[] = [];
  const sub: Ctx = { ...ctx, out: (s) => lines.push(s), err: (s) => lines.push(s), isTTY: false };
  let code: number;
  try {
    code = await main([...rec.args, "--detach", "--json"], sub);
  } catch (e) {
    lines.push((e as Error).message);
    code = EXIT.failed;
  }
  const text = lines.join("\n");
  let runId: string | undefined;
  try {
    runId = (JSON.parse(text.slice(text.indexOf("{"))) as { runId?: string }).runId;
  } catch {
    /* no JSON: it failed */
  }
  appendLog(ctx.paths, rec.id, `fired: sandflow ${rec.args.join(" ")}\n${text}`);
  saveRecord(ctx.paths, { ...rec, state: runId ? "started" : "failed", firedAt: new Date().toISOString(), ...(runId ? { runId } : { error: short(text, 300) || `exit ${code}` }) });
  await removeTrigger(osd, rec.id).catch(() => {});
  return runId ? EXIT.ok : code || EXIT.failed;
}

const CHECKER = "checker";

const checkerCmd: Command = {
  help: `sandflow checker install|uninstall|status

An hourly OS task (Task Scheduler / systemd user timer) that runs "sandflow resume --paused": runs that paused
(Sandflow was shut down, the computer restarted) continue by themselves. Its output: ~/.sandflow/schedules/checker.log`,
  flags: { json: "bool" },
  async run(ctx, a) {
    const sub = a.positionals[0];
    const osd = scheduleOs(ctx);
    if (sub === "install") {
      await installTrigger(osd, ctx.paths, CHECKER, { hourly: true }, ["resume", "--paused"], ctx.env);
      ctx.out("Installed: every hour, paused runs continue (sandflow resume --paused).");
      return EXIT.ok;
    }
    if (sub === "uninstall") {
      await removeTrigger(osd, CHECKER);
      ctx.out("Removed the hourly checker.");
      return EXIT.ok;
    }
    if (sub === "status") {
      const installed = await triggerInstalled(osd, CHECKER);
      let last: string | undefined;
      try {
        last = fs.readFileSync(logFile(ctx.paths, CHECKER), "utf8").trim().split("\n").pop();
      } catch {
        /* never ran */
      }
      if (a.flags.json) return json(ctx, { installed, last }), EXIT.ok;
      ctx.out(installed ? "The hourly checker is installed." : 'The hourly checker isn\'t installed ("sandflow checker install").');
      if (last) ctx.out(`Last check: ${last}`);
      return EXIT.ok;
    }
    throw new UsageError("sandflow checker install|uninstall|status");
  },
};

/** Tests swap the OS layer through this. */
const osFor = new WeakMap<Ctx, OsDeps>();
export const setScheduleOs = (ctx: Ctx, osd: OsDeps) => osFor.set(ctx, osd);
const scheduleOs = (ctx: Ctx) => osFor.get(ctx) ?? realOs();

// ---------- dispatch ----------

const COMMANDS: Record<string, Command> = {
  flows: flowsCmd,
  run: runCmd,
  runs: runsCmd,
  status: statusCmd,
  resume: resumeCmd,
  "-r": resumeCmd,
  answer: answerCmd,
  stop: stopCmd,
  logs: logsCmd,
  schedule: scheduleCmd,
  checker: checkerCmd,
  serve: serveCmd,
  shutdown: shutdownCmd,
  mcp: mcpCmd,
  setup: setupCmd,
  ui: uiCmd,
  "--ui": uiCmd,
};

export function openBrowser(url: string, platform = process.platform) {
  const [cmd, args] = platform === "win32" ? ["cmd", ["/c", "start", '""', url]] : platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
  try {
    spawn(cmd, args as string[], { detached: true, stdio: "ignore", windowsHide: true, windowsVerbatimArguments: platform === "win32" }).on("error", () => {}).unref();
  } catch {
    /* the URL is printed anyway */
  }
}

export function defaultCtx(env: NodeJS.ProcessEnv = process.env): Ctx {
  const paths = homePaths(sandflowHome(env));
  return {
    paths,
    out: (s) => process.stdout.write(`${s}\n`),
    err: (s) => process.stderr.write(`${s}\n`),
    env,
    isTTY: !!process.stdin.isTTY && !!process.stdout.isTTY,
    stdin: process.stdin,
    fetch: globalThis.fetch,
    spawnDaemon: (port) => spawnDaemonProcess(paths, env, port),
    openBrowser: (url) => openBrowser(url),
    platform: process.platform,
  };
}

/** Run the CLI; resolves with the exit code. */
export async function main(argv: string[], ctx: Ctx = defaultCtx()): Promise<number> {
  // `--home DIR` (what OS tasks pass for a custom SANDFLOW_HOME) must come first.
  if (argv[0] === "--home" && argv[1]) {
    const env = { ...ctx.env, SANDFLOW_HOME: argv[1] };
    process.env.SANDFLOW_HOME = argv[1];
    const paths = homePaths(sandflowHome(env));
    ctx = { ...ctx, env, paths, spawnDaemon: (port) => spawnDaemonProcess(paths, env, port) };
    argv = argv.slice(2);
  }
  const first = argv[0];
  if (!first || first === "--help" || first === "-h" || first === "help") {
    const topic = first === "help" && argv[1] ? COMMANDS[argv[1]] : undefined;
    ctx.out(topic ? topic.help : HELP);
    return EXIT.ok;
  }
  if (first === "--version" || first === "-v") {
    ctx.out(cliVersion());
    return EXIT.ok;
  }
  const cmd = COMMANDS[first];
  if (!cmd) {
    ctx.err(`Unknown command "${first}" — sandflow --help lists them`);
    return EXIT.usage;
  }
  try {
    const parsed = parseArgs(argv.slice(1), { ...cmd.flags, help: "bool" });
    if (parsed.flags.help) {
      ctx.out(cmd.help);
      return EXIT.ok;
    }
    return await cmd.run(ctx, parsed);
  } catch (e) {
    if (e instanceof UsageError) {
      ctx.err(e.message);
      return EXIT.usage;
    }
    ctx.err(e instanceof ApiError || e instanceof ScheduleError ? e.message : `Error: ${(e as Error).message}`);
    return EXIT.failed;
  }
}
