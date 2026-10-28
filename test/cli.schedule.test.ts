import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import type { Ctx } from "../backend/cli/client";
import { homePaths } from "../backend/cli/home";
import { main, setScheduleOs } from "../backend/cli/main";
import { installTrigger, launcher, listRecords, removeTrigger, systemdUnits, triggerInstalled, windowsTaskXml, winQuote, type OsDeps } from "../backend/cli/schedule";

const dirs: string[] = [];
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "sandflow-sched-"));
  dirs.push(d);
  return d;
};
afterEach(() => dirs.splice(0).forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

/** Records every OS call instead of making it. */
function fakeOs(platform: NodeJS.Platform, codes: Record<string, number> = {}) {
  const calls: string[][] = [];
  const files = new Map<string, string | Buffer>();
  const osd: OsDeps = {
    platform,
    exec: async (cmd, args) => {
      calls.push([cmd, ...args]);
      return { code: codes[args[0] === "--user" ? args[1] : args[0]] ?? 0, stdout: "", stderr: "" };
    },
    writeFile: (f, d) => void files.set(f, d),
    rm: (f) => void files.delete(f),
    unitDir: "/home/u/.config/systemd/user",
  };
  return { osd, calls, files };
}

describe("OS triggers", () => {
  it("Windows: a one-shot task from XML (ISO start, no locale dates), through conhost --headless", async () => {
    const p = homePaths(tmp());
    const { osd, calls, files } = fakeOs("win32");
    const written: string[] = [];
    osd.writeFile = (f, d) => {
      written.push(Buffer.from(d as Buffer).toString("utf16le"));
      files.set(f, d);
    };
    const at = new Date(2026, 10, 2, 9, 30, 0);
    await installTrigger(osd, p, "ab12cd34", { at }, ["schedule", "fire", "ab12cd34"], {});
    expect(calls).toEqual([["schtasks", "/Create", "/TN", "Sandflow-ab12cd34", "/XML", path.join(p.schedules, "Sandflow-ab12cd34.xml"), "/F"]]);
    expect(files.size).toBe(0); // the XML is removed after
    const xml = written[0];
    expect(xml.charCodeAt(0)).toBe(0xfeff);
    expect(xml).toContain("<StartBoundary>2026-11-02T09:30:00</StartBoundary>");
    expect(xml).not.toContain("<Repetition>");
    expect(xml).toContain("<Command>conhost.exe</Command>");
    expect(xml).toMatch(/<Arguments>--headless .* schedule fire ab12cd34<\/Arguments>/);
    expect(xml).toContain("<LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel>");

    await removeTrigger(osd, "ab12cd34");
    expect(calls[1]).toEqual(["schtasks", "/Delete", "/TN", "Sandflow-ab12cd34", "/F"]);
    expect(await triggerInstalled(osd, "checker")).toBe(true);
    expect(calls[2]).toEqual(["schtasks", "/Query", "/TN", "Sandflow-checker"]);
  });

  it("Windows: the hourly checker repeats every hour; quoting survives spaces and quotes", () => {
    const xml = windowsTaskXml({ start: new Date(2026, 0, 1, 0, 0, 0), hourly: true, command: "C:\\Users\\A B\\.sandflow\\bin\\sandflow.cmd", args: ["resume", "--paused"], description: "x & y" });
    expect(xml).toContain("<Interval>PT1H</Interval>");
    expect(xml).toContain("<Description>x &amp; y</Description>");
    expect(xml).toContain("<Arguments>--headless &quot;C:\\Users\\A B\\.sandflow\\bin\\sandflow.cmd&quot; resume --paused</Arguments>");
    expect(winQuote('say "hi"')).toBe('"say \\"hi\\""');
    expect(winQuote("C:\\dir with space\\")).toBe('"C:\\dir with space\\\\"');
  });

  it("Linux: systemd user service + timer, daemon-reload, enable --now; KillMode=process keeps the daemon alive", async () => {
    const p = homePaths(tmp());
    const { osd, calls, files } = fakeOs("linux");
    await installTrigger(osd, p, "ab12cd34", { at: new Date(2026, 10, 2, 9, 30, 0) }, ["schedule", "fire", "ab12cd34"], { PATH: "/usr/bin:/home/u/.local/bin" });
    expect(calls).toEqual([
      ["systemctl", "--user", "daemon-reload"],
      ["systemctl", "--user", "enable", "--now", "sandflow-ab12cd34.timer"],
    ]);
    const service = String(files.get(path.join("/home/u/.config/systemd/user", "sandflow-ab12cd34.service")));
    const timer = String(files.get(path.join("/home/u/.config/systemd/user", "sandflow-ab12cd34.timer")));
    expect(service).toContain("Type=oneshot");
    expect(service).toContain("KillMode=process");
    expect(service).toContain("Environment=PATH=/usr/bin:/home/u/.local/bin");
    expect(service).toMatch(/ExecStart=.+ schedule fire ab12cd34\n/);
    expect(timer).toContain("OnCalendar=2026-11-02 09:30:00");
    expect(timer).toContain("Persistent=true");

    await removeTrigger(osd, "ab12cd34");
    expect(calls.slice(2)).toEqual([
      ["systemctl", "--user", "disable", "--now", "sandflow-ab12cd34.timer"],
      ["systemctl", "--user", "daemon-reload"],
    ]);
    expect(files.size).toBe(0);
    expect(systemdUnits({ onCalendar: "hourly", command: "/x/sandflow", args: ["resume", "--paused"], description: "d" }).timer).toContain("OnCalendar=hourly");
  });

  it("a failing scheduler call is an error; macOS says it isn't supported", async () => {
    const p = homePaths(tmp());
    await expect(installTrigger(fakeOs("win32", { "/Create": 1 }).osd, p, "x", { hourly: true }, ["resume", "--paused"])).rejects.toThrow(/schtasks \/Create failed/);
    await expect(installTrigger(fakeOs("darwin").osd, p, "x", { hourly: true }, ["resume", "--paused"])).rejects.toThrow(/macOS/);
  });

  it("runs the installed shim when there is one, else this node + script; a custom home travels as --home", () => {
    const p = homePaths(tmp());
    expect(launcher(p, {}, "/x/sandflow.mjs")).toEqual({ command: process.execPath, args: [path.resolve("/x/sandflow.mjs")] });
    fs.mkdirSync(p.bin, { recursive: true });
    const shim = path.join(p.bin, process.platform === "win32" ? "sandflow.cmd" : "sandflow");
    fs.writeFileSync(shim, "");
    expect(launcher(p, { SANDFLOW_HOME: p.home }, "/x/sandflow.mjs")).toEqual({ command: shim, args: ["--home", p.home] });
  });
});

function ctxFor(home: string, platform: NodeJS.Platform) {
  const out: string[] = [];
  const err: string[] = [];
  const ctx: Ctx = {
    paths: homePaths(home),
    out: (s) => out.push(s),
    err: (s) => err.push(s),
    env: {},
    isTTY: false,
    stdin: new PassThrough(),
    fetch,
    spawnDaemon: () => {
      throw new Error("no daemon in this test");
    },
    openBrowser: () => {},
    platform,
  };
  const fake = fakeOs(platform);
  setScheduleOs(ctx, fake.osd);
  return { ctx, out, err, calls: fake.calls };
}

describe("sandflow schedule / checker", () => {
  it("add → record + trigger; edit re-creates it; cancel removes it", async () => {
    const home = tmp();
    const { ctx, out, calls } = ctxFor(home, "linux");
    const at = new Date(Date.now() + 3600_000).toISOString();
    expect(await main(["schedule", "add", "--at", at, "--repo", home, "--", "run", "my-flow", "do it", "--env", "A=1"], ctx)).toBe(0);
    const added = JSON.parse(out.join("\n"));
    expect(added).toEqual({ id: expect.stringMatching(/^[0-9a-f]{8}$/), at: new Date(at).toISOString(), state: "scheduled" });
    const [rec] = listRecords(ctx.paths);
    expect(rec.args).toEqual(["run", "my-flow", "do it", "--env", "A=1", "--repo", path.resolve(home)]);
    expect(calls.at(-1)).toEqual(["systemctl", "--user", "enable", "--now", `sandflow-${added.id}.timer`]);

    out.length = 0;
    const later = new Date(Date.now() + 7200_000).toISOString();
    expect(await main(["schedule", "edit", added.id, "--at", later], ctx)).toBe(0);
    expect(listRecords(ctx.paths)[0].at).toBe(later);
    out.length = 0;
    expect(await main(["schedule", "list", "--json"], ctx)).toBe(0);
    expect(JSON.parse(out.join("\n"))[0]).toMatchObject({ id: added.id, state: "scheduled" });
    expect(await main(["schedule", "cancel", added.id], ctx)).toBe(0);
    expect(listRecords(ctx.paths)[0].state).toBe("cancelled");
    expect(calls.some((c) => c.includes("disable"))).toBe(true);
    expect(await main(["schedule", "cancel", added.id], ctx)).toBe(2);
  });

  it("refuses bad schedules with usage errors", async () => {
    const { ctx, err } = ctxFor(tmp(), "win32");
    expect(await main(["schedule", "add", "--", "run", "f"], ctx)).toBe(2);
    expect(await main(["schedule", "add", "--at", "12:00", "--", "flows"], ctx)).toBe(2);
    expect(await main(["schedule", "add", "--at", "12:00", "--", "run", "f", "--bogus"], ctx)).toBe(2);
    expect(await main(["schedule", "edit", "nope", "--at", "12:00"], ctx)).toBe(2);
    expect(err.join("\n")).toMatch(/--at/);
  });

  it("checker install / status / uninstall drive the hourly task", async () => {
    const { ctx, out, calls } = ctxFor(tmp(), "win32");
    expect(await main(["checker", "install"], ctx)).toBe(0);
    expect(calls[0].slice(0, 3)).toEqual(["schtasks", "/Create", "/TN"]);
    expect(calls[0][3]).toBe("Sandflow-checker");
    expect(await main(["checker", "status"], ctx)).toBe(0);
    expect(out.join("\n")).toMatch(/is installed/);
    expect(await main(["checker", "uninstall"], ctx)).toBe(0);
    expect(calls.at(-1)).toEqual(["schtasks", "/Delete", "/TN", "Sandflow-checker", "/F"]);
    expect(await main(["checker", "nope"], ctx)).toBe(2);
  });
});
