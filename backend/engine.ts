import { randomUUID } from "node:crypto";
import path from "node:path";
import { appendActivity, capRunActivity, type ActivityDraft, type AgentActivity } from "../shared/activity";
import { describeCondition, evaluateCondition } from "../shared/conditions";
import { eventMarkdown } from "../shared/events";
import { nodeLabel, resolveNode } from "../shared/resolve";
import { DEFAULT_EXIT, MAX_SUBFLOW_DEPTH, exitHandle, isExitHandle } from "../shared/subflow";
import type {
  BlockDef,
  BranchHandle,
  IntegrationInfo,
  TriggerEvent,
  EnvValues,
  Flow,
  FlowNode,
  LogLine,
  NodeIO,
  QuestionRecord,
  ResolvedConfig,
  RunFlag,
  RunStartedBy,
  FlagSeverity,
  RunState,
  SandboxKind,
  SteerRecord,
  Settings,
  StackRunInfo,
  SkillFileRef,
} from "../shared/types";
import type { ResumePlan } from "../shared/resume";
import { DELIVERY_WAIT_MS, JOURNAL_SCHEMA, PAUSE_GRACE_MS, PAUSE_REASON_TEXT, activeNodeKeys, statusOfPhase } from "../shared/journal";
import { GUARD_TEXT, classifyFailure, recoverySettings, reviewPrompt } from "../shared/recovery";
import { MAX_STEER_CHARS } from "../shared/types";
import type { AgentSessionRef, FailureCause, NodeRunState, NodeUsage, PauseReason, QueuedStep, RunPhase } from "../shared/types";
import { flowFingerprint, settingsFingerprint } from "./journal";
import type { PackRuntimeInfo } from "./packs";
import { decideAfterFailure, withTriageNotes, type AfterFailure, type TriageRunner } from "./recovery";
import { runStack } from "./stack";
import type { SkillFile } from "./skills";

/** Steering messages one agent may have waiting, and a run may get in all. */
const MAX_PENDING_STEERS = 20;
const MAX_RUN_STEERS = 500;

export interface NodeResult {
  outputs: NodeIO;
  /** manager: id of the chosen target node. */
  route?: string;
  /** script / subflow: the named exit it leaves through. */
  exit?: string;
  /** Flags to raise on the run, from this node (e.g. a script's `flags` output). */
  flags?: { severity: FlagSeverity; message: string; details?: string }[];
}

export type NodeRunner = (
  ctx: RunContext,
  node: FlowNode,
  cfg: ResolvedConfig,
  inputs: NodeIO,
) => Promise<NodeResult>;

/** What the integration runner needs: the definitions of every integration (from packs and your own). */
export interface RunIntegrations {
  get(id: string): IntegrationInfo | undefined;
}

/** What runners need to know about installed packs. */
export interface RunPacks {
  runtime(id: string): PackRuntimeInfo | undefined;
  /** Every installed pack folder (mounted read-only into agent sandboxes). */
  dirs(): { id: string; dir: string }[];
  /** Where prepared copies of packs (setup done, executables linked) are kept for scripts run on this machine. */
  runtimeRoot: string;
}

export interface RunContext {
  run: RunState;
  /** The flow being executed (a subflow's own flow while one of its nodes runs). */
  flow: Flow;
  blocks: BlockDef[];
  /** Every flow — subflows are looked up here. */
  flows: Flow[];
  env: EnvValues;
  settings: Settings;
  /** Set by Create task; used as the sandbox branch. */
  branch?: string;
  /** Branch the sandbox branch is cut from when it doesn't exist yet (default: BASE_BRANCH). */
  baseBranch?: string;
  /** Lazily created sandcastle sandbox, shared by every AI block of the run. */
  sandbox?: unknown;
  /** Sandboxes while they're being created, by kind. */
  sandboxPending?: Partial<Record<SandboxKind, Promise<unknown>>>;
  /** A Box Stack task with an isolated workspace: the context of the run that started it (where it merges into). */
  parentContext?: RunContext;
  /**
   * Sandboxes of a kind other than Settings → Sandbox, for agent blocks that choose where they run (`runOn`): `none`
   * = this computer. All of a run's sandboxes share the same branch and worktree.
   */
  sandboxes?: Partial<Record<SandboxKind, unknown>>;
  /** While a subflow's node runs: the flows around it, innermost first (where they run agents is inherited). */
  outerFlows?: Flow[];
  abort: AbortController;
  installedSkills: Set<string>;
  /** Only the env vars the block declares — never leak all globals. */
  blockEnv(cfg: ResolvedConfig): Record<string, string>;
  log(level: LogLine["level"], msg: string, nodeId?: string): void;
  /** What an agent node is thinking / doing (batched: shown live within ACTIVITY_FLUSH_MS, saved with the run). */
  activity?(nodeId: string, items: ActivityDraft[]): void;
  /** Pause the run until the user answers (rejects when the run is cancelled). */
  ask(nodeId: string, question: string): Promise<string>;
  /**
   * An agent node accepts steering messages while it runs: `onSteer` is called for each message the user sends it
   * (see `RunHandle.steer`). Close the inbox when the node is done.
   */
  steerable?(nodeId: string, onSteer: () => void): SteerInbox;
  /** Raise a flag on the run: saved with it, shown in the run list and as an alert. */
  flag(severity: FlagSeverity, message: string, o?: { nodeKey?: string; details?: string; fromRunId?: string }): RunFlag;
  /** Teardown callbacks run when the run ends (e.g. sandbox.close()). */
  cleanup: Array<() => Promise<unknown>>;
  /** Where agent logs are written (per node). */
  logDir?: string;
  /** Reads the files of a file skill (bundled, uploaded or from a pack). */
  loadSkill?: (ref: SkillFileRef) => Promise<SkillFile[]>;
  packs?: RunPacks;
  integrations?: RunIntegrations;
  /** Packs whose runtime copy is already prepared in this run's sandbox. */
  preparedPacks: Set<string>;

  // ---- journal (see shared/journal.ts) ----
  /** Write the run's journal now (not throttled). A failed write is logged; it never fails the caller. */
  journal?(): void;
  /** The node's own state in the run (node ids are scoped like `log`'s). */
  nodeState?(nodeId: string): NodeRunState | undefined;
  /**
   * Run an irreversible step (create an MR, push, post a comment, merge): a pause or Stop waits for it (bounded)
   * instead of cutting it in half (MEOW `delivery_lock`).
   */
  deliver?<T>(fn: () => Promise<T>): Promise<T>;
  /**
   * The node is re-running after its attempt was interrupted (pause / crash) or failed (recovery): returns what it
   * continues from, once — only the first call of the attempt continues it (MEOW resumes a session on its first query).
   */
  takeInterrupted?(nodeId: string): RerunFrom | undefined;
  /** An agent's session id appeared (journaled right away so a crash can continue it). */
  noteSession?(nodeId: string, session: AgentSessionRef): void;
  noteUsage?(nodeId: string, usage: Omit<NodeUsage, "at">): void;
  /** A sandbox container / an agent process on this computer started (removed if a crash leaves it behind). */
  noteContainer?(kind: "docker" | "podman", containerId: string): void;
  noteProcess?(pid: number, startedAt: number, running: boolean): void;
}

