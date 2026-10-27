import { Switch } from "@/components/ui/switch";
import { TriangleAlert } from "lucide-react";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useStore } from "@/lib/store";
import { HOST_WARNING, RUN_ON_LABELS, resolveRunOn, settingsRunOn } from "../../shared/runOn";
import type { Flow, FlowNode, ResolvedConfig, RunOn, RunOnChoice } from "../../shared/types";

const INHERIT = "inherit";

/**
 * "Run on: Sandbox container / This computer" for agent blocks, nodes and flows. `inheritLabel` names what an unset
 * value falls back to (e.g. "Flow default (Sandbox container)"); omit it to offer only the two places.
 */
export function RunOnSelect({
  value,
  onChange,
  inheritLabel,
  size,
  id,
}: {
  value: RunOnChoice | undefined;
  onChange: (v: RunOnChoice) => void;
  inheritLabel?: string;
  size?: "sm" | "default";
  id?: string;
}) {
  return (
    <Select value={value ?? INHERIT} onValueChange={(v) => onChange(v as RunOnChoice)}>
      <SelectTrigger id={id} size={size} className="w-full">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {inheritLabel && <SelectItem value={INHERIT}>{inheritLabel}</SelectItem>}
        {(Object.keys(RUN_ON_LABELS) as RunOn[]).map((k) => (
          <SelectItem key={k} value={k}>
            {RUN_ON_LABELS[k]}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** Shown wherever an agent will run on this computer. */
export function HostWarning() {
  return (
    <div className="flex items-start gap-1.5 rounded-lg border border-amber-500/40 bg-amber-500/5 p-2 text-[11px] text-muted-foreground">
      <TriangleAlert className="size-3.5 shrink-0 text-amber-400" />
      <span>{HOST_WARNING}</span>
    </div>
  );
}

/** Node (Block tab): where this agent runs, with what an unset value currently means. */
export function NodeRunOn({ flow, node, cfg }: { flow: Flow; node: FlowNode; cfg: ResolvedConfig }) {
  const sandbox = useStore((s) => s.data?.settings.sandbox ?? "docker");
  const { updateNodeOverrides } = useStore.getState();
  const fallback = resolveRunOn([flow.runOn], sandbox)!;
  const effective = cfg.runOn === "inherit" ? fallback : cfg.runOn;
  const from = flow.runOn ? "flow" : "Settings → Sandbox";
  return (
    <div className="space-y-1.5">
      <Label htmlFor="node-run-on">Run on</Label>
      <RunOnSelect
        id="node-run-on"
        size="sm"
        value={cfg.runOn}
        onChange={(runOn) => updateNodeOverrides(node.id, { runOn })}
        inheritLabel={`Default (${RUN_ON_LABELS[fallback]} — from ${from})`}
      />
      {effective === "host" && <HostWarning />}
    </div>
  );
}

/** Inputs tab: whether this flow's runs cut off by a crash, quit or update carry on by themselves on the next start. */
export function FlowContinueSwitch({ flow }: { flow: Flow }) {
  const { setFlowContinueAutomatically } = useStore.getState();
  return (
    <section className="space-y-1">
      <div className="flex items-center justify-between gap-2">
        <Label htmlFor="flow-continue-auto">Continue interrupted runs automatically</Label>
        <Switch id="flow-continue-auto" checked={flow.continueAutomatically !== false} onCheckedChange={(v) => setFlowContinueAutomatically(flow.id, v)} />
      </div>
      <p className="text-[11px] text-muted-foreground">
        When Sandflow quits, updates or crashes mid-run, the run carries on where it was on the next start. Off: it waits for you to
        press Continue. Stop always ends a run for good.
      </p>
    </section>
  );
}

/** Flow-wide default for its agents (Inputs tab). */
export function FlowRunOn({ flow }: { flow: Flow }) {
  const sandbox = useStore((s) => s.data?.settings.sandbox ?? "docker");
  const { setFlowRunOn } = useStore.getState();
  return (
    <section className="space-y-2">
      <Label htmlFor="flow-run-on">AI agents in this flow run on</Label>
      <RunOnSelect
        id="flow-run-on"
        size="sm"
        value={flow.runOn}
        onChange={(v) => setFlowRunOn(flow.id, v === "inherit" ? undefined : v)}
        inheritLabel={`Settings default (${RUN_ON_LABELS[settingsRunOn(sandbox)]})`}
      />
      <p className="text-[11px] text-muted-foreground">A block or node can still choose for itself.</p>
      {flow.runOn === "host" && <HostWarning />}
    </section>
  );
}
