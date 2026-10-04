// Shared domain types used by both the React UI and the flow-engine server.

/** The two things a block can emit. */
export type OutputKind = "artifact" | "steer";
/** A named way out of a block (`exit:<name>`): a Script that picks a route, or a subflow's Flow output. */
export type ExitHandle = `exit:${string}`;
/** Inputs that travel along edges (the other two — starting prompt and env — are global). */
export type EdgeInputKind = "artifact" | "steer";

/**
 * auto    – deterministic logic run on the host (git, CLI, shell).
 * ai      – an agent run inside a sandcastle sandbox.
 * manager – an agent that decides which outgoing connection receives the task.
 * trigger – starts the flow on an event (schedule, GitHub/GitLab webhook or poll, or manually).
 * condition – deterministic If: evaluates rules and continues out of its `true` or `false` handle.
 * script  – runs a pack's code (any language / executable) in a container, or on this machine when trusted.
 * subflow – runs another flow inside this one; its exits are the child flow's Flow output blocks.
 * flow-input / flow-output – where a flow used as a subflow receives its input / hands its result back.
 */
export type BlockKind = "auto" | "ai" | "manager" | "trigger" | "condition" | "script" | "subflow" | "flow-input" | "flow-output";

export type AutoAction = "create-task" | "create-mr" | "shell" | "post-comment";

/** Where a condition's result leaves the block. */
export type BranchHandle = "true" | "false";
export type SourceHandle = OutputKind | BranchHandle | ExitHandle;

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

/**
 * A skill stored as files: `bundled` = shipped in this codebase (`skills/`), `user` = uploaded (`.sandflow/skills/`),
 * `pack` = inside an installed pack (`<pack>/skills/`).
 */
