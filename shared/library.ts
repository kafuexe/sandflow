// Built-in blocks, templates, the recommended-skills catalog and the default flow.

import type { BlockDef, Flow, FlowEdge, SkillRef } from "./types";

// The base skills are vendored into `skills/` (see skills/*/SOURCE.md) and copied into the sandbox as files.
const sp = (name: string, why: string): SkillRef => ({
  name,
  source: "obra/superpowers",
  file: { store: "bundled", dir: `obra-superpowers/${name}` },
  url: `https://github.com/obra/superpowers/tree/main/skills/${name}`,
  why,
});
const mp = (name: string, why: string): SkillRef => ({
  name,
  source: "mattpocock/skills",
  file: { store: "bundled", dir: `mattpocock-skills/${name}` },
  url: `https://github.com/mattpocock/skills/tree/main/skills/engineering/${name}`,
  why,
});

/** Every skill recommended by a built-in block — offered by "Add recommended" in the block editor. */
export const SKILL_CATALOG: SkillRef[] = [
  sp("using-git-worktrees", "Isolated branch/worktree setup for a new task"),
  sp("brainstorming", "Explore intent and requirements before planning"),
  sp("writing-plans", "Turn requirements into a step-by-step implementation plan"),
  sp("executing-plans", "Work a written plan task by task"),
  sp("test-driven-development", "Red → green → refactor for every change"),
  mp("tdd", "Matt Pocock's TDD workflow"),
  sp("requesting-code-review", "Structured review of a diff against its plan"),
  mp("code-review", "Matt Pocock's code-review checklist"),
  sp("receiving-code-review", "Apply review feedback with technical rigor"),
  sp("finishing-a-development-branch", "Wrap up a branch and open a merge request"),
  sp("verification-before-completion", "Check evidence before claiming something is done"),
];

const skill = (name: string) => SKILL_CATALOG.find((s) => s.name === name)!;

const OUTPUT_NOTE =
  "Work in the current repository checkout (it is already on the task branch).";

