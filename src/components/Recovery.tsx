// Recovery (see shared/recovery.ts): the flow's Recovery setting (Inputs tab) and a step's recovery history (Run tab).

import { LifeBuoy } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useStore } from "@/lib/store";
import { cn } from "@/lib/utils";
import { CAUSE_TEXT, GUARD_TEXT, hasAgentBlocks, recoverySettings } from "../../shared/recovery";
import type { Flow, NodeRecovery, RecoveryEntry, RecoveryMode } from "../../shared/types";

const DEFAULT = "default";

/** A whole number ≥ 0 typed in a box; blank = the default. */
function CountInput({ id, value, placeholder, onChange }: { id: string; value: number | undefined; placeholder: number; onChange: (v: number | undefined) => void }) {
  return (
    <Input
      id={id}
      type="number"
      min={0}
      max={20}
      className="h-8 w-20"
      value={value ?? ""}
      placeholder={String(placeholder)}
      onChange={(e) => {
        const v = e.target.value.trim();
        const num = Number(v);
        onChange(v === "" || !Number.isInteger(num) || num < 0 ? undefined : Math.min(num, 20));
      }}
    />
  );
}

/** Inputs tab: what happens when one of the flow's steps fails. */
export function FlowRecoverySetting({ flow }: { flow: Flow }) {
  const flows = useStore((s) => s.data?.flows ?? []);
  const blocks = useStore((s) => s.data?.blocks ?? []);
  const { setFlowRecovery } = useStore.getState();
  const r = flow.recovery ?? {};
  const eff = recoverySettings(flow, flows, blocks);
  const agents = hasAgentBlocks(flow, flows, blocks);
  return (
    <section className="space-y-2">
      <Label htmlFor="flow-recovery">When a step fails</Label>
      <Select
        value={r.mode ?? DEFAULT}
        onValueChange={(v) => setFlowRecovery(flow.id, { mode: v === DEFAULT ? undefined : (v as RecoveryMode) })}
      >
        <SelectTrigger id="flow-recovery" size="sm" className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={DEFAULT}>Default ({agents ? "retry, then triage" : "fail the run"})</SelectItem>
          <SelectItem value="triage">Retry, then a triage agent decides</SelectItem>
          <SelectItem value="off">Fail the run</SelectItem>
        </SelectContent>
      </Select>
      <p className="text-[11px] text-muted-foreground">
        {eff.mode === "triage"
          ? "Crashes, connection errors, stuck and timed-out steps are retried by themselves (an agent first reviews its own work). Other failures — and those once the retries are used up — go to a triage agent on this computer that reads the repo and decides: retry, resume with notes, rescope, skip, or hold the run for you."
          : "A failed step fails the run."}
      </p>
      {eff.mode === "triage" && (
        <div className="grid grid-cols-[1fr_auto] items-center gap-x-3 gap-y-1.5 text-xs">
          <Label htmlFor="flow-recovery-model" className="text-xs font-normal">
            Triage agent: Claude Code, model
          </Label>
          <Input
            id="flow-recovery-model"
            className="h-8 w-32"
            placeholder="CLI default"
            value={r.agent?.model ?? ""}
            onChange={(e) => setFlowRecovery(flow.id, { agent: e.target.value.trim() ? { provider: "claudeCode", model: e.target.value } : undefined })}
          />
          <Label htmlFor="flow-recovery-retries" className="text-xs font-normal">
            Automatic retries per failure
          </Label>
          <CountInput id="flow-recovery-retries" value={r.maxRetries} placeholder={eff.maxRetries} onChange={(v) => setFlowRecovery(flow.id, { maxRetries: v })} />
          <Label htmlFor="flow-recovery-cycles" className="text-xs font-normal">
            Triage decisions per step per run
          </Label>
          <CountInput id="flow-recovery-cycles" value={r.maxRecoveryCycles} placeholder={eff.maxRecoveryCycles} onChange={(v) => setFlowRecovery(flow.id, { maxRecoveryCycles: v })} />
        </div>
      )}
    </section>
  );
}

const DECISION_TEXT: Record<RecoveryEntry["decision"], string> = {
  retry: "retried",
  resume: "resumed with notes",
  rescope: "rescoped",
  skip: "skipped",
  blocked: "held for you",
  fail: "failed the run",
  hold: "held",
};

/** One line per thing recovery did after the step failed. */
export function recoveryLine(h: RecoveryEntry): string {
  const by = h.by === "auto" ? "automatically" : "by triage";
  const delay = h.delayMs ? ` after ${Math.round(h.delayMs / 1000)}s` : "";
  const session = h.session === "fresh" ? " (fresh agent session)" : h.session === "resume" ? " (its own agent session)" : "";
  return `${CAUSE_TEXT[h.cause]} → ${DECISION_TEXT[h.decision]} ${by}${delay}${session}`;
}

/** Run tab: a step's recovery history (cause → decision, why). */
export function RecoveryHistory({ rec, className }: { rec: NodeRecovery | undefined; className?: string }) {
  if (!rec?.history.length) return null;
  return (
    <div className={cn("space-y-1", className)}>
      <div className="flex items-center gap-1 text-[10px] text-muted-foreground uppercase">
        <LifeBuoy className="size-3" aria-hidden /> Recovery · {rec.cycles} triage cycle{rec.cycles === 1 ? "" : "s"} used
      </div>
      <ol className="space-y-1 text-[11px]">
        {rec.history.map((h, i) => (
          <li key={i} className="rounded bg-muted/60 px-2 py-1">
            <div className={cn(h.decision === "hold" || h.decision === "blocked" || h.decision === "fail" ? "text-amber-300" : "text-foreground")}>
              {new Date(h.at).toLocaleTimeString()} · {recoveryLine(h)}
            </div>
            <div className="truncate text-muted-foreground" title={h.message}>
              {h.message}
            </div>
            {h.reason && <div className="text-muted-foreground">Why: {h.reason}{h.guard ? ` (${GUARD_TEXT[h.guard]})` : ""}</div>}
            {h.notes && <div className="text-muted-foreground">Notes: {h.notes}</div>}
            {h.task && <div className="text-muted-foreground">New task: {h.task}</div>}
          </li>
        ))}
      </ol>
    </div>
  );
}
