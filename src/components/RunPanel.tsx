import { useEffect, useRef, useState } from "react";
import { Check, CircleDashed, HelpCircle, Loader2, Send, X, Zap } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Textarea } from "@/components/ui/textarea";
import { useCurrentFlow, useStore } from "@/lib/store";
import { cn } from "@/lib/utils";
import { nodeLabel } from "../../shared/resolve";
import type { NodeRunStatus, RunStatus, TriggerEvent } from "../../shared/types";

const STATUS_ICON: Record<NodeRunStatus, React.ReactNode> = {
  idle: <CircleDashed className="size-3.5 text-muted-foreground" />,
  queued: <CircleDashed className="size-3.5 text-sky-400" />,
  running: <Loader2 className="size-3.5 animate-spin text-sky-400" />,
  waiting: <HelpCircle className="size-3.5 text-amber-400" />,
  done: <Check className="size-3.5 text-emerald-400" />,
  failed: <X className="size-3.5 text-red-400" />,
};

const RUN_BADGE: Record<RunStatus, string> = {
  running: "bg-sky-500/20 text-sky-300",
  waiting: "bg-amber-500/20 text-amber-300",
  done: "bg-emerald-500/20 text-emerald-300",
  failed: "bg-red-500/20 text-red-300",
  cancelled: "bg-muted text-muted-foreground",
};

const LOG_COLOR = { info: "text-muted-foreground", warn: "text-amber-300", error: "text-red-400", agent: "text-foreground" };

export function AnswerBox({ autoFocus }: { autoFocus?: boolean }) {
  const [text, setText] = useState("");
  const answer = useStore((s) => s.answer);
  const submit = () => {
    if (!text.trim()) return;
    void answer(text.trim());
    setText("");
  };
  return (
    <div className="space-y-2">
      <Textarea
        autoFocus={autoFocus}
        rows={3}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit();
        }}
        placeholder="Your answer… (Ctrl+Enter to send)"
      />
      <Button size="sm" onClick={submit} disabled={!text.trim()}>
        <Send /> Send answer
      </Button>
    </div>
  );
}

export function RunPanel() {
  const run = useStore((s) => s.run);
  const blocks = useStore((s) => s.data?.blocks ?? []);
  const runError = useStore((s) => s.runError);
  const flow = useCurrentFlow();
  const [picked, setPicked] = useState<string | null>(null);
  const logBox = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = logBox.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [run?.logs.length]);

  if (!run) {
    return (
      <ScrollArea className="h-full">
        <div className="space-y-4 p-3">
          <div className="text-sm text-muted-foreground">
            {runError ? <div className="text-red-400">{runError}</div> : "No run selected. Press Run, or pick a recent run below."}
          </div>
          <RecentRuns />
        </div>
      </ScrollArea>
    );
  }

  const nodes = flow?.id === run.flowId ? flow.nodes : [];
  const label = (id: string) => {
    const n = nodes.find((x) => x.id === id);
    return n ? nodeLabel(n, blocks) : id;
  };
  const executed = Object.entries(run.nodes).filter(([, s]) => s.executions > 0 || s.status !== "idle");
  const detail = picked ? run.nodes[picked] : undefined;

  return (
    <ScrollArea className="h-full">
      <div className="space-y-4 p-3">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <span className={cn("rounded px-2 py-0.5 text-xs font-medium capitalize", RUN_BADGE[run.status])}>{run.status}</span>
            <span className="truncate text-sm font-medium">{run.flowName}</span>
          </div>
          {run.trigger && run.trigger.source !== "manual" && (
            <div className="text-xs text-muted-foreground">
              <Zap className="mr-1 inline size-3 text-yellow-400" />
              {triggerText(run.trigger)}
              {run.trigger.url && (
                <a href={run.trigger.url} target="_blank" rel="noreferrer" className="ml-1 underline">
                  open
                </a>
              )}
            </div>
          )}
          {run.branch && <div className="font-mono text-xs text-muted-foreground">branch: {run.branch}</div>}
          {run.error && <div className="text-xs text-red-400">{run.error}</div>}
          {runError && <div className="text-xs text-red-400">{runError}</div>}
        </div>

        {run.pendingQuestion && (
          <div className="space-y-2 rounded-lg border border-amber-400/60 bg-amber-500/10 p-3">
            <div className="flex items-center gap-1.5 text-xs font-medium text-amber-300">
              <HelpCircle className="size-4" /> {label(run.pendingQuestion.nodeId)} asks:
            </div>
            <div className="text-sm whitespace-pre-wrap">{run.pendingQuestion.question}</div>
            <AnswerBox />
          </div>
        )}

        <div className="space-y-1">
          <div className="text-xs font-medium text-muted-foreground">Nodes</div>
          {executed.map(([id, s]) => (
            <button
              key={id}
              type="button"
              onClick={() => setPicked(picked === id ? null : id)}
              className={cn(
                "flex w-full items-center gap-2 rounded px-2 py-1 text-left text-sm hover:bg-accent",
                picked === id && "bg-accent",
              )}
            >
              {STATUS_ICON[s.status]}
              <span className="flex-1 truncate">{label(id)}</span>
              {s.routedTo && <span className="truncate text-[10px] text-emerald-400">→ {label(s.routedTo)}</span>}
              {s.executions > 1 && <Badge variant="secondary" className="px-1 py-0 text-[10px]">×{s.executions}</Badge>}
            </button>
          ))}
        </div>

        {detail && picked && (
          <div className="space-y-2 rounded-lg border p-2">
            <div className="text-xs font-medium">{label(picked)} — latest execution</div>
            {detail.error && <div className="text-xs text-red-400">{detail.error}</div>}
            {(
              [
                ["Input artifact", detail.inputs?.artifact],
                ["Input steer", detail.inputs?.steer],
                ["Output artifact", detail.outputs?.artifact],
                ["Output steer", detail.outputs?.steer],
              ] as const
            )
              .filter(([, v]) => v)
              .map(([k, v]) => (
                <div key={k}>
                  <div className="text-[10px] text-muted-foreground uppercase">{k}</div>
                  <pre className="max-h-60 overflow-auto rounded bg-muted p-2 text-[11px] whitespace-pre-wrap">{v}</pre>
                </div>
              ))}
          </div>
        )}

        <div className="space-y-1">
          <div className="text-xs font-medium text-muted-foreground">Logs</div>
          <div ref={logBox} className="max-h-[420px] overflow-auto rounded bg-black/40 p-2 font-mono text-[11px] leading-relaxed">
            {run.logs.map((l, i) => (
              <div key={i} className={cn("whitespace-pre-wrap", LOG_COLOR[l.level])}>
                <span className="text-muted-foreground/60">{new Date(l.ts).toLocaleTimeString()} </span>
                {l.nodeId && <span className="text-sky-400/80">[{label(l.nodeId)}] </span>}
                {l.msg}
              </div>
            ))}
          </div>
        </div>
        <RecentRuns />
      </div>
    </ScrollArea>
  );
}

