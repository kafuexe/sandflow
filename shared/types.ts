// Shared domain types used by both the React UI and the flow-engine server.

import type { AgentActivity } from "./activity";

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
 * integration – runs an action of another harness's CLI on this machine (e.g. `meow run`), see shared/integrations.ts.
 */
export type BlockKind = "auto" | "ai" | "manager" | "trigger" | "condition" | "script" | "subflow" | "stack" | "flow-input" | "flow-output" | "integration";

/** A Box Stack: an orchestrator splits the input, runs `flowId` once per task (several at once) and combines the results. */
export interface StackConfig {
  flowId: string;
  /** Child exits that count as success; any other exit, or an error, rejects the attempt. */
  successExits: string[];
  /** shared = every child works in this run's sandbox; isolated = a worktree and branch per child. */
  workspace: "shared" | "isolated";
  maxConcurrent: number;
  maxChildren: number;
  /** Per task: how many times a rejected task is tried again. */
  maxRetries: number;
  splitInstructions: string;
  combineInstructions: string;
}

export type AutoAction = "create-task" | "create-mr" | "shell" | "post-comment" | "merge-parent" | "checks";

/**
 * What a gate's failure does (see shared/gates.ts): `note` = reported, counted as PASS; `retry` = leave through `fail`
 * (the default); `block` = leave through `fail` (or `pass` when nothing is wired to fail) and Create MR refuses until
 * the gate passes; `stop` = the run fails at once.
 */
export type GateFailLevel = "note" | "retry" | "block" | "stop";

/** One command of a Checks block (lint, tests, build…), run in the run's worktree. */
export interface CheckCommand {
  name: string;
  /** Shell command (`sh -c` in the sandbox; the system shell with Sandbox: None). */
  run: string;
  /** A required check that fails makes the block leave through `fail`; an advisory one is only reported (default true). */
  required?: boolean;
  /** What this check failing does (default: the block's `onFail`). Advisory checks are always `note`. */
  onFail?: GateFailLevel;
  /** Default 600. */
  timeoutSeconds?: number;
}

/** Checks blocks: the commands, and whether unchanged code reuses the last results. */
export interface ChecksConfig {
  commands?: CheckCommand[];
  /** Skip re-running when the commands and the worktree (commit + uncommitted changes) are what they were at the last passing execution (default true). */
  reuse?: boolean;
}

/** An agent block's dev server: started before the agent, stopped after it (an AI tester checking the running app). */
export interface DevServerConfig {
  /** Shell command run in the worktree, e.g. `npm run dev`. Empty = no dev server. */
  command?: string;
  /** Polled until it answers (any HTTP status below 500), e.g. `http://127.0.0.1:5173/`. Empty = only wait a moment. */
  readyUrl?: string;
  /** Longest wait for `readyUrl` (default 60). */
  startupTimeoutSeconds?: number;
}

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

/**
 * Where an agent (ai / manager block) runs: `sandbox` = a Docker/Podman container, `host` = this computer, with the
 * agent CLI installed here and your own login/config. `inherit` (the default) = the flow's choice, else Settings → Sandbox.
 */
export type RunOn = "sandbox" | "host";
export type RunOnChoice = RunOn | "inherit";

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

/** A value set for an integration option on a block or node. */
export type IntegrationValue = string | number | boolean;

