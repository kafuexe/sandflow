import { useLayoutEffect, useMemo, useRef } from "react";
import { PenLine, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAgent } from "@/lib/agent";
import { useStore } from "@/lib/store";
import { buildTimeline, runTitle, type StepItem } from "@/lib/timeline";
import { cn } from "@/lib/utils";
import type { RunState } from "../../../shared/types";
import { RunComposer, StopButton } from "./Composer";
import { QuestionCard } from "./QuestionCard";
import { StepRail } from "./StepRail";
import { StepRow } from "./StepRow";
import { RUN_TONE, RunStatusIcon, ago, duration, useNow } from "./status";
import { useRunFlow } from "./useRunFlow";

function Header({ run, rf }: { run: RunState; rf: ReturnType<typeof useRunFlow> }) {
  const now = useNow();
  const { setCurrentFlow, setView } = useStore.getState();
  const tone = RUN_TONE[run.status];
  return (
    <header className="shrink-0 space-y-2.5 border-b px-6 pt-3 pb-2">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-base leading-6 font-semibold">{runTitle(run)}</h2>
          <p className="flex flex-wrap items-center gap-x-4 gap-y-0.5 text-xs text-muted-foreground">
            <span>
              Flow <span className="font-medium text-foreground">{run.flowName}</span>
            </span>
            <span className={cn("flex items-center gap-1", tone.text)}>
              <RunStatusIcon status={run.status} className="size-3.5" /> {tone.label}
            </span>
            <span className="tabular-nums">
              {run.finishedAt ? `Took ${duration(run.finishedAt - run.startedAt)}` : `Started ${ago(run.startedAt, now)}`}
            </span>
            {run.branch && <span className="font-mono">{run.branch}</span>}
          </p>
        </div>
        {rf.flow && (
          <Button
            size="sm"
            variant="ghost"
            title="Open this flow on the canvas"
            onClick={() => {
              setCurrentFlow(run.flowId);
              setView("builder");
            }}
          >
            <PenLine /> Edit flow
          </Button>
        )}
        {!run.finishedAt && <StopButton run={run} />}
      </div>
      <StepRail run={run} rf={rf} />
    </header>
  );
}

function Opening({ run }: { run: RunState }) {
  if (run.prompt?.trim()) {
    return (
      <div className="flex justify-end">
        <p className="max-w-[85%] rounded-2xl rounded-br-md bg-secondary px-4 py-2.5 text-[15px] leading-relaxed whitespace-pre-wrap">
          {run.prompt}
        </p>
      </div>
    );
  }
  const t = run.trigger;
  return (
    <p className="text-sm text-muted-foreground">
      {t && t.source !== "manual"
        ? `Started by ${t.source} (${t.type})${t.title ? `: ${t.title}` : ""}${t.author ? ` from ${t.author}` : ""}`
        : "Started without a prompt."}
    </p>
  );
}

function Ending({ run }: { run: RunState }) {
  if (!run.finishedAt) return null;
  if (run.status === "failed")
    return (
      <p className="flex items-start gap-2 rounded-lg border border-red-400/30 bg-red-500/10 px-3 py-2 text-sm text-red-200">
        <TriangleAlert className="mt-0.5 size-4 shrink-0" /> {run.error ?? "The run failed."}
      </p>
    );
  return (
    <p className="text-center text-xs text-muted-foreground">
      {run.status === "done" ? "Finished" : run.error ?? "Stopped"} {new Date(run.finishedAt).toLocaleTimeString()}
    </p>
  );
}

export function Conversation({ run }: { run: RunState }) {
  const rf = useRunFlow(run);
  const error = useAgent((s) => s.error);
  const now = useNow(1000);
  const items = useMemo(() => buildTimeline(run), [run]);
  const scroller = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const lastRun = useRef<string>("");

  // Latest execution of each block (only that one still has its outputs), and the final step.
  const { latest, final } = useMemo(() => {
    const latest = new Map<string, StepItem>();
    let final: StepItem | undefined;
    for (const it of items) if (it.kind === "step") (latest.set(it.nodeId, it), (final = it));
    return { latest, final };
  }, [items]);

  // Follow new activity while the user is at the bottom; jump to the bottom when switching runs.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    if (lastRun.current !== run.id || pinned.current) el.scrollTop = el.scrollHeight;
    lastRun.current = run.id;
  }, [run.id, items.length, run.pendingQuestion, run.finishedAt]);

  return (
    <section className="flex min-w-0 flex-1 flex-col" aria-label="Run">
      <Header run={run} rf={rf} />
      <div
        ref={scroller}
        className="min-h-0 flex-1 overflow-y-auto"
        onScroll={(e) => {
          const el = e.currentTarget;
          pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
      >
        <div className="mx-auto max-w-3xl space-y-6 px-6 py-6">
          <Opening run={run} />
          {items.length > 0 && (
            <ol className="relative space-y-4 before:absolute before:top-3 before:bottom-3 before:left-[13.5px] before:w-px before:bg-border">
              {items.map((it) =>
                it.kind === "step" ? (
                  <StepRow
                    key={it.key}
                    item={it}
                    run={run}
                    rf={rf}
                    now={now}
                    latest={latest.get(it.nodeId) === it}
                    expandResult={run.status === "done" && it === final}
                  />
                ) : it.kind === "question" ? (
                  <li key={it.key} className="pl-10">
                    <QuestionCard item={it} run={run} rf={rf} />
                  </li>
                ) : (
                  <li key={it.key} className={cn("pl-10 text-xs", it.level === "error" ? "text-red-300" : "text-amber-200/80")}>
                    {it.text}
                  </li>
                ),
              )}
            </ol>
          )}
          <Ending run={run} />
        </div>
      </div>
      <div className="mx-auto w-full max-w-3xl shrink-0 space-y-2 px-6 pt-2 pb-4">
        {error && (
          <p role="alert" className="text-sm text-red-300">
            {error}
          </p>
        )}
        <RunComposer run={run} rf={rf} />
      </div>
    </section>
  );
}
