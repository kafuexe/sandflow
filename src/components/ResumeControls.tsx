// "Retry from failed step" / "Re-run from here" for finished runs (see shared/resume.ts for what a resume does).

import { useId, useState } from "react";
import { Loader2, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useStore } from "@/lib/store";
import { cn } from "@/lib/utils";
import { nodeLabel } from "../../shared/resolve";
import { canRestartAt, planResume, resumeBlocker, type ResumeResult } from "../../shared/resume";
import type { RunState } from "../../shared/types";

type Resume = (fromNodeIds?: string[]) => Promise<unknown>;

/** Checks a resume against the flow as it is now in the editor (the server checks again, plus the branch). */
function useResumeCheck(run: RunState, fromNodeIds?: string[]): ResumeResult & { label: (id: string) => string } {
  const flow = useStore((s) => s.data?.flows.find((f) => f.id === run.flowId));
  const blocks = useStore((s) => s.data?.blocks ?? []);
  const label = (id: string) => {
    const n = flow?.nodes.find((x) => x.id === id);
    return n ? nodeLabel(n, blocks) : id;
  };
  if (!flow) return { ok: false, problems: [`Flow "${run.flowName}" no longer exists`], label };
  return { ...planResume(run, flow, blocks, fromNodeIds), label };
}

/** Run tab / Agent screen: the primary way back into a failed or stopped run. */
export function RetryBox({ run, onResume, className }: { run: RunState; onResume: Resume; className?: string }) {
  const check = useResumeCheck(run);
  const [busy, setBusy] = useState(false);
  const hintId = useId();
  if (!run.finishedAt || run.parent || (run.status !== "failed" && run.status !== "cancelled")) return null;
  const blocker = resumeBlocker(run);

  let hint: React.ReactNode;
  if (!check.ok) hint = <span className="text-amber-300">{check.problems.join(" ")}</span>;
  else {
    const kept = Object.keys(check.plan.restored).filter((k) => !k.includes("/")).length;
    hint = (
      <>
        Runs <b className="font-medium text-foreground">{check.plan.nodeIds.map(check.label).join(", ")}</b> and everything after it again, with
        the flow as it is now — fix the configuration first.{" "}
        {kept > 0 && `${kept} earlier step${kept === 1 ? " keeps its" : "s keep their"} outputs. `}
        {run.branch && check.plan.branch === run.branch ? (
          <>
            Continues on branch <span className="font-mono">{run.branch}</span>, with the earlier steps&apos; code changes.
          </>
        ) : (
          !check.plan.repo && "Files from the original run's scratch workspace are gone; outputs are restored."
        )}
      </>
    );
  }
  return (
    <div className={cn("space-y-2 rounded-lg border border-sky-400/30 bg-sky-500/5 p-2.5", className)}>
      <Button
        size="sm"
        disabled={!check.ok || busy}
        aria-describedby={hintId}
        onClick={async () => {
          setBusy(true);
          try {
            await onResume();
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? <Loader2 className="animate-spin" /> : <RotateCcw />} Retry from failed step
      </Button>
      <p id={hintId} className="text-xs leading-relaxed text-muted-foreground">
        {blocker ?? hint}
      </p>
    </div>
  );
}

/** "Re-run from here" for one step of a finished run (canvas side panel, Run tab, Agent screen). */
export function RerunFromHere({
  run,
  nodeId,
  onResume,
  compact,
}: {
  run: RunState;
  nodeId: string;
  onResume: Resume;
  /** Small ghost button without the explanation (timeline rows). */
  compact?: boolean;
}) {
  const check = useResumeCheck(run, [nodeId]);
  const [busy, setBusy] = useState(false);
  const hintId = useId();
  if (!run.finishedAt || run.parent || !canRestartAt(run, nodeId)) return null;
  const reason = check.ok ? undefined : check.problems.join(" ");
  const go = async () => {
    setBusy(true);
    try {
      await onResume([nodeId]);
    } finally {
      setBusy(false);
    }
  };
  const icon = busy ? <Loader2 className="animate-spin" /> : <RotateCcw />;
  if (compact) {
    return (
      <Button
        size="sm"
        variant="ghost"
        className="h-6 px-2 text-xs"
        disabled={!check.ok || busy}
        title={reason ?? `Start a new run from ${check.label(nodeId)}, with the flow as it is now; earlier steps keep their outputs`}
        onClick={go}
      >
        {icon} Re-run from here
      </Button>
    );
  }
  return (
    <div className="space-y-1.5">
      <Button size="sm" variant="outline" disabled={!check.ok || busy} aria-describedby={hintId} onClick={go}>
        {icon} Re-run from here
      </Button>
      <p id={hintId} className={cn("text-[11px] leading-relaxed", reason ? "text-amber-300" : "text-muted-foreground")}>
        {reason ??
          `Starts a new run from this step with the flow as it is now. Steps before it keep their outputs from this run${check.ok && run.branch && check.plan.branch === run.branch ? `; it continues on branch ${run.branch}` : ""}.`}
      </p>
    </div>
  );
}

/** "Resumed from …" line linking back to the original run. */
export function ResumedFrom({ run, onOpen }: { run: RunState; onOpen: (runId: string) => void }) {
  const flow = useStore((s) => s.data?.flows.find((f) => f.id === run.flowId));
  const blocks = useStore((s) => s.data?.blocks ?? []);
  if (!run.resumedFrom) return null;
  const labels = run.resumedFrom.nodeIds.map((id) => {
    const n = flow?.nodes.find((x) => x.id === id);
    return n ? nodeLabel(n, blocks) : id;
  });
  return (
    <div className="text-xs text-muted-foreground">
      <RotateCcw className="mr-1 inline size-3" aria-hidden />
      Resumed from{" "}
      <button type="button" className="underline hover:text-foreground" onClick={() => onOpen(run.resumedFrom!.runId)}>
        an earlier run
      </button>{" "}
      at {labels.join(", ")}
    </div>
  );
}