/** Integration blocks: which harness action to run, and the option values set on the block / node. */
export interface IntegrationBlockConfig {
  /** Qualified integration id: `<pack>/<id>`, or `local/<id>` for your own. */
  ref?: string;
  action?: string;
  /** Named exits (from the action's exit codes); empty = plain artifact/steer outputs. */
  exits?: string[];
  /** Option values by option id; merged key by key through the template chain and node overrides. */
  options?: Record<string, IntegrationValue>;
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
  /** ai / manager: run the agent in a container or on this computer (default: inherit). */
  runOn?: RunOnChoice;
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
  /** stack blocks. */
  stack?: Partial<StackConfig>;
  /** integration blocks. */
  integration?: IntegrationBlockConfig;
  /** auto + checks: the commands to run. */
  checks?: ChecksConfig;
  /**
   * ai blocks: a gate. The agent must end with `<verdict>PASS</verdict>` or `<verdict>FAIL</verdict>` and the block
   * leaves through its `pass` / `fail` exit; a missing or malformed verdict counts as FAIL.
   */
  verdict?: boolean;
  /** ai blocks: a dev server running while the agent works. */
  devServer?: DevServerConfig;
  /** ai blocks with a verdict: when the branch only changed docs (Markdown, docs/, README, CHANGELOG, LICENSE), skip the agent and pass. */
  skipDocsOnly?: boolean;
  /** Gates (Checks, agents with a verdict): what a failure does (default `retry`); a check's own `onFail` overrides it. */
  onFail?: GateFailLevel;
  /**
   * Longest a node may run (every kind; inherited like the rest). Unset = no limit, except Shell command (30 min);
   * 0 = no limit (turns that default off). The supervisor stops a node that exceeds it (failure cause `timeout`).
   */
  timeoutSeconds?: number;
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
  /** Pack this block comes from (set when packs load). Absent = one of your own blocks. */
  pack?: string;
  /** A pack block you've edited: your version replaces the pack's until you revert it (pack updates don't apply). */
  modified?: boolean;
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
  runOn: RunOnChoice;
  maxIterations: number;
  trigger: TriggerConfig;
  condition: ConditionSpec;
  script: { run: string; where: "sandbox" | "host"; exits: string[]; timeoutSeconds?: number };
  subflow: { flowId: string };
  flowOutput: { name: string };
  stack: StackConfig;
  integration: { ref: string; action: string; exits: string[]; options: Record<string, IntegrationValue> };
  checks: { commands: CheckCommand[]; reuse: boolean };
  verdict: boolean;
  devServer: { command: string; readyUrl: string; startupTimeoutSeconds: number };
  skipDocsOnly: boolean;
  onFail: GateFailLevel;
  timeoutSeconds?: number;
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
  /** Where this flow's agents run unless a block says otherwise. Absent = Settings → Sandbox. */
  runOn?: RunOn;
  /** Pack this flow comes from (read-only; set when packs load). Absent = one of your own flows. */
  pack?: string;
  /** Optional label colour shown in the flow switcher (one of `FLOW_COLORS`). Absent = no colour. */
  color?: FlowColor;
  /** Continue this flow's interrupted runs by themselves when Sandflow starts again (default on). */
  continueAutomatically?: boolean;
  /** An agent that looks over this flow's running agents now and then (see backend/supervisor.ts). Default off. */
  overseer?: OverseerSettings;
  /** What happens when one of its steps fails (see shared/recovery.ts). Absent = the defaults. */
  recovery?: FlowRecovery;
  /** Most a run of this flow may spend on priced agent steps (USD, Box Stack tasks included). Unset = no limit. */
  budgetUsd?: number;
}

/** Per flow: the overseer agent (a short, read-only turn on this machine — Claude Code, `claude -p`, no tools). */
export interface OverseerSettings {
  enabled: boolean;
  /** Empty = SUPERVISOR_DEFAULTS.overseerModel (a small model). */
  model?: string;
  /** How often it looks, while the run has a running agent (default 300). */
  everySeconds?: number;
}

/** off: a failed step fails the run (as before recovery existed); triage: retries, then a triage agent decides. */
export type RecoveryMode = "off" | "triage";

/** A flow's Recovery setting (Inputs tab). */
export interface FlowRecovery {
  /** Default: `triage` when the flow has agent blocks, else `off`. */
  mode?: RecoveryMode;
  /** The triage agent (Claude Code; empty model = the CLI's default). */
  agent?: AssistantAgent;
  /** Triage decisions a step may cost per run before the run is held for you (default 3). */
  maxRecoveryCycles?: number;
  /** Automatic retries of a crashed / transient / stuck / timed-out step before triage (default 2). */
  maxRetries?: number;
}

