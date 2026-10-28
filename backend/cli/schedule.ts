// `sandflow schedule` / `sandflow checker`: OS triggers that run the CLI later, without a Sandflow window open.
//   Windows: Task Scheduler (`schtasks /Create /XML`, current user, no admin). XML because /SD takes the date in the
//            machine's locale format; StartBoundary is ISO. `conhost --headless` keeps a console from flashing up.
//   Linux:   systemd user timers (`~/.config/systemd/user`, `systemctl --user`).
//   macOS:   not supported yet (said so).
// A one-shot schedule runs `sandflow schedule fire <id>`, which starts the run detached, records it and removes its
// trigger. Records live in ~/.sandflow/schedules/<id>.json, their output in <id>.log.

import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { installedShim, type HomePaths } from "./home";

export interface ScheduleRecord {
  id: string;
  /** ISO time it fires. */
  at: string;
  state: "scheduled" | "started" | "failed" | "cancelled";
  /** The sandflow command it runs (`run <flow> [prompt] [--env K=V]... [--repo PATH]`). */
  args: string[];
  createdAt: string;
  firedAt?: string;
  runId?: string;
  error?: string;
}

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** What touches the OS — replaced in tests so no real task is created. */
export interface OsDeps {
  platform: NodeJS.Platform;
  exec(cmd: string, args: string[]): Promise<ExecResult>;
  writeFile(file: string, data: string | Buffer): void;
  rm(file: string): void;
  /** ~/.config/systemd/user */
  unitDir: string;
}

export function realOs(): OsDeps {
  return {
    platform: process.platform,
    exec: (cmd, args) =>
      new Promise((resolve) =>
        execFile(cmd, args, { windowsHide: true, encoding: "utf8" }, (e, stdout, stderr) =>
          resolve({ code: e ? (typeof e.code === "number" ? e.code : 1) : 0, stdout: String(stdout), stderr: String(stderr || (e && !stdout ? e.message : "")) }),
        ),
      ),
    writeFile: (f, d) => {
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, d);
    },
    rm: (f) => fs.rmSync(f, { force: true }),
    unitDir: path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "systemd", "user"),
  };
}

/**
 * How the OS starts the CLI: the installed shim, else this Node with this script (a dev checkout). A custom
 * SANDFLOW_HOME travels as `--home` (tasks don't get this shell's environment).
 */
