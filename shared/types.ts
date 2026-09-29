// Shared domain types used by both the React UI and the flow-engine server.

/** The two things a block can emit. */
export type OutputKind = "artifact" | "steer";
/** Inputs that travel along edges (the other two — starting prompt and env — are global). */
export type EdgeInputKind = "artifact" | "steer";

/**
 * auto    – deterministic logic run on the host (git, CLI, shell).
 * ai      – an agent run inside a sandcastle sandbox.
 * manager – an agent that decides which outgoing connection receives the task.
 * trigger – starts the flow on an event (schedule, GitHub/GitLab webhook or poll, or manually).
 * condition – deterministic If: evaluates rules and continues out of its `true` or `false` handle.
 */
export type BlockKind = "auto" | "ai" | "manager" | "trigger" | "condition";

export type AutoAction = "create-task" | "create-mr" | "shell" | "post-comment";

/** Where a condition's result leaves the block. */
export type BranchHandle = "true" | "false";
export type SourceHandle = OutputKind | BranchHandle;

// ---------- Triggers ----------

export type TriggerType = "manual" | "schedule" | "github" | "gitlab";

export type IntervalUnit = "seconds" | "minutes" | "hours" | "days" | "weeks" | "months";

export type ScheduleSpec =
  /** Once, at a local date-time (`2026-10-01T09:00`) or an ISO timestamp. */
  | { kind: "once"; at: string }
  /** Every N units, counted from `start` (local date-time; defaults to 2026-01-05T00:00, a Monday). */
  | { kind: "interval"; every: number; unit: IntervalUnit; start?: string }
  /** Cron with optional seconds field (croner syntax, e.g. `0 30 9 * * 1-5`), in `timezone` (IANA) or local time. */
  | { kind: "cron"; expr: string; timezone?: string };

/** Normalised git-host events a trigger can listen for. */
export type GitEventType =
  | "issue.opened"
  | "issue.comment"
  | "merge_request.opened"
  | "merge_request.comment"
  | "push";

export interface TriggerConfig {
  type: TriggerType;
  schedule?: ScheduleSpec;
  /** github/gitlab: which events fire the flow (empty = all supported). */
  events?: GitEventType[];
  /** github: `owner/repo`; gitlab: `group/subgroup/project`. */
  repo?: string;
  /** GitHub Enterprise / self-hosted GitLab host (e.g. `gitlab.corp.local`). Empty = github.com / gitlab.com. */
  host?: string;
  /** webhook = the host pushes to Sandflow's webhook listener; poll = Sandflow asks the API every N seconds. */
  mode?: "webhook" | "poll";
  pollSeconds?: number;
  /** Env var holding the webhook secret (GitHub HMAC secret / GitLab secret token). */
  secretEnv?: string;
  /** What to do if this flow is still running when the trigger fires again. */
  overlap?: "queue" | "skip";
}

// ---------- Conditions ----------

export type ConditionOp =
  | "equals"
  | "not_equals"
  | "contains"
  | "not_contains"
  | "starts_with"
  | "ends_with"
  | "matches"
  | "in"
  | "exists"
  | "not_exists"
  | "gt"
  | "lt"
  | "is_true"
  | "is_false";

export interface ConditionRule {
  /** Dotted path: `text` (input artifact), `steer`, `json.<path>` (artifact parsed as JSON), `trigger.<path>`. */
  field: string;
  op: ConditionOp;
  /** Comparison value; for `in`, a comma- or newline-separated list; for `matches`, a regex. */
  value?: string;
  caseSensitive?: boolean;
}

export interface ConditionSpec {
  match: "all" | "any";
  rules: ConditionRule[];
}