/** The curated palette a flow can be tagged with. */
export type FlowColor = "red" | "orange" | "amber" | "green" | "teal" | "blue" | "violet" | "pink";

export type SandboxKind = "docker" | "podman" | "none";

export interface Settings {
  /** Global starting prompt handed to every block that accepts it. */
  startingPrompt: string;
  sandbox: SandboxKind;
  /** Safety valve for loops (e.g. CR → CR fix → CR …). */
  maxSteps: number;
  /** A run continued this many times without a step finishing isn't continued automatically again (default 5). */
  maxContinues?: number;
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
  /** Desktop app: register Sandflow's MCP server and skills with Claude Code (default on; off removes them). */
  claudeCode?: { enabled: boolean };
  /** Settings → Supervisor: the timed check of running runs (defaults: SUPERVISOR_DEFAULTS in shared/supervisor.ts). */
  supervisor?: SupervisorSettings;
  /** Settings → Notifications: tell you when runs end or need you (see backend/notify.ts). */
  notifications?: NotificationSettings;
}

/** A top-level run ended (done / failed / stopped) or is waiting for you (a question, or held). */
export type NotifyEvent = "done" | "failed" | "stopped" | "attention";

export interface NotificationSettings {
  /** Which events notify (none: off). */
  events?: NotifyEvent[];
  /** A desktop notification (shown by the app window). */
  os?: boolean;
  /** Shell command run on this computer with SANDFLOW_* env vars — only ever from these settings, never a flow / pack. */
  command?: string;
  /** POSTed a JSON summary of the run. */
  webhookUrl?: string;
}

export interface SupervisorSettings {
  enabled?: boolean;
  /** How often it looks at every live run. */
  pollSeconds?: number;
  /** A node quiet this long gets a warning flag. Unset: 10 min for agents, 15 min for others. */
  silentAfterSeconds?: number;
  /** A node quiet this long is stopped (failure cause `stuck`). */
  stuckAfterSeconds?: number;
  /** A question unanswered this long gets a reminder (then at most hourly). */
  remindAfterSeconds?: number;
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
  /** Every integration — from packs and your own (their actions are already blocks in `blocks`). */
  integrations?: IntegrationInfo[];
}

// ---------- Integrations (other harnesses) ----------

/** `args` = free-form command-line text, split into arguments (quotes respected, nothing expanded). */
export type IntegrationOptionType = "string" | "text" | "boolean" | "number" | "select" | "args";

export interface IntegrationChoice {
  value: string;
  label?: string;
}

/** Something a user can set on an integration block, and how it becomes command-line arguments. */
export interface IntegrationOption {
  id: string;
  label: string;
  type: IntegrationOptionType;
  description?: string;
  default?: IntegrationValue;
  required?: boolean;
  placeholder?: string;
  /** Arguments added when the option is set (`["--workflow", "{{value}}"]`); a boolean adds them when it's on. */
  args?: string[];
  /** select: the fixed choices. */
  choices?: (string | IntegrationChoice)[];
  /**
   * select: load the choices by running the harness (e.g. `["workflows", "list"]`). Each output line matching
   * `pattern` is a choice — group 1 is the value, group 2 (optional) its label. Without a pattern every line is one.
   */
  choicesFrom?: { args: string[]; pattern?: string };
  /** select: a value that isn't in the list may be typed in. */
  allowCustom?: boolean;
}

/** One thing a harness can do — each becomes a block. */
export interface IntegrationAction {
  id: string;
  name: string;
  description?: string;
  icon?: string;
  /** Arguments after the command, as templates (`{{input}}`, `{{env.REPO_PATH}}`, `{{option.name}}`, …). */
  args: string[];
  options?: IntegrationOption[];
  inputs?: BlockInputs;
  outputs?: BlockOutputs;
  /** Env vars the action needs (added to the integration's own `env`). */
  env?: string[];
  /** Working directory template. Default: the run's worktree, else REPO_PATH, else a scratch folder. */
  cwd?: string;
  /** Exit code → named exit, e.g. `{"0": "delivered", "3": "no-mr"}`. */
  exitCodes?: Record<string, string>;
  /** Exit taken by every other exit code. Without it, an unmapped non-zero code fails the block. */
  failExit?: string;
  /** Output artifact template. Default `{{stdout}}`; also `{{stderr}}`, `{{code}}`, `{{match.<name>}}`. */
  artifact?: string;
  /** Regexes run over the output; group 1 (or the whole match) becomes `{{match.<name>}}`. */
  matches?: Record<string, string>;
  timeoutSeconds?: number;
}

