// Run notifications (Settings → Notifications): a desktop notification, a host command and / or a webhook when a
// top-level run ends or needs you. Fire-and-forget: a slow or broken channel never holds the run up — its failure
// goes into the run's log instead.
//
// The command runs on this computer, outside any sandbox, so it only ever comes from the app's own settings (never a
// flow, pack or block).

import type { NotificationSettings, NotifyEvent, RunState } from "../shared/types";
import { runTree, exitText } from "./proc";

export interface RunNotice {
  event: NotifyEvent;
  runId: string;
  flowId: string;
  flowName: string;
  status: RunState["status"];
  error?: string;
  costUsd?: number;
  startedAt: number;
  endedAt?: number;
}

export interface NotifierDeps {
  settings: () => NotificationSettings | undefined;
  /** Hand a desktop notification to the app window (it's the one that can show it). */
  os: (n: RunNotice, title: string, body: string) => void;
  /** Note a channel's failure in the run's log. */
  log: (run: RunState, msg: string) => void;
  runTree?: typeof runTree;
  fetch?: typeof fetch;
  commandTimeoutMs?: number;
  webhookTimeoutMs?: number;
}

/**
 * What a state is worth telling about, with a key that's the same for the same transition (onChange fires many times
 * per state). A pause for quit / update / crash isn't: it continues by itself.
 */
export function noticeKey(s: RunState): { event: NotifyEvent; key: string } | undefined {
  if (s.parent) return undefined; // a stack task: its top-level run reports
  if (s.status === "done") return { event: "done", key: "done" };
  if (s.status === "failed") return { event: "failed", key: "failed" };
  if (s.status === "cancelled") return { event: "stopped", key: "stopped" };
  if (s.status === "paused" && s.hold) return { event: "attention", key: `hold:${s.hold.at}` };
  if (s.status === "waiting" && s.pendingQuestion) return { event: "attention", key: `question:${s.questions?.length ?? 0}:${s.pendingQuestion.question}` };
  return undefined;
}

export function noticeFor(s: RunState, event: NotifyEvent): RunNotice {
  return {
    event,
    runId: s.id,
    flowId: s.flowId,
    flowName: s.flowName,
    status: s.status,
    ...(s.error ? { error: s.error } : {}),
    ...(s.costUsd !== undefined ? { costUsd: s.costUsd } : {}),
    startedAt: s.startedAt,
    ...(s.finishedAt ? { endedAt: s.finishedAt } : {}),
  };
}

const TITLES: Record<NotifyEvent, string> = { done: "Run finished", failed: "Run failed", stopped: "Run stopped", attention: "Run needs you" };

function text(n: RunNotice, s: RunState): { title: string; body: string } {
  const why = n.event === "attention" ? (s.pendingQuestion?.question ?? s.hold?.problems[0]) : n.error;
  return { title: `${TITLES[n.event]}: ${n.flowName}`, body: (why ?? "").slice(0, 200) };
}

export function createNotifier(deps: NotifierDeps) {
  const exec = deps.runTree ?? runTree;
  /** The last transition told about, per run — so it's told once. */
  const told = new Map<string, string>();

  /** Every configured channel, for one notice. Settles once they all have; never rejects. */
  async function deliver(n: RunNotice, s: RunState, cfg: NotificationSettings, log: (msg: string) => void): Promise<void> {
    const jobs: Promise<void>[] = [];
    if (cfg.os) {
      const t = text(n, s);
      try {
        deps.os(n, t.title, t.body);
      } catch (e) {
        log(`Notification: desktop notification failed: ${(e as Error).message}`);
      }
    }
    if (cfg.command) {
      const env = {
        ...process.env,
        SANDFLOW_EVENT: n.event,
        SANDFLOW_RUN_ID: n.runId,
        SANDFLOW_FLOW: n.flowName,
        SANDFLOW_FLOW_ID: n.flowId,
        SANDFLOW_STATUS: n.status,
        SANDFLOW_COST_USD: n.costUsd !== undefined ? n.costUsd.toFixed(4) : "",
        SANDFLOW_ERROR: n.error ?? "",
      };
      jobs.push(
        Promise.resolve().then(() => exec(cfg.command!, null, { env, timeoutMs: deps.commandTimeoutMs ?? 30_000, stdoutTail: 4096, stderrTail: 4096 })).then(
          (r) => {
            if (r.killed) log(`Notification command ${r.killed}`);
            else if (r.code !== 0) log(`Notification command ${exitText(r)}${r.stderr.trim() ? `: ${r.stderr.trim().slice(-300)}` : ""}`);
          },
          (e) => log(`Notification command couldn't start: ${(e as Error).message}`),
        ),
      );
    }
    if (cfg.webhookUrl) {
      const post = deps.fetch ?? fetch;
      const url = cfg.webhookUrl;
      jobs.push(
        (async () => {
          try {
            const res = await post(url, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(n),
              signal: AbortSignal.timeout(deps.webhookTimeoutMs ?? 10_000),
            });
            if (!res.ok) log(`Notification webhook answered ${res.status}`);
          } catch (e) {
            log(`Notification webhook failed: ${(e as Error).message}`);
          }
        })(),
      );
    }
    await Promise.all(jobs);
  }

  return {
    /** Look at a run's state (call on every change); notifies once per transition the settings ask for. */
    onChange(s: RunState): Promise<void> | undefined {
      const k = noticeKey(s);
      if (!k || told.get(s.id) === k.key) return undefined;
      told.set(s.id, k.key);
      if (told.size > 1000) told.delete(told.keys().next().value!);
      const cfg = deps.settings();
      if (!cfg?.events?.includes(k.event)) return undefined;
      return deliver(noticeFor(s, k.event), s, cfg, (msg) => deps.log(s, msg));
    },
    /** Settings → Notifications → Send test: a sample through every configured channel; returns what went wrong. */
    async test(): Promise<string[]> {
      const cfg = deps.settings() ?? {};
      const now = Date.now();
      const s: RunState = { id: "test", flowId: "test", flowName: "Test notification", status: "done", startedAt: now - 60_000, finishedAt: now, nodes: {}, logs: [], costUsd: 0.1234 };
      const problems: string[] = [];
      await deliver(noticeFor(s, "done"), s, cfg, (msg) => problems.push(msg));
      return problems;
    },
  };
}

export type Notifier = ReturnType<typeof createNotifier>;
