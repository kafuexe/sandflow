import { useState } from "react";
import { ChevronRight, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useAgent } from "@/lib/agent";
import { groupRuns, sectionRuns, taskTone, type RunTree, type StackGroup } from "@/lib/runGroups";
import { useStore } from "@/lib/store";
import { runTitle } from "@/lib/timeline";
import { cn } from "@/lib/utils";
import { nodeLabel } from "../../../shared/resolve";
import type { RunSummary } from "../../../shared/types";
import { FLAG_TONE, FlagIcon, RUN_TONE, RunStatusIcon, TASK_TONE, ago, useNow } from "./status";
import { ResizablePanel } from "@/components/ui/resizable";
import { PANELS } from "@/lib/panelSize";

const flagCount = (r: RunSummary) => (r.flags ? r.flags.warning + r.flags.error : 0);

/** "Big refactor › Areas › billing" for a stack task, the run's own title otherwise. */
export function runPath(run: RunSummary, byId: Map<string, RunSummary>): string {
  if (!run.parent || !run.stack) return runTitle(run);
  const parent = byId.get(run.parent.runId);
  return `${parent ? runPath(parent, byId) : "…"} › ${run.stack.name} › ${run.stack.task}`;
}

function RunRow({ run, now, title, task }: { run: RunSummary; now: number; title?: string; task?: boolean }) {
  const select = useAgent((s) => s.select);
  const selected = useAgent((s) => s.selectedId === run.id);
  const flows = useStore((s) => s.data?.flows ?? []);
  const blocks = useStore((s) => s.data?.blocks ?? []);
  const q = run.pendingQuestion;
  const asker = q && flows.find((f) => f.id === run.flowId)?.nodes.find((n) => n.id === q.nodeId);
  const flags = flagCount(run);
  const s = run.stack;
  // A finished top-level run with flags leads with the flag; everything else with its status.
  const leadFlag = flags > 0 && !!run.finishedAt && !task;

  let detail: React.ReactNode;
  if (q) {
    detail = (
      <span className="block truncate text-xs leading-5 text-amber-300/90">
        {asker ? nodeLabel(asker, blocks) : "A block"} asks: {q.question}
      </span>
    );
  } else {
    const what =
      task && s
        ? s.outcome === "dropped"
          ? <span className={FLAG_TONE.text}>Dropped after {s.attempt} attempt{s.attempt === 1 ? "" : "s"}</span>
          : s.attempt > 1
            ? `Attempt ${s.attempt} of ${s.maxAttempts}`
            : run.flowName
        : leadFlag
          ? <><span className={FLAG_TONE.text}>{flags} flag{flags === 1 ? "" : "s"}</span> · {run.flowName}</>
          : run.flowName;
    detail = (
      <span className="flex gap-2 text-xs leading-5 text-muted-foreground">
        <span className="truncate">{what}</span>
        <span className="ml-auto shrink-0 tabular-nums">{ago(run.startedAt, now)}</span>
      </span>
    );
  }

  return (
    <button
      type="button"
      onClick={() => select(run.id)}
      aria-current={selected ? "true" : undefined}
      className={cn(
        "group relative flex w-full items-start gap-2.5 rounded-md py-2 pr-2 pl-3 text-left outline-none",
        "hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring/60",
        selected && "bg-accent",
      )}
    >
      <span className={cn("absolute inset-y-2 left-0 w-0.5 rounded-full", selected ? (leadFlag ? FLAG_TONE.bar : RUN_TONE[run.status].bar) : "bg-transparent")} />
      {leadFlag ? <FlagIcon className="mt-0.5" /> : <RunStatusIcon status={run.status} className="mt-0.5" />}
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          <span className="truncate text-sm leading-5">{title ?? (task && s ? s.task : runTitle(run))}</span>
          {flags > 0 && !leadFlag && <FlagIcon className="size-3.5" label={`${flags} flag${flags === 1 ? "" : "s"}`} />}
        </span>
        {detail}
      </span>
    </button>
  );
}

/** Open/closed state of stack groups, remembered for this session. */
const groupOpen = new Map<string, boolean>();