/** `integrations/<id>.json` in a pack (or one of your own): how to drive another harness's CLI. */
export interface IntegrationDef {
  id: string;
  name: string;
  description?: string;
  homepage?: string;
  icon?: string;
  color?: string;
  /** The executable (found on PATH; `SANDFLOW_<COMMAND>_PATH` points at a specific one). */
  command: string;
  /** How to tell it's installed, e.g. `{"args": ["--version"]}`; the first version-like text is its version. */
  detect?: { args: string[]; pattern?: string };
  /** How to install it — shown to the user, never run by Sandflow. Commands by platform (`win32`, `linux`, `darwin`, `default`). */
  install?: { url?: string; notes?: string; commands?: Record<string, string> };
  /** Env vars every action needs. */
  env?: string[];
  /** Options every action has (listed after the action's own). */
  options?: IntegrationOption[];
  actions: IntegrationAction[];
}

/** An integration as the UI sees it. */
export interface IntegrationInfo {
  /** Qualified id: `<pack>/<id>`, or `local/<id>` for your own. */
  id: string;
  /** `local` for your own. */
  pack: string;
  def: IntegrationDef;
  /** May run on this machine: your own always may; a pack's when that pack is trusted. */
  trusted: boolean;
  problems: string[];
}

/** Is the harness installed here? */
export interface IntegrationStatus {
  id: string;
  installed: boolean;
  version?: string;
  /** Executable that was found. */
  path?: string;
  /** Why it couldn't be checked / found. */
  error?: string;
  checkedAt: number;
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
  integrationCount?: number;
  /** Problems found while loading (bad JSON, unmet requirements, …). */
  problems: string[];
}

/** Something a pack does that runs code — listed before installing. */
export interface PackRisk {
  kind: "script" | "host-script" | "shell" | "setup" | "bin" | "dockerfile" | "image" | "integration";
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
  /** Harnesses this pack integrates (each action is one of `blocks`). */
  integrations?: { id: string; name: string; command: string; actions: string[] }[];
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
/** `paused`: the run stopped working without ending (quit, update, crash) — it can be continued (see shared/journal.ts). */
export type RunStatus = "running" | "waiting" | "paused" | "done" | "failed" | "cancelled";

/** Where a run is in its life (journaled with every change, see shared/journal.ts). */
export type RunPhase = "running" | "waiting" | "pausing" | "paused" | "interrupted" | "continuing" | "done" | "failed" | "cancelled";
/** Why a run paused: Sandflow quit, updated, stopped without saying (crash, power loss…), or recovery held it for you. */
export type PauseReason = "quit" | "update" | "crash" | "blocked";

/** What triage may decide for a failed step. */
export type RecoveryAction = "retry" | "resume" | "rescope" | "skip" | "blocked";

/** Why recovery held the run for a human instead of going on (MEOW blocker causes). */
export type RecoveryGuard = "needs-human" | "repeated-decision" | "invalid-decision" | "triage-failed" | "recovery-exhausted";

/** One thing recovery did after a step failed. */
export interface RecoveryEntry {
  at: number;
  cause: FailureCause;
  message: string;
  /** What was done: a triage action, an automatic `retry`, `fail` (recovery off / nothing to do) or `hold`. */
  decision: RecoveryAction | "fail" | "hold";
  by: "auto" | "triage";
  reason?: string;
  notes?: string;
  /** rescope: the task the step got instead of its input. */
  task?: string;
  /** Held: which guard stopped it. */
  guard?: RecoveryGuard;
  /** Agent steps run again: whether they continued their own session or started fresh. */
  session?: "resume" | "fresh";
  /** Automatic retries: the backoff before it. */
  delayMs?: number;
}

/** A step's recovery in this run (journaled: the budget survives a continue). */
export interface NodeRecovery {
  /** Triage decisions applied (counted against maxRecoveryCycles). */
  cycles: number;
  /** Automatic retries since the step last finished or triage last decided. */
  retries?: number;
  /** Triage notes for this step, appended to its instructions for the rest of the run. */
  notes?: string[];
  history: RecoveryEntry[];
}

export interface RunTransition {
  phase: RunPhase;
  at: number;
  attempt: number;
}

/** A step waiting in a graph's queue, with the inputs it will receive. */
export interface QueuedStep {
  nodeId: string;
  inputs: NodeIO;
}

/** What a run must still match to be continued: stamped at its first start, checked before every continue. */
export interface RunFingerprints {
  /** sha256 of the flow and every block / flow it reaches (layout left out). */
  flow: string;
  /** sha256 of the settings that change how it runs. */
  settings: string;
  workspace: { repo?: string; branch: string; commit?: string };
}

/** An agent's own session (e.g. Claude Code's), so an interrupted agent can carry on where it was. */
export interface AgentSessionRef {
  id: string;
  /** `host` = this computer; otherwise the container id it ran in. */
  where: string;
}

export interface NodeUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  /** Model the agent was set to (empty: the CLI's default). */
  model?: string;
  /** Absent: the model has no known price (see shared/pricing.ts). */
  costUsd?: number;
  at: number;
}

