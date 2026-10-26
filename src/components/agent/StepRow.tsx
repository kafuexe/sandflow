import { useState } from "react";
import { ChevronRight, Loader2, Navigation } from "lucide-react";
import { activityOf } from "@/lib/activityView";
import { offersSteer, steersOf } from "@/lib/steer";
import { BlockIcon } from "@/lib/icons";
import type { StepItem } from "@/lib/timeline";
import { cn } from "@/lib/utils";
import type { RunState } from "../../../shared/types";
import type { AgentActivity } from "../../../shared/activity";
import { ActivityFilterBar, ActivityList, useActivityFilter } from "../AgentActivity";
import { SteerBox } from "../SteerBox";
import { Disclosure } from "./Disclosure";
import { RerunFromHere } from "../ResumeControls";
import { useAgent } from "@/lib/agent";
import { duration } from "./status";
import type { RunFlow } from "./useRunFlow";

const MAX_LINES = 400;

function StatusText({ item, now }: { item: StepItem; now: number }) {
  switch (item.status) {
    case "running":
      return (
        <span className="flex items-center gap-1 text-sky-300">
          <Loader2 className="size-3 animate-spin motion-reduce:animate-none" /> Working {duration(now - item.ts)}
        </span>
      );
    case "waiting":
      return <span className="text-amber-300">Waiting for your answer</span>;
    case "done":
      return <span className="text-muted-foreground">Done in {duration((item.endedAt ?? item.ts) - item.ts)}</span>;
    case "failed":
      return <span className="text-red-300">Failed</span>;
    case "stopped":
      return <span className="text-muted-foreground">Stopped</span>;
  }
}

/** What the agent thought and did during this step; open while it runs. */
function StepActivity({ items, running }: { items: AgentActivity[]; running: boolean }) {
  const [open, setOpen] = useState(running);
  const activityFilter = useActivityFilter();
  return (
    <details open={open} onToggle={(e) => setOpen(e.currentTarget.open)} className="group/d">
      <summary className="flex w-fit cursor-pointer list-none items-center gap-1 rounded text-xs text-muted-foreground outline-none select-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60 [&::-webkit-details-marker]:hidden">
        <ChevronRight className="size-3.5 transition-transform group-open/d:rotate-90 motion-reduce:transition-none" />
        AI activity ({items.length})
      </summary>
      {open && (
        <div className="mt-1.5 space-y-1.5">
          <ActivityFilterBar {...activityFilter} />
          <ActivityList items={items} filter={activityFilter.filter} />
        </div>
      )}
    </details>
  );
}

/** One execution of one block, on the run's timeline. */
export function StepRow({
  item,
  run,
  rf,
  latest,
  expandResult,
  now,
}: {
  item: StepItem;
  run: RunState;
  rf: RunFlow;
  /** This is the block's most recent execution (the run only keeps the latest outputs). */
  latest: boolean;
  expandResult: boolean;
  now: number;
}) {
  const cfg = rf.cfg(item.nodeId);
  const ns = run.nodes[item.nodeId];
  const color = cfg?.color ?? "#71717a";
  const lines = item.lines.slice(-MAX_LINES);
  const output = latest && item.status === "done" ? ns?.outputs?.artifact : undefined;
  const activity = activityOf(run.activity, item.nodeId, item.execution);
  const canSteer = latest && item.status === "running" && offersSteer(run, item.nodeId, cfg?.kind);
  const [steering, setSteering] = useState(false);
  // Messages still on their way stay visible even with the box closed.
  const pendingSteers = latest && steersOf(run, item.nodeId).some((s) => s.status === "pending");

  return (
    <li className="relative flex gap-3">
      <span
        className="relative z-10 mt-px flex size-7 shrink-0 items-center justify-center rounded-full border bg-background"
        style={{ borderColor: `${color}80`, color }}
      >
        <BlockIcon name={cfg?.icon ?? "box"} className="size-3.5" />
      </span>
      <div className="min-w-0 flex-1 space-y-1.5 pt-1">
        <div className="flex items-baseline gap-2 text-sm">
          <span className={cn("font-medium", item.status === "stopped" && "text-muted-foreground")}>{rf.label(item.nodeId)}</span>
          {item.execution > 1 && <span className="text-xs text-muted-foreground">run {item.execution}</span>}
          <span className="ml-auto shrink-0 text-xs tabular-nums">
            <StatusText item={item} now={now} />
          </span>
          {canSteer && (
            <button
              type="button"
              aria-expanded={steering}
              onClick={() => setSteering(!steering)}
              title="Send this agent a message while it works"
              className="flex h-6 shrink-0 items-center gap-1 self-center rounded-full border border-sky-400/50 px-2 text-xs text-sky-300 outline-none hover:bg-sky-400/10 focus-visible:ring-2 focus-visible:ring-ring/60"
            >
              <Navigation className="size-3" aria-hidden /> Steer
            </button>
          )}
        </div>
        {((canSteer && steering) || pendingSteers) && <SteerBox run={run} nodeKey={item.nodeId} cfg={cfg} autoFocus={steering} />}
        {item.note && (
          <p className="text-xs text-muted-foreground">
            {item.note.startsWith("routed to ") ? `Handed off to ${item.note.slice(10)}` : `Condition: ${item.note}`}
          </p>
        )}
        {item.status === "failed" && latest && ns?.error && <p className="text-xs text-red-300">{ns.error}</p>}
        {activity.length > 0 && <StepActivity items={activity} running={item.status === "running"} />}
        {lines.length > 0 && (
          <Disclosure
            title={`Log (${item.lines.length} ${item.lines.length === 1 ? "line" : "lines"})`}
            body={lines.map((l) => l.msg).join("\n")}
          />
        )}
        {output && <Disclosure title="Result" body={output} mono={false} open={expandResult} />}
        {latest && run.finishedAt && !item.nodeId.includes("/") && (
          <RerunFromHere run={run} nodeId={item.nodeId} compact onResume={(from) => useAgent.getState().resume(run.id, from)} />
        )}
      </div>
    </li>
  );
}

