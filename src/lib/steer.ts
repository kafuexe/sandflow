// Whether a node of a run can be steered right now, and how the message will reach it. Free of React (unit-tested).

import type { AgentProvider, ResolvedConfig, RunState, SteerRecord } from "../../shared/types";

/** Agent CLIs whose sessions can be resumed: steering interrupts them and continues the same session. */
const RESUMES: AgentProvider[] = ["claudeCode", "codex", "pi"];

export interface Steerability {
  /** The box takes messages. */
  can: boolean;
  /** An agent block (the box is shown, possibly disabled). */
  agent: boolean;
  /** Why it can't be steered, or what happens to the message. */
  hint: string;
}

export function steerability(run: Pick<RunState, "finishedAt" | "nodes"> | undefined, nodeKey: string, cfg: Pick<ResolvedConfig, "kind" | "agent"> | undefined): Steerability {
  const agent = cfg?.kind === "ai" || cfg?.kind === "manager";
  if (!run || run.finishedAt) return { can: false, agent, hint: "This run has ended — steering reaches an agent only while it works." };
  if (!agent) return { can: false, agent, hint: "Only AI agent and manager blocks can be steered." };
  const status = run.nodes[nodeKey]?.status ?? "idle";
  if (status === "running") {
    return {
      can: true,
      agent,
      hint: RESUMES.includes(cfg!.agent.provider)
        ? "The agent pauses, reads your message and continues the same session — nothing it did is lost."
        : "This agent can't be paused mid-turn: it gets your message as soon as its current turn ends.",
    };
  }
  if (status === "waiting") return { can: true, agent, hint: "It's waiting for your answer — your message goes along with it." };
  if (status === "done" || status === "failed") return { can: false, agent, hint: "This step has finished — steering reaches an agent only while it works." };
  return { can: false, agent, hint: "This step hasn't started yet — you can steer it once it's working." };
}

/** The node's steering messages, in the order sent. */
export const steersOf = (run: Pick<RunState, "steers"> | undefined, nodeKey: string): SteerRecord[] =>
  (run?.steers ?? []).filter((s) => s.nodeId === nodeKey);

/** A running agent node the canvas / Agent screen offers a "Steer" button on. */
export const offersSteer = (run: Pick<RunState, "finishedAt" | "nodes"> | undefined, nodeKey: string, kind: ResolvedConfig["kind"] | undefined) =>
  !!run && !run.finishedAt && (kind === "ai" || kind === "manager") && run.nodes[nodeKey]?.status === "running";