/** A Checks block's last results, journaled so an unchanged worktree reuses them. */
export interface ChecksEvidence {
  /** sha256 of the commands and the worktree (HEAD + uncommitted changes) they ran on. */
  fingerprint: string;
  passed: boolean;
  /** `onFail` = the check's level when it isn't `retry`. */
  results: { name: string; required: boolean; ok: boolean; code: number | null; seconds: number; output: string; onFail?: GateFailLevel }[];
  at: number;
}

/** What an irreversible step (Create MR, Post comment, Merge into parent) already did, so it's never done twice. */
export interface NodeDelivery {
  /** Execution of the node this belongs to. */
  exec: number;
  pushed?: boolean;
  mrUrl?: string;
  commentUrl?: string;
  merged?: boolean;
}

/** A Box Stack node's tasks, journaled so continuing doesn't redo finished ones. */
export interface StackJournal {
  groupId: string;
  tasks: {
    name: string;
    slug: string;
    input: string;
    status: "pending" | "running" | "done" | "dropped";
    /** The current attempt's child run. */
    runId?: string;
    attempt: number;
    outputs?: NodeIO;
    branch?: string;
    reason?: string;
  }[];
}

/** Why a paused run waits for you instead of continuing by itself. */
export interface RunHold {
  /**
   * validation: something it needs changed (Repair adopts it); manual: the flow's switch is off; loop: continued too
   * often; blocked: recovery stopped at a failed step and needs you (`guard` says why; Continue runs that step again).
   */
  reason: "validation" | "manual" | "loop" | "corrupt" | "blocked";
  /** blocked: which recovery guard held it, and the step. */
  guard?: RecoveryGuard;
  nodeKey?: string;
  problems: string[];
  /** Repair can adopt the current state. */
  repairable?: boolean;
  at: number;
}

export interface NodeIO {
  artifact?: string;
  steer?: string;
}

/**
 * Why a node failed: `error` the block itself failed · `timeout` its time limit · `stuck` the supervisor stopped it ·
 * `crash` a crash-like exit · `transient` OS / network / CLI connection trouble · `sandbox` its container vanished ·
 * `interrupted` cut off by a pause / crash.
 */
export type FailureCause = "error" | "timeout" | "stuck" | "crash" | "transient" | "sandbox" | "interrupted";

