// "Retry from failed step" / "Re-run from here" for finished runs (see shared/resume.ts for what a resume does).

import { useId, useState } from "react";
import { Loader2, PauseCircle, Play, RotateCcw, Wrench } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useStore } from "@/lib/store";
import { cn } from "@/lib/utils";
import { nodeLabel } from "../../shared/resolve";
import { runNodeLabel } from "../../shared/subflow";
import { PAUSE_REASON_TEXT, isPaused } from "../../shared/journal";
import { GUARD_TEXT } from "../../shared/recovery";
import { RecoveryHistory } from "./Recovery";
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

const HOLD_TEXT = {
  validation: "It can't continue as it is:",
  manual: "This flow's interrupted runs wait for you (Inputs → Continue interrupted runs automatically is off).",
  loop: "It was continued several times without a step finishing, so it isn't continued automatically any more.",
  corrupt: "Its journal can't be read, so it can't be continued.",
  blocked: "Recovery held it at a failed step:",
};

/**
 * Run tab / Agent screen: a paused or interrupted run (quit, update, crash) — Continue carries on as the same run
 * (finished steps kept, interrupted ones run again); Repair first adopts what changed when a check failed.
 */
export function ContinueBox({
  run,
  onContinue,
  className,
}: {
  run: RunState;
  onContinue: (repair: boolean) => Promise<string[] | undefined>;
  className?: string;
}) {
  const flows = useStore((s) => s.data?.flows ?? []);
  const blocks = useStore((s) => s.data?.blocks ?? []);
  const [busy, setBusy] = useState<"continue" | "repair">();
  const [changes, setChanges] = useState<string[]>();
  if (!isPaused(run)) return null;
  const why = PAUSE_REASON_TEXT[run.pauseReason ?? "crash"];
  const interrupted = Object.keys(run.nodes)
    .filter((k) => run.nodes[k].interrupted)
    .map((k) => runNodeLabel(k, flows.find((f) => f.id === run.flowId), flows, blocks));
  const hold = run.hold;
  const go = async (repair: boolean) => {
    setBusy(repair ? "repair" : "continue");
    try {
      const c = await onContinue(repair);
      if (repair && c) setChanges(c);
    } finally {
      setBusy(undefined);
    }
  };
  return (
    <div role="status" className={cn("space-y-2 rounded-lg border border-violet-400/30 bg-violet-500/5 p-2.5 text-xs", className)}>
      <div className="flex items-center gap-1.5 font-medium text-violet-200">
        <PauseCircle className="size-4" aria-hidden /> {run.phase === "interrupted" ? "Interrupted" : "Paused"} — {why}
      </div>
      {run.parent ? (
        <p className="text-muted-foreground">It continues with the run that started it.</p>
      ) : (
        <>
          <p className="leading-relaxed text-muted-foreground">
            Continue carries on as this same run: finished steps are kept
            {interrupted.length > 0 && <>, and {interrupted.join(", ")} (cut off) runs again — an agent first continues its own session</>}.
          </p>
          {hold && (
            <div className="space-y-1 text-amber-300">
              <p>{HOLD_TEXT[hold.reason]}</p>
              {hold.reason === "blocked" && (
                <div className="space-y-1">
                  <p>
                    {hold.nodeKey ? runNodeLabel(hold.nodeKey, flows.find((f) => f.id === run.flowId), flows, blocks) : "A step"}
                    {hold.guard ? ` — ${GUARD_TEXT[hold.guard]}` : ""}: {hold.problems.join("; ")}
                  </p>
                  <p className="text-muted-foreground">Fix the cause, then Continue runs that step again (it first reviews its own work); Stop ends the run.</p>
                  {hold.nodeKey && <RecoveryHistory rec={run.recovery?.[hold.nodeKey]} />}
                </div>
              )}
              {hold.reason === "validation" && (
                <ul className="list-disc space-y-0.5 pl-4">
                  {hold.problems.map((p) => (
                    <li key={p}>{p}</li>
                  ))}
                </ul>
              )}
            </div>
          )}
          {changes && <p className="text-emerald-300">Repaired: {changes.length ? changes.join("; ") : "nothing had changed"}.</p>}
          <div className="flex flex-wrap gap-2">
            <Button size="sm" disabled={!!busy || hold?.reason === "corrupt"} onClick={() => void go(false)} title="Check it can go on, then carry on as the same run">
              {busy === "continue" ? <Loader2 className="animate-spin" /> : <Play />} Continue
            </Button>
            {hold?.reason === "validation" && hold.repairable && (
              <Button
                size="sm"
                variant="outline"
                disabled={!!busy}
                onClick={() => void go(true)}
                title="Adopt the current flow, settings and branch (each change is listed and kept in the run's journal), then continue"
              >
                {busy === "repair" ? <Loader2 className="animate-spin" /> : <Wrench />} Repair and continue
              </Button>
            )}
          </div>
        </>
      )}
    </div>
  );
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
