import { useState } from "react";
import { ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAgent } from "@/lib/agent";
import { groupRuns } from "@/lib/runGroups";
import { useStore } from "@/lib/store";
import { runTitle } from "@/lib/timeline";
import { cn } from "@/lib/utils";
import { runNodeLabel } from "../../../shared/subflow";
import type { RunFlag, RunState } from "../../../shared/types";
import { FLAG_TONE, FlagIcon } from "./status";

function FlagLine({ run, flag }: { run: RunState; flag: RunFlag }) {
  const [open, setOpen] = useState(false);
  const flows = useStore((s) => s.data?.flows ?? []);
  const blocks = useStore((s) => s.data?.blocks ?? []);
  const { dismissFlag, openRun } = useAgent.getState();
  const flow = flows.find((f) => f.id === run.flowId);
  const where = flag.nodeKey ? runNodeLabel(flag.nodeKey, flow, flows, blocks) : undefined;
  const error = flag.severity === "error";
  return (
    <li className={cn("rounded-md border-l-2 bg-background/40 px-3 py-2", error ? "border-red-400" : "border-orange-400")}>
      <div className="flex items-start gap-2">
        <button
          type="button"
          className="flex min-w-0 flex-1 items-start gap-1.5 text-left text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
          onClick={() => setOpen(!open)}
          aria-expanded={open}
          disabled={!flag.details}
        >
          {flag.details && <ChevronRight className={cn("mt-0.5 size-4 shrink-0 transition-transform motion-reduce:transition-none", open && "rotate-90")} />}
          <span className="min-w-0">
            <span className="block">{flag.message}</span>
            {(where || flag.fromRunId) && (
              <span className="block text-xs text-muted-foreground">
                {where && <>From {where}</>}
                {flag.fromRunId && (
                  <>
                    {where && " · "}
                    <span
                      role="link"
                      tabIndex={0}
                      className="underline underline-offset-2 hover:text-foreground"
                      onClick={(e) => (e.stopPropagation(), openRun(flag.fromRunId!))}
                      onKeyDown={(e) => e.key === "Enter" && (e.stopPropagation(), openRun(flag.fromRunId!))}
                    >
                      open the task's run
                    </span>
                  </>
                )}
              </span>
            )}
          </span>
        </button>
        <Button size="sm" variant="ghost" className="h-7 shrink-0" onClick={() => void dismissFlag(run.id, flag.id)}>
          Clear
        </Button>
      </div>
      {open && flag.details && <pre className="mt-2 max-h-64 overflow-auto pl-5.5 text-xs whitespace-pre-wrap text-muted-foreground">{flag.details}</pre>}
    </li>
  );
}

/** Undismissed flags at the top of a run: what went wrong, where, and a way to clear each one. */
export function FlagsBanner({ run }: { run: RunState }) {
  const open = (run.flags ?? []).filter((f) => !f.dismissed);
  if (!open.length) return null;
  return (
    <section aria-label="Flags" className={cn("space-y-2 rounded-lg border p-3", FLAG_TONE.border, FLAG_TONE.bg)}>
      <h3 className={cn("flex items-center gap-1.5 text-sm font-medium", FLAG_TONE.text)}>
        <FlagIcon className="size-4" label="" /> {open.length === 1 ? "1 flag needs a look" : `${open.length} flags need a look`}
      </h3>
      <ul className="space-y-1.5">
        {open.map((f) => (
          <FlagLine key={f.id} run={run} flag={f} />
        ))}
      </ul>
    </section>
  );
}

/** For a Box Stack task: the way back to the run that started it, and its other attempts. */
export function StackCrumb({ run }: { run: RunState }) {
  const list = useAgent((s) => s.list);
  const select = useAgent((s) => s.select);
  if (!run.parent || !run.stack) return null;
  const tree = groupRuns(list);
  const parent = tree.byId.get(run.parent.runId);
  const group = tree.groups.get(run.parent.runId)?.find((g) => g.groupId === run.stack!.groupId);
  const attempts = group?.attempts.get(run.stack.index) ?? [];
  const link = "rounded underline-offset-2 outline-none hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring/60";
  return (
    <nav aria-label="Box Stack task" className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs text-muted-foreground">
      <button type="button" className={link} onClick={() => select(run.parent!.runId)}>
        {parent ? runTitle(parent) : "Parent run"}
      </button>
      <ChevronRight className="size-3" aria-hidden />
      <span>{run.stack.name}</span>
      <ChevronRight className="size-3" aria-hidden />
      <span className="text-foreground">
        {run.stack.task} ({run.stack.index + 1} of {run.stack.total})
      </span>
      {attempts.length > 1 && (
        <span className="ml-2 flex items-center gap-1">
          Attempts:
          {attempts.map((a) => (
            <button
              key={a.id}
              type="button"
              className={cn(link, "tabular-nums", a.id === run.id && "font-medium text-foreground")}
              aria-current={a.id === run.id ? "true" : undefined}
              onClick={() => select(a.id)}
            >
              {a.stack!.attempt}
            </button>
          ))}
        </span>
      )}
      {run.stack.branch && <span className="ml-2 font-mono">{run.stack.branch}</span>}
    </nav>
  );
}
