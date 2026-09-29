import { randomUUID } from "node:crypto";
import path from "node:path";
import { describeCondition, evaluateCondition } from "../shared/conditions";
import { eventMarkdown } from "../shared/events";
import { nodeLabel, resolveNode } from "../shared/resolve";
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
  RunState,
  Settings,
  SkillFileRef,
} from "../shared/types";
import type { SkillFile } from "./skills";

export interface NodeResult {
  outputs: NodeIO;
  /** manager: id of the chosen target node. */
  route?: string;
}

export type NodeRunner = (
  ctx: RunContext,
  node: FlowNode,
  cfg: ResolvedConfig,
  inputs: NodeIO,
) => Promise<NodeResult>;

export interface RunContext {
  run: RunState;
  flow: Flow;
  blocks: BlockDef[];
  env: EnvValues;
  settings: Settings;
  /** Set by Create task; used as the sandbox branch. */
  branch?: string;
  /** Lazily created sandcastle sandbox, shared by every AI block of the run. */
  sandbox?: unknown;
  abort: AbortController;
  installedSkills: Set<string>;
  /** Only the env vars the block declares — never leak all globals. */
  blockEnv(cfg: ResolvedConfig): Record<string, string>;
  log(level: LogLine["level"], msg: string, nodeId?: string): void;
  /** Pause the run until the user answers (rejects when the run is cancelled). */
  ask(nodeId: string, question: string): Promise<string>;
  /** Teardown callbacks run when the run ends (e.g. sandbox.close()). */
  cleanup: Array<() => Promise<unknown>>;
  /** Where agent logs are written (per node). */
  logDir?: string;
  /** Reads the files of a file skill (bundled or uploaded). */
  loadSkill?: (ref: SkillFileRef) => Promise<SkillFile[]>;
}

export interface StartRunOptions {
  flow: Flow;
  blocks: BlockDef[];
  env: EnvValues;
  settings: Settings;
  runners: { auto: NodeRunner; ai: NodeRunner };
  onChange?: (state: RunState) => void;
  saveArtifact?: (runId: string, nodeId: string, n: number, text: string) => void;
  /** Base directory for per-run agent logs (`<logRoot>/<runId>/<nodeId>.log`). */
  logRoot?: string;
  loadSkill?: (ref: SkillFileRef) => Promise<SkillFile[]>;
  /** The event that started the run (default: a manual event). */
  trigger?: TriggerEvent;
  /** Start only from this (trigger) node — used for triggered runs. Default: every node without inputs. */
  startNodeId?: string;
  /** Starting prompt for this run only; overrides `settings.startingPrompt`. */
  prompt?: string;
}

export interface RunHandle {
  state: RunState;
  done: Promise<RunState>;
  answer(answer: string): boolean;
  cancel(): void;
}

const MAX_LOGS = 2000;