function triggerText(t: TriggerEvent): string {
  const where = t.number !== undefined ? ` ${t.target === "merge_request" ? (t.source === "gitlab" ? "!" : "#") : "#"}${t.number}` : "";
  return [t.source === "schedule" ? "Scheduled" : `${t.source}: ${t.type}${where}`, t.author && `by ${t.author}`].filter(Boolean).join(" ");
}

/** Recent runs across all flows — including ones started by triggers. */
function RecentRuns() {
  const runs = useStore((s) => s.runs);
  const current = useStore((s) => s.run?.id);
  const watch = useStore((s) => s.watch);
  const log = useStore((s) => s.triggers?.log);
  if (!runs.length && !log?.length) return null;
  return (
    <div className="space-y-3">
      {runs.length > 0 && (
        <div className="space-y-1">
          <div className="text-xs font-medium text-muted-foreground">Recent runs</div>
          {runs.slice(0, 15).map((r) => (
            <button
              key={r.id}
              type="button"
              onClick={() => void watch(r.id)}
              className={cn("flex w-full items-center gap-2 rounded px-2 py-1 text-left text-xs hover:bg-accent", r.id === current && "bg-accent")}
            >
              <span className={cn("rounded px-1.5 py-0.5 text-[10px] capitalize", RUN_BADGE[r.status])}>{r.status}</span>
              <span className="min-w-0 flex-1 truncate">
                {r.flowName}
                {r.trigger && r.trigger.source !== "manual" && (
                  <span className="text-muted-foreground"> · {triggerText({ ...r.trigger, firedAt: r.startedAt })}</span>
                )}
              </span>
              <span className="shrink-0 text-[10px] text-muted-foreground">{new Date(r.startedAt).toLocaleTimeString()}</span>
            </button>
          ))}
        </div>
      )}
      {!!log?.length && (
        <div className="space-y-1">
          <div className="text-xs font-medium text-muted-foreground">Trigger activity</div>
          <div className="max-h-40 overflow-auto rounded bg-black/30 p-2 font-mono text-[10px] leading-relaxed">
            {log.slice(0, 50).map((l, i) => (
              <div key={i} className={l.level === "info" ? "text-muted-foreground" : l.level === "warn" ? "text-amber-300" : "text-red-400"}>
                {new Date(l.ts).toLocaleTimeString()} {l.msg}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
