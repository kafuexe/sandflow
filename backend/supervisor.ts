// The supervisor tick (MEOW's orchestrator `_Supervisor` / `runner._supervise`): one loop per Sandflow that looks at
// every live run every `pollSeconds`. Cheap, deterministic checks each tick — driver lock heartbeat, signs of life
// (silent → flag, stuck → stop), time limits, loops, unanswered questions, vanished containers — and judgement only
// when asked for: the optional overseer agent (per flow), whose answer is a JSON verdict the code validates (MEOW:
// agents write a decision file, the code checks it) and acts on within limits (MEOW `_refusal`).
//
// What it decides is journaled on the run (`run.supervision`, see RunHandle.supervise) and reaches watchers as
// `supervisor` events (shared/runEvents.ts). Stopping a node goes through `RunHandle.stopNode` with a cause; what
// happens after that failure is decided elsewhere (recovery), not here.

import os from "node:os";
import { isSettled } from "../shared/journal";
import { nodeLabel, resolveNode } from "../shared/resolve";
import { SUPERVISOR_DEFAULTS, isAgentKind, nodeTimeoutSeconds, supervisorSettings, validateOverseer, type EffectiveSupervisor } from "../shared/supervisor";
import type { AppData, Flow, FlowNode, NodeRunState, ResolvedConfig, RunState, SupervisionEntry } from "../shared/types";
import { cmdLine, resolveCli } from "./chats";
import type { RunHandle } from "./engine";
import { runTree } from "./proc";

/** One short, read-only overseer turn: the prompt in, the agent's answer (text) out. */
export interface OverseerRequest {
  prompt: string;
  model: string;
  signal: AbortSignal;
}
export type OverseerRunner = (req: OverseerRequest) => Promise<string>;

export interface SupervisorDeps {
  /** Every live run (stack children included). */
  runs(): RunHandle[];
  load(): Pick<AppData, "flows" | "blocks" | "settings">;
  /** Refresh the run's driver lock (`runs/<id>.lock`). */
  heartbeat?(runId: string): void;
  /** Does this container still exist? undefined: can't tell (Docker not answering…) — nothing is done then. */
  containerExists?(kind: "docker" | "podman", id: string): Promise<boolean | undefined>;
  overseer?: OverseerRunner;
  now?(): number;
  sleep?(ms: number): Promise<void>;
  /** Supervisor trouble (never a run's). */
  warn?(msg: string): void;
}

export interface Supervisor {
  /** One pass over every live run. */
  tick(): Promise<void>;
  /** Tick every `pollSeconds` until `stop`. */
  start(): void;
  stop(): void;
  /** Overseer turns still under way (they run beside the ticks). */
  drain(): Promise<void>;
}

/** Longest an overseer turn may take. */
export const OVERSEER_TIMEOUT_MS = 120_000;
/** Overseer limits per node execution (MEOW `_refusal`). */
export const MAX_OVERSEER_STEERS = 3;
export const MAX_OVERSEER_RESTARTS = 1;
/** Lines of a node's activity the overseer reads. */
const OVERSEER_LINES = 150;

const CONTAINER_ID_RE = /^[0-9a-f]{12,64}$/;
/** Kinds whose signs of life are watched (the others log nothing while they work: their time limit watches them). */
const LIVE_KINDS = new Set(["ai", "manager", "script", "integration"]);
/** Kinds the supervisor may stop for being quiet. An integration's harness can run quietly for hours. */
const STUCK_KINDS = new Set(["ai", "manager", "script"]);
/** Kinds whose output says anything about a loop. */
const OUTPUT_KINDS = new Set(["ai", "manager", "auto", "script", "integration", "subflow", "stack"]);

const mins = (ms: number) => (ms >= 60_000 ? `${Math.round(ms / 60_000)} min` : `${Math.max(1, Math.round(ms / 1000))} s`);
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

/** The node a key names (`sub/plan` = node `plan` inside subflow node `sub`) and its resolved config. */
export function nodeAt(key: string, flow: Flow | undefined, data: Pick<AppData, "flows" | "blocks">): { node: FlowNode; cfg: ResolvedConfig } | undefined {
  let f = flow;
  let found: { node: FlowNode; cfg: ResolvedConfig } | undefined;
  for (const id of key.split("/")) {
    const node = f?.nodes.find((x) => x.id === id);
    if (!node) return undefined;
    try {
      found = { node, cfg: resolveNode(node, data.blocks) };
    } catch {
      return undefined;
    }
    f = found.cfg.kind === "subflow" ? data.flows.find((x) => x.id === found!.cfg.subflow.flowId) : undefined;
  }
  return found;
}