/** What the supervisor noticed or did (journaled on the run, reported to watchers as `supervisor` events). */
export interface SupervisionEntry {
  at: number;
  /** Node key it's about, if any. */
  node?: string;
  /** The node's execution it was about (overseer limits count per execution). */
  exec?: number;
  kind: "silent" | "stuck" | "timeout" | "loop" | "reminder" | "sandbox" | "overseer";
  detail: string;
  /** What was done: `stopped`, `steered`, `flagged`, `ignored`… (absent: only noted). */
  action?: string;
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
  /** Resumed run: this step didn't run again — its state and outputs were copied from the original run. */
  restored?: boolean;
  /** When the current attempt started / finished (journal: started and not finished = active). */
  startedAt?: number;
  finishedAt?: number;
  /** The attempt was cut off by a pause or crash; `mutation` = it could have been changing files. */
  interrupted?: "mutation" | "plain";
  /** Agent nodes: the agent's session, journaled the moment it's known. */
  session?: AgentSessionRef;
  usage?: NodeUsage[];
  delivery?: NodeDelivery;
  stack?: StackJournal;
  /** Why the last attempt failed (see FailureCause). */
  failure?: { cause: FailureCause; message: string; at: number };
  /** Gates: a `block`-level failure, kept until this gate passes — while any node has one, Create MR refuses. */
  gateBlock?: { message: string; at: number };
  /** Its latest sign of life (log line, agent activity) — what the supervisor's liveness check reads. */
  lastActivityAt?: number;
  /** Executions in a row that produced exactly the previous execution's output (a loop going nowhere). */
  repeats?: number;
  /** Checks blocks: the last results. */
  checks?: ChecksEvidence;
}

/** Where a run's agents worked — recorded so the run can be resumed on the same branch. */
export interface RunWorkspace {
  /** REPO_PATH when the run started (absent: a scratch workspace, removed when the run ended). */
  repo?: string;
  /** The branch the run's sandbox uses (Create task may switch to its own; that one is `RunState.branch`). */
  branch: string;
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

/**
 * A message the user sent to a working agent node mid-run ("focus on X", "stop and summarize"). It reaches the agent
 * by interrupting its current turn and resuming the same session with it (`interrupt`), or — for agents that can't
 * resume a session — at the agent's next turn (`next-turn`).
 */
export interface SteerRecord {
  id: string;
  nodeId: string;
  message: string;
  sentAt: number;
  /** pending: not handed to the agent yet; dropped: the step ended first. */
  status: "pending" | "applied" | "dropped";
  appliedAt?: number;
  how?: "interrupt" | "next-turn";
  /** Why it was dropped, or how it was delivered when that's worth saying. */
  note?: string;
}

/** Longest steering message accepted. */
export const MAX_STEER_CHARS = 4000;

export interface LogLine {
  ts: number;
  level: "info" | "warn" | "error" | "agent";
  nodeId?: string;
  msg: string;
}

export type FlagSeverity = "warning" | "error";

/** Something that went wrong in a run and needs a look — saved on the run until it's cleared. */
export interface RunFlag {
  id: string;
  severity: FlagSeverity;
  /** Node key that raised it (`stack1`, `stack1/cr`), if any. */
  nodeKey?: string;
  message: string;
  /** Longer text shown when the flag is expanded. */
  details?: string;
  /** Set when the flag was copied up from a child run. */
  fromRunId?: string;
  at: number;
  dismissed?: boolean;
}

/** Who started a run from outside the app (absent: the UI, a trigger or a stack). */
export interface RunStartedBy {
  /** claude-code: through the Claude Code registration (the stdio bridge); mcp: any other MCP client. */
  kind: "claude-code" | "mcp";
  label: string;
}

/** Where a stack child run sits in its stack. */
export interface StackRunInfo {
  /** One per stack execution (a looping parent gets a new group each time it reaches the stack). */
  groupId: string;
  /** The stack node's label. */
  name: string;
  /** Task position from the split (0-based). */
  index: number;
  total: number;
  /** Task name from the split. */
  task: string;
  /** 1-based. */
  attempt: number;
  maxAttempts: number;
  outcome?: "succeeded" | "rejected" | "dropped";
  /** Isolated workspace: the child's own branch. */
  branch?: string;
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
  /** Steering messages sent to agent nodes while they worked, in the order sent. */
  steers?: SteerRecord[];
  /** The starting prompt this run used (a per-run prompt, or the global one). */
  prompt?: string;
  logs: LogLine[];
  /** What each agent node was thinking / doing, by node key (capped per node, see shared/activity.ts). */
  activity?: Record<string, AgentActivity[]>;
  error?: string;
  /** The event that started the run (manual runs get `{ source: "manual" }`). */
  trigger?: TriggerEvent;
  /** Trigger node that fired (absent for manual runs). */
  triggerNodeId?: string;
  flags?: RunFlag[];
  /** Set on a run started by another run's stack node. */
  parent?: { runId: string; nodeKey: string };
  stack?: StackRunInfo;
  /** A run started with an input (stack children): what it was handed. */
  input?: NodeIO;
  /** A run started with an input (stack children): the Flow output it reached and what it handed back. */
  result?: { exit?: string; outputs?: NodeIO };
  /** Where its agents worked (absent on runs from before resuming existed — those can't be resumed). */
  workspace?: RunWorkspace;
  /** Top-level steps still queued when the run failed or was stopped, with their inputs ("Retry" starts them too). */
  unstarted?: { nodeId: string; inputs: NodeIO }[];
  /** This run resumes another one: started from these steps, with the other steps' outputs copied from it. */
  resumedFrom?: { runId: string; nodeIds: string[] };

