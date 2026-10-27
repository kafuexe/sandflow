import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { acquireRunLock, cleanupLeftovers, flowFingerprint, OWN_START, readLock, redactJournal, releaseRunLock, secretValues } from "../backend/journal";
import { createStorage, writeAtomic } from "../backend/storage";
import { JOURNAL_SCHEMA, activeNodeKeys, journalProblem, statusOfPhase } from "../shared/journal";
import type { BlockDef, Flow, RunState } from "../shared/types";

const dirs: string[] = [];
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "sandflow-journal-"));
  dirs.push(d);
  return d;
};
afterEach(() => dirs.splice(0).forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

const ID = "2026-10-27T10-00-00-000Z-abcdef12";
export const journal = (o: Partial<RunState> = {}): RunState => ({
  id: ID,
  flowId: "f",
  flowName: "F",
  status: "running",
  startedAt: 1,
  nodes: { a: { status: "done", executions: 1, outputs: { artifact: "x" } } },
  logs: [],
  schemaVersion: JOURNAL_SCHEMA,
  phase: "running",
  transitions: [{ phase: "running", at: 1, attempt: 1 }],
  attempt: 1,
  ...o,
});

describe("journal: atomic, durable writes", () => {
  it("writes the whole file and leaves no temp files behind", () => {
    const d = tmp();
    const f = path.join(d, "x", "a.json");
    writeAtomic(f, "one");
    writeAtomic(f, "two");
    expect(fs.readFileSync(f, "utf8")).toBe("two");
    expect(fs.readdirSync(path.dirname(f))).toEqual(["a.json"]);
  });
});

describe("journal: strict load (fail closed)", () => {
  it("accepts a valid journal and reads an old run as legacy", () => {
    const s = createStorage(tmp());
    s.saveRun(journal());
    expect(s.loadJournal(ID)).toMatchObject({ run: { id: ID, phase: "running" } });
    expect(s.loadJournal(ID).problem).toBeUndefined();
    const old = { ...journal(), schemaVersion: undefined, phase: undefined };
    s.saveRun(old);
    expect(s.loadJournal(ID)).toMatchObject({ legacy: true });
  });

  it("a corrupt journal is never loaded, is left byte-for-byte as it was, and is listed flagged with its path", () => {
    const d = tmp();
    const s = createStorage(d);
    const f = path.join(d, "runs", `${ID}.json`);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, '{"schemaVersion":1,"id":"');
    const got = s.loadJournal(ID);
    expect(got.run).toBeUndefined();
    expect(got.problem).toMatch(/unreadable/);
    expect(fs.readFileSync(f, "utf8")).toBe('{"schemaVersion":1,"id":"');
    const row = s.listRuns().find((r) => r.id === ID);
    expect(row).toMatchObject({ status: "failed", hold: { reason: "corrupt" } });
    expect(row?.hold?.problems[0]).toContain(f);
  });

  it("refuses wrong schema versions, mismatched ids, unknown phases and broken nodes or queues", () => {
    expect(journalProblem(journal())).toBeUndefined();
    expect(journalProblem({ ...journal(), schemaVersion: 99 })).toMatch(/schema/);
    expect(journalProblem(journal(), "other-id")).toMatch(/id/);
    expect(journalProblem({ ...journal(), phase: "dancing" })).toMatch(/phase/);
    expect(journalProblem({ ...journal(), nodes: { a: { status: "x", executions: 1 } } })).toMatch(/"a"/);
    expect(journalProblem({ ...journal(), queues: { "": [{ nodeId: 3, inputs: {} }] } })).toMatch(/queues/);
    expect(journalProblem({ ...journal(), attempt: 0 })).toMatch(/attempt/);
  });

  it("status is derived from the phase", () => {
    expect(statusOfPhase("interrupted")).toBe("paused");
    expect(statusOfPhase("paused")).toBe("paused");
    expect(statusOfPhase("continuing")).toBe("running");
    expect(statusOfPhase("pausing", "waiting")).toBe("waiting");
    expect(statusOfPhase("cancelled")).toBe("cancelled");
  });

  it("active nodes: started and not finished, or marked interrupted", () => {
    const r = journal({
      nodes: {
        a: { status: "done", executions: 1, startedAt: 1, finishedAt: 2 },
        b: { status: "running", executions: 1, startedAt: 3 },
        c: { status: "idle", executions: 1, startedAt: 3, interrupted: "plain" },
        d: { status: "queued", executions: 0 },
      },
    });
    expect(activeNodeKeys(r)).toEqual(["b", "c"]);
  });
});