export type OverseerVerdict = { verdict: "ok" | "concern" | "stuck"; node: string; message: string; action: "none" | "steer" | "restart" };

/** The overseer's answer, validated (MEOW validates an agent's decision file): the verdict, or why it can't be used. */
export function parseVerdict(text: string, nodes: string[]): OverseerVerdict | { error: string } {
  const t = text.trim();
  let raw: unknown;
  for (const candidate of [t, t.slice(t.indexOf("{"), t.lastIndexOf("}") + 1)]) {
    try {
      raw = JSON.parse(candidate);
      break;
    } catch {
      /* try the next */
    }
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { error: "no JSON object in its answer" };
  const v = raw as Record<string, unknown>;
  if (!["ok", "concern", "stuck"].includes(v.verdict as string)) return { error: `invalid verdict ${JSON.stringify(v.verdict)}` };
  const action = v.action === undefined ? "none" : v.action;
  if (!["none", "steer", "restart"].includes(action as string)) return { error: `invalid action ${JSON.stringify(v.action)}` };
  if (typeof v.node !== "string" || !nodes.includes(v.node)) return { error: `"node" must be one of ${nodes.join(", ")}` };
  const message = typeof v.message === "string" ? v.message.trim() : "";
  if (action === "steer" && !message) return { error: "a steer needs a message" };
  return { verdict: v.verdict as OverseerVerdict["verdict"], node: v.node, message: clip(message, 2000), action: action as OverseerVerdict["action"] };
}

/** What the overseer is asked: per running agent node, its task, how long it has run, its latest activity, its earlier verdicts. */
export function overseerPrompt(run: RunState, nodes: { key: string; label: string; cfg: ResolvedConfig; ns: NodeRunState }[], now: number): string {
  const parts = [
    `You oversee a run of the Sandflow flow "${run.flowName}". For its running AI agents below, judge whether each is making progress on its task. You have no tools: judge from what's here.`,
    `Answer with ONLY one JSON object, nothing else:`,
    `{"verdict": "ok" | "concern" | "stuck", "node": "<node key>", "message": "<one or two sentences>", "action": "none" | "steer" | "restart"}`,
    [
      `- ok: it is progressing (action "none").`,
      `- concern: something is off (going in circles, drifting from its task, …). action "steer" sends "message" to the agent to put it back on track, so write it TO the agent; or "none" to only note it.`,
      `- stuck: it is making no progress at all (action "restart": it is stopped and may be run again).`,
      `Name the one node that most needs attention (any node if all are fine).`,
    ].join("\n"),
  ];
  for (const n of nodes) {
    const task = [n.cfg.instructions, n.cfg.extraInstructions].filter((s) => s.trim()).join("\n\n");
    const activity = (run.activity?.[n.key] ?? []).filter((a) => a.exec === undefined || a.exec === n.ns.executions);
    const lines = activity.length
      ? activity.map((a) => `${a.kind}${a.name ? ` ${a.name}` : ""}: ${clip(a.text.replace(/\s+/g, " "), 300)}`)
      : run.logs.filter((l) => l.nodeId === n.key && (l.ts >= (n.ns.startedAt ?? 0))).map((l) => clip(l.msg.replace(/\s+/g, " "), 300));
    const verdicts = (run.supervision ?? []).filter((s) => s.kind === "overseer" && s.node === n.key && s.exec === n.ns.executions).slice(-5);
    parts.push(
      [
        `## Node "${n.key}" (${n.label}) — running for ${mins(now - (n.ns.startedAt ?? now))}`,
        `### Task\n${clip(task || "(no instructions)", 3000)}`,
        `### Input\n${clip(n.ns.inputs?.artifact?.trim() || run.prompt?.trim() || "(none)", 2000)}`,
        `### Latest activity (oldest first)\n${lines.slice(-OVERSEER_LINES).join("\n") || "(nothing yet)"}`,
        `### Your earlier verdicts on it\n${verdicts.map((v) => `- ${v.detail}${v.action ? ` (${v.action})` : ""}`).join("\n") || "(none)"}`,
      ].join("\n\n"),
    );
  }
  return parts.join("\n\n");
}

export function createSupervisor(deps: SupervisorDeps): Supervisor {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms).unref?.()));
  const warn = deps.warn ?? ((m: string) => console.warn(`[supervisor] ${m}`));
  /** Containers looked up lately (at most every `sandboxCheckSeconds` each). */
  const containers = new Map<string, { at: number; exists?: boolean }>();
  /** Per run: when the overseer last looked, and whether it's looking now. */
  const overseerAt = new Map<string, number>();
  const overseeing = new Set<string>();
  const inflight = new Set<Promise<void>>();
  const abort = new AbortController();
  let running = false;

  async function containerGone(kind: "docker" | "podman", id: string, t: number): Promise<boolean> {
    let c = containers.get(id);
    if (!c || t - c.at >= SUPERVISOR_DEFAULTS.sandboxCheckSeconds * 1000) {
      c = { at: t, exists: await deps.containerExists!(kind, id).catch(() => undefined) };
      containers.set(id, c);
    }
    return c.exists === false;
  }

  async function checkRun(h: RunHandle, data: Pick<AppData, "flows" | "blocks" | "settings">, s: EffectiveSupervisor) {
    const run = h.state;
    if (isSettled(run) || run.phase === "pausing") return;
    const t = now();
    const flow = data.flows.find((f) => f.id === run.flowId);
    const entries = () => run.supervision ?? [];
    const note = (e: Omit<SupervisionEntry, "at">) => h.supervise({ at: t, ...e });

    for (const [key, ns] of Object.entries(run.nodes)) {
      const at = nodeAt(key, flow, data);
      if (!at) continue;
      const { cfg } = at;
      const label = nodeLabel(at.node, data.blocks);

      // 4. Loops: the same output as the previous execution, and it ran often (`maxSteps` still bounds it).
      if (
        OUTPUT_KINDS.has(cfg.kind) &&
        ns.executions >= SUPERVISOR_DEFAULTS.loopWarnAfter &&
        (ns.repeats ?? 0) > 0 &&
        !entries().some((e) => e.kind === "loop" && e.node === key)
      ) {
        const detail = `${label} ran ${ns.executions} times and produced the same output as its previous run — the flow may be looping without progress`;
        h.flag("warning", detail, { nodeKey: key });
        note({ node: key, exec: ns.executions, kind: "loop", detail, action: "flagged" });
      }

      if (ns.status !== "running" || ns.startedAt === undefined) continue;
      // Time spent waiting on the user (this node or a step inside it) isn't the node's own.
      const asked = (run.questions ?? []).filter((q) => (q.nodeId === key || q.nodeId.startsWith(`${key}/`)) && q.askedAt >= ns.startedAt!);
      if (run.pendingQuestion && asked.some((q) => q.answer === undefined)) continue;
      const waited = asked.reduce((sum, q) => sum + ((q.answeredAt ?? t) - q.askedAt), 0);
      const lastAnswer = Math.max(0, ...asked.map((q) => q.answeredAt ?? 0));

      // 3. Time limits.
      const limit = nodeTimeoutSeconds(cfg);
      if (limit !== undefined && t - ns.startedAt - waited > limit * 1000) {
        const detail = `${label} ran longer than its time limit of ${mins(limit * 1000)}`;
        if (h.stopNode(key, "timeout", detail)) note({ node: key, exec: ns.executions, kind: "timeout", detail, action: "stopped" });
        continue;
      }

      // 6. Its container vanished (looked up at most every 60 s).
      const where = ns.session?.where;
      if (deps.containerExists && where && CONTAINER_ID_RE.test(where)) {
        const kind = run.sandboxes?.find((c) => c.containerId === where)?.kind ?? (data.settings.sandbox === "podman" ? "podman" : "docker");
        if (await containerGone(kind, where, t)) {
          const detail = `${label}'s ${kind} container (${where.slice(0, 12)}) is gone`;
          if (h.stopNode(key, "sandbox", "its container is gone")) note({ node: key, exec: ns.executions, kind: "sandbox", detail, action: "stopped" });
          continue;
        }
      }

      // 2. Signs of life.
      if (!LIVE_KINDS.has(cfg.kind)) continue;
      const last = Math.max(ns.lastActivityAt ?? 0, ns.startedAt, lastAnswer);
      const quiet = t - last;
      if (STUCK_KINDS.has(cfg.kind) && quiet > s.stuckAfterSeconds * 1000) {
        const detail = `${label} showed no sign of life for ${mins(quiet)}`;
        if (h.stopNode(key, "stuck", `${detail} — stopped by the supervisor`)) note({ node: key, exec: ns.executions, kind: "stuck", detail, action: "stopped" });
        continue;
      }
      const silentAfter = s.silentAfterSeconds ?? (isAgentKind(cfg) ? SUPERVISOR_DEFAULTS.silentAgentSeconds : SUPERVISOR_DEFAULTS.silentOtherSeconds);
      // Once per silence: a flag raised after its last sign of life covers this one.
      if (quiet > silentAfter * 1000 && !entries().some((e) => e.kind === "silent" && e.node === key && e.at > last)) {
        const detail = `${label} has been silent for ${mins(quiet)}`;
        h.flag("warning", detail, { nodeKey: key });
        note({ node: key, exec: ns.executions, kind: "silent", detail, action: "flagged" });
      }
    }

    // 5. A question nobody has answered: remind (watchers / the Run tab see it), at most hourly.
    const q = run.pendingQuestion;
    if (q?.askedAt !== undefined && t - q.askedAt > s.remindAfterSeconds * 1000) {
      const prev = entries().filter((e) => e.kind === "reminder" && e.node === q.nodeId && e.at >= q.askedAt!).at(-1);
      if (!prev || t - prev.at >= SUPERVISOR_DEFAULTS.remindEverySeconds * 1000) {
        note({ node: q.nodeId, kind: "reminder", detail: `A question has waited ${mins(t - q.askedAt)} for your answer: ${clip(q.question, 300)}`, action: "reminded" });
      }
    }

    // The overseer: while an agent runs, every `everySeconds`, beside the ticks (it may take a while).
    const ov = validateOverseerSafe(flow?.overseer);
    if (!ov || !deps.overseer || overseeing.has(run.id)) return;
    const agents = Object.entries(run.nodes).flatMap(([key, ns]) => {
      if (ns.status !== "running") return [];
      const at = nodeAt(key, flow, data);
      return at && isAgentKind(at.cfg) ? [{ key, label: nodeLabel(at.node, data.blocks), cfg: at.cfg, ns }] : [];
    });
    if (!agents.length) return;
    const since = overseerAt.get(run.id) ?? Math.min(...agents.map((a) => a.ns.startedAt ?? t));
    if (t - since < (ov.everySeconds ?? SUPERVISOR_DEFAULTS.overseerEverySeconds) * 1000) return;
    overseerAt.set(run.id, t);
    overseeing.add(run.id);
    const p = oversee(h, agents, ov.model || SUPERVISOR_DEFAULTS.overseerModel).finally(() => {
      overseeing.delete(run.id);
      inflight.delete(p);
    });
    inflight.add(p);
  }

  function validateOverseerSafe(o: Flow["overseer"]) {
    try {
      return validateOverseer(o);
    } catch {
      return undefined;
    }
  }

  /** One overseer turn and what follows from it. Its failures are logged on the run; they never fail it. */
  async function oversee(h: RunHandle, agents: { key: string; label: string; cfg: ResolvedConfig; ns: NodeRunState }[], model: string) {
    const run = h.state;
    const execs = new Map(agents.map((a) => [a.key, a.ns.executions]));
    const note = (e: Omit<SupervisionEntry, "at" | "kind">) => !isSettled(run) && h.supervise({ at: now(), kind: "overseer", ...e });
    let text: string;
    try {
      text = await deps.overseer!({ prompt: overseerPrompt(run, agents, now()), model, signal: AbortSignal.any([abort.signal, AbortSignal.timeout(OVERSEER_TIMEOUT_MS)]) });
    } catch (e) {
      return void note({ detail: `The overseer failed: ${clip((e as Error).message, 300)}`, action: "ignored" });
    }
    const v = parseVerdict(text, agents.map((a) => a.key));
    if ("error" in v) return void note({ detail: `The overseer's answer was ignored: ${v.error}`, action: "ignored" });
    const exec = execs.get(v.node)!;
    const ns = run.nodes[v.node];
    const detail = `${v.verdict}: ${v.message || "(no message)"}`;
    // It moved on while the overseer was thinking: the verdict is about something that's over.
    if (!ns || ns.status !== "running" || ns.executions !== exec) return void note({ node: v.node, exec, detail, action: "ignored" });
    const mine = (run.supervision ?? []).filter((e) => e.kind === "overseer" && e.node === v.node && e.exec === exec);
    if (v.verdict === "stuck" || v.action === "restart") {
      if (mine.filter((e) => e.action === "stopped").length >= MAX_OVERSEER_RESTARTS) return void note({ node: v.node, exec, detail: `${detail} (already restarted once)`, action: "ignored" });
      if (h.stopNode(v.node, "stuck", `The overseer judged it stuck: ${v.message || "no progress"}`)) return void note({ node: v.node, exec, detail, action: "stopped" });
      return void note({ node: v.node, exec, detail, action: "ignored" });
    }
    if (v.verdict === "concern" && v.action === "steer") {
      const steered = mine.filter((e) => e.action === "steered");
      if (steered.length >= MAX_OVERSEER_STEERS) return void note({ node: v.node, exec, detail: `${detail} (steer limit reached)`, action: "ignored" });
      if (steered.at(-1)?.detail === detail) return void note({ node: v.node, exec, detail: `${detail} (same as its last steer)`, action: "ignored" });
      const r = h.steer(v.node, v.message);
      return void note({ node: v.node, exec, detail: r.ok ? detail : `${detail} (couldn't steer: ${r.error})`, action: r.ok ? "steered" : "ignored" });
    }
    note({ node: v.node, exec, detail, action: "none" });
  }

  async function tick() {
    let data: Pick<AppData, "flows" | "blocks" | "settings">;
    try {
      data = deps.load();
    } catch (e) {
      return warn(`couldn't load the settings: ${(e as Error).message}`);
    }
    const s = supervisorSettings(data.settings.supervisor);
    for (const h of deps.runs()) {
      try {
        // 1. The driver lock's heartbeat — even with the checks off, or a live run's lock would look stale.
        if (!h.state.parent && !isSettled(h.state)) deps.heartbeat?.(h.state.id);
        if (s.enabled) await checkRun(h, data, s);
      } catch (e) {
        warn(`run ${h.state.id}: ${(e as Error).message}`);
      }
    }
  }

  return {
    tick,
    start() {
      if (running) return;
      running = true;
      void (async () => {
        while (running) {
          await tick();
          let poll: number = SUPERVISOR_DEFAULTS.pollSeconds;
          try {
            poll = supervisorSettings(deps.load().settings.supervisor).pollSeconds;
          } catch {
            /* keep the default */
          }
          if (running) await sleep(poll * 1000);
        }
      })();
    },
    stop() {
      running = false;
      abort.abort();
    },
    async drain() {
      while (inflight.size) await Promise.allSettled([...inflight]);
    },
  };
}

/**
 * The real overseer: one `claude -p` turn on this machine with no tools (nothing it says can touch anything), the
 * prompt on stdin, in an empty folder so no project's CLAUDE.md or settings come along.
 */
export const claudeOverseer: OverseerRunner = async ({ prompt, model, signal }) => {
  const bin = resolveCli(["claude"]);
  const args = ["-p", "--output-format", "text", "--tools", "", "--strict-mcp-config", "--model", model];
  const o = { cwd: os.tmpdir(), stdin: prompt, signal, timeoutMs: OVERSEER_TIMEOUT_MS };
  const r = bin.viaCmd
    ? await runTree(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", cmdLine(bin.cmd, args)], { ...o, windowsVerbatimArguments: true })
    : await runTree(bin.cmd, [...bin.args, ...args], { ...o, env: bin.args.length ? { ...process.env, ELECTRON_RUN_AS_NODE: "1" } : process.env });
  if (r.killed) throw new Error(`claude ${r.killed}`);
  if (r.code !== 0) throw new Error(`claude exited with code ${r.code}${r.stderr.trim() ? `: ${clip(r.stderr.trim().split("\n").slice(-3).join(" "), 300)}` : ""}`);
  return r.stdout;
};
