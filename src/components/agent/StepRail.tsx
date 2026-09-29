import { Check, ChevronRight, Loader2, MessageCircleQuestion, X } from "lucide-react";
import { cn } from "@/lib/utils";
import type { NodeRunStatus, RunState } from "../../../shared/types";
import type { RunFlow } from "./useRunFlow";

const MARK: Record<NodeRunStatus, React.ReactNode> = {
  idle: <span className="size-1.5 rounded-full bg-muted-foreground/40" />,
  queued: <span className="size-1.5 rounded-full bg-sky-400/70" />,
  running: <Loader2 className="size-3.5 animate-spin text-sky-300 motion-reduce:animate-none" />,
  waiting: <MessageCircleQuestion className="size-3.5 text-amber-300" />,
  done: <Check className="size-3.5 text-emerald-300" />,
  failed: <X className="size-3.5 text-red-300" />,
};

/** The flow's blocks in order, showing where this run is right now. */
export function StepRail({ run, rf }: { run: RunState; rf: RunFlow }) {
  return (
    <ol className="flex items-center gap-1 overflow-x-auto pb-1 text-xs [scrollbar-width:thin]" aria-label="Flow progress">
      {rf.steps.map((step, i) => {
        const ns = run.nodes[step.id];
        const status = ns?.status ?? "idle";
        const live = status === "running" || status === "waiting";
        return (
          <li key={step.id} className="flex shrink-0 items-center gap-1">
            {i > 0 && <ChevronRight className="size-3 text-muted-foreground/40" aria-hidden />}
            <span
              aria-current={live ? "step" : undefined}
              className={cn(
                "flex h-6 items-center gap-1.5 rounded-full border px-2",
                status === "idle" && "border-transparent text-muted-foreground/70",
                status === "done" && "border-transparent text-muted-foreground",
                status === "failed" && "border-red-400/40 text-red-200",
                status === "running" && "border-sky-400/50 bg-sky-400/10 font-medium text-foreground",
                status === "waiting" && "border-amber-400/60 bg-amber-400/10 font-medium text-amber-100",
                status === "queued" && "border-transparent text-foreground/80",
              )}
            >
              <span className="flex size-3.5 items-center justify-center">{MARK[status]}</span>
              {step.label}
              {ns && ns.executions > 1 && <span className="tabular-nums text-muted-foreground">×{ns.executions}</span>}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
