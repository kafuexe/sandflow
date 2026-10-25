import { useEffect, useId, useRef, useState } from "react";
import { Check, CircleSlash, Loader2, Navigation, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/api";
import { steerability, steersOf } from "@/lib/steer";
import { useStore } from "@/lib/store";
import { cn } from "@/lib/utils";
import { MAX_STEER_CHARS, type ResolvedConfig, type RunState, type SteerRecord } from "../../shared/types";

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

function SteerStatus({ s }: { s: SteerRecord }) {
  if (s.status === "pending")
    return (
      <span className="flex items-center gap-1 text-amber-300">
        <Loader2 className="size-3 animate-spin motion-reduce:animate-none" aria-hidden /> Pending
      </span>
    );
  if (s.status === "applied")
    return (
      <span className="flex items-center gap-1 text-emerald-300">
        <Check className="size-3" aria-hidden /> {s.how === "interrupt" ? "Delivered — agent resumed with it" : "Delivered at its next turn"}
      </span>
    );
  return (
    <span className="flex items-center gap-1 text-muted-foreground">
      <CircleSlash className="size-3" aria-hidden /> Not delivered
    </span>
  );
}

/**
 * "Steer this agent": send a message to an agent block while it works. Shows each message's state (pending,
 * delivered, not delivered). Disabled, with the reason, when the node can't be steered.
 */
export function SteerBox({
  run,
  nodeKey,
  cfg,
  autoFocus,
  className,
}: {
  run: RunState;
  nodeKey: string;
  cfg: Pick<ResolvedConfig, "kind" | "agent"> | undefined;
  autoFocus?: boolean;
  className?: string;
}) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string>();
  const ref = useRef<HTMLTextAreaElement>(null);
  const headId = useId();
  const hintId = useId();
  const focus = useStore((s) => (s.steerFocus?.nodeKey === nodeKey ? s.steerFocus.at : undefined));
  const st = steerability(run, nodeKey, cfg);
  const mine = steersOf(run, nodeKey);

  // The canvas's "Steer" button asks for the box.
  useEffect(() => {
    if ((focus || autoFocus) && st.can) ref.current?.focus();
  }, [focus, autoFocus]); // eslint-disable-line react-hooks/exhaustive-deps

  const send = async () => {
    const message = text.trim();
    if (!message || !st.can || sending) return;
    setSending(true);
    setError(undefined);
    try {
      await api.steer(run.id, nodeKey, message);
      setText("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSending(false);
    }
  };

  return (
    <section aria-labelledby={headId} className={cn("space-y-2 rounded-lg border border-sky-400/40 bg-sky-400/[0.06] p-3", !st.can && "border-border bg-card/40", className)}>
      <h3 id={headId} className="flex items-center gap-1.5 text-xs font-medium">
        <Navigation className={cn("size-3.5", st.can ? "text-sky-300" : "text-muted-foreground")} aria-hidden /> Steer this agent
      </h3>
      <p id={hintId} className="text-[11px] text-muted-foreground">
        {st.hint}
      </p>
      <Textarea
        ref={ref}
        rows={2}
        value={text}
        disabled={!st.can}
        maxLength={MAX_STEER_CHARS}
        aria-labelledby={headId}
        aria-describedby={hintId}
        placeholder={st.can ? "e.g. Focus on the failing test first; don't touch the API" : undefined}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            void send();
          }
        }}
        className="min-h-14 text-sm"
      />
      <div className="flex items-center gap-2">
        <Button size="sm" onClick={() => void send()} disabled={!st.can || !text.trim() || sending}>
          {sending ? <Loader2 className="animate-spin motion-reduce:animate-none" /> : <Send />} Send
        </Button>
        {st.can && <span className="text-[10px] text-muted-foreground">{isMac ? "⌘" : "Ctrl"}+Enter</span>}
      </div>
      {error && (
        <p role="alert" className="text-xs text-red-300">
          {error}
        </p>
      )}
      {mine.length > 0 && (
        <ol aria-label="Your steering messages" aria-live="polite" className="space-y-1.5 border-t border-border/60 pt-2">
          {mine.map((s) => (
            <li key={s.id} className="space-y-0.5 text-xs">
              <p className="whitespace-pre-wrap">{s.message}</p>
              <div className="flex flex-wrap items-center gap-x-2 text-[10px]">
                <SteerStatus s={s} />
                {s.note && <span className="text-muted-foreground">{s.note}</span>}
              </div>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
