import { useEffect, useRef } from "react";
import { Flag, OctagonAlert, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAgent } from "@/lib/agent";
import type { FlagEvent } from "@/lib/api";
import { desktop } from "@/lib/desktop";
import { cn } from "@/lib/utils";

const VISIBLE = 3;
const WARNING_MS = 10_000;

/** Desktop app, window in the background: also tell the OS, so a flag isn't missed. */
function notifyOs(e: FlagEvent) {
  if (!desktop || document.hasFocus() || typeof Notification === "undefined" || Notification.permission === "denied") return;
  const n = new Notification(`${e.flag.severity === "error" ? "Error" : "Flag"}: ${e.runTitle}`, { body: e.flag.message, tag: e.flag.id });
  n.onclick = () => {
    window.focus();
    useAgent.getState().openRun(e.runId);
  };
}

function Alert({ e }: { e: FlagEvent }) {
  const { closeAlert, openRun } = useAgent.getState();
  const error = e.flag.severity === "error";
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  // Warnings go away on their own (paused while you're on them); errors stay until you act.
  const arm = () => {
    if (!error) timer.current = setTimeout(() => closeAlert(e.flag.id), WARNING_MS);
  };
  const pause = () => clearTimeout(timer.current);
  useEffect(() => {
    arm();
    return pause;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const Icon = error ? OctagonAlert : Flag;
  return (
    <div
      role={error ? "alert" : "status"}
      onMouseEnter={pause}
      onMouseLeave={arm}
      onFocus={pause}
      onBlur={arm}
      className={cn(
        "pointer-events-auto w-[22rem] max-w-[calc(100vw-2rem)] overflow-hidden rounded-lg border border-l-4 bg-popover text-popover-foreground shadow-lg",
        "animate-in fade-in slide-in-from-bottom-2 motion-reduce:animate-none",
        error ? "border-l-red-400" : "border-l-orange-400",
      )}
    >
      <div className="flex gap-2.5 p-3">
        <Icon className={cn("mt-0.5 size-4 shrink-0", error ? "text-red-300" : "text-orange-300")} aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{e.runTitle}</p>
          <p className="line-clamp-3 text-sm text-muted-foreground">{e.flag.message}</p>
          <div className="mt-2 flex justify-end gap-1.5">
            <Button size="sm" variant="ghost" className="h-7" onClick={() => closeAlert(e.flag.id)}>
              Dismiss
            </Button>
            <Button
              size="sm"
              variant="secondary"
              className="h-7"
              onClick={() => {
                closeAlert(e.flag.id);
                openRun(e.runId);
              }}
            >
              Open run
            </Button>
          </div>
        </div>
        <button type="button" onClick={() => closeAlert(e.flag.id)} className="h-fit rounded text-muted-foreground hover:text-foreground" aria-label="Dismiss">
          <X className="size-4" />
        </button>
      </div>
    </div>
  );
}

/** Popups for flags raised on any run, bottom right, newest on top. */
export function FlagAlerts() {
  const alerts = useAgent((s) => s.alerts);
  const seen = useRef(new Set<string>());
  useEffect(() => {
    for (const a of alerts) {
      if (seen.current.has(a.flag.id)) continue;
      seen.current.add(a.flag.id);
      notifyOs(a);
    }
  }, [alerts]);
  if (!alerts.length) return null;
  const more = alerts.length - VISIBLE;
  return (
    <div className="pointer-events-none fixed right-4 bottom-4 z-50 flex flex-col items-end gap-2" aria-live="polite">
      {alerts.slice(0, VISIBLE).map((a) => (
        <Alert key={a.flag.id} e={a} />
      ))}
      {more > 0 && (
        <button
          type="button"
          className="pointer-events-auto rounded-md bg-popover px-2.5 py-1 text-xs text-muted-foreground shadow hover:text-foreground"
          onClick={() => {
            useAgent.setState({ alerts: [] });
            useAgent.getState().openRun(alerts[VISIBLE].runId);
          }}
        >
          +{more} more flag{more === 1 ? "" : "s"}
        </button>
      )}
    </div>
  );
}