/** A normalised trigger event; every block of the run can see it (e.g. `trigger.author` in an If block). */
export interface TriggerEvent {
  source: TriggerType;
  /** e.g. `merge_request.comment`, `schedule`, `manual`. */
  type: string;
  /** Raw provider action (`opened`, `created`, …). */
  action?: string;
  repo?: string;
  host?: string;
  author?: string;
  title?: string;
  /** Comment / issue / MR description text. */
  body?: string;
  url?: string;
  /** Issue / PR / MR number (GitLab: iid). */
  number?: number;
  /** What `number` refers to — used by Post comment. */
  target?: "issue" | "merge_request";
  branch?: string;
  targetBranch?: string;
  labels?: string[];
  firedAt: number;
  /** Provider payload, for advanced conditions (`trigger.raw.…`). */
  raw?: unknown;
}

export type AgentProvider = "claudeCode" | "codex" | "pi" | "opencode" | "cursor" | "copilot";
export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export interface AgentConfig {
  provider: AgentProvider;
  model: string;
  effort?: Effort;
  /** Custom API endpoint (e.g. an on-prem gateway). Empty = the provider's default. */
  endpoint?: string;
  /** Env var the endpoint is passed in. Defaults per provider (ANTHROPIC_BASE_URL / OPENAI_BASE_URL). */
  endpointEnv?: string;
}

/** A skill stored as files: `bundled` = shipped in this codebase (`skills/`), `user` = uploaded (`.sandflow/skills/`). */
export interface SkillFileRef {
  store: "bundled" | "user";
  /** Directory inside the store, e.g. `obra-superpowers/writing-plans`. */
  dir: string;
}

/**
 * A skill installed into the sandbox before a block runs: either copied from files (`file`)
 * or fetched from GitHub with `npx skills add <source> --skill <name>`.
 */
export interface SkillRef {
  name: string;
  /** GitHub `owner/repo` the skill lives in (for file skills: where it originally came from). */
  source?: string;
  file?: SkillFileRef;
  /** Link to read the skill online. */
  url?: string;
  /** Why this skill is recommended for the block. */
  why?: string;
}

export interface BlockInputs {
  artifact?: boolean;
  steer?: boolean;
  startingPrompt?: boolean;
}

export interface BlockOutputs {
  artifact?: boolean;
  steer?: boolean;
}

/**
 * Every field is optional so templates can define a partial base configuration.
 * Resolution order: DEFAULT_CONFIG ← template ancestors (root first) ← block ← node overrides.
 */
export interface BlockConfig {
  kind?: BlockKind;
  description?: string;
  color?: string;
  icon?: string;
  inputs?: BlockInputs;
  outputs?: BlockOutputs;
  /** Names of global env vars this block needs (merged/unioned through the template chain). */
  env?: string[];
  /** When true the agent may ask the user a question and the flow pauses for the answer. */
  allowQuestions?: boolean;
  /** Recommended online skills (merged/unioned through the template chain). */
  skills?: SkillRef[];
  /** AI / manager: the role instructions for the agent. */
  instructions?: string;
  /** Appended after `instructions` (handy for per-node tweaks without replacing the base prompt). */
  extraInstructions?: string;
  /** auto: what to do. */
  autoAction?: AutoAction;
  /** auto + shell: command run on the host inside REPO_PATH. */
  shellCommand?: string;
  agent?: Partial<AgentConfig>;
  maxIterations?: number;
  /** trigger blocks. */
  trigger?: TriggerConfig;
  /** condition blocks. */
  condition?: ConditionSpec;
}

export interface BlockDef {
  id: string;
  name: string;
  /** Templates show up in the "Templates" tab and can be extended by blocks and by other templates. */
  isTemplate: boolean;
  /** Template this block/template inherits its base configuration from. */
  extends?: string | null;
  builtin?: boolean;
  config: BlockConfig;
}

export interface ResolvedConfig {
  kind: BlockKind;
  description: string;
  color: string;
  icon: string;
  inputs: Required<BlockInputs>;
  outputs: Required<BlockOutputs>;
  env: string[];
  allowQuestions: boolean;
  skills: SkillRef[];
  instructions: string;
  extraInstructions: string;
  autoAction: AutoAction;
  shellCommand: string;
  agent: AgentConfig;
  maxIterations: number;
  trigger: TriggerConfig;
  condition: ConditionSpec;
}