function StackGroupView({ group, parent, tree, now }: { group: StackGroup; parent: RunSummary; tree: RunTree; now: number }) {
  const finished = group.settled === group.total || !!parent.finishedAt;
  const [open, setOpen] = useState(() => groupOpen.get(group.groupId) ?? !finished);
  const toggle = () => {
    groupOpen.set(group.groupId, !open);
    setOpen(!open);
  };
  const tones = group.tasks.map(taskTone);
  // Tasks still queued behind the concurrency limit have no run yet.
  const pending = Math.max(0, group.total - group.tasks.length);
  const id = `stack-${group.groupId}`;
  return (
    <div className="ml-[18px] border-l border-orange-400/30 pl-1.5">
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        aria-controls={id}
        className="flex w-full items-center gap-1.5 rounded-md py-1 pr-2 pl-1 text-left text-xs text-muted-foreground outline-none hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring/60"
      >
        <ChevronRight className={cn("size-3.5 shrink-0 transition-transform motion-reduce:transition-none", open && "rotate-90")} />
        <span className="truncate font-medium text-foreground/80">{group.name}</span>
        <span className="shrink-0 tabular-nums">
          {group.settled} of {group.total} done
        </span>
        <span className="ml-auto flex h-1.5 w-16 shrink-0 gap-px overflow-hidden rounded-full" aria-hidden>
          {tones.map((t, i) => (
            <span key={i} className={cn("flex-1", TASK_TONE[t].bar)} />
          ))}
          {Array.from({ length: pending }, (_, i) => (
            <span key={`p${i}`} className="flex-1 bg-muted" />
          ))}
        </span>
      </button>
      {open && (
        <div id={id} className="space-y-0.5">
          {group.tasks.map((t) => (
            <div key={t.id}>
              <RunRow run={t} now={now} task />
              <Groups run={t} tree={tree} now={now} />
            </div>
          ))}
          {pending > 0 && <p className="py-1 pl-7 text-xs text-muted-foreground">{pending} more waiting to start</p>}
        </div>
      )}
    </div>
  );
}

function Groups({ run, tree, now }: { run: RunSummary; tree: RunTree; now: number }) {
  return (
    <>
      {tree.groups.get(run.id)?.map((g) => (
        <StackGroupView key={g.groupId} group={g} parent={run} tree={tree} now={now} />
      ))}
    </>
  );
}

function Section({ title, runs, tone, children }: { title: string; runs: RunSummary[]; tone?: string; children: (r: RunSummary) => React.ReactNode }) {
  if (!runs.length) return null;
  return (
    <section className="space-y-0.5">
      <h3 className={cn("flex items-center gap-2 px-3 pt-3 pb-1 text-xs font-medium text-muted-foreground", tone)}>
        {title}
        <span className="tabular-nums opacity-70">{runs.length}</span>
      </h3>
      {runs.map((r) => (
        <div key={r.id}>{children(r)}</div>
      ))}
    </section>
  );
}

export function RunList() {
  const list = useAgent((s) => s.list);
  const selectedId = useAgent((s) => s.selectedId);
  const select = useAgent((s) => s.select);
  const now = useNow();
  const tree = groupRuns(list);
  const s = sectionRuns(list);
  const withGroups = (r: RunSummary) => (
    <>
      <RunRow run={r} now={now} />
      <Groups run={r} tree={tree} now={now} />
    </>
  );

  return (
    <ResizablePanel panel={PANELS.runList} edge="right" label="Resize runs list" className="flex flex-col border-r bg-card/30" aria-label="Runs">
      <div className="p-3 pb-1">
        <Button
          className="w-full justify-start"
          variant={selectedId === null ? "secondary" : "outline"}
          onClick={() => select(null)}
          aria-current={selectedId === null ? "true" : undefined}
        >
          <Plus /> New run
        </Button>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <nav className="px-1.5 pb-3">
          <Section title="Flagged" runs={s.flagged} tone={FLAG_TONE.text}>{withGroups}</Section>
          <Section title="Needs your answer" runs={s.waiting} tone="text-amber-300">
            {(r) => <RunRow run={r} now={now} title={r.parent ? runPath(r, tree.byId) : undefined} />}
          </Section>
          <Section title="Running" runs={s.running}>{withGroups}</Section>
          <Section title="Earlier" runs={s.earlier}>{withGroups}</Section>
          {!list.length && (
            <p className="px-3 pt-4 text-sm text-muted-foreground">
              No runs yet. Describe a task and pick a flow to start one. Every run shows up here.
            </p>
          )}
        </nav>
      </ScrollArea>
    </ResizablePanel>
  );
}