describe("journal: redaction", () => {
  it("secret-named env values never reach the file; long outputs are capped", () => {
    const d = tmp();
    fs.writeFileSync(path.join(d, "env.json"), JSON.stringify({ GITHUB_TOKEN: "ghp_supersecret123", REPO_PATH: "/repo/path" }));
    const s = createStorage(d);
    const long = "y".repeat(300 * 1024);
    s.saveRun(journal({ prompt: "work in /repo/path", nodes: { a: { status: "done", executions: 1, outputs: { artifact: `token is ghp_supersecret123`, steer: long } } } }));
    const text = fs.readFileSync(path.join(d, "runs", `${ID}.json`), "utf8");
    expect(text).not.toContain("ghp_supersecret123");
    expect(text).toContain("[redacted]");
    expect(text).toContain("/repo/path"); // not secret-named
    const saved = JSON.parse(text) as RunState;
    expect(saved.nodes.a.outputs!.steer!.length).toBeLessThan(long.length);
    expect(saved.nodes.a.outputs!.steer).toMatch(/cut in the journal/);
  });

  it("short values and non-secret names are left alone", () => {
    expect(secretValues({ API_KEY: "1", PASSWORD: "hunter22", BRANCH: "feature-x" })).toEqual(["hunter22"]);
    const r = redactJournal(journal({ prompt: 'say "hunter22"' }), ["hunter22"]);
    expect(r.prompt).toBe('say "[redacted]"');
  });
});

describe("journal: flow fingerprint", () => {
  const blocks: BlockDef[] = [
    { id: "root", name: "Root", isTemplate: true, config: { kind: "ai", instructions: "be good" } },
    { id: "mid", name: "Mid", isTemplate: true, extends: "root", config: {} },
    { id: "leaf", name: "Leaf", isTemplate: false, extends: "mid", config: {} },
    { id: "sub", name: "Sub", isTemplate: false, config: { kind: "subflow" } },
  ];
  const inner: Flow = { id: "inner", name: "Inner", nodes: [{ id: "x", type: "block", position: { x: 0, y: 0 }, data: { blockId: "leaf" } }], edges: [] };
  const outer: Flow = {
    id: "outer",
    name: "Outer",
    nodes: [{ id: "s", type: "block", position: { x: 0, y: 0 }, data: { blockId: "sub", overrides: { subflow: { flowId: "inner" } } } }],
    edges: [],
  };

  it("changes when a block anywhere in a template chain changes, even inside a subflow", () => {
    const fp = flowFingerprint(outer, [outer, inner], blocks);
    const edited = blocks.map((b) => (b.id === "root" ? { ...b, config: { ...b.config, instructions: "be bad" } } : b));
    expect(flowFingerprint(outer, [outer, inner], edited)).not.toBe(fp);
  });

  it("ignores layout, names and the flow's own switches", () => {
    const fp = flowFingerprint(outer, [outer, inner], blocks);
    const moved = { ...outer, name: "Renamed", continueAutomatically: false, nodes: outer.nodes.map((n) => ({ ...n, position: { x: 9, y: 9 } })) };
    expect(flowFingerprint(moved, [moved, inner], blocks)).toBe(fp);
  });
});

describe("journal: one driver per run", () => {
  it("a second owner is refused; the lock is released by its owner only", () => {
    const d = tmp();
    expect(acquireRunLock(d, ID)).toEqual({ ok: true });
    const again = acquireRunLock(d, ID);
    expect(again.ok).toBe(false);
    expect(readLock(d, ID)).toMatchObject({ pid: process.pid, startedAt: OWN_START });
    releaseRunLock(d, ID);
    expect(readLock(d, ID)).toBeUndefined();
  });

  it("a dead owner (pid gone, or the pid now belongs to another process) is reclaimed", () => {
    const d = tmp();
    fs.writeFileSync(path.join(d, `${ID}.lock`), JSON.stringify({ pid: 2 ** 22 + 12345, startedAt: 1, host: os.hostname(), at: 1 }));
    expect(acquireRunLock(d, ID)).toEqual({ ok: true });
    fs.writeFileSync(path.join(d, `${ID}.lock`), JSON.stringify({ pid: process.pid, startedAt: OWN_START - 3_600_000, host: os.hostname(), at: 1 }));
    expect(acquireRunLock(d, ID)).toEqual({ ok: true });
    expect(readLock(d, ID)?.startedAt).toBe(OWN_START);
  });
});

describe("journal: leftovers", () => {
  it("removes a recorded container only when it still exists with that id; never kills an unmatched process", async () => {
    const calls: string[][] = [];
    const exec = async (cmd: string, args: string[]) => {
      calls.push([cmd, ...args]);
      if (args[0] === "inspect") return args[3] === "aaaaaaaaaaaa" ? { code: 0, stdout: "aaaaaaaaaaaa1234\n", stderr: "" } : { code: 1, stdout: "", stderr: "no such" };
      return { code: 0, stdout: "", stderr: "" };
    };
    const killed: number[] = [];
    const done = await cleanupLeftovers(
      {
        sandboxes: [{ kind: "docker", containerId: "aaaaaaaaaaaa" }, { kind: "docker", containerId: "bbbbbbbbbbbb" }],
        processes: [{ pid: 2 ** 22 + 777, startedAt: 1 }, { pid: process.pid, startedAt: OWN_START }],
      },
      exec,
      (p) => killed.push(p),
    );
    expect(done).toEqual(["container aaaaaaaaaaaa"]);
    expect(calls.filter((c) => c[1] === "rm")).toEqual([["docker", "rm", "-f", "aaaaaaaaaaaa"]]);
    expect(killed).toEqual([]);
  });
});
