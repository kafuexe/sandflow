// Turns a run's flat log into what the Agent screen shows: steps (one per block execution), questions and notices.

import { nodeLabel } from "../../shared/resolve";
import type { BlockDef, Flow, LogLine, QuestionRecord, RunState, RunSummary } from "../../shared/types";

export type StepStatus = "running" | "waiting" | "done" | "failed" | "stopped";

export interface StepItem {
  kind: "step";
  key: string;
  ts: number;
  nodeId: string;
  execution: number;
  endedAt?: number;
  status: StepStatus;
  /** Everything the block logged during this execution (agent output, warnings…). */
  lines: LogLine[];
  /** e.g. "routed to Create MR" or "true". */
  note?: string;
}

export interface QuestionItem {
  kind: "question";
  key: string;
  ts: number;
  record: QuestionRecord;
  pending: boolean;
}

export interface NoticeItem {
  kind: "notice";
  key: string;
  ts: number;
  level: "warn" | "error";
  text: string;
}

export type TimelineItem = StepItem | QuestionItem | NoticeItem;

export interface FlowStep {
  id: string;
  label: string;
}

/** The flow's nodes in the order a run reaches them (breadth-first from the start nodes). */
export function flowSteps(flow: Flow, blocks: BlockDef[]): FlowStep[] {
  const incoming = new Set(flow.edges.map((e) => e.target));
  const queue = flow.nodes.filter((n) => !incoming.has(n.id)).map((n) => n.id);
  const seen = new Set<string>();
  for (let i = 0; i < queue.length; i++) {
    const id = queue[i];
    if (seen.has(id)) continue;
    seen.add(id);
    for (const e of flow.edges) if (e.source === id && !seen.has(e.target)) queue.push(e.target);
  }
  // Nodes unreachable from a start node (e.g. inside a cycle) still belong on the rail.
  for (const n of flow.nodes) seen.add(n.id);
  const byId = new Map(flow.nodes.map((n) => [n.id, n]));
  return [...seen].map((id) => ({ id, label: nodeLabel(byId.get(id)!, blocks) }));
}

// Log lines the engine writes itself; the timeline shows them as structure, not text.
const START_RE = /^▶ .* — execution (\d+)$/;

export function buildTimeline(run: RunState): TimelineItem[] {
  const items: TimelineItem[] = [];
  const open = new Map<string, StepItem>();

  for (const [i, l] of run.logs.entries()) {
    const start = l.nodeId ? START_RE.exec(l.msg) : null;
    if (l.nodeId && start) {
      const step: StepItem = {
        kind: "step", key: `s${i}`, ts: l.ts, nodeId: l.nodeId, execution: Number(start[1]), status: "running", lines: [],
      };
      open.set(l.nodeId, step);
      items.push(step);
      continue;
    }
    const step = l.nodeId ? open.get(l.nodeId) : undefined;
    if (step && l.level === "info" && l.msg.startsWith("✓ ")) {
      step.status = "done";
      step.endedAt = l.ts;
      open.delete(step.nodeId);
    } else if (step && l.level === "info" && l.msg.startsWith("↪ ")) {
      step.note = l.msg.slice(2);
    } else if (step && l.level === "info" && (l.msg.startsWith("Question: ") || l.msg.startsWith("Answer: "))) {
      // shown as question cards
    } else if (step) {
      step.lines.push(l);
    } else if (l.level === "error" || l.level === "warn") {
      items.push({ kind: "notice", key: `n${i}`, ts: l.ts, level: l.level, text: l.msg });
    }
  }

  for (const step of open.values()) {
    if (run.finishedAt) {
      step.status = run.status === "failed" ? "failed" : "stopped";
      step.endedAt = run.finishedAt;
    } else if (run.pendingQuestion?.nodeId === step.nodeId) {
      step.status = "waiting";
    }
  }

  for (const [i, q] of (run.questions ?? []).entries()) {
    const pending = !q.answeredAt && run.pendingQuestion?.nodeId === q.nodeId && run.pendingQuestion.question === q.question;
    items.push({ kind: "question", key: `q${i}`, ts: q.askedAt, record: q, pending });
  }

  // Stable: a question asked during a step lands after that step's header.
  return items.map((it, i) => [it, i] as const).sort((a, b) => a[0].ts - b[0].ts || a[1] - b[1]).map(([it]) => it);
}

/** One line naming the run: its prompt, else what triggered it, else the flow. */
export function runTitle(r: Pick<RunSummary, "flowName" | "prompt" | "trigger">): string {
  const first = r.prompt?.split("\n").find((l) => l.trim())?.trim();
  return first || r.trigger?.title?.trim() || r.flowName;
}

export const isActive = (r: Pick<RunSummary, "finishedAt">) => !r.finishedAt;