export function launcher(paths: HomePaths, env: NodeJS.ProcessEnv = process.env, script = process.argv[1]): { command: string; args: string[] } {
  const home = env.SANDFLOW_HOME?.trim() ? ["--home", paths.home] : [];
  const shim = installedShim(paths);
  if (shim) return { command: shim, args: home };
  return { command: process.execPath, args: [path.resolve(script), ...home] };
}

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Windows command-line quoting (CommandLineToArgvW rules, enough for paths and plain words). */
export function winQuote(a: string): string {
  if (a && !/[\s"]/.test(a)) return a;
  return `"${a.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, "$1$1")}"`;
}

/** Local time as YYYY-MM-DDTHH:MM:SS (no zone: Task Scheduler / systemd read it as local). */
export function localStamp(d: Date, sep = "T"): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}${sep}${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export function windowsTaskXml(o: { start: Date; hourly?: boolean; command: string; args: string[]; description: string }): string {
  const repeat = o.hourly ? "<Repetition><Interval>PT1H</Interval><StopAtDurationEnd>false</StopAtDurationEnd></Repetition>" : "";
  const args = ["--headless", o.command, ...o.args].map(winQuote).join(" ");
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>${xml(o.description)}</Description></RegistrationInfo>
  <Triggers><TimeTrigger>${repeat}<StartBoundary>${localStamp(o.start)}</StartBoundary><Enabled>true</Enabled></TimeTrigger></Triggers>
  <Principals><Principal id="Author"><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <StartWhenAvailable>true</StartWhenAvailable>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Enabled>true</Enabled>
  </Settings>
  <Actions Context="Author"><Exec><Command>conhost.exe</Command><Arguments>${xml(args)}</Arguments></Exec></Actions>
</Task>
`;
}

/** systemd quoting for ExecStart= / Environment= values. */
const sdQuote = (a: string) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `"${a.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`);

export function systemdUnits(o: { onCalendar: string; command: string; args: string[]; description: string; path?: string }) {
  // KillMode=process: the daemon this may start must outlive the oneshot (the default kills the whole cgroup).
  const service = `[Unit]
Description=${o.description}

[Service]
Type=oneshot
KillMode=process
${o.path ? `Environment=${sdQuote(`PATH=${o.path}`)}\n` : ""}ExecStart=${[o.command, ...o.args].map(sdQuote).join(" ")}
`;
  const timer = `[Unit]
Description=${o.description}

[Timer]
OnCalendar=${o.onCalendar}
Persistent=true

[Install]
WantedBy=timers.target
`;
  return { service, timer };
}

export class ScheduleError extends Error {}

const taskName = (name: string, platform: NodeJS.Platform) => (platform === "win32" ? `Sandflow-${name}` : `sandflow-${name}`);

function unsupported(platform: NodeJS.Platform): never {
  throw new ScheduleError(
    platform === "darwin"
      ? "Scheduling isn't supported on macOS yet — run the command from cron or launchd instead"
      : `Scheduling isn't supported on ${platform}`,
  );
}

async function must(osd: OsDeps, cmd: string, args: string[]) {
  const r = await osd.exec(cmd, args);
  if (r.code !== 0) throw new ScheduleError(`${cmd} ${args[0] === "--user" ? args.slice(0, 2).join(" ") : args[0]} failed: ${(r.stderr || r.stdout).trim()}`);
  return r;
}

/** Create (or replace) the OS trigger `name`: once at `at`, or hourly. `cli` is the sandflow command it runs. */
export async function installTrigger(
  osd: OsDeps,
  paths: HomePaths,
  name: string,
  when: { at: Date } | { hourly: true },
  cli: string[],
  env: NodeJS.ProcessEnv = process.env,
) {
  const l = launcher(paths, env);
  const description = "hourly" in when ? "Sandflow: continue paused runs (sandflow checker)" : `Sandflow scheduled run (${name})`;
  const task = taskName(name, osd.platform);
  if (osd.platform === "win32") {
    // A few minutes out, so the first check doesn't land on top of the install.
    const start = "hourly" in when ? new Date(Date.now() + 5 * 60_000) : when.at;
    const file = path.join(paths.schedules, `${task}.xml`);
    osd.writeFile(file, Buffer.from(`﻿${windowsTaskXml({ start, hourly: "hourly" in when, command: l.command, args: [...l.args, ...cli], description })}`, "utf16le"));
    try {
      await must(osd, "schtasks", ["/Create", "/TN", task, "/XML", file, "/F"]);
    } finally {
      osd.rm(file);
    }
    return;
  }
  if (osd.platform === "linux") {
    const units = systemdUnits({
      onCalendar: "hourly" in when ? "hourly" : localStamp(when.at, " "),
      command: l.command,
      args: [...l.args, ...cli],
      description,
      // A user service gets a minimal PATH; git / docker / the agent CLIs are found with this shell's.
      path: env.PATH,
    });
    osd.writeFile(path.join(osd.unitDir, `${task}.service`), units.service);
    osd.writeFile(path.join(osd.unitDir, `${task}.timer`), units.timer);
    await must(osd, "systemctl", ["--user", "daemon-reload"]);
    await must(osd, "systemctl", ["--user", "enable", "--now", `${task}.timer`]);
    return;
  }
  unsupported(osd.platform);
}

export async function removeTrigger(osd: OsDeps, name: string) {
  const task = taskName(name, osd.platform);
  if (osd.platform === "win32") {
    await osd.exec("schtasks", ["/Delete", "/TN", task, "/F"]);
    return;
  }
  if (osd.platform === "linux") {
    await osd.exec("systemctl", ["--user", "disable", "--now", `${task}.timer`]);
    osd.rm(path.join(osd.unitDir, `${task}.service`));
    osd.rm(path.join(osd.unitDir, `${task}.timer`));
    await osd.exec("systemctl", ["--user", "daemon-reload"]);
    return;
  }
  unsupported(osd.platform);
}

export async function triggerInstalled(osd: OsDeps, name: string): Promise<boolean> {
  const task = taskName(name, osd.platform);
  if (osd.platform === "win32") return (await osd.exec("schtasks", ["/Query", "/TN", task])).code === 0;
  if (osd.platform === "linux") return (await osd.exec("systemctl", ["--user", "is-enabled", `${task}.timer`])).code === 0;
  unsupported(osd.platform);
}

// ---------- records ----------

const recordFile = (paths: HomePaths, id: string) => path.join(paths.schedules, `${id}.json`);
export const logFile = (paths: HomePaths, id: string) => path.join(paths.schedules, `${id}.log`);

export const newScheduleId = () => randomBytes(4).toString("hex");

export function saveRecord(paths: HomePaths, r: ScheduleRecord) {
  fs.mkdirSync(paths.schedules, { recursive: true });
  fs.writeFileSync(recordFile(paths, r.id), `${JSON.stringify(r, null, 2)}\n`);
}

export function loadRecord(paths: HomePaths, id: string): ScheduleRecord | undefined {
  if (!/^[\w-]+$/.test(id)) return undefined;
  try {
    return JSON.parse(fs.readFileSync(recordFile(paths, id), "utf8")) as ScheduleRecord;
  } catch {
    return undefined;
  }
}

export function listRecords(paths: HomePaths): ScheduleRecord[] {
  let names: string[] = [];
  try {
    names = fs.readdirSync(paths.schedules).filter((f) => f.endsWith(".json"));
  } catch {
    /* none yet */
  }
  return names
    .map((f) => loadRecord(paths, f.slice(0, -5)))
    .filter((r): r is ScheduleRecord => !!r && typeof r.at === "string")
    .sort((a, b) => a.at.localeCompare(b.at));
}

export function appendLog(paths: HomePaths, id: string, line: string) {
  fs.mkdirSync(paths.schedules, { recursive: true });
  fs.appendFileSync(logFile(paths, id), `${new Date().toISOString()} ${line}\n`);
}
