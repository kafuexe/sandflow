// /api/* request handler, mounted inside the Vite dev/preview server (see vite.config.ts) — no separate server.

import type { IncomingMessage, ServerResponse } from "node:http";
import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { CORE_BLOCKS } from "../shared/core";
import { eventMarkdown } from "../shared/events";
import { ENV_NAME_RE, resolveNode } from "../shared/resolve";
import { validateSettings } from "../shared/settings";
import { sanitizeFlowColor } from "../shared/flows";
import { subflowCycle } from "../shared/subflow";
import { missingInputs, validateBlocks } from "../shared/validate";
import { planResume, type ResumePlan } from "../shared/resume";
import { MAX_CONTINUES, PAUSE_REASON_TEXT, TERMINAL_PHASES, isPaused, isSettled } from "../shared/journal";
import type { PauseReason, RunHold } from "../shared/types";
import type { AppData, AssistantAgent, BlockDef, Chat, DataChange, EnvValues, Flow, IntegrationDef, PackManifest, RunFlag, RunState, Settings, TriggerEvent } from "../shared/types";
import { createChatService, type AssistantRunner } from "./chats";
import { branchConflictWarning, sharedBranchKey, type ActiveRunInfo } from "../shared/runConflicts";
import { startRun, type NodeRunner, type RunHandle, type RunIntegrations, type RunPacks } from "./engine";
import { buildPack, writePackFolder, zipFiles } from "./packs";
import { createMcp } from "./mcp";
import { checkContinue, markCrashed, repairRun, runBranch } from "./continue";
import { acquireRunLock, cleanupLeftovers, readLock, releaseRunLock } from "./journal";
import { killPidTree } from "./proc";
import {
  ensureSandboxReady,
  execCli,
  importSandboxImage,
  loadBundledSandboxImage,
  sandboxImageStatus,
  setBundledSandboxImage,
  type Exec,
} from "./sandbox";
import { createSkillStore, type SkillFile } from "./skills";
import { applyPackEdits, dismissFlag, limitRuns, settleInterrupted, summarize, type Storage } from "./storage";
import { createTriggerService, type FireOutcome } from "./triggers";
import { startWebhookServer, type WebhookServer } from "./webhooks";

type Next = (err?: unknown) => void;
type Handler = (req: IncomingMessage, res: ServerResponse, next: Next) => void;

class HttpError extends Error {
  constructor(public status: number, message: string, public extra?: object) {
    super(message);
  }
}

const MAX_BODY = 5 * 1024 * 1024;

const execFileP = promisify(execFile);

/** Whether `branch` exists in the git checkout at `repo` (false too when `repo` isn't one). */
async function branchExists(repo: string, branch: string): Promise<boolean> {
  try {
    await execFileP("git", ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], { cwd: repo, windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

/** Zips of packs come in as base64 JSON. */
const MAX_PACK_BODY = 300 * 1024 * 1024;

async function readJson<T>(req: IncomingMessage, max = MAX_BODY): Promise<T> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > max) throw new HttpError(413, "Body too large");
    chunks.push(c as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "null") as T;
  } catch {
    throw new HttpError(400, "Invalid JSON");
  }
}

function send(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(body));
}

export type Api = Handler & {
  /** Pause every active run (quit / update) — they continue when Sandflow starts again — and stop the services. */
  shutdown(timeoutMs?: number, reason?: Exclude<PauseReason, "crash">): Promise<void>;
  /** The continue pass run at start (interrupted runs are found, checked and continued): settles once it's done. */
  ready: Promise<void>;
};

export interface ApiOptions {
  bundledSkillsDir?: string;
  exec?: Exec;
  assistant?: AssistantRunner;
  /** Try to pull the base pack from GitHub at start while the installed one is the copy shipped with the app. */
  fetchBasePack?: boolean;
  /** The sandbox image bundle shipped with the app; loaded automatically while the default image is missing. */
  bundledSandboxImage?: string;
  /** Don't look for interrupted runs to continue at start (default: do). */
  noContinuePass?: boolean;
  /** How long running steps get to finish when runs pause (default 5 s). */
  pauseGraceMs?: number;
}

