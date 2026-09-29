import { useState } from "react";
import { Loader2, Plus, RotateCcw, Send, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAgent } from "@/lib/agent";
import { cn } from "@/lib/utils";
import type { RunState } from "../../../shared/types";
import type { RunFlow } from "./useRunFlow";

/** Borderless textarea used inside the composer frames. */
export function ComposerInput(props: React.ComponentProps<"textarea">) {
  return (
    <textarea
      {...props}
      className={cn(
        "block max-h-72 min-h-20 w-full resize-none bg-transparent px-4 pt-3 pb-2 text-[15px] leading-relaxed outline-none [field-sizing:content] placeholder:text-muted-foreground/70",
        props.className,
      )}
    />
  );
}

export function StopButton({ run, size = "sm" }: { run: RunState; size?: "sm" | "default" }) {
  const stop = useAgent((s) => s.stop);
  const [stopping, setStopping] = useState(false);
  return (
    <Button
      size={size}
      variant="outline"
      className="border-red-400/40 text-red-200 hover:bg-red-500/15 hover:text-red-100"
      disabled={stopping}
      onClick={async () => {
        if (!confirm(`Stop "${run.flowName}"? The sandbox is torn down and this run can't be resumed.`)) return;
        setStopping(true);
        await stop(run.id);
        setStopping(false);
      }}
    >
      {stopping ? <Loader2 className="animate-spin" /> : <Square />} Stop run
    </Button>
  );
}

function AnswerComposer({ run, rf }: { run: RunState; rf: RunFlow }) {
  const q = run.pendingQuestion!;
  const answer = useAgent((s) => s.answer);
  const sending = useAgent((s) => !!s.answering[run.id]);
  const [text, setText] = useState("");
  const who = rf.label(q.nodeId);
  const send = async () => {
    if (!text.trim() || sending) return;
    if (await answer(run.id, text.trim())) setText("");
  };

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void send();
      }}
      className="rounded-xl border border-amber-400/60 bg-amber-400/[0.06] shadow-[0_0_0_4px] shadow-amber-400/10 focus-within:border-amber-300"
    >
      <label htmlFor="answer" className="flex items-center gap-2 border-b border-amber-400/20 px-4 py-2 text-xs text-amber-200">
        <span className="font-medium">Answering {who}</span>
        <span className="truncate text-amber-200/60">{q.question.split("\n")[0]}</span>
      </label>
      <ComposerInput
        id="answer"
        autoFocus
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            void send();
          }
        }}
        placeholder={`Reply to ${who}…`}
      />
      <div className="flex items-center gap-2 px-3 pb-3">
        <StopButton run={run} />
        <span className="ml-auto hidden text-xs text-muted-foreground sm:inline">Ctrl+Enter to send</span>
        <Button type="submit" size="sm" disabled={!text.trim() || sending} className="bg-amber-400 text-black hover:bg-amber-300">
          {sending ? <Loader2 className="animate-spin" /> : <Send />} Send answer
        </Button>
      </div>
    </form>
  );
}

function RunningBar({ run, rf }: { run: RunState; rf: RunFlow }) {
  const current = Object.entries(run.nodes).find(([, s]) => s.status === "running")?.[0];
  return (
    <div className="flex items-center gap-3 rounded-xl border bg-card/50 px-4 py-3 text-sm">
      <Loader2 className="size-4 shrink-0 animate-spin text-sky-300 motion-reduce:animate-none" />
      <p className="min-w-0 flex-1 text-muted-foreground">
        <span className="text-foreground">{current ? `${rf.label(current)} is working.` : "Starting…"}</span> If the flow
        needs anything, its question shows up here.
      </p>
      <StopButton run={run} />
    </div>
  );
}

function FinishedBar({ run }: { run: RunState }) {
  const { select, setDraft, setDraftFlow } = useAgent.getState();
  const text = run.status === "done" ? "This run finished." : run.status === "failed" ? "This run failed." : "This run was stopped.";
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-xl border bg-card/50 px-4 py-3 text-sm">
      <p className="mr-auto text-muted-foreground">{text}</p>
      {run.prompt && (
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            setDraft(run.prompt ?? "");
            setDraftFlow(run.flowId);
            select(null);
          }}
        >
          <RotateCcw /> Run again
        </Button>
      )}
      <Button size="sm" variant="secondary" onClick={() => select(null)}>
        <Plus /> New run
      </Button>
    </div>
  );
}

/** Bottom of a run's conversation: answer a question, watch it work, or start again. */
export function RunComposer({ run, rf }: { run: RunState; rf: RunFlow }) {
  if (run.finishedAt) return <FinishedBar run={run} />;
  if (run.pendingQuestion) return <AnswerComposer key={`${run.id}:${run.pendingQuestion.askedAt}`} run={run} rf={rf} />;
  return <RunningBar run={run} rf={rf} />;
}