export const BUILTIN_BLOCKS: BlockDef[] = [
  // ---------- Templates ----------
  {
    id: "tpl-ai-agent",
    name: "AI Agent (template)",
    isTemplate: true,
    builtin: true,
    config: {
      kind: "ai",
      description: "Base for agent blocks: accepts artifact, steer and the starting prompt.",
      color: "#8b5cf6",
      icon: "bot",
      inputs: { artifact: true, steer: true, startingPrompt: true },
      outputs: { artifact: true, steer: true },
      env: ["REPO_PATH", "ANTHROPIC_API_KEY"],
      agent: { provider: "claudeCode", model: "claude-opus-4-8", effort: "high" },
    },
  },
  {
    id: "tpl-auto-git",
    name: "Git Automation (template)",
    isTemplate: true,
    builtin: true,
    config: {
      kind: "auto",
      description: "Base for deterministic git/CLI steps run on the host.",
      color: "#10b981",
      icon: "git-branch",
      env: ["REPO_PATH"],
    },
  },
  {
    id: "tpl-reviewer",
    name: "Reviewer (template)",
    isTemplate: true,
    extends: "tpl-ai-agent",
    builtin: true,
    config: {
      description: "Base for review agents (a template that extends a template).",
      color: "#f59e0b",
      icon: "search-check",
      instructions:
        "You are a meticulous senior code reviewer. Focus on correctness, security, missing tests and deviations from the plan. " +
        "Do not modify code. Be concrete: cite files and lines.",
      skills: [skill("requesting-code-review")],
    },
  },

  // ---------- Blocks ----------
  {
    id: "create-task",
    name: "Create task",
    isTemplate: false,
    extends: "tpl-auto-git",
    builtin: true,
    config: {
      description: "Creates the task branch from BASE_BRANCH and hands the starting prompt on as the task.",
      icon: "flag",
      autoAction: "create-task",
      inputs: { startingPrompt: true },
      outputs: { artifact: true },
      env: ["BRANCH_NAME", "BASE_BRANCH"],
      skills: [skill("using-git-worktrees")],
    },
  },
  {
    id: "plan",
    name: "Plan",
    isTemplate: false,
    extends: "tpl-ai-agent",
    builtin: true,
    config: {
      description: "Reads the task and the repo and writes an implementation plan.",
      icon: "list-checks",
      color: "#6366f1",
      instructions:
        "You are a senior engineer planning a change. Read the task and explore the repository. " +
        "Produce a step-by-step implementation plan: files to change or create, tests to write first, risks and open questions. " +
        "Do NOT write or modify any code. " +
        "The artifact is the full plan in markdown; the steer is the handful of key points the implementer must not miss.",
      skills: [skill("writing-plans"), skill("brainstorming")],
    },
  },
  {
    id: "implement",
    name: "Implement",
    isTemplate: false,
    extends: "tpl-ai-agent",
    builtin: true,
    config: {
      description: "Implements the plan with TDD and commits the work.",
      icon: "hammer",
      color: "#3b82f6",
      maxIterations: 5,
      instructions:
        "You are implementing a plan. Follow the input artifact (the plan) and the steering notes. " +
        "Use test-driven development: write a failing test, make it pass, refactor. Commit your work in small, well-described commits. " +
        OUTPUT_NOTE +
        " The artifact is a summary of what you changed and how it was tested; the steer lists anything a reviewer should look at closely.",
      skills: [skill("executing-plans"), skill("test-driven-development"), skill("tdd")],
    },
  },
  {
    id: "cr",
    name: "CR",
    isTemplate: false,
    extends: "tpl-reviewer",
    builtin: true,
    config: {
      description: "Reviews the branch diff against the plan and gives a verdict.",
      icon: "search-check",
      env: ["BASE_BRANCH"],
      extraInstructions:
        "Review the diff of this branch against the base branch (`git fetch origin` then `git diff origin/$BASE_BRANCH...HEAD`, " +
        "or `git diff $BASE_BRANCH...HEAD` if there is no remote). Compare it with the plan/summary in the input artifact. " +
        "The artifact is your review and MUST end with a line that is exactly `VERDICT: APPROVED` or `VERDICT: CHANGES_REQUESTED`. " +
        "The steer is a concrete, numbered list of fixes (empty if approved).",
      skills: [skill("code-review")],
    },
  },
  {
    id: "cr-fix",
    name: "CR fix",
    isTemplate: false,
    extends: "tpl-ai-agent",
    builtin: true,
    config: {
      description: "Applies the requested review changes and commits them.",
      icon: "wrench",
      color: "#ef4444",
      maxIterations: 3,
      instructions:
        "You are addressing code-review feedback. The input artifact is the review; the steer is the list of requested fixes. " +
        "Verify each point before changing code, fix what is valid (with tests), and commit. " +
        OUTPUT_NOTE +
        " The artifact lists what you fixed and anything you deliberately did not change (with reasons).",
      skills: [skill("receiving-code-review")],
    },
  },
  {
    id: "create-mr",
    name: "Create MR",
    isTemplate: false,
    extends: "tpl-auto-git",
    builtin: true,
    config: {
      description: "Pushes the branch and opens a pull/merge request with gh or glab.",
      icon: "git-pull-request",
      autoAction: "create-mr",
      inputs: { artifact: true },
      outputs: { artifact: true },
      env: ["MR_PROVIDER", "BASE_BRANCH", "BRANCH_NAME"],
      skills: [skill("finishing-a-development-branch")],
    },
  },
  {
    id: "manager",
    name: "Manager",
    isTemplate: false,
    extends: "tpl-ai-agent",
    builtin: true,
    config: {
      kind: "manager",
      description: "Reads the incoming result and routes it to exactly one of its outgoing connections.",
      icon: "split",
      color: "#ec4899",
      instructions:
        "You are a delivery manager deciding the next step of a pipeline. Read the input artifact and steering notes, " +
        "then pick exactly one route. Default guidance: if the review is approved / has no requested changes, route to the " +
        "step that creates the merge request; otherwise route to the step that fixes the review comments. " +
        "Do not modify code.",
      skills: [skill("verification-before-completion")],
    },
  },
  {
    id: "shell",
    name: "Shell command",
    isTemplate: false,
    extends: "tpl-auto-git",
    builtin: true,
    config: {
      description: "Runs a shell command in REPO_PATH on the host; stdout becomes the artifact.",
      icon: "terminal",
      autoAction: "shell",
      shellCommand: "git log --oneline -5",
      inputs: { artifact: true },
      outputs: { artifact: true },
    },
  },
];

const edge = (source: string, target: string, sourceHandle: FlowEdge["sourceHandle"], targetHandle = sourceHandle): FlowEdge => ({
  id: `e-${source}-${sourceHandle}-${target}-${targetHandle}`,
  source,
  target,
  sourceHandle,
  targetHandle,
});

const X = 320;
const node = (id: string, blockId: string, col: number, row = 0) => ({
  id,
  type: "block" as const,
  position: { x: col * X, y: row * 260 },
  data: { blockId },
});

export const DEFAULT_FLOW: Flow = {
  id: "feature-pipeline",
  name: "Feature pipeline",
  nodes: [
    node("n-create-task", "create-task", 0),
    node("n-plan", "plan", 1),
    node("n-implement", "implement", 2),
    node("n-cr", "cr", 3),
    node("n-manager", "manager", 4),
    node("n-create-mr", "create-mr", 5),
    node("n-cr-fix", "cr-fix", 4, 1),
  ],
  edges: [
    edge("n-create-task", "n-plan", "artifact"),
    edge("n-plan", "n-implement", "artifact"),
    edge("n-plan", "n-implement", "steer"),
    edge("n-implement", "n-cr", "artifact"),
    edge("n-cr", "n-manager", "artifact"),
    edge("n-cr", "n-manager", "steer"),
    edge("n-manager", "n-cr-fix", "artifact"),
    edge("n-manager", "n-cr-fix", "steer"),
    edge("n-cr-fix", "n-cr", "artifact"),
    edge("n-manager", "n-create-mr", "artifact"),
  ],
};