/**
 * What a step running again continues from: its agent's session (continued with `prompt`, default "you were
 * interrupted…"), or — `fresh` — a new session with `prompt` in front of its task (recovery recycles a session).
 */
export interface RerunFrom {
  session?: AgentSessionRef;
  prompt?: string;
  fresh?: boolean;
}

/** Steering messages for one running agent node. */
export interface SteerInbox {
  /** Messages not handed to the agent yet, oldest first. */
  pending(): SteerRecord[];
  /** The agent got these (logged, and shown in its activity). */
  applied(records: SteerRecord[], how: NonNullable<SteerRecord["how"]>): void;
  /** Note for the user on still-pending messages (e.g. "queued until the agent's next turn"). */
  note(records: SteerRecord[], note: string): void;
  /** The node is done: anything still pending is dropped with `why`. */
  close(why?: string): void;
}

export type SteerResult = { ok: true; steer: SteerRecord } | { ok: false; status: 400 | 404 | 409; error: string };

export interface StartRunOptions {
  flow: Flow;
  blocks: BlockDef[];
  /** Every flow (for subflows). Defaults to just `flow`. */
  flows?: Flow[];
  env: EnvValues;
  settings: Settings;
  /** `triage`: the recovery triage agent — without it a failed step fails the run (recovery is off). */
  runners: { auto: NodeRunner; ai: NodeRunner; script?: NodeRunner; integration?: NodeRunner; triage?: TriageRunner };
  /** Waits between automatic retries (default: a timer). */
  sleep?: (ms: number) => Promise<void>;
  onChange?: (state: RunState) => void;
  saveArtifact?: (runId: string, nodeId: string, n: number, text: string) => void;
  /** Base directory for per-run agent logs (`<logRoot>/<runId>/<nodeId>.log`). */
  logRoot?: string;
  loadSkill?: (ref: SkillFileRef) => Promise<SkillFile[]>;
  packs?: RunPacks;
  integrations?: RunIntegrations;
  /** The event that started the run (default: a manual event). */
  trigger?: TriggerEvent;
  /** Start only from this (trigger) node — used for triggered runs. Default: every node without inputs. */
  startNodeId?: string;
  /** Starting prompt for this run only; overrides `settings.startingPrompt`. */
  prompt?: string;
  /** Called for every flag raised on this run. */
  onFlag?: (run: RunState, flag: RunFlag) => void;
  /** Run the flow from its Flow input with these inputs (like a subflow); the exit reached goes to `run.result`. */
  entry?: NodeIO;
  /** Subflow nesting depth this run starts at (stack children run one deeper than their stack). */
  depth?: number;
  parent?: { runId: string; nodeKey: string };
  stack?: StackRunInfo;
  /** Work in this run's sandbox (a stack's Shared workspace): sandbox, branch and installed skills are shared. */
  share?: RunContext;
  /** Sandbox branch for this run, and the branch it's cut from. */
  branch?: string;
  baseBranch?: string;
  parentContext?: RunContext;
  /** Called when this run starts a child run (a stack's task), so the caller can track, save and stream it. */
  onSpawn?: (child: RunHandle) => void;
  /** Longest each cleanup step (e.g. closing a sandbox) may take before the run ends without it. Default 20 s. */
  cleanupTimeoutMs?: number;
  /** Logged as warnings when the run starts (e.g. it shares a branch with another run). */
  warnings?: string[];
  /** Recorded on the run: who started it from outside the app (Claude Code). */
  startedBy?: RunStartedBy;
  /**
   * Resume `from` (a finished run of this flow, see shared/resume.ts): start only at the plan's steps, with the inputs
   * they had, after copying the other steps' states and outputs from it. Its trigger event is reused; pass its
   * starting prompt as `prompt` and its branch as `branch`.
   */
  resume?: { from: RunState; plan: ResumePlan };
  /**
   * Continue this paused / interrupted run as the same run (same id): finished steps are skipped, interrupted ones
   * run again, every graph's journaled queue is restored. Pass its branch as `branch` and its prompt as `prompt`.
   */
  continueFrom?: RunState;
  /** Write the journal now (node start / finish, queue and phase changes, sessions) — not throttled like onChange. */
  onJournal?: (state: RunState) => void;
  /** Reads a saved run (a Box Stack continuing its tasks' runs). */
  loadRun?: (id: string) => RunState | undefined;
  /** How long running steps get to finish when the run pauses (default PAUSE_GRACE_MS). */
  pauseGraceMs?: number;
  /** Longest a pause / Stop waits for an irreversible step (default DELIVERY_WAIT_MS). */
  deliveryWaitMs?: number;
}

export interface RunHandle {
  state: RunState;
  done: Promise<RunState>;
  answer(answer: string): boolean;
  /** Send a steering message to a running agent node (by node key). */
  steer(nodeKey: string, message: string): SteerResult;
  cancel(): void;
  /**
   * Pause instead of cancel (quit, update): no new step starts, running steps get a short grace period, then their
   * processes are stopped and their attempts marked interrupted. Resolves once the run is paused (`done`).
   */
  pause(reason: Exclude<PauseReason, "crash" | "blocked">): Promise<RunState>;
}

const MAX_LOGS = 2000;
/** Agent activity is pushed to the UI at most this often per run. */
export const ACTIVITY_FLUSH_MS = 300;
const CLEANUP_TIMEOUT_MS = 20_000;

/** A step in a graph's queue; `again` = its attempt was interrupted, it runs again (same execution). */
type QueueItem = QueuedStep & { again?: boolean };

/** Where a graph run ended up: a subflow reached one of its Flow outputs (or ran out of nodes). */
interface GraphResult {
  exit?: string;
  outputs?: NodeIO;
}

/**
 * The context runners see while a node of a subflow runs: same run, sandbox and settings, but `flow` is the
 * subflow and node ids are reported under the subflow node (`<subflowNode>/<node>`).
 */
function scopedContext(ctx: RunContext, flow: Flow, prefix: string, outerFlows: Flow[]): RunContext {
  if (!prefix) return ctx;
  const own: Partial<RunContext> = {
    flow,
    outerFlows,
    log: (level, msg, nodeId) => ctx.log(level, msg, nodeId === undefined ? undefined : prefix + nodeId),
    activity: (nodeId, items) => ctx.activity?.(prefix + nodeId, items),
    ask: (nodeId, question) => ctx.ask(prefix + nodeId, question),
    steerable: (nodeId, onSteer) => ctx.steerable!(prefix + nodeId, onSteer),
    flag: (severity, message, o) => ctx.flag(severity, message, o?.nodeKey === undefined ? o : { ...o, nodeKey: prefix + o.nodeKey }),
    nodeState: (nodeId) => ctx.nodeState?.(prefix + nodeId),
    takeInterrupted: (nodeId) => ctx.takeInterrupted?.(prefix + nodeId),
    noteSession: (nodeId, session) => ctx.noteSession?.(prefix + nodeId, session),
    noteUsage: (nodeId, usage) => ctx.noteUsage?.(prefix + nodeId, usage),
    logDir: ctx.logDir ? path.join(ctx.logDir, prefix.replace(/[^\w-]/g, "_")) : undefined,
  };
  return new Proxy(ctx, {
    get: (target, key) => (key in own ? own[key as keyof RunContext] : Reflect.get(target, key)),
    // Runners set ctx.branch / ctx.sandbox — those belong to the whole run.
    set: (target, key, value) => Reflect.set(target, key, value),
  });
}

