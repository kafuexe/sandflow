// Arms the trigger blocks of active flows: schedule timers, git-host pollers and webhook routes.

import { createHmac, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  matchesEvents,
  normalizeGithubApiEvent,
  normalizeGithubWebhook,
  normalizeGitlabApiEvent,
  normalizeGitlabWebhook,
} from "../shared/events";
import { nodeLabel, resolveNode } from "../shared/resolve";
import { nextFire } from "../shared/schedule";
import type { AppData, Flow, ResolvedConfig, TriggerEvent } from "../shared/types";
import { execCli, type Exec } from "./sandbox";

/** What happened when a trigger fired (for the trigger log). */
export type FireOutcome = { status: "started"; runId: string } | { status: "queued" } | { status: "skipped"; reason: string };

export interface TriggerDeps {
  load(): AppData;
  fire(flow: Flow, nodeId: string, event: TriggerEvent): FireOutcome;
  exec?: Exec;
  /** Where poll cursors are persisted so a restart doesn't replay old events. */
  statePath?: string;
}

export interface TriggerStatus {
  flowId: string;
  flowName: string;
  nodeId: string;
  label: string;
  type: ResolvedConfig["trigger"]["type"];
  mode?: "webhook" | "poll";
  /** schedule: next fire time (ms). */
  nextRun?: number;
  /** webhook: path on the webhook listener. */
  webhookPath?: string;
  lastFired?: number;
  lastPoll?: number;
  lastError?: string;
}

export interface TriggerLogEntry {
  ts: number;
  flowId: string;
  nodeId: string;
  level: "info" | "warn" | "error";
  msg: string;
}

export interface WebhookResult {
  status: number;
  message: string;
}

const MAX_TIMER = 2 ** 31 - 1; // setTimeout limit (~24.8 days)
const MIN_POLL_SECONDS = 15;
const MAX_LOG = 300;

interface Armed {
  key: string;
  flow: Flow;
  nodeId: string;
  cfg: ResolvedConfig;
  status: TriggerStatus;
  timer?: ReturnType<typeof setTimeout>;
  /** Fingerprint so unchanged triggers aren't re-armed on every save. */
  sig: string;
}

const safeEqual = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