export function createApi(
  storage: Storage,
  runners: { auto: NodeRunner; ai: NodeRunner; script?: NodeRunner; integration?: NodeRunner },
  opts: ApiOptions = {},
): Api {
  const skills = createSkillStore(storage.dir, opts.bundledSkillsDir, storage.packs);
  const runPacks: RunPacks = {
    runtime: (id) => storage.packs.runtime(id),
    dirs: () => storage.packs.dirs(),
    runtimeRoot: path.join(storage.dir, "packs-runtime"),
  };
  const runIntegrations: RunIntegrations = { get: (id) => storage.integrations.get(id) };
  const exec = opts.exec ?? execCli;
  setBundledSandboxImage(opts.bundledSandboxImage);
  if (opts.bundledSandboxImage) {
    // First start after an install / update: load the shipped image in the background so the first run
    // doesn't wait for it. Quietly skipped when Docker / Podman isn't running yet — runs retry it.
    void ensureSandboxReady(storage.load().settings, exec).catch(() => {});
  }
  const runs = new Map<string, RunHandle>();
  const listeners = new Map<string, Set<(s: RunState) => void>>();

  // ---------- data revisions (UI ↔ assistant edits) ----------

  /** Bumped on every flows/blocks write. The UI sends the rev it last saw; a stale write gets 409. */
  let rev = 0;
  const dataListeners = new Set<(c: DataChange) => void>();
  function changed(c: Omit<DataChange, "rev">) {
    rev++;
    dataListeners.forEach((fn) => fn({ rev, ...c }));
  }
  /** Flag events go out on the same stream as data changes, so every view hears about them. */
  const flagListeners = new Set<(event: "flag" | "flag-dismissed", data: object) => void>();
  function announceFlag(run: RunState, flag: RunFlag) {
    const runTitle = run.trigger?.title || run.prompt?.split("\n")[0]?.slice(0, 80) || run.flowName;
    flagListeners.forEach((fn) => fn("flag", { runId: run.id, runTitle, flowName: run.flowName, flag }));
  }
  function checkRev(url: URL) {
    const seen = url.searchParams.get("rev");
    if (seen !== null && Number(seen) !== rev) {
      throw new HttpError(409, "The flow was changed by the assistant since you last loaded it", { rev });
    }
  }

  const mcp = createMcp({
    load: storage.load,
    saveFlows(flows, c) {
      storage.saveFlows(flows);
      syncTriggers();
      changed({ source: "assistant", ...c });
    },
    saveBlocks(blocks) {
      storage.saveBlocks(blocks);
      syncTriggers();
      changed({ source: "assistant" });
    },
  });
  const chats = createChatService({ dir: storage.dir, load: storage.load, mcp, runner: opts.assistant });

  /** Where agents reach the MCP server — derived from the Host we're being called on (random port in the desktop app). */
  let mcpUrl = "";
  function noteHost(host: string | undefined) {
    if (!host || !/^[\w.-]+:\d+$|^[\w.-]+$/.test(host)) return;
    const url = `http://${host}/api/mcp`;
    if (url === mcpUrl) return;
    mcpUrl = url;
    try {
      fs.writeFileSync(path.join(storage.dir, "mcp.json"), JSON.stringify({ mcpServers: { sandflow: { type: "http", url } } }, null, 2));
    } catch {
      /* informational only */
    }
  }

  /** Saves of live runs are throttled per run; a finished run is always saved. */
  const lastSave = new Map<string, number>();
  const runsDir = path.join(storage.dir, "runs");
  /** Top-level runs this Sandflow drives — it holds their `runs/<id>.lock` (one driver per run, MEOW DriverLock). */
  const locked = new Set<string>();
  const unlock = (id: string) => {
    if (!locked.delete(id)) return;
    try {
      releaseRunLock(runsDir, id);
    } catch {
      /* a stale lock is reclaimed next time */
    }
  };
  /** A journal that's been written immediately (node start / finish, phases, sessions): the throttle starts over. */
  const saveJournal = (s: RunState) => {
    lastSave.set(s.id, Date.now());
    storage.saveRun(s);
  };
  /** Runs still going, with the branch they share (if any) — for the concurrency warning. */
  const branchKeys = new Map<string, string>();
  function activeRuns(): ActiveRunInfo[] {
    return [...runs.values()]
      .filter((h) => !isSettled(h.state))
      .map((h) => ({ id: h.state.id, flowName: h.state.flowName, startedAt: h.state.startedAt, branchKey: branchKeys.get(h.state.id) }));
  }

  function track(handle: RunHandle) {
    runs.set(handle.state.id, handle);
    void handle.done.then((s) => {
      branchKeys.delete(s.id);
      storage.saveRun(s);
      lastSave.delete(s.id);
      // Paused or finished: nothing here drives it any more.
      unlock(s.id);
      setTimeout(() => runs.get(s.id) === handle && runs.delete(s.id), 10 * 60_000).unref?.();
      if (!s.parent && !shuttingDown) drainQueue(s.flowId);
    });
  }

  /** Start a run (manual, or fired by a trigger node). */
  function launch(
    flow: Flow,
    data: AppData,
    extra: { trigger?: TriggerEvent; startNodeId?: string; prompt?: string; branch?: string; resume?: { from: RunState; plan: ResumePlan }; continueFrom?: RunState } = {},
    notes: string[] = [],
  ): RunHandle & { warning?: string } {
    // Runs are independent (own context, sandbox, branch and logs), so any number may run at once — the one thing
    // they can share is an explicit BRANCH_NAME in the same REPO_PATH (or, resuming, the original run's branch).
    // Say so instead of refusing the run.
    const branchEnv = extra.branch ? { ...data.env, BRANCH_NAME: extra.branch } : data.env;
    const branchKey = sharedBranchKey(branchEnv);
    const conflict = branchConflictWarning(branchEnv, activeRuns());
    const warnings = [...notes, ...(conflict ? [conflict] : [])];
    const warning = warnings.length ? warnings.join("\n\n") : undefined;
    const handle = startRun({
      flow,
      blocks: data.blocks,
      env: data.env,
      settings: data.settings,
      flows: data.flows,
      runners,
      logRoot: path.join(storage.dir, "runs"),
      saveArtifact: storage.saveArtifact,
      loadSkill: skills.read,
      packs: runPacks,
      integrations: runIntegrations,
      ...extra,
      onFlag: announceFlag,
      // Stack children are runs of their own: answerable, cancellable and streamed like any other.
      onSpawn: track,
      warnings: warnings.length ? warnings : undefined,
      onJournal: saveJournal,
      loadRun: (id) => storage.loadJournal(id).run,
      ...(opts.pauseGraceMs !== undefined ? { pauseGraceMs: opts.pauseGraceMs } : {}),
      onChange: (s) => {
        listeners.get(s.id)?.forEach((fn) => fn(s));
        if (s.finishedAt || Date.now() - (lastSave.get(s.id) ?? 0) > 2000) {
          lastSave.set(s.id, Date.now());
          storage.saveRun(s);
        }
      },
    });
    track(handle);
    if (branchKey) branchKeys.set(handle.state.id, branchKey);
    const id = handle.state.id;
    if (!locked.has(id)) {
      try {
        if (acquireRunLock(runsDir, id).ok) locked.add(id);
      } catch (e) {
        console.warn(`[runs] couldn't take the lock of run ${id}: ${(e as Error).message}`);
      }
    }
    if (!extra.continueFrom) stampCommit(handle.state);
    return Object.assign(handle, { warning });
  }

  /**
   * The workspace fingerprint's commit: where the run's branch (or, before it exists, the base) is as the run starts.
   * Synchronous on purpose: it's read before any step of the run could commit.
   */
  function stampCommit(run: RunState) {
    const repo = run.workspace?.repo;
    const fp = run.fingerprints?.workspace;
    if (!repo || !fp || fp.commit || !fs.existsSync(repo)) return;
    const at = (ref: string) => {
      try {
        return execFileSync("git", ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], { cwd: repo, windowsHide: true, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 10_000 }).trim();
      } catch {
        return undefined;
      }
    };
    const commit = at(`refs/heads/${fp.branch}`) ?? at(storage.load().env.BASE_BRANCH?.trim() || "HEAD");
    if (commit) fp.commit = commit;
  }

  // ---------- triggers ----------

  /** Triggered runs waiting because their flow is busy (overlap: queue). */
  const queues = new Map<string, { nodeId: string; event: TriggerEvent }[]>();
  const MAX_QUEUE = 50;
  const flowBusy = (flowId: string) => [...runs.values()].some((h) => h.state.flowId === flowId && !h.state.parent && !isSettled(h.state));

  function startTriggered(flowId: string, nodeId: string, event: TriggerEvent): FireOutcome {
    const data = storage.load();
    const flow = data.flows.find((f) => f.id === flowId);
    if (!flow) return { status: "skipped", reason: "flow was deleted" };
    if (!flow.active) return { status: "skipped", reason: "flow is not active" };
    // The event is what a triggered run works on, so no starting prompt is needed; without one, the event summary
    // stands in for it (agents and Create task that read the starting prompt get the event).
    const missing = missingInputs(flow, data.blocks, data.env, data.settings.startingPrompt, data.flows, { triggered: true });
    if (missing.length) return { status: "skipped", reason: `missing inputs: ${missing.join(", ")}` };
    const prompt = data.settings.startingPrompt.trim() ? undefined : eventMarkdown(event);
    return { status: "started", runId: launch(flow, data, { trigger: event, startNodeId: nodeId, prompt }).state.id };
  }

  function fireTrigger(flow: Flow, nodeId: string, event: TriggerEvent): FireOutcome {
    if (!flowBusy(flow.id)) return startTriggered(flow.id, nodeId, event);
    const data = storage.load();
    const node = flow.nodes.find((n) => n.id === nodeId);
    let overlap: "queue" | "skip" = "queue";
    try {
      if (node) overlap = resolveNode(node, data.blocks).trigger.overlap ?? "queue";
    } catch {
      /* default */
    }
    if (overlap === "skip") return { status: "skipped", reason: "flow is already running (overlap: skip)" };
    const q = queues.get(flow.id) ?? [];
    if (q.length >= MAX_QUEUE) return { status: "skipped", reason: `queue is full (${MAX_QUEUE})` };
    q.push({ nodeId, event });
    queues.set(flow.id, q);
    return { status: "queued" };
  }

  function drainQueue(flowId: string) {
    const q = queues.get(flowId);
    while (q?.length && !flowBusy(flowId)) {
      const next = q.shift()!;
      const outcome = startTriggered(flowId, next.nodeId, next.event);
      if (outcome.status !== "started") console.warn(`[trigger] queued ${next.event.type} skipped: ${"reason" in outcome ? outcome.reason : ""}`);
    }
    if (q && !q.length) queues.delete(flowId);
  }

  const triggers = createTriggerService({
    load: storage.load,
    fire: fireTrigger,
    exec,
    statePath: path.join(storage.dir, "triggers-state.json"),
  });

  // Webhook listener: its own port, only when enabled in Settings.
  let webhookServer: WebhookServer | undefined;
  let webhookKey = "";
  let webhookError: string | undefined;
  async function syncWebhooks() {
    const w = storage.load().settings.webhooks;
    const key = w?.enabled ? `${w.host}:${w.port}` : "";
    if (key === webhookKey) return;
    webhookKey = key;
    await webhookServer?.close();
    webhookServer = undefined;
    webhookError = undefined;
    if (!w?.enabled) return;
    // Retry briefly: after a dev-server restart the previous listener may still be releasing the port.
    for (let attempt = 1; ; attempt++) {
      try {
        webhookServer = await startWebhookServer(w.host, w.port, triggers.handleWebhook);
        return;
      } catch (e) {
        const busy = (e as NodeJS.ErrnoException).code === "EADDRINUSE";
        if (busy && attempt < 10 && webhookKey === key) {
          await new Promise((r) => setTimeout(r, 500));
          continue;
        }
        webhookError = `Couldn't listen on ${w.host}:${w.port}: ${(e as Error).message}`;
        console.warn(`[webhooks] ${webhookError}`);
        return;
      }
    }
  }
  function webhookInfo() {
    const w = storage.load().settings.webhooks;
    const base = w?.publicUrl?.trim().replace(/\/+$/, "") || (webhookServer ? `http://${w?.host === "0.0.0.0" ? "<this-machine>" : w?.host}:${webhookServer.port}` : undefined);
    return { enabled: !!w?.enabled, listening: !!webhookServer, port: webhookServer?.port, baseUrl: base, error: webhookError };
  }
  function syncTriggers() {
    triggers.sync();
    void syncWebhooks();
  }
  syncTriggers();

  // ---------- packs ----------

  // Installing / removing a pack (or editing a linked pack folder) changes the blocks and flows everyone sees.
  const offPacks = storage.packs.onChange(() => {
    syncTriggers();
    changed({ source: "ui" });
  });
  if (opts.fetchBasePack) {
    // The app ships a copy of the base pack; fetch the current one from GitHub unless updates are off
    // (air-gapped installs keep the shipped copy).
    const mode = storage.load().settings.updates?.mode;
    if (mode !== "off") {
      void storage.packs
        .refreshBaseOnline()
        .then((msg) => console.log(`[packs] ${msg}`))
        .catch((e: Error) => console.warn(`[packs] couldn't fetch the base pack (keeping the shipped copy): ${e.message}`));
    }
  }

  /**
   * Resume a finished run as a new run of its flow as it is now (see shared/resume.ts), from `fromNodeIds` (default:
   * its failed / stopped / still-queued steps). The new run works on the original's branch, which must still exist.
   * Runs being resumed right now (the checks await git) are in `resuming`: a second resume of the same one is refused.
   */
  const resuming = new Set<string>();
  async function resumeRun(id: string, fromNodeIds?: string[]) {
    if (resuming.has(id)) throw new HttpError(409, "This run is already being resumed");
    resuming.add(id);
    try {
      return await planAndResume(id, fromNodeIds);
    } finally {
      resuming.delete(id);
    }
  }

  async function planAndResume(id: string, fromNodeIds?: string[]) {
    const orig = getRun(id);
    if (runs.get(id) && !orig.finishedAt) throw new HttpError(409, "The run is still going — stop it first");
    const already = [...runs.values()].find((h) => !h.state.finishedAt && h.state.resumedFrom?.runId === id);
    if (already) throw new HttpError(409, `This run is already being resumed (run ${already.state.id})`, { runId: already.state.id });
    const data = storage.load();
    const flow = data.flows.find((f) => f.id === orig.flowId);
    if (!flow) throw new HttpError(404, `Flow "${orig.flowName}" no longer exists`);
    const planned = planResume(orig, flow, data.blocks, fromNodeIds);
    if (!planned.ok) throw new HttpError(400, `Can't resume: ${planned.problems.join("; ")}`, { problems: planned.problems });
    const plan = planned.plan;
    const prompt = orig.prompt ?? "";
    const missing = missingInputs(flow, data.blocks, data.env, prompt, data.flows, { triggered: !!orig.triggerNodeId });
    if (missing.length) throw new HttpError(400, `Missing inputs: ${missing.join(", ")}`, { missing });
    const notes = [...plan.warnings];
    let env = data.env;
    if (plan.repo) {
      const repo = data.env.REPO_PATH?.trim();
      if (!repo) {
        throw new HttpError(400, `Can't resume: the original run worked in ${plan.repo} (REPO_PATH), which is no longer set — set it again to continue on branch ${plan.branch}`, {
          problems: ["REPO_PATH is no longer set"],
        });
      }
      if (repo !== plan.repo) notes.push(`REPO_PATH changed since the original run (${plan.repo} → ${repo}); continuing on branch ${plan.branch} in ${repo}.`);
      // A run still working on that branch (e.g. an earlier resume of this run) would share its worktree with this
      // one. That's only refused for the run's own branch — an explicit BRANCH_NAME shared by runs just warns.
      const explicit = data.env.BRANCH_NAME?.trim();
      const busy = activeRuns().find((r) => r.branchKey === `${repo}\0${plan.branch}`);
      if (busy && plan.branch !== explicit) {
        throw new HttpError(409, `Can't resume: run ${busy.id} ("${busy.flowName}") is still working on branch ${plan.branch} — wait for it to finish or stop it first`, {
          runId: busy.id,
        });
      }
      // Steps that read BRANCH_NAME (scripts, Create task) work on the branch the run continues, not one set since.
      if (explicit && explicit !== plan.branch) {
        notes.push(`BRANCH_NAME is now ${explicit}, but this run continues the original run's branch ${plan.branch} — its steps get BRANCH_NAME=${plan.branch}.`);
        env = { ...data.env, BRANCH_NAME: plan.branch! };
      }
      // A branch the original run actually used must still be there: it holds the earlier steps' code changes.
      if (orig.branch && plan.branch === orig.branch && !(await branchExists(repo, orig.branch))) {
        const problem = `Branch ${orig.branch} no longer exists in ${repo}, so the code changes the earlier steps made are gone (was it deleted or merged?). Restore the branch, re-run from the first step, or start a new run.`;
        throw new HttpError(409, `Can't resume: ${problem}`, { problems: [problem] });
      }
    }
    return launch(flow, env === data.env ? data : { ...data, env }, { prompt, branch: plan.branch, resume: { from: orig, plan } }, notes);
  }

  // ---------- continuing paused / interrupted runs (see shared/journal.ts, backend/continue.ts) ----------

  let shuttingDown = false;
  /** Runs being continued right now (the checks await git): a second Continue of the same one is refused. */
  const continuing = new Set<string>();

  /** Hold a paused run for the user: it doesn't continue by itself; the flag says why. */
  function hold(run: RunState, h: Omit<RunHold, "at">, flag: string) {
    run.hold = { ...h, at: Date.now() };
    if (!run.flags?.some((f) => f.id === `hold-${h.reason}` && !f.dismissed && f.message === flag)) {
      const f = { id: `hold-${h.reason}`, severity: h.reason === "manual" ? ("warning" as const) : ("error" as const), message: flag, details: h.problems.join("\n"), at: Date.now() };
      run.flags = [...(run.flags ?? []).filter((x) => x.id !== f.id), f];
      announceFlag(run, f);
    }
    storage.saveRun(run);
  }

  /**
   * Continue a paused / interrupted run as the same run, after MEOW's checks (`checkContinue`); `repair` first adopts
   * what changed instead. `auto` = the continue pass at start (a failed check holds the run instead of throwing).
   */
  async function continueRun(id: string, o: { repair?: boolean; auto?: boolean } = {}): Promise<{ run: RunState; changes?: string[] }> {
    const live = runs.get(id);
    if (live && !isSettled(live.state)) throw new HttpError(409, "This run is still going");
    if (continuing.has(id)) throw new HttpError(409, "This run is already being continued");
    continuing.add(id);
    let mine = false;
    try {
      const j = storage.loadJournal(id);
      if (j.problem === "missing") throw new HttpError(404, "Run not found");
      if (j.problem) throw new HttpError(409, `Can't continue: the run's journal is corrupt (${j.problem}) — it's preserved as it is at ${j.file}`);
      if (j.legacy || !j.run) throw new HttpError(409, "This run was started by an older version of Sandflow, which didn't journal what continuing needs — use Retry instead");
      const run = j.run;
      if (run.parent) throw new HttpError(409, "This is a Box Stack task — it continues with the run that started it");
      if (TERMINAL_PHASES.has(run.phase!)) throw new HttpError(409, `This run has ${run.phase === "done" ? "finished" : run.phase === "failed" ? "failed — use Retry" : "been stopped — use Retry"}`);
      const lock = locked.has(id) ? { ok: true as const } : acquireRunLock(runsDir, id);
      if (!lock.ok) throw new HttpError(409, `Another Sandflow${lock.holder ? ` (process ${lock.holder.pid})` : ""} is running this run`);
      if (!locked.has(id)) {
        locked.add(id);
        mine = true;
      }
      const data = storage.load();
      // Not paused: its driver died without saying (we hold the lock now) — a crash.
      if (!isPaused(run)) markCrashed(run, data);
      let changes: string[] | undefined;
      if (o.repair) {
        try {
          changes = await repairRun(run, data);
        } catch (e) {
          throw new HttpError(409, (e as Error).message);
        }
        (run.repairs ??= []).push({ at: Date.now(), changes });
        run.logs.push({ ts: Date.now(), level: "warn", msg: `Repaired: ${changes.length ? changes.join("; ") : "nothing had changed"}` });
      }
      const check = await checkContinue(run, data);
      if (check.problems.length) {
        hold(run, { reason: "validation", problems: check.problems, repairable: check.repairable }, `Paused — can't continue as it is: ${check.problems[0]}${check.problems.length > 1 ? ` (+${check.problems.length - 1} more)` : ""}`);
        throw new HttpError(409, `Can't continue: ${check.problems.join("; ")}`, { problems: check.problems, repairable: check.repairable });
      }
      const flow = data.flows.find((f) => f.id === run.flowId)!;
      // What a crash left behind (its containers, its agents' processes) goes first — only what matches its record.
      const removed = await cleanupLeftovers(run, exec, killPidTree).catch(() => []);
      if (removed.length) run.logs.push({ ts: Date.now(), level: "info", msg: `Removed what the interrupted attempt left running: ${removed.join(", ")}` });
      run.sandboxes = [];
      run.processes = [];
      for (const f of run.flags ?? []) if (f.id.startsWith("hold-") || f.id === "interrupted") f.dismissed = true;
      // Steps that read BRANCH_NAME work on the branch the run continues, not one set since.
      const branch = runBranch(run);
      const explicit = data.env.BRANCH_NAME?.trim();
      const env = explicit && explicit !== branch && run.workspace?.repo ? { ...data.env, BRANCH_NAME: branch } : data.env;
      const h = launch(flow, env === data.env ? data : { ...data, env }, { continueFrom: run, prompt: run.prompt ?? "", branch });
      mine = false; // the run holds it now (released when it pauses or ends)
      return { run: h.state, changes };
    } finally {
      continuing.delete(id);
      if (mine) unlock(id);
    }
  }

  /** Stop a paused run that isn't loaded: it's cancelled (and never continued). */
  function cancelPaused(id: string): RunState | undefined {
    const j = storage.loadJournal(id);
    const run = j.run;
    if (!run || j.legacy || TERMINAL_PHASES.has(run.phase!)) return undefined;
    const lock = locked.has(id) ? { ok: true as const } : acquireRunLock(runsDir, id);
    if (!lock.ok) throw new HttpError(409, "Another Sandflow is running this run — stop it there");
    try {
      run.phase = "cancelled";
      run.status = "cancelled";
      (run.transitions ??= []).push({ phase: "cancelled", at: Date.now(), attempt: run.attempt ?? 1 });
      run.finishedAt = Date.now();
      run.hold = undefined;
      run.queues = undefined;
      run.logs.push({ ts: Date.now(), level: "warn", msg: "Run stopped while paused — it won't be continued" });
      storage.saveRun(run);
      return run;
    } finally {
      if (!locked.has(id)) releaseRunLock(runsDir, id);
    }
  }

  /**
   * At start (MEOW tick reconcile + `resume --continue`): every journal not in a terminal phase is looked at. One that
   * was going with no live driver crashed → interrupted. Paused / interrupted runs are checked and continued — unless
   * their flow's "Continue interrupted runs automatically" is off, or they keep dying without progress.
   */
  async function continuePass() {
    const data = storage.load();
    const max = data.settings.maxContinues ?? MAX_CONTINUES;
    const open: RunState[] = [];
    for (const id of storage.runIds()) {
      const j = storage.loadJournal(id);
      // Corrupt journals are left as they are (listed with a flag); old runs are never continued.
      if (j.run && !j.legacy && !TERMINAL_PHASES.has(j.run.phase!) && !runs.has(id)) open.push(j.run);
    }
    const byId = new Map(open.map((r) => [r.id, r]));
    const crashed = new Set<string>();
    for (const run of open.filter((r) => !r.parent && !isPaused(r))) {
      const lock = acquireRunLock(runsDir, run.id);
      if (!lock.ok) continue; // another Sandflow on this data folder drives it
      try {
        storage.saveRun(markCrashed(run, data));
        crashed.add(run.id);
      } finally {
        releaseRunLock(runsDir, run.id);
      }
    }
    // A crashed run's stack tasks crashed with it (they continue with it).
    const rootOf = (r: RunState) => {
      let cur = r;
      for (let i = 0; i < 20 && cur.parent && byId.has(cur.parent.runId); i++) cur = byId.get(cur.parent.runId)!;
      return cur.parent ? cur.parent.runId : cur.id;
    };
    for (const c of open.filter((r) => r.parent && !isPaused(r))) {
      if (crashed.has(rootOf(c)) || (!byId.has(rootOf(c)) && !readLock(runsDir, rootOf(c)))) storage.saveRun(markCrashed(c, data));
    }
    for (const run of open.filter((r) => !r.parent && isPaused(r))) {
      if (shuttingDown) return;
      if (readLock(runsDir, run.id) && !acquireAndRelease(run.id)) continue;
      const flow = data.flows.find((f) => f.id === run.flowId);
      if (flow?.continueAutomatically === false) {
        if (run.hold?.reason !== "manual") {
          hold(run, { reason: "manual", problems: ["This flow's runs aren't continued automatically"] }, `Paused (${PAUSE_REASON_TEXT[run.pauseReason ?? "crash"].toLowerCase()}) — press Continue to carry on`);
        }
        continue;
      }
      if (run.hold?.reason === "loop") continue; // waits for Continue
      if ((run.stalls ?? 0) >= max) {
        hold(run, { reason: "loop", problems: [`Continued ${run.stalls} times without a step finishing`] }, `Not continued automatically: it was continued ${run.stalls} times without a step finishing — press Continue to try again`);
        continue;
      }
      try {
        await continueRun(run.id, { auto: true });
        console.log(`[runs] continued run ${run.id} (${run.flowName})`);
      } catch (e) {
        console.warn(`[runs] run ${run.id} stays paused: ${(e as Error).message}`);
      }
    }
  }
  /** Whether a lock left on a paused run is stale (we can take it); taken locks are released again. */
  function acquireAndRelease(id: string): boolean {
    if (!acquireRunLock(runsDir, id).ok) return false;
    releaseRunLock(runsDir, id);
    return true;
  }

  function getRun(id: string): RunState {
    const live = runs.get(id)?.state;
    if (live) return live;
    const saved = storage.loadRun(id);
    if (!saved) throw new HttpError(404, "Run not found");
    return settleInterrupted(saved);
  }

  function getChat(id: string): Chat {
    let chat: Chat | undefined;
    try {
      chat = chats.get(id);
    } catch {
      /* invalid id */
    }
    if (!chat) throw new HttpError(404, "Chat not found");
    return chat;
  }

  async function handle(req: IncomingMessage, res: ServerResponse, next: Next) {
    const url = new URL(req.url ?? "/", "http://x");
    if (!url.pathname.startsWith("/api/")) return next();
    const parts = url.pathname.slice(5).split("/").filter(Boolean);
    const method = req.method ?? "GET";
    // Writes must be JSON: cross-site pages can only send JSON after a CORS preflight, which Vite rejects.
    if (method !== "GET" && !req.headers["content-type"]?.startsWith("application/json")) {
      throw new HttpError(415, "Content-Type must be application/json");
    }
    const isId = (i: number) =>
      i === 1 && (parts[0] === "runs" || parts[0] === "chats" || (parts[0] === "packs" && !["preview", "install", "export"].includes(parts[1])));
    const route = `${method} /${parts.map((p, i) => (isId(i) ? ":id" : p)).join("/")}`;
    noteHost(req.headers.host);

    if (method === "POST" && parts[0] === "runs" && parts[2] === "flags" && parts[4] === "dismiss" && parts.length === 5) {
      const live = runs.get(parts[1]);
      const run = live?.state ?? getRun(parts[1]);
      if (!dismissFlag(run, parts[3])) throw new HttpError(404, "Flag not found");
      storage.saveRun(run);
      if (live && !run.finishedAt) listeners.get(run.id)?.forEach((fn) => fn(run));
      flagListeners.forEach((fn) => fn("flag-dismissed", { runId: run.id, flagId: parts[3] }));
      return send(res, 200, { ok: true });
    }

    // Node keys of subflow nodes contain "/" — sent URL-encoded as one path segment.
    if (method === "POST" && parts[0] === "runs" && parts[2] === "nodes" && parts[4] === "steer" && parts.length === 5) {
      const h = runs.get(parts[1]);
      const { message } = (await readJson<{ message?: unknown }>(req)) ?? {};
      if (typeof message !== "string") throw new HttpError(400, "Send { message: string }");
      if (!h) {
        getRun(parts[1]); // 404 for an unknown run
        throw new HttpError(409, "This run has ended — there's no agent left to steer");
      }
      let nodeKey: string;
      try {
        nodeKey = decodeURIComponent(parts[3]);
      } catch {
        throw new HttpError(400, "Invalid node id");
      }
      const r = h.steer(nodeKey, message);
      if (!r.ok) throw new HttpError(r.status, r.error);
      return send(res, 200, { ok: true, steer: r.steer });
    }

    switch (route) {
      case "GET /data":
        return send(res, 200, { ...storage.load(), rev });

      case "GET /data/events": {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
        const push = (c: DataChange) => res.write(`event: change\ndata: ${JSON.stringify(c)}\n\n`);
        push({ rev, source: "ui" });
        dataListeners.add(push);
        const pushFlag = (event: string, data: object) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        flagListeners.add(pushFlag);
        const beat = setInterval(() => res.write(": ping\n\n"), 15_000);
        req.on("close", () => {
          clearInterval(beat);
          dataListeners.delete(push);
          flagListeners.delete(pushFlag);
        });
        return;
      }

      case "PUT /blocks": {
        const blocks = await readJson<BlockDef[]>(req);
        if (!Array.isArray(blocks)) throw new HttpError(400, "Expected an array of blocks");
        checkRev(url);
        const current = storage.load().blocks;
        const own = blocks.filter((b) => !b.pack);
        // A pack block comes from the server unless the client sent your edit of it (`modified`); one sent
        // without `modified` is the pack's own version — that's how an edit is reverted.
        const edits = blocks.filter((b) => b.pack && b.modified);
        const packBlocks = [...CORE_BLOCKS, ...applyPackEdits(storage.packBlocks(), edits)];
        const before = new Map(current.map((b) => [b.id, JSON.stringify(b)]));
        const next = [...packBlocks, ...own];
        const touched = new Set(next.filter((b) => before.get(b.id) !== JSON.stringify(b)).map((b) => b.id));
        const errors = validateBlocks(next, touched);
        if (errors.length) throw new HttpError(400, errors[0], { errors });
        storage.saveBlocks(next);
        syncTriggers();
        changed({ source: "ui" });
        return send(res, 200, { ok: true, rev });
      }

      case "PUT /flows": {
        const flows = await readJson<Flow[]>(req);
        if (!Array.isArray(flows)) throw new HttpError(400, "Expected an array of flows");
        checkRev(url);
        const own = flows.filter((f) => !f.pack).map(sanitizeFlowColor);
        const bad = own.find((f) => f.id.includes("/"));
        if (bad) throw new HttpError(400, `Flow id "${bad.id}" can't contain "/" (that's reserved for pack flows)`);
        const current = storage.load();
        const all = [...own, ...current.flows.filter((f) => f.pack)];
        for (const f of own) {
          const cycle = subflowCycle(f.id, all, current.blocks);
          if (cycle) throw new HttpError(400, `Subflow loop: ${cycle} — a flow can't contain itself`);
        }
        storage.saveFlows(own);
        syncTriggers();
        changed({ source: "ui" });
        return send(res, 200, { ok: true, rev });
      }

      // ---------- MCP (agents) ----------

      case "POST /mcp": {
        const chatId = url.searchParams.get("chat");
        const out = mcp.handle(await readJson<unknown>(req), {
          scope: url.searchParams.get("flow") || undefined,
          // Calls from an in-app chat's agent show up in that chat.
          onCall: chatId ? (c) => chats.record(chatId, c) : undefined,
        });
        if (out === undefined) {
          res.statusCode = 202;
          return res.end();
        }
        return send(res, 200, out);
      }

      case "GET /mcp":
        res.setHeader("allow", "POST");
        throw new HttpError(405, "This MCP server only answers POST (no server-sent stream)");

      // ---------- "Edit with AI" chats ----------

      case "GET /chats": {
        const flowId = url.searchParams.get("flowId");
        if (!flowId) throw new HttpError(400, "flowId is required");
        return send(res, 200, chats.list(flowId));
      }

      case "POST /chats": {
        const { flowId, agent } = (await readJson<{ flowId?: string; agent?: AssistantAgent }>(req)) ?? {};
        try {
          return send(res, 200, chats.create(String(flowId ?? ""), agent));
        } catch (e) {
          throw new HttpError((e as Error).message === "Flow not found" ? 404 : 400, (e as Error).message);
        }
      }

      case "PATCH /chats/:id": {
        const { agent } = (await readJson<{ agent?: AssistantAgent }>(req)) ?? {};
        getChat(parts[1]);
        try {
          const chat = chats.setAgent(parts[1], agent as AssistantAgent);
          return send(res, 200, { ...chat, running: chats.running(chat.id) });
        } catch (e) {
          throw new HttpError(400, (e as Error).message);
        }
      }

      case "GET /chats/:id": {
        const chat = parts.length === 2 ? getChat(parts[1]) : undefined;
        if (chat) return send(res, 200, { ...chat, running: chats.running(chat.id) });
        break;
      }

      case "DELETE /chats/:id":
        getChat(parts[1]);
        chats.remove(parts[1]);
        return send(res, 200, { ok: true });

      case "POST /chats/:id/messages": {
        const { text } = (await readJson<{ text?: string }>(req)) ?? {};
        getChat(parts[1]);
        const r = chats.send(parts[1], String(text ?? ""), mcpUrl || `http://${req.headers.host}/api/mcp`);
        if (r.error) throw new HttpError(r.status ?? 400, r.error);
        return send(res, 200, { ok: true });
      }

      case "POST /chats/:id/cancel":
        return send(res, 200, { ok: chats.cancel(parts[1]) });

      case "GET /chats/:id/events": {
        const chat = getChat(parts[1]);
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
        const push = (c: Chat) => res.write(`event: chat\ndata: ${JSON.stringify({ ...c, running: chats.running(c.id) })}\n\n`);
        push(chat);
        const off = chats.subscribe(chat.id, push);
        const beat = setInterval(() => res.write(": ping\n\n"), 15_000);
        req.on("close", () => {
          clearInterval(beat);
          off();
        });
        return;
      }

      case "PUT /settings": {
        const s = await readJson<Settings>(req);
        try {
          storage.saveSettings(validateSettings(s));
        } catch (e) {
          throw new HttpError(400, (e as Error).message);
        }
        syncTriggers();
        return send(res, 200, { ok: true });
      }

      case "GET /sandbox/status":
        return send(res, 200, await sandboxImageStatus(storage.load().settings, exec));

      case "POST /sandbox/import": {
        const { path: file } = (await readJson<{ path?: string }>(req)) ?? {};
        try {
          const settings = storage.load().settings;
          // No file picked = load the bundle that shipped with the app.
          const output = file ? await importSandboxImage(settings, String(file), exec) : await loadBundledSandboxImage(settings, exec);
          return send(res, 200, { output });
        } catch (e) {
          throw new HttpError(400, (e as Error).message);
        }
      }

      case "PUT /env": {
        const env = await readJson<EnvValues>(req);
        if (!env || typeof env !== "object" || Array.isArray(env)) throw new HttpError(400, "Expected an object");
        const bad = Object.keys(env).filter((k) => !ENV_NAME_RE.test(k));
        if (bad.length) throw new HttpError(400, `Invalid env var name: ${bad.join(", ")}`);
        storage.saveEnv(Object.fromEntries(Object.entries(env).map(([k, v]) => [k, String(v)])));
        return send(res, 200, { ok: true });
      }

      case "POST /runs": {
        // `prompt` (optional) is this run's starting prompt; without it the global one is used.
        const body = (await readJson<{ flowId?: string; prompt?: string }>(req)) ?? {};
        const prompt = typeof body.prompt === "string" ? body.prompt.trim() : undefined;
        const data = storage.load();
        const flow = data.flows.find((f) => f.id === body.flowId);
        if (!flow) throw new HttpError(404, "Flow not found");
        const missing = missingInputs(flow, data.blocks, data.env, prompt ?? data.settings.startingPrompt, data.flows);
        if (missing.length) throw new HttpError(400, `Missing inputs: ${missing.join(", ")}`, { missing });
        const started = launch(flow, data, { prompt });
        return send(res, 200, { runId: started.state.id, ...(started.warning ? { warning: started.warning } : {}) });
      }

      case "GET /runs": {
        const live = [...runs.values()].map((h) => summarize(h.state));
        const liveIds = new Set(live.map((r) => r.id));
        const saved = storage.listRuns(50).filter((r) => !liveIds.has(r.id));
        const all = limitRuns([...live, ...saved].sort((a, b) => b.startedAt - a.startedAt), 50);
        return send(res, 200, all);
      }

      case "GET /triggers":
        return send(res, 200, {
          triggers: triggers.status(),
          log: triggers.log().slice(0, 100),
          webhooks: webhookInfo(),
          queued: Object.fromEntries([...queues].map(([k, q]) => [k, q.length])),
        });

      case "GET /skills":
        return send(res, 200, await skills.list());

      // ---------- packs ----------

      case "GET /packs":
        return send(res, 200, storage.packs.load().infos);

      case "POST /packs/preview": {
        // One of: { url } (GitHub/GitLab) · { folder, link } · { zipName, zipBase64 } · { zipPath } · { update: packId }
        const b =
          (await readJson<{ url?: string; folder?: string; link?: boolean; zipName?: string; zipBase64?: string; zipPath?: string; update?: string }>(req, MAX_PACK_BODY)) ??
          {};
        try {
          if (b.url) return send(res, 200, await storage.packs.previewUrl(b.url));
          if (b.folder) return send(res, 200, storage.packs.previewFolder(b.folder, !!b.link));
          if (b.zipBase64) return send(res, 200, storage.packs.previewZip(b.zipName ?? "pack.zip", Buffer.from(b.zipBase64, "base64")));
          if (b.zipPath) return send(res, 200, storage.packs.previewZip(b.zipPath, fs.readFileSync(b.zipPath)));
          if (b.update) return send(res, 200, await storage.packs.previewUpdate(b.update));
        } catch (e) {
          throw new HttpError(400, (e as Error).message);
        }
        throw new HttpError(400, "Give a url, a folder, a zip or a pack to update");
      }

      case "POST /packs/install": {
        const b = (await readJson<{ token?: string; trustHost?: boolean; replace?: boolean }>(req)) ?? {};
        try {
          return send(res, 200, storage.packs.install(String(b.token ?? ""), { trustHost: !!b.trustHost, replace: !!b.replace }));
        } catch (e) {
          throw new HttpError(400, (e as Error).message);
        }
      }

      case "POST /packs/export": {
        // Build a pack from your own blocks/flows: as a zip (base64) or into a folder.
        const b = (await readJson<{ manifest?: PackManifest; blockIds?: string[]; flowIds?: string[]; folder?: string }>(req)) ?? {};
        const data = storage.load();
        try {
          const files = await buildPack({
            manifest: b.manifest as PackManifest,
            blocks: data.blocks.filter((x) => b.blockIds?.includes(x.id)),
            flows: data.flows.filter((x) => b.flowIds?.includes(x.id)),
            allBlocks: data.blocks,
            allFlows: data.flows,
            installed: data.packs ?? [],
            readSkill: skills.read,
          });
          if (b.folder?.trim()) {
            writePackFolder(path.resolve(b.folder.trim()), files);
            return send(res, 200, { folder: path.resolve(b.folder.trim()), fileCount: files.size });
          }
          const id = (b.manifest as PackManifest).id;
          return send(res, 200, { fileName: `${id}.zip`, zipBase64: Buffer.from(zipFiles(files, id)).toString("base64"), fileCount: files.size });
        } catch (e) {
          throw new HttpError(400, (e as Error).message);
        }
      }

      case "DELETE /packs/:id": {
        try {
          storage.packs.remove(parts[1]);
        } catch (e) {
          throw new HttpError(404, (e as Error).message);
        }
        return send(res, 200, { ok: true });
      }

      case "POST /packs/:id/trust": {
        const { trustHost } = (await readJson<{ trustHost?: boolean }>(req)) ?? {};
        try {
          storage.packs.setTrust(parts[1], !!trustHost);
        } catch (e) {
          throw new HttpError(404, (e as Error).message);
        }
        return send(res, 200, { ok: true });
      }

      case "POST /packs/:id/reload":
        storage.packs.reload();
        return send(res, 200, { ok: true });

      // ---------- integrations (other harnesses) ----------
      // Integration ids contain "/" (`base/meow`, `local/meow`), so they travel in the body.

      case "GET /integrations":
        return send(res, 200, storage.integrations.list());

      case "POST /integrations": {
        // Add or replace one of your own: { def, previousId? }.
        const b = (await readJson<{ def?: IntegrationDef; previousId?: string }>(req)) ?? {};
        try {
          const info = storage.integrations.save(b.def as IntegrationDef, b.previousId);
          changed({ source: "ui" });
          return send(res, 200, info);
        } catch (e) {
          throw new HttpError(400, (e as Error).message);
        }
      }

      case "POST /integrations/delete": {
        const { id } = (await readJson<{ id?: string }>(req)) ?? {};
        try {
          storage.integrations.remove(String(id ?? ""));
        } catch (e) {
          throw new HttpError(404, (e as Error).message);
        }
        changed({ source: "ui" });
        return send(res, 200, { ok: true });
      }

      case "POST /integrations/status": {
        // { id, force? } for one, or { all: true, force? } for every integration.
        const b = (await readJson<{ id?: string; all?: boolean; force?: boolean }>(req)) ?? {};
        try {
          if (b.all) return send(res, 200, await Promise.all(storage.integrations.list().map((i) => storage.integrations.status(i.id, !!b.force))));
          return send(res, 200, await storage.integrations.status(String(b.id ?? ""), !!b.force));
        } catch (e) {
          throw new HttpError(404, (e as Error).message);
        }
      }

      case "POST /integrations/choices": {
        const b = (await readJson<{ id?: string; action?: string; option?: string }>(req)) ?? {};
        try {
          return send(res, 200, await storage.integrations.choices(String(b.id ?? ""), String(b.action ?? ""), String(b.option ?? ""), storage.load().env));
        } catch (e) {
          throw new HttpError(400, (e as Error).message);
        }
      }

      case "POST /skills": {
        const body = await readJson<{ name?: string; files?: SkillFile[] }>(req);
        try {
          return send(res, 200, await skills.save(String(body?.name ?? ""), body?.files ?? []));
        } catch (e) {
          throw new HttpError(400, (e as Error).message);
        }
      }

      case "GET /runs/:id":
        if (parts.length === 2) return send(res, 200, getRun(parts[1]));
        break;

      case "GET /runs/:id/events": {
        const state = getRun(parts[1]);
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });
        const push = (s: RunState) => res.write(`event: state\ndata: ${JSON.stringify(s)}\n\n`);
        push(state);
        // Finished or paused: nothing more comes (a continued run is watched again).
        if (isSettled(state)) return res.end();
        let set = listeners.get(state.id);
        if (!set) listeners.set(state.id, (set = new Set()));
        // A finished run can still change once more (e.g. "Run stopped" logged after it ended): the stream is closed
        // by then, and writing to it would crash the server.
        const stop = () => {
          clearInterval(beat);
          set!.delete(fn);
        };
        const fn = (s: RunState) => {
          if (res.writableEnded) return stop();
          push(s);
          if (isSettled(s)) {
            res.end();
            stop();
          }
        };
        set.add(fn);
        const beat = setInterval(() => !res.writableEnded && res.write(": ping\n\n"), 15_000);
        req.on("close", stop);
        return;
      }

      case "POST /runs/:id/answer": {
        const h = runs.get(parts[1]);
        const { answer } = (await readJson<{ answer?: string }>(req)) ?? {};
        if (!h || !h.answer(String(answer ?? ""))) throw new HttpError(409, "No pending question");
        return send(res, 200, { ok: true });
      }

      case "POST /runs/:id/resume": {
        const body = (await readJson<{ fromNodeIds?: unknown }>(req)) ?? {};
        const from = body.fromNodeIds;
        if (from !== undefined && (!Array.isArray(from) || from.length > 100 || from.some((x) => typeof x !== "string" || x.length > 200))) {
          throw new HttpError(400, "fromNodeIds must be a list of node ids");
        }
        const started = await resumeRun(parts[1], from as string[] | undefined);
        return send(res, 200, { runId: started.state.id, ...(started.warning ? { warning: started.warning } : {}) });
      }

      case "POST /runs/:id/cancel": {
        const h = runs.get(parts[1]);
        // A paused run (not running here): Stop cancels it for good, so it's never continued.
        if (!h || isPaused(h.state)) {
          const stopped = cancelPaused(parts[1]);
          if (stopped) {
            runs.delete(parts[1]);
            return send(res, 200, { ok: true, status: stopped.status });
          }
        }
        // Stopping a run that already ended (e.g. a second click on Stop) is fine; an unknown run is not.
        if (!h) return send(res, 200, { ok: true, status: getRun(parts[1]).status });
        h.cancel();
        return send(res, 200, { ok: true, status: h.state.status });
      }

      case "POST /runs/:id/continue":
      case "POST /runs/:id/repair": {
        const r = await continueRun(parts[1], { repair: parts[2] === "repair" });
        return send(res, 200, { runId: r.run.id, ...(r.changes ? { changes: r.changes } : {}) });
      }
    }
    throw new HttpError(404, `No route ${method} ${url.pathname}`);
  }

  const handler: Api = (req, res, next) => {
    handle(req, res, next).catch((e) => {
      if (res.headersSent) return res.end();
      if (e instanceof HttpError) send(res, e.status, { error: e.message, ...e.extra });
      else send(res, 500, { error: (e as Error).message });
    });
  };
  /**
   * Pause every active run (they continue when Sandflow starts again; Stop is the way to cancel one) and wait, bounded,
   * for them: running steps get a grace period, irreversible ones finish, sandboxes / containers get closed.
   */
  handler.shutdown = async (timeoutMs = 45_000, reason = "quit") => {
    shuttingDown = true;
    offPacks();
    triggers.stop();
    queues.clear();
    await chats.shutdown();
    await webhookServer?.close();
    webhookServer = undefined;
    const active = [...runs.values()].filter((h) => !isSettled(h.state));
    await Promise.race([
      Promise.allSettled(active.map((h) => h.pause(reason))),
      new Promise((r) => setTimeout(r, timeoutMs).unref?.()),
    ]);
    // Whatever didn't get to "paused" in time stays "pausing" in its journal: the next start treats it as a crash.
    for (const h of active) storage.saveRun(h.state);
    for (const id of [...locked]) unlock(id);
  };
  handler.ready = opts.noContinuePass ? Promise.resolve() : continuePass().catch((e) => console.warn(`[runs] continue pass failed: ${(e as Error).message}`));
  return handler;
}