export interface SkillFileRef {
  store: "bundled" | "user" | "pack";
  /** Pack id (store `pack` only; filled in when the pack is loaded). */
  pack?: string;
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

/** Script blocks: what to run and where. */
export interface ScriptConfig {
  /** Shell command, run in the pack's runtime copy (`$PACK_DIR`), e.g. `python scripts/report.py`. */
  run?: string;
  /** `sandbox` (default) = a container; `host` = this machine (only your own blocks and trusted packs). */
  where?: "sandbox" | "host";
  /** Named exits; the script picks one with `"exit": "<name>"` in its output. Empty = plain artifact/steer outputs. */
  exits?: string[];
  timeoutSeconds?: number;
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
  /** script blocks. */
  script?: ScriptConfig;
  /** subflow blocks: the flow to run. */
  subflow?: { flowId?: string };
  /** flow-output blocks: the exit this output becomes on the subflow node. */
  flowOutput?: { name?: string };
}

export interface BlockDef {
  id: string;
  name: string;
  /** Templates show up in the "Templates" tab and can be extended by blocks and by other templates. */
  isTemplate: boolean;
  /** Template this block/template inherits its base configuration from. */
  extends?: string | null;
  /** Legacy: shipped inside the app before packs existed (now migrated to the base pack). */
  builtin?: boolean;
  /** Pack this block comes from (read-only; set when packs load). Absent = one of your own blocks. */
  pack?: string;
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
  script: { run: string; where: "sandbox" | "host"; exits: string[]; timeoutSeconds?: number };
  subflow: { flowId: string };
  flowOutput: { name: string };
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
  description?: string;
  /** Pack this flow comes from (read-only; set when packs load). Absent = one of your own flows. */
  pack?: string;
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
  /** Default agent for new "Edit with AI" chats (the last one picked). */
  assistantAgent?: AssistantAgent;
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
  /** Installed packs (their blocks and flows are already merged into `blocks` / `flows`). */
  packs?: PackInfo[];
}

// ---------- Packs ----------

/** Where a pack was installed from. */
export type PackSource =
  | { type: "github"; repo: string; host?: string; ref?: string; subdir?: string }
  | { type: "gitlab"; project: string; host?: string; ref?: string; subdir?: string }
  | { type: "folder"; path: string; link: boolean }
  | { type: "zip"; name: string }
  | { type: "bundled" };

/** A pack's dependency on another pack. */
export interface PackRequirement {
  id: string;
  /** semver range, e.g. `^1.0.0`. */
  version?: string;
  /** Where to get it when it's missing (a GitHub/GitLab URL). */
  source?: string;
}

/** `manifest.json` at the root of a pack. */
export interface PackManifest {
  id: string;
  name: string;
  version: string;
  description?: string;
  author?: string;
  homepage?: string;
  license?: string;
  requires?: PackRequirement[];
  /** Run once per install/update inside the pack's runtime copy, e.g. `pip install -r requirements.txt -t .deps`. */
  setup?: string;
  /** Container for this pack's Script blocks: an image name, or a Dockerfile in the pack (built locally). */
  sandbox?: { image?: string; dockerfile?: string };
  /** Executables: name → platform (`linux-x64`, `linux-arm64`, `win32-x64`, `darwin-arm64`, …) → path in the pack. */
  bin?: Record<string, Record<string, string>>;
}

/** An installed pack, as the UI sees it. */
export interface PackInfo {
  id: string;
  name: string;
  version: string;
  description?: string;
  author?: string;
  homepage?: string;
  source: PackSource;
  /** Commit the pack is pinned to (git sources). */
  commit?: string;
  /** sha256 over the pack's files. */
  hash: string;
  installedAt: number;
  /** May run code on this machine (Script blocks with where: host, Shell command blocks). */
  trustHost: boolean;
  /** Ships something that runs code: scripts, setup, executables, a Dockerfile or shell commands. */
  hasCode: boolean;
  requires: PackRequirement[];
  blockCount: number;
  flowCount: number;
  skillCount: number;
  /** Problems found while loading (bad JSON, unmet requirements, …). */
  problems: string[];
}

/** Something a pack does that runs code — listed before installing. */
export interface PackRisk {
  kind: "script" | "host-script" | "shell" | "setup" | "bin" | "dockerfile" | "image";
  /** Block or file it comes from. */
  where: string;
  detail: string;
}

/** What installing a staged pack would do. */
export interface PackPreview {
  token: string;
  manifest: PackManifest;
  source: PackSource;
  commit?: string;
  hash: string;
  blocks: { id: string; name: string; kind?: string; isTemplate: boolean }[];
  flows: { id: string; name: string }[];
  skills: string[];
  fileCount: number;
  totalBytes: number;
  risks: PackRisk[];
  /** Needs the run-code-on-this-machine permission to work fully. */
  needsHost: boolean;
  /** The same pack id is already installed. */
  existing?: { version: string; source: PackSource; hash: string; trustHost: boolean };
  /** Files added / changed / removed compared with the installed copy. */
  changes?: { added: string[]; changed: string[]; removed: string[]; codeChanged: boolean };
  missing: PackRequirement[];
  conflicts: { id: string; installed: string; required: string }[];
  /** Installed packs whose requirements this version would break. */
  breaks: { id: string; requires: string }[];
  problems: string[];
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
  /** script / subflow: the exit it left through. */
  exit?: string;
}

export interface QaPair {
  question: string;
  answer: string;
}

export interface PendingQuestion {
  nodeId: string;
  question: string;
  askedAt?: number;
}

/** A question an agent asked during the run, and the user's answer once given. */
export interface QuestionRecord {
  nodeId: string;
  question: string;
  askedAt: number;
  answer?: string;
  answeredAt?: number;
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
  /** Every question asked so far, in order. */
  questions?: QuestionRecord[];
  /** The starting prompt this run used (a per-run prompt, or the global one). */
  prompt?: string;
  logs: LogLine[];
  error?: string;
  /** The event that started the run (manual runs get `{ source: "manual" }`). */
  trigger?: TriggerEvent;
  /** Trigger node that fired (absent for manual runs). */
  triggerNodeId?: string;
}

// ---------- "Edit with AI" chats ----------

export interface ChatToolCall {
  id: string;
  /** MCP tool name without the `mcp__sandflow__` prefix, e.g. `edit_flow`. */
  name: string;
  input: unknown;
  /** Tool output text; for edits it starts with a `Changes:` list (`+ node …`, `- edge …`, `~ …`). */
  result?: string;
  isError?: boolean;
}

export type ChatPart = { type: "text"; text: string } | { type: "tool"; call: ChatToolCall };

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  ts: number;
  parts: ChatPart[];
  /** Assistant turns only. */
  status?: "running" | "done" | "error" | "cancelled";
  /** Assistant turns: which agent answered. */
  agent?: AgentProvider;
  error?: string;
}

/** A conversation with the assistant about one flow. A flow can have many. */
export interface Chat {
  id: string;
  flowId: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  /** Agent that answers in this chat (can be switched between turns). */
  agent: AssistantAgent;
  /** Agent session to resume, per agent — switching agents starts a new session primed with the conversation so far. */
  sessions: Partial<Record<AgentProvider, string>>;
  messages: ChatMessage[];
}

export interface AssistantAgent {
  provider: AgentProvider;
  /** Empty = the CLI's default model. */
  model?: string;
}

export interface ChatSummary {
  id: string;
  flowId: string;
  title: string;
  updatedAt: number;
  running: boolean;
}

/** Sent on /api/data/events whenever flows or blocks change on the server. */
export interface DataChange {
  rev: number;
  source: "ui" | "assistant";
  flowId?: string;
  /** Nodes the assistant added or edited. */
  touched?: string[];
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
  prompt?: string;
  pendingQuestion?: PendingQuestion;
}
