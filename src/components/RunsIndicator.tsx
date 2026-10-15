import { useEffect, useId, useRef, useState } from "react";
import { ChevronDown, Eye, HelpCircle, Loader2, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import { RUN_BADGE } from "@/components/RunPanel";
import { activeRunsLabel, activeRunsOf } from "@/lib/runSelection";
import { useStore } from "@/lib/store";
import { cn } from "@/lib/utils";

/** Short, stable tag for a run in lists (its id ends in a random suffix). */
const shortId = (id: string) => id.slice(-4);

/**
 * "2 running" pill for the flow on screen: lists its active runs, picks which one the canvas + Run tab show, and
 * stops any of them. Hidden while the flow has no active runs.
 */
export function RunsIndicator({ flowId }: { flowId: string }) {
  const runs = useStore((s) => s.runs);
  const watched = useStore((s) => s.run);
  const { watch, cancelRun } = useStore.getState();
  const [open, setOpen] = useState(false);
  const [stopping, setStopping] = useState<Set<string>>(new Set());
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  const active = activeRunsOf(runs, flowId, watched);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [open]);

  useEffect(() => {
    if (!active.length) setOpen(false);
  }, [active.length]);

  if (!active.length) return null;
  const waiting = active.some((r) => r.status === "waiting" || r.pendingQuestion);
  const close = () => {
    setOpen(false);
    trigger.current?.focus();
  };

  return (
    <div
      ref={root}
      className="relative"
      onKeyDown={(e) => {
        if (e.key === "Escape" && open) {
          e.stopPropagation();
          close();
        }
      }}
    >
      <button
        ref={trigger}
        type="button"
        aria-haspopup="true"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        title="Runs of this flow in progress — pick one to show, or stop it"
        onClick={() => setOpen(!open)}
        className={cn(
          "flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-xs font-medium tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-ring/60",
          waiting
            ? "border-amber-400/50 bg-amber-500/10 text-amber-300 hover:bg-amber-500/20"
            : "border-sky-400/40 bg-sky-500/10 text-sky-300 hover:bg-sky-500/20",
        )}
      >
        {waiting ? <HelpCircle className="size-3.5" aria-hidden /> : <Loader2 className="size-3.5 animate-spin" aria-hidden />}
        {activeRunsLabel(active)}
        <ChevronDown className={cn("size-3.5 opacity-70 transition-transform", open && "rotate-180")} aria-hidden />
      </button>
      {open && (
        <div
          id={panelId}
          role="region"
          aria-label="Active runs of this flow"
          className="absolute top-full right-0 z-50 mt-1.5 w-[22rem] origin-top-right overflow-hidden rounded-lg border bg-popover text-popover-foreground shadow-lg shadow-black/20 animate-in fade-in-0 zoom-in-95 slide-in-from-top-1"
        >
          <div className="border-b px-3 py-2 text-xs text-muted-foreground">
            {active.length} active {active.length === 1 ? "run" : "runs"} — the canvas shows the selected one
          </div>
          <ul className="max-h-[min(60vh,20rem)] overflow-y-auto p-1">
            {active.map((r) => {
              const shown = r.id === watched?.id;
              const when = new Date(r.startedAt).toLocaleTimeString();
              const what = r.trigger && r.trigger.source !== "manual" ? `${r.trigger.source}: ${r.trigger.type}` : r.prompt?.trim();
              return (
                <li key={r.id} className={cn("flex items-center gap-2 rounded-md px-2 py-1.5", shown && "bg-accent")}>
                  <button
                    type="button"
                    aria-current={shown ? "true" : undefined}
                    aria-label={`Show run ${shortId(r.id)} started ${when}${shown ? " (shown)" : ""}`}
                    onClick={() => {
                      void watch(r.id);
                      close();
                    }}
                    className="flex min-w-0 flex-1 items-center gap-2 rounded text-left text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
                  >
                    <span className={cn("shrink-0 rounded px-1.5 py-0.5 text-[10px] capitalize", RUN_BADGE[r.status])}>{r.status}</span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate">
                        <span className="font-mono text-muted-foreground">#{shortId(r.id)}</span> · {when}
                      </span>
                      {what && <span className="block truncate text-[11px] text-muted-foreground">{what}</span>}
                    </span>
                    {shown && <Eye className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />}
                  </button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 shrink-0 px-2 text-red-400 hover:text-red-300"
                    disabled={stopping.has(r.id)}
                    aria-label={`Stop run ${shortId(r.id)} started ${when}`}
                    title="Stop this run"
                    onClick={async () => {
                      setStopping((s) => new Set(s).add(r.id));
                      await cancelRun(r.id);
                      setStopping((s) => {
                        const n = new Set(s);
                        n.delete(r.id);
                        return n;
                      });
                    }}
                  >
                    {stopping.has(r.id) ? <Loader2 className="animate-spin" /> : <Square />} Stop
                  </Button>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