export interface FlowNodeData {
  blockId: string;
  /** Optional display label (defaults to the block name). */
  label?: string;
  /** Per-node overrides on top of the resolved block definition. */
  overrides?: BlockConfig;
  [key: string]: unknown;
}

export interface FlowNode {
  id: string;
  type: "block";
  position: { x: number; y: number };
  data: FlowNodeData;
}

export interface FlowEdge {
  id: string;
  source: string;
  target: string;
  /** artifact/steer, or `true`/`false` out of a condition block (carries the condition's input along). */
  sourceHandle: SourceHandle;
  targetHandle: EdgeInputKind;
}

export interface Flow {
  id: string;
  name: string;
  nodes: FlowNode[];
  edges: FlowEdge[];
  /** When true, the flow's trigger blocks (schedule / git) fire runs automatically. */
  active?: boolean;
}

export type SandboxKind = "docker" | "podman" | "none";

export interface Settings {
  /** Global starting prompt handed to every block that accepts it. */
  startingPrompt: string;
  sandbox: SandboxKind;
  /** Safety valve for loops (e.g. CR → CR fix → CR …). */
  maxSteps: number;
  /** Local image for Docker/Podman sandboxes (never pulled). Default: sandflow-agent:<app version>. */
  sandboxImage?: string;
  /** Host folder with agent CLIs (e.g. a Linux `claude` binary), mounted read-only at /opt/sandflow/tools. */
  agentToolsDir?: string;
  /** Desktop app update source. Default: GitHub releases. */
  updates?: UpdateSettings;
  /** Listener for GitHub/GitLab webhooks — separate port that only serves /hooks/*. */
  webhooks?: WebhookSettings;
}

export interface WebhookSettings {
  enabled: boolean;
  /** Bind address: 127.0.0.1 (behind a reverse proxy / tunnel) or 0.0.0.0 (reachable on the network). */
  host: string;
  port: number;
  /** How the git host reaches this listener (shown as the webhook URL), e.g. `https://sandflow.corp.local`. */
  publicUrl?: string;
}

export interface UpdateSettings {
  mode: "github" | "url" | "off";
  /** For mode "url": base URL serving latest.yml + installers (e.g. an internal file server). */
  url?: string;
}

export type EnvValues = Record<string, string>;

export interface AppData {
  blocks: BlockDef[];
  flows: Flow[];
  settings: Settings;
  env: EnvValues;
}

// ---------- Runs ----------

export type NodeRunStatus = "idle" | "queued" | "running" | "waiting" | "done" | "failed";
export type RunStatus = "running" | "waiting" | "done" | "failed" | "cancelled";

export interface NodeIO {
  artifact?: string;
  steer?: string;
}

export interface NodeRunState {
  status: NodeRunStatus;
  executions: number;
  inputs?: NodeIO;
  outputs?: NodeIO;
  error?: string;
  /** manager: id of the node it routed to. */
  routedTo?: string;
  /** condition: which way it went. */
  branch?: BranchHandle;
}

export interface QaPair {
  question: string;
  answer: string;
}

export interface PendingQuestion {
  nodeId: string;
  question: string;
}

export interface LogLine {
  ts: number;
  level: "info" | "warn" | "error" | "agent";
  nodeId?: string;
  msg: string;
}

export interface RunState {
  id: string;
  flowId: string;
  flowName: string;
  status: RunStatus;
  startedAt: number;
  finishedAt?: number;
  branch?: string;
  nodes: Record<string, NodeRunState>;
  pendingQuestion?: PendingQuestion;
  logs: LogLine[];
  error?: string;
  /** The event that started the run (manual runs get `{ source: "manual" }`). */
  trigger?: TriggerEvent;
  /** Trigger node that fired (absent for manual runs). */
  triggerNodeId?: string;
}

/** Row of the runs list. */
export interface RunSummary {
  id: string;
  flowId: string;
  flowName: string;
  status: RunStatus;
  startedAt: number;
  finishedAt?: number;
  trigger?: { source: TriggerType; type: string; author?: string; title?: string };
}
