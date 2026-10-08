import { randomUUID } from "node:crypto";
import path from "node:path";
import { describeCondition, evaluateCondition } from "../shared/conditions";
import { eventMarkdown } from "../shared/events";
import { nodeLabel, resolveNode } from "../shared/resolve";
import { DEFAULT_EXIT, MAX_SUBFLOW_DEPTH, exitHandle, isExitHandle } from "../shared/subflow";
import type {
  BlockDef,
  BranchHandle,
  TriggerEvent,
  EnvValues,
  Flow,
  FlowNode,
  LogLine,
  NodeIO,
  QuestionRecord,
  ResolvedConfig,
  RunFlag,
  FlagSeverity,
  RunState,
  Settings,
  StackRunInfo,
  SkillFileRef,
} from "../shared/types";
import type { PackRuntimeInfo } from "./packs";
import { runStack } from "./stack";
import type { SkillFile } from "./skills";

export interface NodeResult {
  outputs: NodeIO;
  /** manager: id of the chosen target node. */
  route?: string;
  /** script / subflow: the named exit it leaves through. */
  exit?: string;
}

export type NodeRunner = (
  ctx: RunContext,
  node: FlowNode,
  cfg: ResolvedConfig,
  inputs: NodeIO,
) => Promise<NodeResult>;

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
  /** The sandbox while it's being created. */
  sandboxPending?: Promise<unknown>;
  /** A Box Stack task with an isolated workspace: the context of the run that started it (where it merges into). */
  parentContext?: RunContext;
  abort: AbortController;
  installedSkills: Set<string>;
  /** Only the env vars the block declares — never leak all globals. */
  blockEnv(cfg: ResolvedConfig): Record<string, string>;
  log(level: LogLine["level"], msg: string, nodeId?: string): void;
  /** Pause the run until the user answers (rejects when the run is cancelled). */
  ask(nodeId: string, question: string): Promise<string>;
  /** Raise a flag on the run: saved with it, shown in the run list and as an alert. */
  flag(severity: FlagSeverity, message: string, o?: { nodeKey?: string; details?: string; fromRunId?: string }): RunFlag;
  /** Teardown callbacks run when the run ends (e.g. sandbox.close()). */
  cleanup: Array<() => Promise<unknown>>;
  /** Where agent logs are written (per node). */
  logDir?: string;
  /** Reads the files of a file skill (bundled, uploaded or from a pack). */
  loadSkill?: (ref: SkillFileRef) => Promise<SkillFile[]>;
  packs?: RunPacks;
  /** Packs whose runtime copy is already prepared in this run's sandbox. */
  preparedPacks: Set<string>;
}

export interface StartRunOptions {
  flow: Flow;
  blocks: BlockDef[];
  /** Every flow (for subflows). Defaults to just `flow`. */
  flows?: Flow[];
  env: EnvValues;
  settings: Settings;
  runners: { auto: NodeRunner; ai: NodeRunner; script?: NodeRunner };
  onChange?: (state: RunState) => void;
  saveArtifact?: (runId: string, nodeId: string, n: number, text: string) => void;
  /** Base directory for per-run agent logs (`<logRoot>/<runId>/<nodeId>.log`). */
  logRoot?: string;
  loadSkill?: (ref: SkillFileRef) => Promise<SkillFile[]>;
  packs?: RunPacks;
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
}

export interface RunHandle {
  state: RunState;
  done: Promise<RunState>;
  answer(answer: string): boolean;
  cancel(): void;
}

const MAX_LOGS = 2000;

/** Where a graph run ended up: a subflow reached one of its Flow outputs (or ran out of nodes). */
interface GraphResult {
  exit?: string;
  outputs?: NodeIO;
}

/**
 * The context runners see while a node of a subflow runs: same run, sandbox and settings, but `flow` is the
 * subflow and node ids are reported under the subflow node (`<subflowNode>/<node>`).
 */
function scopedContext(ctx: RunContext, flow: Flow, prefix: string): RunContext {
  if (!prefix) return ctx;
  const own: Partial<RunContext> = {
    flow,
    log: (level, msg, nodeId) => ctx.log(level, msg, nodeId === undefined ? undefined : prefix + nodeId),
    ask: (nodeId, question) => ctx.ask(prefix + nodeId, question),
    flag: (severity, message, o) => ctx.flag(severity, message, o?.nodeKey === undefined ? o : { ...o, nodeKey: prefix + o.nodeKey }),
    logDir: ctx.logDir ? path.join(ctx.logDir, prefix.replace(/[^\w-]/g, "_")) : undefined,
  };
  return new Proxy(ctx, {
    get: (target, key) => (key in own ? own[key as keyof RunContext] : Reflect.get(target, key)),
    // Runners set ctx.branch / ctx.sandbox — those belong to the whole run.
    set: (target, key, value) => Reflect.set(target, key, value),
  });
}

