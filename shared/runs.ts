// Run helpers shared by the server and the UI.

import type { RunState, RunSummary } from "./types";

function flagCounts(r: RunState): RunSummary["flags"] {
  const open = (r.flags ?? []).filter((f) => !f.dismissed);
  if (!open.length) return undefined;
  return { warning: open.filter((f) => f.severity === "warning").length, error: open.filter((f) => f.severity === "error").length };
}

export function summarize(r: RunState): RunSummary {
  const t = r.trigger;
  return {
    id: r.id,
    flowId: r.flowId,
    flowName: r.flowName,
    status: r.status,
    startedAt: r.startedAt,
    finishedAt: r.finishedAt,
    trigger: t ? { source: t.source, type: t.type, author: t.author, title: t.title } : undefined,
    prompt: r.prompt,
    pendingQuestion: r.pendingQuestion,
    flags: flagCounts(r),
    parent: r.parent,
    stack: r.stack,
    ...(r.resumedFrom ? { resumedFrom: r.resumedFrom } : {}),
  };
}