export function startRun(opts: StartRunOptions): RunHandle {
  const { flow, blocks, env, runners } = opts;
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
  };
  const emit = () => opts.onChange?.(run);

  let pending: { resolve: (a: string) => void; reject: (e: Error) => void } | undefined;

  const ctx: RunContext = {
    run,
    flow,
    blocks,
    env,
    settings,
    abort: new AbortController(),
    installedSkills: new Set(),
    cleanup: [],
    logDir: opts.logRoot ? path.join(opts.logRoot, run.id) : undefined,
    loadSkill: opts.loadSkill,
    blockEnv: (cfg) =>
      Object.fromEntries(cfg.env.filter((k) => env[k] !== undefined).map((k) => [k, env[k]])),
    log(level, msg, nodeId) {
      run.logs.push({ ts: Date.now(), level, nodeId, msg });
      if (run.logs.length > MAX_LOGS) run.logs.splice(0, run.logs.length - MAX_LOGS);
      emit();
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

  const byId = new Map(flow.nodes.map((n) => [n.id, n]));
  const label = (id: string) => {
    const n = byId.get(id);
    return n ? nodeLabel(n, blocks) : id;
  };

  async function execute() {
    const incoming = new Set(flow.edges.map((e) => e.target));
    const starts = opts.startNodeId
      ? flow.nodes.filter((n) => n.id === opts.startNodeId)
      : flow.nodes.filter((n) => !incoming.has(n.id));
    if (!starts.length) {
      throw new Error(
        opts.startNodeId ? `Trigger node ${opts.startNodeId} not found` : "Flow has no start node (every node has an incoming edge)",
      );
    }

    const queue: { nodeId: string; inputs: NodeIO }[] = starts.map((n) => ({ nodeId: n.id, inputs: {} }));
    for (const q of queue) run.nodes[q.nodeId].status = "queued";
    emit();
    let steps = 0;

    while (queue.length) {
      if (ctx.abort.signal.aborted) return;
      if (++steps > settings.maxSteps) {
        throw new Error(`Max steps exceeded (${settings.maxSteps}) — is the flow stuck in a loop?`);
      }
      const { nodeId, inputs } = queue.shift()!;
      const node = byId.get(nodeId)!;
      const cfg = resolveNode(node, blocks);
      const ns = run.nodes[nodeId];
      ns.status = "running";
      ns.executions++;
      ns.inputs = inputs;
      ns.error = undefined;
      ctx.log("info", `▶ ${label(nodeId)} (${cfg.kind}) — execution ${ns.executions}`, nodeId);

      let result: NodeResult;
      let branch: BranchHandle | undefined;
      try {
        if (cfg.kind === "trigger") {
          result = { outputs: { artifact: eventMarkdown(run.trigger!) } };
        } else if (cfg.kind === "condition") {
          const r = evaluateCondition(cfg.condition, { text: inputs.artifact, steer: inputs.steer, trigger: run.trigger });
          branch = r.result ? "true" : "false";
          for (const x of r.rules) {
            ctx.log("info", `${x.passed ? "✓" : "✗"} ${describeCondition({ match: "all", rules: [x.rule] })} (got ${JSON.stringify(x.actual) ?? "nothing"})`, nodeId);
          }
          result = { outputs: {} };
        } else {
          result = await (cfg.kind === "auto" ? runners.auto : runners.ai)(ctx, node, cfg, inputs);
        }
      } catch (e) {
        if (ctx.abort.signal.aborted) {
          ns.status = "failed";
          ns.error = "Cancelled";
          return;
        }
        ns.status = "failed";
        ns.error = (e as Error).message;
        throw new Error(`${label(nodeId)}: ${(e as Error).message}`);
      }

      const outputs: NodeIO = {};
      if (cfg.outputs.artifact && result.outputs.artifact !== undefined) outputs.artifact = result.outputs.artifact;
      if (cfg.outputs.steer && result.outputs.steer !== undefined) outputs.steer = result.outputs.steer;
      ns.outputs = outputs;
      ns.status = "done";
      if (outputs.artifact !== undefined) opts.saveArtifact?.(run.id, nodeId, ns.executions, outputs.artifact);

      // A condition only follows the edges of the branch it took, carrying its own input along.
      const outEdges = flow.edges.filter(
        (e) => e.source === nodeId && (branch ? e.sourceHandle === branch : e.sourceHandle !== "true" && e.sourceHandle !== "false"),
      );
      if (branch) {
        ns.branch = branch;
        ns.outputs = inputs;
        ctx.log("info", outEdges.length ? `↪ ${branch}` : `↪ ${branch} — nothing connected, this path ends`, nodeId);
      }
      const passOn: NodeIO = branch ? inputs : outputs;
      const successors = [...new Set(outEdges.map((e) => e.target))];
      let targets = successors;
      if (cfg.kind === "manager" && successors.length) {
        let chosen = result.route;
        if (!chosen || !successors.includes(chosen)) {
          ctx.log("warn", `Manager returned invalid route "${chosen ?? ""}" — falling back to ${label(successors[0])}`, nodeId);
          chosen = successors[0];
        }
        ns.routedTo = chosen;
        targets = [chosen];
        ctx.log("info", `↪ routed to ${label(chosen)}`, nodeId);
      }

      for (const t of targets) {
        const tCfg = resolveNode(byId.get(t)!, blocks);
        const tInputs: NodeIO = {};
        for (const e of outEdges.filter((e) => e.target === t)) {
          const value =
            e.sourceHandle === "true" || e.sourceHandle === "false"
              ? e.targetHandle === "steer"
                ? (passOn.steer ?? passOn.artifact)
                : passOn.artifact
              : passOn[e.sourceHandle];
          if (value !== undefined && tCfg.inputs[e.targetHandle]) tInputs[e.targetHandle] = value;
        }
        queue.push({ nodeId: t, inputs: tInputs });
        if (run.nodes[t].status !== "running") run.nodes[t].status = "queued";
      }
      ctx.log("info", `✓ ${label(nodeId)}`, nodeId);
    }
  }

  const done = (async () => {
    try {
      await execute();
      run.status = ctx.abort.signal.aborted ? "cancelled" : "done";
    } catch (e) {
      run.status = ctx.abort.signal.aborted ? "cancelled" : "failed";
      if (run.status === "failed") {
        run.error = (e as Error).message;
        ctx.log("error", run.error);
      }
    } finally {
      for (const fn of ctx.cleanup.splice(0)) {
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