export function startRun(opts: StartRunOptions): RunHandle {
  const { flow, blocks, env, runners } = opts;
  const flows = opts.flows?.some((f) => f.id === flow.id) ? opts.flows : [...(opts.flows ?? []), flow];
  const settings: Settings = opts.prompt === undefined ? opts.settings : { ...opts.settings, startingPrompt: opts.prompt };
  const run: RunState = {
    id: `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`,
    flowId: flow.id,
    flowName: flow.name,
    status: "running",
    startedAt: Date.now(),
    nodes: Object.fromEntries(flow.nodes.map((n) => [n.id, { status: "idle", executions: 0 }])),
    logs: [],
    questions: [],
    prompt: settings.startingPrompt,
    trigger: opts.trigger ?? { source: "manual", type: "manual", firedAt: Date.now() },
    triggerNodeId: opts.startNodeId,
    ...(opts.parent ? { parent: opts.parent } : {}),
    ...(opts.stack ? { stack: opts.stack } : {}),
    ...(opts.entry ? { input: opts.entry } : {}),
  };
  const emit = () => opts.onChange?.(run);

  let pending: { resolve: (a: string) => void; reject: (e: Error) => void } | undefined;

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
    blockEnv: (cfg) =>
      Object.fromEntries(cfg.env.filter((k) => env[k] !== undefined).map((k) => [k, env[k]])),
    log(level, msg, nodeId) {
      run.logs.push({ ts: Date.now(), level, nodeId, msg });
      if (run.logs.length > MAX_LOGS) run.logs.splice(0, run.logs.length - MAX_LOGS);
      emit();
    },
    flag(severity, message, o = {}) {
      const f: RunFlag = { id: randomUUID().slice(0, 8), severity, message, at: Date.now(), ...o };
      (run.flags ??= []).push(f);
      ctx.log(severity === "error" ? "error" : "warn", `⚑ ${message}`, o.nodeKey);
      opts.onFlag?.(run, f);
      return f;
    },
    ask(nodeId, question) {
      if (ctx.abort.signal.aborted) return Promise.reject(new Error("Run cancelled"));
      run.status = "waiting";
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
            run.status = "running";
            run.nodes[nodeId].status = "running";
            run.pendingQuestion = undefined;
            record.answer = a;
            record.answeredAt = Date.now();
            ctx.log("info", `Answer: ${a}`, nodeId);
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

  ctx.branch = opts.branch;
  ctx.baseBranch = opts.baseBranch;
  ctx.parentContext = opts.parentContext;
  if (opts.share) {
    // Shared workspace: the sandbox (and whatever was set up in it) belongs to the run that owns it.
    const owner = opts.share;
    for (const k of ["sandbox", "sandboxPending", "branch", "baseBranch", "installedSkills", "preparedPacks", "cleanup"] as const) {
      Object.defineProperty(ctx, k, { get: () => owner[k], set: (v) => ((owner as unknown as Record<string, unknown>)[k] = v), enumerable: true });
    }
  }

  let steps = 0;

  /**
   * Run one flow's graph. Top level (`entry` undefined): starts at the trigger node or every node without inputs.
   * As a subflow: starts at its Flow input blocks with the parent's inputs, and returns as soon as a Flow output
   * is reached.
   */
  async function runGraph(g: Flow, prefix: string, depth: number, entry?: NodeIO): Promise<GraphResult> {
    const gctx = scopedContext(ctx, g, prefix);
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
    let starts: FlowNode[];
    if (entry) {
      starts = g.nodes.filter((n) => kindOf(n) === "flow-input");
      // No Flow input: start where a top-level run would (never at a trigger — they don't fire inside subflows).
      if (!starts.length) starts = g.nodes.filter((n) => !incoming.has(n.id) && kindOf(n) !== "trigger");
      if (!starts.length) throw new Error(`Subflow "${g.name}" has nothing to start from — add a Flow input`);
    } else {
      starts = opts.startNodeId ? g.nodes.filter((n) => n.id === opts.startNodeId) : g.nodes.filter((n) => !incoming.has(n.id));
      if (!starts.length) {
        throw new Error(
          opts.startNodeId ? `Trigger node ${opts.startNodeId} not found` : "Flow has no start node (every node has an incoming edge)",
        );
      }
    }

    const queue: { nodeId: string; inputs: NodeIO }[] = starts.map((n) => ({ nodeId: n.id, inputs: {} }));
    for (const q of queue) run.nodes[key(q.nodeId)].status = "queued";
    emit();

    while (queue.length) {
      if (ctx.abort.signal.aborted) return {};
      if (++steps > settings.maxSteps) {
        throw new Error(`Max steps exceeded (${settings.maxSteps}) — is the flow stuck in a loop?`);
      }
      const { nodeId, inputs } = queue.shift()!;
      const k = key(nodeId);
      const node = byId.get(nodeId)!;
      const cfg = resolveNode(node, blocks);
      const ns = run.nodes[k];
      ns.status = "running";
      ns.executions++;
      ns.inputs = inputs;
      ns.error = undefined;
      ctx.log("info", `▶ ${label(nodeId)} (${cfg.kind}) — execution ${ns.executions}`, k);

      let result: NodeResult;
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
          const r = await runGraph(child, `${k}/`, depth + 1, inputs);
          if (ctx.abort.signal.aborted) throw new Error("Run cancelled");
          if (r.exit === undefined) ctx.log("warn", `Flow "${child.name}" ended without reaching a Flow output — nothing continues after it`, k);
          result = { outputs: r.outputs ?? {}, exit: r.exit };
        } else if (cfg.kind === "stack") {
          if (depth + 1 > MAX_SUBFLOW_DEPTH) throw new Error(`Subflows nested more than ${MAX_SUBFLOW_DEPTH} deep — does a flow contain itself?`);
          result = await runStack(
            {
              ctx,
              scoped: gctx,
              nodeKey: k,
              label: label(nodeId),
              ai: runners.ai,
              spawn: (child, o) => {
                const h = startRun({
                  ...opts,
                  flow: child,
                  trigger: run.trigger,
                  startNodeId: undefined,
                  prompt: undefined,
                  settings,
                  entry: o.entry,
                  depth: depth + 1,
                  parent: { runId: run.id, nodeKey: k },
                  stack: o.stack,
                  share: o.shared ? ctx : undefined,
                  branch: o.branch,
                  baseBranch: o.baseBranch,
                  parentContext: o.shared ? undefined : ctx,
                  onFlag: (r, f) => void ctx.flag(f.severity, f.message, { nodeKey: k, details: f.details, fromRunId: f.fromRunId ?? r.id }),
                });
                opts.onSpawn?.(h);
                return h;
              },
              settled: (h) => opts.onChange?.(h.state),
            },
            node,
            cfg,
            inputs,
          );
        } else if (cfg.kind === "script") {
          if (!runners.script) throw new Error("Script blocks aren't supported here");
          result = await runners.script(gctx, node, cfg, inputs);
        } else {
          result = await (cfg.kind === "auto" ? runners.auto : runners.ai)(gctx, node, cfg, inputs);
        }
      } catch (e) {
        if (ctx.abort.signal.aborted) {
          ns.status = "failed";
          ns.error = "Cancelled";
          return {};
        }
        ns.status = "failed";
        ns.error = (e as Error).message;
        throw new Error(`${label(nodeId)}: ${(e as Error).message}`);
      }

      // Named exits (Script / subflow): the result leaves through one exit and keeps both artifact and steer.
      const exits = cfg.kind === "script" ? cfg.script.exits.filter(Boolean) : cfg.kind === "subflow" ? null : [];
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
      ctx.log("info", `✓ ${label(nodeId)}`, k);
    }
    return {};
  }

  const done = (async () => {
    try {
      const r = await runGraph(flow, "", opts.depth ?? 0, opts.entry);
      if (opts.entry) run.result = r;
      run.status = ctx.abort.signal.aborted ? "cancelled" : "done";
    } catch (e) {
      run.status = ctx.abort.signal.aborted ? "cancelled" : "failed";
      if (run.status === "failed") {
        run.error = (e as Error).message;
        ctx.log("error", run.error);
        // A stack child's failure is reported by its stack (it may be retried).
        if (!opts.parent) ctx.flag("error", `Run failed: ${run.error}`);
      }
    } finally {
      for (const fn of opts.share ? [] : ctx.cleanup.splice(0)) {
        try {
          await fn();
        } catch (e) {
          ctx.log("warn", `Cleanup failed: ${(e as Error).message}`);
        }
      }
      for (const ns of Object.values(run.nodes)) if (ns.status === "queued" || ns.status === "running" || ns.status === "waiting") ns.status = "idle";
      run.pendingQuestion = undefined;
      run.finishedAt = Date.now();
      if (run.status === "cancelled") ctx.log("warn", "Run cancelled");
      emit();
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
    cancel() {
      if (run.finishedAt) return;
      ctx.abort.abort(new Error("Run cancelled"));
      pending?.reject(new Error("Run cancelled"));
    },
  };
}
