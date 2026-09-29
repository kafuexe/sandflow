import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useAgent } from "@/lib/agent";
import { useStore } from "@/lib/store";
import { runTitle } from "@/lib/timeline";
import { cn } from "@/lib/utils";
import { nodeLabel } from "../../../shared/resolve";
import type { RunSummary } from "../../../shared/types";
import { RUN_TONE, RunStatusIcon, ago, useNow } from "./status";

function RunRow({ run, selected, now }: { run: RunSummary; selected: boolean; now: number }) {
  const select = useAgent((s) => s.select);
  const flows = useStore((s) => s.data?.flows ?? []);
  const blocks = useStore((s) => s.data?.blocks ?? []);
  const q = run.pendingQuestion;
  const asker = q && flows.find((f) => f.id === run.flowId)?.nodes.find((n) => n.id === q.nodeId);

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
      <span className={cn("absolute inset-y-2 left-0 w-0.5 rounded-full", selected ? RUN_TONE[run.status].bar : "bg-transparent")} />
      <RunStatusIcon status={run.status} className="mt-0.5" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm leading-5">{runTitle(run)}</span>
        {q ? (
          <span className="block truncate text-xs leading-5 text-amber-300/90">
            {asker ? nodeLabel(asker, blocks) : "A block"} asks: {q.question}
          </span>
        ) : (
          <span className="flex gap-2 text-xs leading-5 text-muted-foreground">
            <span className="truncate">{run.flowName}</span>
            <span className="ml-auto shrink-0 tabular-nums">{ago(run.startedAt, now)}</span>
          </span>
        )}
      </span>
    </button>
  );
}

function Group({ title, runs, selectedId, now, tone }: { title: string; runs: RunSummary[]; selectedId: string | null; now: number; tone?: string }) {
  if (!runs.length) return null;
  return (
    <section className="space-y-0.5">
      <h3 className={cn("flex items-center gap-2 px-3 pt-3 pb-1 text-xs font-medium text-muted-foreground", tone)}>
        {title}
        <span className="tabular-nums opacity-70">{runs.length}</span>
      </h3>
      {runs.map((r) => (
        <RunRow key={r.id} run={r} selected={r.id === selectedId} now={now} />
      ))}
    </section>
  );
}

export function RunList() {
  const list = useAgent((s) => s.list);
  const selectedId = useAgent((s) => s.selectedId);
  const select = useAgent((s) => s.select);
  const now = useNow();

  const waiting = list.filter((r) => !r.finishedAt && r.pendingQuestion);
  const running = list.filter((r) => !r.finishedAt && !r.pendingQuestion);
  const earlier = list.filter((r) => r.finishedAt);

  return (
    <aside className="flex w-72 shrink-0 flex-col border-r bg-card/30" aria-label="Runs">
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
          <Group title="Needs your answer" runs={waiting} selectedId={selectedId} now={now} tone="text-amber-300" />
          <Group title="Running" runs={running} selectedId={selectedId} now={now} />
          <Group title="Earlier" runs={earlier} selectedId={selectedId} now={now} />
          {!list.length && (
            <p className="px-3 pt-4 text-sm text-muted-foreground">
              No runs yet. Describe a task and pick a flow to start one. Every run shows up here.
            </p>
          )}
        </nav>
      </ScrollArea>
    </aside>
  );
}
