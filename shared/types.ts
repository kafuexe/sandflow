// Shared domain types used by both the React UI and the flow-engine server.

/** The two things a block can emit. */
export type OutputKind = "artifact" | "steer";
/** Inputs that travel along edges (the other two — starting prompt and env — are global). */
export type EdgeInputKind = "artifact" | "steer";

/**
 * auto    – deterministic logic run on the host (git, CLI, shell).
 * ai      – an agent run inside a sandcastle sandbox.
 * manager – an agent that decides which outgoing connection receives the task.
 */
export type BlockKind = "auto" | "ai" | "manager";

export type AutoAction = "create-task" | "create-mr" | "shell";

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
  sourceHandle: OutputKind;
  targetHandle: EdgeInputKind;
}

export interface Flow {
  id: string;
  name: string;
  nodes: FlowNode[];
  edges: FlowEdge[];
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
}
