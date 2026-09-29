import { ArrowDown, MessageCircleQuestion } from "lucide-react";
import { cn } from "@/lib/utils";
import type { QuestionItem } from "@/lib/timeline";
import type { RunState } from "../../../shared/types";
import { Disclosure } from "./Disclosure";
import { ago, useNow } from "./status";
import type { RunFlow } from "./useRunFlow";

/**
 * A question from a block. While pending it carries everything needed to answer: who is asking,
 * what that block was working from, and what you already told it.
 */
export function QuestionCard({ item, run, rf }: { item: QuestionItem; run: RunState; rf: RunFlow }) {
  const now = useNow();
  const { record, pending } = item;
  const who = rf.label(record.nodeId);
  const cfg = rf.cfg(record.nodeId);
  const inputs = run.nodes[record.nodeId]?.inputs;
  const earlier = (run.questions ?? []).filter((q) => q.nodeId === record.nodeId && q.askedAt < record.askedAt && q.answer !== undefined);

  return (
    <article
      aria-label={`Question from ${who}`}
      className={cn(
        "relative rounded-lg border py-3 pr-4 pl-5",
        pending ? "border-amber-400/50 bg-amber-400/[0.07]" : "border-border bg-card/40",
      )}
    >
      <span className={cn("absolute inset-y-0 left-0 w-1 rounded-l-lg", pending ? "bg-amber-400" : "bg-muted-foreground/30")} />
      <header className="flex items-center gap-2 text-xs">
        <MessageCircleQuestion className={cn("size-4", pending ? "text-amber-300" : "text-muted-foreground")} />
        <span className={cn("font-medium", pending ? "text-amber-200" : "text-muted-foreground")}>
          {pending ? `${who} is paused and asking you` : `${who} asked`}
        </span>
        <span className="ml-auto text-muted-foreground tabular-nums">{ago(record.askedAt, now)}</span>
      </header>

      <p className="mt-2 max-w-[70ch] text-[15px] leading-relaxed whitespace-pre-wrap">{record.question}</p>

      {pending && (
        <div className="mt-3 space-y-1.5">
          {cfg?.description && <p className="text-xs text-muted-foreground">{who}: {cfg.description}</p>}
          {inputs?.artifact && <Disclosure title={`What ${who} was working from`} body={inputs.artifact} />}
          {inputs?.steer && <Disclosure title="Instructions from the previous step" body={inputs.steer} />}
          {earlier.length > 0 && (
            <Disclosure
              title={`Your earlier answers to ${who} (${earlier.length})`}
              body={earlier.map((q) => `Q: ${q.question}\nA: ${q.answer}`).join("\n\n")}
              open
            />
          )}
        </div>
      )}

      {record.answer !== undefined ? (
        <div className="mt-3 flex justify-end">
          <p className="max-w-[85%] rounded-2xl rounded-br-md bg-secondary px-3.5 py-2 text-sm whitespace-pre-wrap">
            <span className="sr-only">Your answer: </span>
            {record.answer}
          </p>
        </div>
      ) : pending ? (
        <p className="mt-3 flex items-center gap-1.5 text-xs text-amber-200/80">
          <ArrowDown className="size-3.5" /> Answer in the box below. The flow continues as soon as you send it.
        </p>
      ) : (
        <p className="mt-3 text-xs text-muted-foreground">Not answered. The run ended first.</p>
      )}
    </article>
  );
}