/** Blocks whose cut-off attempt may have left files half-changed (MEOW `interrupted_mutation`). */
export function mutates(cfg: ResolvedConfig): boolean {
  if (cfg.kind === "auto") return cfg.autoAction === "shell" || cfg.autoAction === "create-mr" || cfg.autoAction === "merge-parent";
  return cfg.kind === "ai" || cfg.kind === "manager" || cfg.kind === "script" || cfg.kind === "integration";
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms).unref?.());

/** Where the run's work is (for the triage agent): its sandbox's worktree, else the project. */
function runWorktree(ctx: RunContext): string | undefined {
  const sb = (ctx.sandbox ?? ctx.sandboxes?.none ?? Object.values(ctx.sandboxes ?? {})[0]) as { worktreePath?: unknown } | undefined;
  if (typeof sb?.worktreePath === "string") return sb.worktreePath;
  return ctx.env.REPO_PATH?.trim() || undefined;
}

export function startRun(opts: StartRunOptions): RunHandle {
  const { flow, blocks, env, runners } = opts;
  const flows = opts.flows?.some((f) => f.id === flow.id) ? opts.flows : [...(opts.flows ?? []), flow];
  const settings: Settings = opts.prompt === undefined ? opts.settings : { ...opts.settings, startingPrompt: opts.prompt };
  const cont = opts.continueFrom;
  const run: RunState = cont ?? {
    id: `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`,
    flowId: flow.id,
    flowName: flow.name,
    status: "running",
    startedAt: Date.now(),
    nodes: Object.fromEntries(flow.nodes.map((n) => [n.id, { status: "idle", executions: 0 }])),
    logs: [],
    questions: [],
    prompt: settings.startingPrompt,
    trigger: opts.resume?.from.trigger ?? opts.trigger ?? { source: "manual", type: "manual", firedAt: Date.now() },
    triggerNodeId: opts.resume ? opts.resume.from.triggerNodeId : opts.startNodeId,
    ...(opts.parent ? { parent: opts.parent } : {}),
    ...(opts.stack ? { stack: opts.stack } : {}),
    ...(opts.entry ? { input: opts.entry } : {}),
    schemaVersion: JOURNAL_SCHEMA,
    phase: "running",
    attempt: 1,
    transitions: [{ phase: "running", at: Date.now(), attempt: 1 }],
    steps: 0,
    ...(opts.startedBy ? { startedBy: opts.startedBy } : {}),
  };
  if (cont) {
    // The same run, again: what was going when it stopped runs again (see `continuing` below).
    run.attempt = (run.attempt ?? 1) + 1;
    run.stalls = (run.stalls ?? 0) + 1;
    run.finishedAt = undefined;
    run.hold = undefined;
    run.pauseReason = undefined;
    run.pendingQuestion = undefined;
    run.error = undefined;
    for (const n of flow.nodes) run.nodes[n.id] ??= { status: "idle", executions: 0 };
  } else if (!opts.share) {
    // What a resume needs to find this run's work again (see shared/resume.ts).
    const repo = env.REPO_PATH?.trim();
    run.workspace = { ...(repo ? { repo } : {}), branch: opts.branch || env.BRANCH_NAME?.trim() || `sandflow/${run.id}` };
  }
  if (!cont) {
    // What continuing checks against later (MEOW plan / config fingerprints); the server adds the branch's commit.
    run.fingerprints = {
      flow: flowFingerprint(flow, flows, blocks),
      settings: settingsFingerprint(settings),
      workspace: { ...(run.workspace?.repo ? { repo: run.workspace.repo } : {}), branch: run.workspace?.branch ?? opts.branch ?? `sandflow/${run.id}` },
    };
  }

  /**
   * Continuing: each graph's queue (by node-key prefix) as it starts again — first the steps whose attempt was cut
   * off (they run again with the inputs they had), then what was still queued. Taken once per graph.
   */
  const resumeQueues = new Map<string, QueueItem[]>();
  /** Interrupted node keys → what their re-run continues from (handed out once, see `takeInterrupted`). */
  const interruptedNodes = new Map<string, RerunFrom>();
  if (cont) {
    const prefixOf = (k: string) => k.slice(0, k.lastIndexOf("/") + 1);
    for (const [p, q] of Object.entries(cont.queues ?? {})) resumeQueues.set(p, q.map((s) => ({ nodeId: s.nodeId, inputs: { ...s.inputs } })));
    // Outer steps first: a subflow node must run again before the steps inside it can.
    for (const k of activeNodeKeys(cont).sort((a, b) => b.split("/").length - a.split("/").length)) {
      const ns = cont.nodes[k];
      const p = prefixOf(k);
      const q = resumeQueues.get(p) ?? [];
      q.unshift({ nodeId: k.slice(p.length), inputs: { ...(ns.inputs ?? {}) }, again: true });
      resumeQueues.set(p, q);
      // A step that failed (held by recovery) reviews its work against the failure instead of "you were interrupted".
      interruptedNodes.set(k, { session: ns.session, ...(ns.failure ? { prompt: reviewPrompt(ns.failure.cause, ns.failure.message) } : {}) });
    }
    // No queues journaled at all (it died before its first journal write): it starts from the beginning again.
    if (cont.queues && !resumeQueues.has("")) resumeQueues.set("", []);
    for (const ns of Object.values(run.nodes)) if (ns.status === "queued" || ns.status === "running" || ns.status === "waiting") ns.status = "idle";
  }
  const resume = opts.resume;
  if (resume) {
    const { from, plan } = resume;
    run.resumedFrom = { runId: from.id, nodeIds: plan.nodeIds };
    for (const [k, ns] of Object.entries(plan.restored)) run.nodes[k] = structuredClone(ns);
    if (plan.questions.length) run.questions = structuredClone(plan.questions);
    const activity = Object.entries(from.activity ?? {}).filter(([k]) => plan.restored[k]);
    if (activity.length) run.activity = structuredClone(Object.fromEntries(activity));
    if (from.branch && plan.branch === from.branch) run.branch = from.branch;
  }
  const emit = () => opts.onChange?.(run);
  let journalFailed = false;
  /** Save the journal now; a failed write is logged once (until one succeeds again) and never stops the run. */
  const journal = () => {
    emit();
    if (!opts.onJournal) return;
    try {
      opts.onJournal(run);
      journalFailed = false;
    } catch (e) {
      if (!journalFailed) ctx.log("warn", `Couldn't write the run journal (the run goes on): ${(e as Error).message}`);
      journalFailed = true;
    }
  };
  const setPhase = (phase: RunPhase) => {
    if (run.phase === phase) return;
    run.phase = phase;
    run.status = statusOfPhase(phase, run.status);
    (run.transitions ??= []).push({ phase, at: Date.now(), attempt: run.attempt ?? 1 });
    journal();
  };
  /** Set by `pause`: no new step starts, and the run ends paused instead of done / cancelled. */
  let pausing: PauseReason | undefined;
  /** Set by `cancel` (its abort may wait for a delivery in flight): no new step starts. */
  let stopping = false;
  /**
   * Steps stopped on purpose with a cause (the supervisor's stuck / timeout / sandbox), by node key: when the step
   * then fails, that cause wins over what its error looks like.
   */
  const pendingStops = new Map<string, { cause: FailureCause; message: string }>();
  /** Why a step failed: the cause it was stopped with, else what its error looks like (see shared/recovery.ts). */
  const failureCause = (key: string, err: unknown): FailureCause => pendingStops.get(key)?.cause ?? classifyFailure(err);
  /** The run's Recovery setting (its own flow's); recovery needs a triage runner — without one a failure fails the run. */
  const recovery = runners.triage ? recoverySettings(flow, flows, blocks) : undefined;
  const wait = (ms: number) =>
    ms <= 0
      ? Promise.resolve()
      : Promise.race([
          (opts.sleep ?? sleep)(ms),
          new Promise<void>((r) => (ctx.abort.signal.aborted ? r() : ctx.abort.signal.addEventListener("abort", () => r(), { once: true }))),
        ]);
  const halted = () => ctx.abort.signal.aborted || stopping || !!pausing;
  /** Irreversible steps in flight (see `RunContext.deliver`). */
  const delivering = new Set<Promise<unknown>>();
  const deliveriesDone = () =>
    delivering.size ? Promise.race([Promise.allSettled([...delivering]), sleep(opts.deliveryWaitMs ?? DELIVERY_WAIT_MS)]) : Promise.resolve();
  /** Nodes running right now, and who waits for none to be. */
  let runningNodes = 0;
  const idleWaiters = new Set<() => void>();
  const nodeEnded = () => {
    runningNodes--;
    if (runningNodes <= 0) for (const w of [...idleWaiters]) w();
  };
  /** Every live graph's queue by prefix, journaled whenever one changes. */
  const liveQueues = new Map<string, QueueItem[]>();
  const journalQueues = () => {
    run.queues = Object.fromEntries([...liveQueues].map(([p, q]) => [p, q.map(({ nodeId, inputs }): QueuedStep => ({ nodeId, inputs }))]));
  };

  let pending: { resolve: (a: string) => void; reject: (e: Error) => void } | undefined;
  /** Running agent nodes that take steering messages, by node key. */
  const steerTargets = new Map<string, () => void>();
  /** Node keys that ever took steering messages. */
  const steerSeen = new Set<string>();

  // Agent activity arrives line by line; it's collected and pushed with the run state a few times a second.
  const activityQueue = new Map<string, (AgentActivity & { chunk?: boolean })[]>();
  let activityTimer: NodeJS.Timeout | undefined;
  const flushActivity = () => {
    clearTimeout(activityTimer);
    activityTimer = undefined;
    if (!activityQueue.size) return;
    const all = (run.activity ??= {});
    for (const [k, items] of activityQueue) all[k] = appendActivity(all[k] ?? [], items);
    capRunActivity(all);
    activityQueue.clear();
    emit();
  };

  const ctx: RunContext = {
    run,
    flow,
    blocks,
    flows,
    env,
    settings,
    abort: new AbortController(),
    installedSkills: new Set(),
    preparedPacks: new Set(),
    cleanup: [],
    logDir: opts.logRoot ? path.join(opts.logRoot, run.id) : undefined,
    loadSkill: opts.loadSkill,
    packs: opts.packs,
    integrations: opts.integrations,
    blockEnv: (cfg) =>
      Object.fromEntries(cfg.env.filter((k) => env[k] !== undefined).map((k) => [k, env[k]])),
    log(level, msg, nodeId) {
      run.logs.push({ ts: Date.now(), level, nodeId, msg });
      if (run.logs.length > MAX_LOGS) run.logs.splice(0, run.logs.length - MAX_LOGS);
      emit();
    },
    activity(nodeId, items) {
      if (!items.length || run.finishedAt) return;
      const exec = run.nodes[nodeId]?.executions;
      const ts = Date.now();
      let q = activityQueue.get(nodeId);
      if (!q) activityQueue.set(nodeId, (q = []));
      for (const it of items) q.push({ ...it, ts, ...(exec ? { exec } : {}) });
      if (!activityTimer) {
        activityTimer = setTimeout(flushActivity, ACTIVITY_FLUSH_MS);
        activityTimer.unref?.();
      }
    },
    flag(severity, message, o = {}) {
      const f: RunFlag = { id: randomUUID().slice(0, 8), severity, message, at: Date.now(), ...o };
      (run.flags ??= []).push(f);
      ctx.log(severity === "error" ? "error" : "warn", `⚑ ${message}`, o.nodeKey);
      opts.onFlag?.(run, f);
      return f;
    },
    steerable(nodeId, onSteer) {
      steerTargets.set(nodeId, onSteer);
      steerSeen.add(nodeId);
      const mine = () => (run.steers ?? []).filter((s) => s.nodeId === nodeId && s.status === "pending");
      return {
        pending: mine,
        applied(records, how) {
          if (!records.length) return;
          const at = Date.now();
          for (const r of records) {
            r.status = "applied";
            r.appliedAt = at;
            r.how = how;
            r.note = undefined;
            ctx.log("info", `Steered by user: ${r.message}`, nodeId);
          }
          ctx.activity?.(nodeId, records.map((r) => ({ kind: "steer" as const, text: r.message })));
          emit();
        },
        note(records, note) {
          for (const r of records) r.note = note;
          if (records.length) emit();
        },
        close(why = "The step ended before the agent got this message") {
          if (steerTargets.get(nodeId) === onSteer) steerTargets.delete(nodeId);
          const left = mine();
          for (const r of left) {
            r.status = "dropped";
            r.note = why;
          }
          if (left.length) {
            ctx.log("warn", `${left.length} steering message${left.length === 1 ? "" : "s"} not delivered: ${why}`, nodeId);
          }
        },
      };
    },
    journal,
    nodeState: (nodeId) => run.nodes[nodeId],
    async deliver(fn) {
      if (halted()) throw new Error(pausing ? "Run paused" : "Run cancelled");
      const p = fn();
      delivering.add(p);
      try {
        return await p;
      } finally {
        delivering.delete(p);
      }
    },
    takeInterrupted(nodeId) {
      const it = interruptedNodes.get(nodeId);
      interruptedNodes.delete(nodeId);
      return it;
    },
    noteSession(nodeId, session) {
      const ns = run.nodes[nodeId];
      if (!ns || (ns.session?.id === session.id && ns.session.where === session.where)) return;
      ns.session = session;
      journal();
    },
    noteUsage(nodeId, usage) {
      const ns = run.nodes[nodeId];
      if (!ns) return;
      (ns.usage ??= []).push({ ...usage, at: Date.now() });
      journal();
    },
    noteContainer(kind, containerId) {
      const list = (run.sandboxes ??= []);
      if (list.some((c) => c.containerId === containerId)) return;
      list.push({ kind, containerId });
      journal();
    },
    noteProcess(pid, startedAt, running) {
      const list = (run.processes ??= []);
      const i = list.findIndex((p) => p.pid === pid);
      if (running && i < 0) list.push({ pid, startedAt });
      else if (!running && i >= 0) list.splice(i, 1);
      else return;
      journal();
    },
    ask(nodeId, question) {
      if (halted()) return Promise.reject(new Error(pausing ? "Run paused" : "Run cancelled"));
      setPhase("waiting");
      run.nodes[nodeId].status = "waiting";
      const askedAt = Date.now();
      const record: QuestionRecord = { nodeId, question, askedAt };
      run.pendingQuestion = { nodeId, question, askedAt };
      (run.questions ??= []).push(record);
      ctx.log("info", `Question: ${question}`, nodeId);
      return new Promise<string>((resolve, reject) => {
        pending = {
          resolve: (a) => {
            pending = undefined;
            run.nodes[nodeId].status = "running";
            run.pendingQuestion = undefined;
            record.answer = a;
            record.answeredAt = Date.now();
            ctx.log("info", `Answer: ${a}`, nodeId);
            setPhase("running");
            resolve(a);
          },
          reject: (e) => {
            pending = undefined;
            run.pendingQuestion = undefined;
            reject(e);
          },
        };
      });
    },
  };

  ctx.branch = opts.branch ?? cont?.branch;
  ctx.baseBranch = opts.baseBranch;
  ctx.parentContext = opts.parentContext;
  if (opts.share) {
    // Shared workspace: the sandbox (and whatever was set up in it) belongs to the run that owns it.
    const owner = opts.share;
    for (const k of ["sandbox", "sandboxes", "sandboxPending", "branch", "baseBranch", "installedSkills", "preparedPacks", "cleanup"] as const) {
      Object.defineProperty(ctx, k, { get: () => owner[k], set: (v) => ((owner as unknown as Record<string, unknown>)[k] = v), enumerable: true });
    }
  }
  for (const w of opts.warnings ?? []) ctx.log("warn", w);
  if (cont) {
    const again = [...interruptedNodes.keys()];
    ctx.log(
      "info",
      `↻ Continuing this run (attempt ${run.attempt})${again.length ? ` — ${again.join(", ")} ${again.length === 1 ? "was" : "were"} interrupted and run${again.length === 1 ? "s" : ""} again` : ""}; finished steps are kept`,
    );
    setPhase("continuing");
  }
  if (resume) {
    const restoredCount = Object.keys(resume.plan.restored).filter((k) => !k.includes("/")).length;
    ctx.log(
      "info",
      `↻ Resuming run ${resume.from.id}: re-running from ${resume.plan.nodeIds.map((id) => {
        const n = flow.nodes.find((x) => x.id === id);
        return n ? nodeLabel(n, blocks) : id;
      }).join(", ")}${restoredCount ? `; ${restoredCount} other step${restoredCount === 1 ? " keeps its" : "s keep their"} outputs from that run` : ""}`,
    );
  }

  let steps = cont?.steps ?? 0;
  /** The top-level graph's queue: what's still waiting when the run ends is saved as `run.unstarted`. */
  let topQueue: { nodeId: string; inputs: NodeIO }[] = [];

  /** Rejects as soon as the run is stopped: a node's runner is raced against it, so Stop never waits on a runner. */
  const stopped = new Promise<never>((_, reject) => {
    const fail = () => reject(new Error("Run cancelled"));
    if (ctx.abort.signal.aborted) fail();
    else ctx.abort.signal.addEventListener("abort", fail, { once: true });
  });
  stopped.catch(() => {});
  const untilStopped = <T>(p: Promise<T>): Promise<T> => {
    p.catch(() => {}); // it may still fail after the run was stopped — nobody waits for it any more
    return Promise.race([p, stopped]);
  };

  /**
   * Run one flow's graph. Top level (`entry` undefined): starts at the trigger node or every node without inputs.
   * As a subflow: starts at its Flow input blocks with the parent's inputs, and returns as soon as a Flow output
   * is reached.
   */
  async function runGraph(g: Flow, prefix: string, depth: number, entry?: NodeIO, outer: Flow[] = []): Promise<GraphResult> {
    const gctx = scopedContext(ctx, g, prefix, outer);
    const byId = new Map(g.nodes.map((n) => [n.id, n]));
    const key = (id: string) => prefix + id;
    const label = (id: string) => {
      const n = byId.get(id);
      return n ? nodeLabel(n, blocks) : id;
    };
    for (const n of g.nodes) run.nodes[key(n.id)] ??= { status: "idle", executions: 0 };
    const kindOf = (n: FlowNode) => {
      try {
        return resolveNode(n, blocks).kind;
      } catch {
        return undefined;
      }
    };

    const incoming = new Set(g.edges.map((e) => e.target));
    // Continuing: this graph picks up from its journaled queue (once — a later pass through a subflow starts afresh).
    const resumed = resumeQueues.get(prefix);
    resumeQueues.delete(prefix);
    let starts: FlowNode[];
    if (resumed) {
      starts = [];
      for (const q of resumed.filter((q) => !byId.has(q.nodeId))) ctx.log("warn", `Step ${key(q.nodeId)} is no longer in the flow — skipped`);
    } else if (entry) {
      starts = g.nodes.filter((n) => kindOf(n) === "flow-input");
      // No Flow input: start where a top-level run would (never at a trigger — they don't fire inside subflows).
      if (!starts.length) starts = g.nodes.filter((n) => !incoming.has(n.id) && kindOf(n) !== "trigger");
      if (!starts.length) throw new Error(`Subflow "${g.name}" has nothing to start from — add a Flow input`);
    } else if (resume && !prefix) {
      const missing = resume.plan.starts.filter((s) => !byId.has(s.nodeId));
      if (missing.length) throw new Error(`Step ${missing.map((s) => s.nodeId).join(", ")} is no longer in the flow`);
      starts = [];
    } else {
      starts = opts.startNodeId ? g.nodes.filter((n) => n.id === opts.startNodeId) : g.nodes.filter((n) => !incoming.has(n.id));
      if (!starts.length) {
        throw new Error(
          opts.startNodeId ? `Trigger node ${opts.startNodeId} not found` : "Flow has no start node (every node has an incoming edge)",
        );
      }
    }

    const queue: QueueItem[] = resumed
      ? resumed.filter((q) => byId.has(q.nodeId))
      : resume && !prefix && !entry
        ? resume.plan.starts.map((s) => ({ nodeId: s.nodeId, inputs: { ...s.inputs } }))
        : starts.map((n) => ({ nodeId: n.id, inputs: {} }));
    if (!prefix && !entry) topQueue = queue;
    for (const q of queue) run.nodes[key(q.nodeId)].status = "queued";
    liveQueues.set(prefix, queue);
    journalQueues();
    journal();
    if (!prefix) setPhase(run.pendingQuestion ? "waiting" : "running");

    try {
      while (queue.length) {
        if (halted()) return {};
        const { nodeId, inputs, again } = queue.shift()!;
        // An interrupted step running again is the same step: it was counted when it started.
        if (!again && ++steps > settings.maxSteps) {
          throw new Error(`Max steps exceeded (${settings.maxSteps}) — is the flow stuck in a loop?`);
        }
        run.steps = steps;
        const k = key(nodeId);
        const node = byId.get(nodeId)!;
        // Triage notes for this step (recovery `resume`) are part of its instructions for the rest of the run.
        const cfg = withTriageNotes(resolveNode(node, blocks), run.recovery?.[k]);
        const ns = run.nodes[k];
        if (ns.restored) {
          // A restored step reached again (e.g. a loop back to it): it runs for real now.
          delete ns.restored;
          ns.executions = 0;
        }
        ns.status = "running";
        if (!again || !ns.executions) ns.executions++;
        ns.inputs = inputs;
        ns.error = undefined;
        ns.startedAt = Date.now();
        ns.finishedAt = undefined;
        ns.interrupted = undefined;
        if (!again) {
          ns.session = undefined;
          interruptedNodes.delete(k);
        }
        // Journaled before it runs: a crash from here on finds it active (and re-runs it).
        journalQueues();
        journal();
        ctx.log("info", `${again ? "↻" : "▶"} ${label(nodeId)} (${cfg.kind}) — execution ${ns.executions}${again ? ", interrupted — running it again" : ""}`, k);
        runningNodes++;

        try {
          let result!: NodeResult;
          let branch: BranchHandle | undefined;
          try {
            if (cfg.kind === "trigger") {
              result = { outputs: { artifact: eventMarkdown(run.trigger!) } };
            } else if (cfg.kind === "condition") {
              const r = evaluateCondition(cfg.condition, { text: inputs.artifact, steer: inputs.steer, trigger: run.trigger });
              branch = r.result ? "true" : "false";
              for (const x of r.rules) {
                ctx.log("info", `${x.passed ? "✓" : "✗"} ${describeCondition({ match: "all", rules: [x.rule] })} (got ${JSON.stringify(x.actual) ?? "nothing"})`, k);
              }
              result = { outputs: {} };
            } else if (cfg.kind === "flow-input") {
              // As a subflow: what the parent sent. On its own: the starting prompt, so the flow can be tried out directly.
              result = { outputs: entry ? { ...entry } : settings.startingPrompt.trim() ? { artifact: settings.startingPrompt } : {} };
            } else if (cfg.kind === "flow-output") {
              const name = cfg.flowOutput.name.trim() || DEFAULT_EXIT;
              ns.outputs = inputs;
              ns.status = "done";
              ns.exit = name;
              ns.finishedAt = Date.now();
              if (entry) {
                ctx.log("info", `⇥ flow output "${name}"`, k);
                // The subflow is finished: drop whatever else it had queued.
                for (const q of queue) if (run.nodes[key(q.nodeId)].status === "queued") run.nodes[key(q.nodeId)].status = "idle";
                return { exit: name, outputs: inputs };
              }
              ctx.log("info", `⇥ flow output "${name}" (this flow isn't running as a subflow, so this path ends)`, k);
              continue;
            } else if (cfg.kind === "subflow") {
              const child = flows.find((f) => f.id === cfg.subflow.flowId);
              if (!child) throw new Error(cfg.subflow.flowId ? `Subflow runs unknown flow "${cfg.subflow.flowId}"` : "Subflow has no flow selected");
              if (depth + 1 > MAX_SUBFLOW_DEPTH) throw new Error(`Subflows nested more than ${MAX_SUBFLOW_DEPTH} deep — does a flow contain itself?`);
              ctx.log("info", `↳ running flow "${child.name}"`, k);
              const r = await runGraph(child, `${k}/`, depth + 1, inputs, [g, ...outer]);
              if (halted()) throw new Error(pausing ? "Run paused" : "Run cancelled");
              if (r.exit === undefined) ctx.log("warn", `Flow "${child.name}" ended without reaching a Flow output — nothing continues after it`, k);
              result = { outputs: r.outputs ?? {}, exit: r.exit };
            } else if (cfg.kind === "stack") {
              if (depth + 1 > MAX_SUBFLOW_DEPTH) throw new Error(`Subflows nested more than ${MAX_SUBFLOW_DEPTH} deep — does a flow contain itself?`);
              /** A task's run: one more level down, in this run's sandbox (shared) or a worktree cut from its branch. */
              const childOptions = (child: Flow, o: { shared: boolean; branch?: string; baseBranch?: string }): StartRunOptions => ({
                ...opts,
                flow: child,
                trigger: run.trigger,
                startNodeId: undefined,
                prompt: undefined,
                resume: undefined,
                continueFrom: undefined,
                settings,
                depth: depth + 1,
                parent: { runId: run.id, nodeKey: k },
                share: o.shared ? ctx : undefined,
                branch: o.branch,
                baseBranch: o.baseBranch,
                parentContext: o.shared ? undefined : ctx,
                onFlag: (r, f) => void ctx.flag(f.severity, f.message, { nodeKey: k, details: f.details, fromRunId: f.fromRunId ?? r.id }),
              });
              result = await runStack(
                {
                  ctx,
                  scoped: gctx,
                  nodeKey: k,
                  label: label(nodeId),
                  ai: runners.ai,
                  spawn: (child, o) => {
                    const h = startRun({
                      ...childOptions(child, o),
                      entry: o.entry,
                      stack: o.stack,
                    });
                    opts.onSpawn?.(h);
                    return h;
                  },
                  resumeChild: (id, child, o) => {
                    const saved = opts.loadRun?.(id);
                    if (!saved || saved.parent?.runId !== run.id) return undefined;
                    if (saved.finishedAt) return saved;
                    const h = startRun({ ...childOptions(child, o), continueFrom: saved });
                    opts.onSpawn?.(h);
                    return h;
                  },
                  halted,
                  settled: (h) => opts.onChange?.(h.state),
                },
                node,
                cfg,
                inputs,
              );
            } else if (cfg.kind === "script") {
              if (!runners.script) throw new Error("Script blocks aren't supported here");
              result = await untilStopped(runners.script(gctx, node, cfg, inputs));
            } else if (cfg.kind === "integration") {
              if (!runners.integration) throw new Error("Integration blocks aren't supported here");
              result = await untilStopped(runners.integration(gctx, node, cfg, inputs));
            } else {
              result = await untilStopped((cfg.kind === "auto" ? runners.auto : runners.ai)(gctx, node, cfg, inputs));
            }
          } catch (e) {
            const message = (e as Error).message;
            /** Cut off by a pause: this attempt runs again when the run continues. Stopped: it's over. */
            const halt = () => {
              if (pausing) {
                ns.interrupted = mutates(cfg) ? "mutation" : "plain";
                ns.error = undefined;
              } else {
                ns.status = "idle";
                ns.error = "Stopped";
              }
            };
            if (pausing && (ctx.abort.signal.aborted || message === "Run paused")) {
              ns.failure = undefined;
              halt();
              return {};
            }
            if (ctx.abort.signal.aborted || stopping) {
              halt();
              return {};
            }
            const stop = pendingStops.get(k);
            pendingStops.delete(k);
            ns.failure = { cause: failureCause(k, e), message: stop?.message ?? message, at: Date.now() };
            ns.error = message;
            // What happens next is decided in one place (backend/recovery.ts). A subflow's own steps were already
            // through recovery; a run being stopped or paused is never retried.
            let next: AfterFailure = { kind: "fail" };
            if (recovery && cfg.kind !== "subflow" && !halted()) {
              journal();
              // Journaled once recovery did something (recovery off leaves no trace).
              const history = run.recovery?.[k] ?? { cycles: 0, history: [] };
              try {
                next = await decideAfterFailure(
                  {
                    settings: recovery,
                    triage: runners.triage,
                    signal: ctx.abort.signal,
                    run,
                    nodeKey: k,
                    flow: g,
                    blocks,
                    inputs,
                    cwd: runWorktree(ctx),
                    canHold: !opts.parent,
                    log: (level, msg) => ctx.log(level, msg, k),
                  },
                  node,
                  cfg,
                  ns.failure,
                  history,
                );
              } catch (e2) {
                if (!halted()) ctx.log("warn", `Recovery failed: ${(e2 as Error).message}`, k);
              }
              if (history.history.length) (run.recovery ??= {})[k] = history;
              if (next.kind === "retry") await wait(next.delayMs);
              if (halted()) {
                halt();
                journal();
                return {};
              }
            }
            if (next.kind === "fail") {
              ns.status = "failed";
              ns.finishedAt = Date.now();
              throw new Error(`${label(nodeId)}: ${message}`);
            }
            if (next.kind === "hold") {
              // Paused for a human (part 1's pause): Continue runs this step again, reviewing against the failure.
              ns.interrupted = mutates(cfg) ? "mutation" : "plain";
              pausing = "blocked";
              run.pauseReason = "blocked";
              run.hold = { reason: "blocked", guard: next.guard, nodeKey: k, problems: [next.reason], at: Date.now() };
              // Like the server's holds (`hold-<reason>`): dismissed when the run is continued.
              ctx.flag("error", `Held at ${label(nodeId)} — ${GUARD_TEXT[next.guard]}: ${next.reason}`, { nodeKey: k }).id = "hold-blocked";
              setPhase("pausing");
              return {};
            }
            if (next.kind === "retry") {
              // The same step again (it was counted when it started); an agent continues its session or starts fresh.
              if (next.session === "resume") interruptedNodes.set(k, { session: ns.session, prompt: next.prompt });
              else if (next.session === "fresh") interruptedNodes.set(k, { prompt: next.prompt, fresh: true });
              else interruptedNodes.delete(k);
              if (next.session !== "resume") ns.session = undefined;
              const again: NodeIO = next.task !== undefined ? { ...inputs, artifact: next.task } : inputs;
              queue.unshift({ nodeId, inputs: again, again: true });
              journalQueues();
              journal();
              continue;
            }
            // Skipped by triage: it goes on as if it finished with the output triage gave.
            ctx.log("warn", `Skipped after its failure — the flow goes on${next.output !== undefined ? " with the output triage gave" : ""}`, k);
            result = { outputs: next.output !== undefined ? { artifact: next.output } : {} };
          }

          for (const f of result.flags ?? []) ctx.flag(f.severity, f.message, { nodeKey: k, details: f.details });

          // Named exits (Script / integration / subflow): the result leaves through one exit and keeps both artifact and steer.
          const exits =
            cfg.kind === "script" ? cfg.script.exits.filter(Boolean)
            : cfg.kind === "integration" ? cfg.integration.exits.filter(Boolean)
            : cfg.kind === "subflow" ? null
            : [];
          let exit: string | undefined;
          if (cfg.kind === "subflow" || cfg.kind === "stack") exit = result.exit;
          else if (exits?.length) {
            exit = result.exit;
            if (!exit || !exits.includes(exit)) {
              ctx.log("warn", `Script picked exit "${exit ?? ""}", which isn't one of ${exits.join(", ")} — using "${exits[0]}"`, k);
              exit = exits[0];
            }
          }
          const byExit = exit !== undefined || cfg.kind === "subflow" || cfg.kind === "stack";

          const outputs: NodeIO = {};
          if ((byExit || cfg.outputs.artifact) && result.outputs.artifact !== undefined) outputs.artifact = result.outputs.artifact;
          if ((byExit || cfg.outputs.steer) && result.outputs.steer !== undefined) outputs.steer = result.outputs.steer;
          ns.outputs = outputs;
          ns.status = "done";
          ns.finishedAt = Date.now();
          ns.failure = undefined;
          if (run.recovery?.[k]) run.recovery[k].retries = 0;
          run.stalls = 0;
          if (exit !== undefined) ns.exit = exit;
          if (outputs.artifact !== undefined) opts.saveArtifact?.(run.id, k, ns.executions, outputs.artifact);

          // A condition only follows the edges of the branch it took, carrying its own input along.
          const outEdges = g.edges.filter((e) =>
            e.source !== nodeId ? false
            : branch ? e.sourceHandle === branch
            : byExit ? exit !== undefined && e.sourceHandle === exitHandle(exit)
            : e.sourceHandle !== "true" && e.sourceHandle !== "false" && !isExitHandle(e.sourceHandle),
          );
          if (branch) {
            ns.branch = branch;
            ns.outputs = inputs;
            ctx.log("info", outEdges.length ? `↪ ${branch}` : `↪ ${branch} — nothing connected, this path ends`, k);
          } else if (exit !== undefined) {
            ctx.log("info", outEdges.length ? `↪ exit ${exit}` : `↪ exit ${exit} — nothing connected, this path ends`, k);
          }
          const passOn: NodeIO = branch ? inputs : outputs;
          const successors = [...new Set(outEdges.map((e) => e.target))];
          let targets = successors;
          if (cfg.kind === "manager" && successors.length) {
            let chosen = result.route;
            if (!chosen || !successors.includes(chosen)) {
              ctx.log("warn", `Manager returned invalid route "${chosen ?? ""}" — falling back to ${label(successors[0])}`, k);
              chosen = successors[0];
            }
            ns.routedTo = chosen;
            targets = [chosen];
            ctx.log("info", `↪ routed to ${label(chosen)}`, k);
          }

          for (const t of targets) {
            const tCfg = resolveNode(byId.get(t)!, blocks);
            // A subflow node accepts whatever its flow's Flow input takes; checked again inside it.
            const accepts = (h: "artifact" | "steer") => tCfg.kind === "subflow" || tCfg.inputs[h];
            const tInputs: NodeIO = {};
            for (const e of outEdges.filter((e) => e.target === t)) {
              const value =
                e.sourceHandle === "true" || e.sourceHandle === "false"
                  ? e.targetHandle === "steer"
                    ? (passOn.steer ?? passOn.artifact)
                    : passOn.artifact
                  : isExitHandle(e.sourceHandle)
                    ? passOn[e.targetHandle]
                    : passOn[e.sourceHandle];
              if (value !== undefined && accepts(e.targetHandle)) tInputs[e.targetHandle] = value;
            }
            queue.push({ nodeId: t, inputs: tInputs });
            if (run.nodes[key(t)].status !== "running") run.nodes[key(t)].status = "queued";
          }
          flushActivity();
          ctx.log("info", `✓ ${label(nodeId)}`, k);
          journalQueues();
          journal();
        } finally {
          nodeEnded();
        }
      }
      return {};
    } finally {
      // A paused run keeps every graph's queue in its journal (continuing restores them); otherwise this graph is over.
      if (!pausing) {
        liveQueues.delete(prefix);
        journalQueues();
      }
    }
  }

  /** Set once the graph has ended (done / failed / cancelled): a Stop during cleanup no longer changes the outcome. */
  let settled = false;
  /** The run ended paused (quit / update): it's continued later instead of finishing. */
  let paused = false;
  const done = (async () => {
    try {
      const r = await runGraph(flow, "", opts.depth ?? 0, opts.entry ?? cont?.input);
      if (pausing) paused = true;
      else {
        if (opts.entry ?? cont?.input) run.result = r;
        run.status = ctx.abort.signal.aborted || stopping ? "cancelled" : "done";
      }
    } catch (e) {
      if (pausing && (ctx.abort.signal.aborted || (e as Error).message === "Run paused")) paused = true;
      else run.status = ctx.abort.signal.aborted || stopping ? "cancelled" : "failed";
      if (!paused && run.status === "failed") {
        run.error = (e as Error).message;
        ctx.log("error", run.error);
        // A stack child's failure is reported by its stack (it may be retried).
        if (!opts.parent) ctx.flag("error", `Run failed: ${run.error}`);
      }
    } finally {
      settled = true;
      // Each step is bounded: a sandbox that won't close must not keep the run (and Stop) hanging.
      const limit = opts.cleanupTimeoutMs ?? CLEANUP_TIMEOUT_MS;
      // A shared workspace's cleanup belongs to the run that owns it.
      for (const fn of opts.share ? [] : ctx.cleanup.splice(0)) {
        let timer: NodeJS.Timeout | undefined;
        try {
          const step = Promise.resolve().then(fn);
          step.catch(() => {});
          const timedOut = await Promise.race([
            step.then(() => false),
            new Promise<boolean>((r) => (timer = setTimeout(() => r(true), limit))),
          ]);
          if (timedOut) ctx.log("warn", `Cleanup step didn't finish within ${Math.round(limit / 1000)}s — continuing without it`);
        } catch (e) {
          ctx.log("warn", `Cleanup failed: ${(e as Error).message}`);
        } finally {
          clearTimeout(timer);
        }
      }
      if (!paused && run.status !== "done" && topQueue.length) run.unstarted = topQueue.map((q) => ({ nodeId: q.nodeId, inputs: q.inputs }));
      for (const ns of Object.values(run.nodes)) if (ns.status === "queued" || ns.status === "running" || ns.status === "waiting") ns.status = "idle";
      run.pendingQuestion = undefined;
      steerTargets.clear();
      for (const st of run.steers ?? []) {
        if (st.status === "pending") Object.assign(st, { status: "dropped", note: `The run ${paused ? "paused" : "ended"} before the agent got this message` });
      }
      flushActivity();
      if (paused) {
        // Not finished: the journal (phase, active steps, queues) is what continuing starts from.
        if (pausing === "blocked") ctx.log("warn", `⏸ Held — ${run.hold?.problems[0] ?? PAUSE_REASON_TEXT.blocked}. Continue runs ${run.hold?.nodeKey ?? "the step"} again; Stop ends the run.`);
        else ctx.log("warn", `⏸ Paused — ${PAUSE_REASON_TEXT[pausing!]}. It continues where it was when Sandflow starts again.`);
        setPhase("paused");
      } else {
        run.finishedAt = Date.now();
        run.queues = undefined;
        if (run.status === "cancelled") ctx.log("warn", "Run stopped — every running step was cancelled and its processes killed");
        setPhase(run.status as RunPhase);
      }
      journal();
    }
    return run;
  })();

  return {
    state: run,
    done,
    answer(a) {
      if (!pending) return false;
      pending.resolve(a);
      return true;
    },
    steer(nodeKey, message) {
      const text = message.trim();
      if (!text) return { ok: false, status: 400, error: "The steering message is empty" };
      if (text.length > MAX_STEER_CHARS) return { ok: false, status: 400, error: `The steering message is too long (max ${MAX_STEER_CHARS} characters)` };
      if (run.finishedAt || settled || halted()) return { ok: false, status: 409, error: "This run has ended — there's no agent left to steer" };
      const ns = run.nodes[nodeKey];
      if (!ns) return { ok: false, status: 404, error: `No step "${nodeKey}" in this run` };
      const onSteer = steerTargets.get(nodeKey);
      if (ns.status !== "running" && ns.status !== "waiting") {
        return { ok: false, status: 409, error: `This step isn't running (it's ${ns.status}) — only an agent that is working can be steered` };
      }
      if (!onSteer) {
        // An agent that took messages a moment ago is wrapping up its step (its status changes right after).
        if (steerSeen.has(nodeKey)) return { ok: false, status: 409, error: "This agent is finishing its step — it can't take messages any more" };
        return { ok: false, status: 409, error: "Only AI agent and manager blocks can be steered" };
      }
      // Steers are saved with the run: keep a runaway client from growing it without bound.
      const steers = run.steers ?? [];
      if (steers.filter((s) => s.nodeId === nodeKey && s.status === "pending").length >= MAX_PENDING_STEERS) {
        return { ok: false, status: 409, error: `${MAX_PENDING_STEERS} messages are already waiting for this agent — wait until it has read them` };
      }
      if (steers.length >= MAX_RUN_STEERS) return { ok: false, status: 409, error: `This run already got ${MAX_RUN_STEERS} steering messages — that's the limit` };
      const steer: SteerRecord = { id: randomUUID().slice(0, 8), nodeId: nodeKey, message: text, sentAt: Date.now(), status: "pending" };
      (run.steers ??= []).push(steer);
      ctx.log("info", `Steering message received: ${text}`, nodeKey);
      onSteer();
      emit();
      return { ok: true, steer };
    },
    cancel() {
      // Idempotent: a second Stop (or one after the run ended) does nothing.
      if (run.finishedAt || ctx.abort.signal.aborted || stopping) return;
      if (settled) {
        // The run already ended and is only closing its sandboxes: hurry that along (kills containers / processes)
        // but keep its real outcome — it finished, it wasn't stopped.
        ctx.abort.abort(new Error("Run cancelled"));
        return;
      }
      // Show it right away; the run finishes once cleanup (closing sandboxes) is done.
      stopping = true;
      pausing = undefined;
      const active = Object.entries(run.nodes).filter(([, ns]) => ns.status === "running" || ns.status === "waiting");
      ctx.log("warn", `Stop requested — cancelling ${active.length ? active.map(([id]) => id).join(", ") : "the run"} and killing its processes`);
      pending?.reject(new Error("Run cancelled"));
      run.pendingQuestion = undefined;
      for (const ns of Object.values(run.nodes)) if (ns.status === "queued") ns.status = "idle";
      setPhase("cancelled");
      const abort = () => ctx.abort.abort(new Error("Run cancelled"));
      if (!delivering.size) return abort();
      // An irreversible step (Create MR, Post comment, …) isn't cut in half: it finishes first (bounded).
      ctx.log("warn", "Waiting for the step that is delivering (MR / comment / merge) to finish before stopping");
      void deliveriesDone().then(abort);
    },
    async pause(reason) {
      if (run.finishedAt || settled || stopping || ctx.abort.signal.aborted) return done;
      if (pausing) return done;
      pausing = reason;
      run.pauseReason = reason;
      ctx.log("warn", `Pausing — ${PAUSE_REASON_TEXT[reason]}; no new step starts`);
      setPhase("pausing");
      // Irreversible steps finish first (MEOW: cancellation waits on the delivery lock).
      await deliveriesDone();
      // A short grace period for what's running to finish by itself (not for a question nobody will answer now).
      if (runningNodes > 0 && !pending) {
        await Promise.race([
          new Promise<void>((r) => {
            const w = () => (idleWaiters.delete(w), r());
            idleWaiters.add(w);
          }),
          sleep(opts.pauseGraceMs ?? PAUSE_GRACE_MS),
        ]);
      }
      // Still going: stop its processes. Its attempt is marked interrupted and runs again when the run continues.
      if (!settled) ctx.abort.abort(new Error("Run paused"));
      pending?.reject(new Error("Run paused"));
      return done;
    },
  };
}