  // ---- journal (see shared/journal.ts): enough on its own to continue the run as the same run ----
  schemaVersion?: number;
  phase?: RunPhase;
  transitions?: RunTransition[];
  /** 1 = first start; +1 per continue. */
  attempt?: number;
  pauseReason?: PauseReason;
  /** Set while a paused run waits for you (Continue / Repair) instead of continuing by itself. */
  hold?: RunHold;
  fingerprints?: RunFingerprints;
  /** Each graph's queue, by node-key prefix (`""` top level, `sub/` inside subflow node `sub`). */
  queues?: Record<string, QueuedStep[]>;
  /** Steps taken so far (counted against Settings → max steps). */
  steps?: number;
  /** Continues since a step last finished (a run that keeps dying isn't continued automatically forever). */
  stalls?: number;
  /** Containers the run's sandboxes ran in, and agent processes on this computer — removed if left over by a crash. */
  sandboxes?: { kind: "docker" | "podman"; containerId: string }[];
  processes?: { pid: number; startedAt: number }[];
  /** What each Repair adopted. */
  repairs?: { at: number; changes: string[] }[];
  /** What recovery did after steps failed, by node key (see shared/recovery.ts). */
  recovery?: Record<string, NodeRecovery>;
  startedBy?: RunStartedBy;
  /** What the supervisor noticed / did, oldest first (capped; `supervisionDropped` counts what was cut off the front). */
  supervision?: SupervisionEntry[];
  supervisionDropped?: number;
  /** Priced spend so far (USD): its own steps and its Box Stack tasks'. */
  costUsd?: number;
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

/** A branch a finished run left behind (Settings → Clean up, see backend/cleanup.ts). */
export interface CleanupItem {
  /** `<repo>\0<branch>` — what the UI sends back to remove. */
  id: string;
  repo: string;
  branch: string;
  /** Runs that used the branch, newest first. */
  runIds: string[];
  /** A worktree still checked out on it (removed with it). */
  worktree?: string;
  removable: boolean;
  /** Why it's kept, or what removing it does. */
  reason: string;
}

export interface CleanupResult {
  id: string;
  ok: boolean;
  message: string;
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
  /** Undismissed flags by severity (absent when there are none). */
  flags?: { warning: number; error: number };
  parent?: { runId: string; nodeKey: string };
  stack?: StackRunInfo;
  resumedFrom?: { runId: string; nodeIds: string[] };
  phase?: RunPhase;
  pauseReason?: PauseReason;
  hold?: RunHold;
  startedBy?: RunStartedBy;
  costUsd?: number;
}
