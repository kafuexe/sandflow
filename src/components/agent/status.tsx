import { useEffect, useState } from "react";
import { Check, CircleDashed, CircleSlash, Loader2, MessageCircleQuestion, X } from "lucide-react";
import { cn } from "@/lib/utils";
import type { RunStatus } from "../../../shared/types";

/** Status colours match the builder's Run panel: amber = needs you, sky = working, emerald = done. */
export const RUN_TONE: Record<RunStatus, { text: string; bar: string; label: string }> = {
  waiting: { text: "text-amber-300", bar: "bg-amber-400", label: "Needs your answer" },
  running: { text: "text-sky-300", bar: "bg-sky-400", label: "Running" },
  done: { text: "text-emerald-300", bar: "bg-emerald-400", label: "Finished" },
  failed: { text: "text-red-300", bar: "bg-red-400", label: "Failed" },
  cancelled: { text: "text-muted-foreground", bar: "bg-muted-foreground/50", label: "Stopped" },
};

export function RunStatusIcon({ status, className }: { status: RunStatus; className?: string }) {
  const c = cn("size-4 shrink-0", RUN_TONE[status].text, className);
  if (status === "waiting") return <MessageCircleQuestion className={c} aria-label="Needs your answer" />;
  if (status === "running") return <Loader2 className={cn(c, "animate-spin motion-reduce:animate-none")} aria-label="Running" />;
  if (status === "done") return <Check className={c} aria-label="Finished" />;
  if (status === "failed") return <X className={c} aria-label="Failed" />;
  return <CircleSlash className={c} aria-label="Stopped" />;
}

export function IdleIcon({ className }: { className?: string }) {
  return <CircleDashed className={cn("size-4 shrink-0 text-muted-foreground/60", className)} />;
}

/** Re-renders every `ms` so relative times stay current. */
export function useNow(ms = 30_000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

export function ago(ts: number, now: number) {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86_400) return `${Math.round(s / 3600)}h ago`;
  return new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function duration(ms: number) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}