export function githubSignature(secret: string, body: Buffer | string) {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

export type TriggerService = ReturnType<typeof createTriggerService>;

export function createTriggerService(deps: TriggerDeps) {
  const exec = deps.exec ?? execCli;
  const armed = new Map<string, Armed>();
  const log: TriggerLogEntry[] = [];
  let cursors: Record<string, string> = {};
  if (deps.statePath) {
    try {
      cursors = JSON.parse(fs.readFileSync(deps.statePath, "utf8")) as Record<string, string>;
    } catch {
      /* first start */
    }
  }
  const saveCursors = () => {
    if (!deps.statePath) return;
    fs.mkdirSync(path.dirname(deps.statePath), { recursive: true });
    fs.writeFileSync(deps.statePath, JSON.stringify(cursors, null, 2));
  };

  function note(a: Pick<Armed, "flow" | "nodeId">, level: TriggerLogEntry["level"], msg: string) {
    log.push({ ts: Date.now(), flowId: a.flow.id, nodeId: a.nodeId, level, msg });
    if (log.length > MAX_LOG) log.splice(0, log.length - MAX_LOG);
    if (level !== "info") console.warn(`[trigger ${a.flow.name}] ${msg}`);
  }

  function fire(a: Armed, event: TriggerEvent) {
    // Re-read the flow: it may have been edited since the trigger was armed.
    const flow = deps.load().flows.find((f) => f.id === a.flow.id) ?? a.flow;
    const outcome = deps.fire(flow, a.nodeId, event);
    a.status.lastFired = Date.now();
    const what = `${event.type}${event.author ? ` by ${event.author}` : ""}`;
    if (outcome.status === "started") note(a, "info", `${what} → started run ${outcome.runId}`);
    else if (outcome.status === "queued") note(a, "info", `${what} → queued (flow is already running)`);
    else note(a, "warn", `${what} → skipped: ${outcome.reason}`);
    return outcome;
  }

  // ---------- schedules ----------

  function armSchedule(a: Armed) {
    const spec = a.cfg.trigger.schedule;
    const next = spec ? nextFire(spec, new Date()) : undefined;
    a.status.nextRun = next?.getTime();
    if (!next) return;
    const wait = Math.min(Math.max(0, next.getTime() - Date.now()), MAX_TIMER);
    a.timer = setTimeout(() => {
      if (!armed.has(a.key)) return;
      if (Date.now() >= next.getTime()) {
        fire(a, { source: "schedule", type: "schedule", title: `Scheduled run (${a.status.label})`, firedAt: Date.now() });
      }
      armSchedule(a); // next occurrence (or re-wait if the timer was capped)
    }, wait);
  }

  // ---------- polling ----------

  async function pollOnce(a: Armed) {
    const t = a.cfg.trigger;
    const repo = t.repo?.trim();
    a.status.lastPoll = Date.now();
    if (!repo) {
      a.status.lastError = "Set the repository to poll";
      return;
    }
    const hostArgs = t.host?.trim() ? ["--hostname", t.host.trim()] : [];
    const args =
      t.type === "github"
        ? ["api", ...hostArgs, `repos/${repo}/events?per_page=100`]
        : ["api", ...hostArgs, `projects/${encodeURIComponent(repo)}/events?per_page=100&sort=desc`];
    const cmd = t.type === "github" ? "gh" : "glab";
    const r = await exec(cmd, args);
    if (r.code !== 0) {
      a.status.lastError = `${cmd} api failed: ${(r.stderr || r.stdout).trim().slice(0, 300)}`;
      note(a, "error", a.status.lastError);
      return;
    }
    let items: Array<Record<string, unknown>>;
    try {
      items = JSON.parse(r.stdout) as Array<Record<string, unknown>>;
      if (!Array.isArray(items)) throw new Error("not a list");
    } catch {
      a.status.lastError = `Unexpected ${cmd} api output`;
      return;
    }
    a.status.lastError = undefined;
    const id = (x: Record<string, unknown>) => Number(x.id);
    const sorted = items.filter((x) => Number.isFinite(id(x))).sort((x, y) => id(x) - id(y));
    const newest = sorted.at(-1);
    const cursor = cursors[a.key];
    if (cursor === undefined) {
      // First poll: remember where we are; never fire for history.
      cursors[a.key] = String(newest ? id(newest) : 0);
      saveCursors();
      note(a, "info", `Polling ${repo} every ${Math.max(MIN_POLL_SECONDS, t.pollSeconds ?? 60)}s`);
      return;
    }
    for (const item of sorted) {
      if (id(item) <= Number(cursor)) continue;
      cursors[a.key] = String(id(item));
      const ev =
        t.type === "github" ? normalizeGithubApiEvent(item, t.host?.trim()) : normalizeGitlabApiEvent(item, repo, t.host?.trim());
      if (ev && matchesEvents(ev, t.events)) fire(a, ev);
    }
    saveCursors();
  }

  function armPoll(a: Armed) {
    const every = Math.max(MIN_POLL_SECONDS, a.cfg.trigger.pollSeconds ?? 60) * 1000;
    const tick = async () => {
      if (!armed.has(a.key)) return;
      try {
        await pollOnce(a);
      } catch (e) {
        a.status.lastError = (e as Error).message;
      }
      if (armed.has(a.key)) a.timer = setTimeout(() => void tick(), every);
    };
    a.timer = setTimeout(() => void tick(), 0);
  }

  // ---------- lifecycle ----------

  function disarm(a: Armed) {
    if (a.timer) clearTimeout(a.timer);
    armed.delete(a.key);
  }

  /** (Re)arm the trigger blocks of every active flow. Call after flows / blocks / settings change. */
  function sync() {
    const data = deps.load();
    const wanted = new Map<string, { flow: Flow; nodeId: string; cfg: ResolvedConfig }>();
    for (const flow of data.flows) {
      if (!flow.active) continue;
      for (const node of flow.nodes) {
        let cfg: ResolvedConfig;
        try {
          cfg = resolveNode(node, data.blocks);
        } catch {
          continue;
        }
        if (cfg.kind !== "trigger" || cfg.trigger.type === "manual") continue;
        wanted.set(`${flow.id}/${node.id}`, { flow, nodeId: node.id, cfg });
      }
    }
    for (const [key, a] of armed) if (!wanted.has(key)) disarm(a);
    for (const [key, w] of wanted) {
      const sig = JSON.stringify(w.cfg.trigger);
      const existing = armed.get(key);
      if (existing?.sig === sig) {
        existing.flow = w.flow;
        continue;
      }
      if (existing) disarm(existing);
      const t = w.cfg.trigger;
      const node = w.flow.nodes.find((n) => n.id === w.nodeId)!;
      const a: Armed = {
        key,
        flow: w.flow,
        nodeId: w.nodeId,
        cfg: w.cfg,
        sig,
        status: {
          flowId: w.flow.id,
          flowName: w.flow.name,
          nodeId: w.nodeId,
          label: nodeLabel(node, data.blocks),
          type: t.type,
          mode: t.type === "schedule" ? undefined : (t.mode ?? "webhook"),
          webhookPath: t.type !== "schedule" && (t.mode ?? "webhook") === "webhook" ? `/hooks/${t.type}/${w.flow.id}/${w.nodeId}` : undefined,
        },
      };
      armed.set(key, a);
      if (t.type === "schedule") armSchedule(a);
      else if ((t.mode ?? "webhook") === "poll") armPoll(a);
    }
  }

  /** Handle `POST /hooks/<provider>/<flowId>/<nodeId>` (called by the webhook listener). */
  function handleWebhook(
    provider: string,
    flowId: string,
    nodeId: string,
    headers: Record<string, string | string[] | undefined>,
    body: Buffer,
  ): WebhookResult {
    const a = armed.get(`${flowId}/${nodeId}`);
    const t = a?.cfg.trigger;
    if (!a || !t || t.type !== provider || (t.mode ?? "webhook") !== "webhook") {
      return { status: 404, message: "No active webhook trigger here (is the flow Active?)" };
    }
    const secretName = t.secretEnv?.trim();
    const secret = secretName ? deps.load().env[secretName] : undefined;
    if (!secret) {
      note(a, "error", `Webhook rejected: set the secret in ${secretName ?? "the trigger's secret env var"}`);
      return { status: 403, message: "Webhook secret is not configured in Sandflow" };
    }
    const header = (n: string) => {
      const v = headers[n];
      return Array.isArray(v) ? v[0] : v;
    };
    if (provider === "github") {
      const sig = header("x-hub-signature-256") ?? "";
      if (!safeEqual(sig, githubSignature(secret, body))) {
        note(a, "warn", "Webhook rejected: bad signature");
        return { status: 401, message: "Bad signature" };
      }
    } else if (!safeEqual(header("x-gitlab-token") ?? "", secret)) {
      note(a, "warn", "Webhook rejected: bad token");
      return { status: 401, message: "Bad token" };
    }

    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(body.toString("utf8")) as Record<string, unknown>;
    } catch {
      return { status: 400, message: "Body is not JSON" };
    }
    const ghEvent = header("x-github-event") ?? "";
    if (provider === "github" && ghEvent === "ping") return { status: 200, message: "pong" };
    const ev = provider === "github" ? normalizeGithubWebhook(ghEvent, payload) : normalizeGitlabWebhook(payload);
    if (!ev || !matchesEvents(ev, t.events)) return { status: 202, message: "Ignored (event not selected)" };
    if (t.repo?.trim() && ev.repo?.toLowerCase() !== t.repo.trim().toLowerCase()) {
      return { status: 202, message: `Ignored (repository ${ev.repo} ≠ ${t.repo})` };
    }
    const outcome = fire(a, ev);
    return { status: 202, message: outcome.status === "skipped" ? `Skipped: ${outcome.reason}` : outcome.status };
  }

  return {
    sync,
    handleWebhook,
    /** For tests / "poll now". */
    pollNow: (flowId: string, nodeId: string) => {
      const a = armed.get(`${flowId}/${nodeId}`);
      return a ? pollOnce(a) : Promise.resolve();
    },
    status: (): TriggerStatus[] => [...armed.values()].map((a) => ({ ...a.status })),
    log: () => [...log].reverse(),
    stop() {
      for (const a of [...armed.values()]) disarm(a);
    },
  };
}
