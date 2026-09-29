import { memo } from "react";
import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import { Check, HelpCircle, KeyRound, Loader2, MessageSquareText, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { BlockIcon } from "@/lib/icons";
import { useStore } from "@/lib/store";
import { cn } from "@/lib/utils";
import { describeCondition } from "../../shared/conditions";
import { resolveNode } from "../../shared/resolve";
import { describeSchedule } from "../../shared/schedule";
import { skillKey } from "../../shared/skills";
import type { FlowNodeData, NodeRunStatus, ResolvedConfig } from "../../shared/types";

type BlockNodeType = Node<FlowNodeData, "block">;

const KIND_LABEL: Record<ResolvedConfig["kind"], string> = { auto: "AUTO", ai: "AI", manager: "MANAGER", trigger: "TRIGGER", condition: "IF" };

const TRIGGER_WHAT: Record<string, string> = { manual: "Run button", schedule: "", github: "GitHub", gitlab: "GitLab" };

/** One-line summary of what starts a trigger node / what an If checks. */
function summary(cfg: ResolvedConfig): string | undefined {
  if (cfg.kind === "condition") return describeCondition(cfg.condition);
  if (cfg.kind !== "trigger") return undefined;
  const t = cfg.trigger;
  if (t.type === "schedule") return describeSchedule(t.schedule);
  if (t.type === "manual") return "Starts when you press Run";
  const events = t.events?.length ? t.events.join(", ") : "all events";
  return `${TRIGGER_WHAT[t.type]} ${t.repo ?? "(set repo)"} · ${events} · ${t.mode ?? "webhook"}`;
}

/** true/false outputs of an If block. */
function BranchHandles({ taken }: { taken?: "true" | "false" }) {
  return (
    <>
      {(["true", "false"] as const).map((b, i) => (
        <Handle key={b} id={b} type="source" position={Position.Right} className={`handle-${b}`} style={{ top: `${((i + 1) / 3) * 100}%` }}>
          <span className={cn("pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-[9px] font-medium", b === "true" ? "text-emerald-400" : "text-red-400", taken === b && "underline")}>
            {b}
          </span>
        </Handle>
      ))}
    </>
  );
}

const STATUS_RING: Record<NodeRunStatus, string> = {
  idle: "",
  queued: "ring-2 ring-sky-500/40",
  running: "ring-2 ring-sky-400",
  waiting: "ring-2 ring-amber-400 animate-pulse",
  done: "ring-2 ring-emerald-500/70",
  failed: "ring-2 ring-red-500",
};

function StatusBadge({ status, executions }: { status: NodeRunStatus; executions: number }) {
  if (status === "idle" && !executions) return null;
  const icon = {
    idle: null,
    queued: <Loader2 className="size-3 opacity-50" />,
    running: <Loader2 className="size-3 animate-spin" />,
    waiting: <HelpCircle className="size-3" />,
    done: <Check className="size-3" />,
    failed: <X className="size-3" />,
  }[status];
  return (
    <span
      className={cn(
        "absolute -top-2.5 -right-2.5 flex items-center gap-0.5 rounded-full border bg-card px-1.5 py-0.5 text-[10px] font-medium",
        status === "failed" && "border-red-500 text-red-400",
        status === "done" && "border-emerald-500 text-emerald-400",
        status === "waiting" && "border-amber-400 text-amber-300",
        (status === "running" || status === "queued") && "border-sky-400 text-sky-300",
      )}
    >
      {icon}
      {executions > 1 && `×${executions}`}
    </span>
  );
}

function HandleRow({ cfg, side }: { cfg: ResolvedConfig; side: "in" | "out" }) {
  const io = side === "in" ? cfg.inputs : cfg.outputs;
  const kinds = (["artifact", "steer"] as const).filter((k) => io[k]);
  return (
    <>
      {kinds.map((k, i) => {
        const top = `${((i + 1) / (kinds.length + 1)) * 100}%`;
        return (
          <Handle
            key={k}
            id={k}
            type={side === "in" ? "target" : "source"}
            position={side === "in" ? Position.Left : Position.Right}
            className={`handle-${k}`}
            style={{ top }}
          >
            <span
              className={cn(
                "pointer-events-none absolute top-1/2 -translate-y-1/2 text-[9px] text-muted-foreground",
                side === "in" ? "left-3" : "right-3",
              )}
            >
              {k}
            </span>
          </Handle>
        );
      })}
    </>
  );
}

function BlockNodeImpl({ id, data, selected }: NodeProps<BlockNodeType>) {
  const blocks = useStore((s) => s.data?.blocks ?? []);
  const runNode = useStore((s) => s.run?.nodes[id]);
  const updateOverrides = useStore((s) => s.updateNodeOverrides);
  const touchedAt = useStore((s) => s.highlight[id]);
  const flowActive = useStore((s) => !!s.data?.flows.find((f) => f.id === s.currentFlowId)?.active);
  const block = blocks.find((b) => b.id === data.blockId);

  let cfg: ResolvedConfig | undefined;
  let error: string | undefined;
  try {
    cfg = block ? resolveNode({ id, type: "block", position: { x: 0, y: 0 }, data }, blocks) : undefined;
    if (!block) error = `Missing block "${data.blockId}"`;
  } catch (e) {
    error = (e as Error).message;
  }

  if (!cfg || error) {
    return (
      <div className="w-[240px] rounded-lg border border-red-500 bg-card p-3 text-xs text-red-400">
        {error ?? "Invalid block"}
      </div>
    );
  }

  const parent = block?.extends ? blocks.find((b) => b.id === block.extends) : undefined;
  const status = runNode?.status ?? "idle";

  return (
    <div
      // Remount the glow when the assistant touches the node again so the animation replays.
      key={touchedAt ?? "idle"}
      className={cn(
        "relative w-[240px] rounded-lg border bg-card text-card-foreground shadow-md transition-shadow",
        selected && "outline-2 outline-offset-2 outline-primary/60",
        STATUS_RING[status],
        touchedAt && "ai-touched",
      )}
    >
      <StatusBadge status={status} executions={runNode?.executions ?? 0} />
      {cfg.kind !== "trigger" && <HandleRow cfg={cfg} side="in" />}
      {cfg.kind === "condition" ? <BranchHandles taken={runNode?.branch} /> : <HandleRow cfg={cfg} side="out" />}

      <div className="flex items-center gap-2 rounded-t-lg border-b px-3 py-2" style={{ borderTop: `3px solid ${cfg.color}` }}>
        <span className="flex size-6 items-center justify-center rounded" style={{ background: `${cfg.color}33`, color: cfg.color }}>
          <BlockIcon name={cfg.icon} className="size-3.5" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold">{data.label || block?.name}</div>
          {parent && <div className="truncate text-[10px] text-muted-foreground">extends {parent.name}</div>}
        </div>
        <div className="flex flex-col items-end gap-0.5">
          <Badge variant="secondary" className="px-1.5 py-0 text-[9px]">
            {KIND_LABEL[cfg.kind]}
          </Badge>
          {block?.isTemplate && (
            <Badge variant="outline" className="px-1.5 py-0 text-[9px]">
              tpl
            </Badge>
          )}
        </div>
      </div>

      <div className="space-y-1.5 px-7 py-2 text-[10px]">
        {summary(cfg) && <div className="line-clamp-3 font-mono text-muted-foreground" title={summary(cfg)}>{summary(cfg)}</div>}
        {cfg.kind === "trigger" && flowActive && cfg.trigger.type !== "manual" && (
          <span className="inline-flex items-center gap-1 rounded bg-emerald-500/15 px-1.5 py-0.5 text-emerald-400">● listening</span>
        )}
        {(cfg.inputs.startingPrompt || cfg.env.length > 0) && (
          <div className="flex flex-wrap gap-1">
            {cfg.inputs.startingPrompt && (
              <span className="flex items-center gap-1 rounded bg-muted px-1.5 py-0.5">
                <MessageSquareText className="size-3" /> starting prompt
              </span>
            )}
            {cfg.env.length > 0 && (
              <span className="flex items-center gap-1 rounded bg-muted px-1.5 py-0.5" title={cfg.env.join(", ")}>
                <KeyRound className="size-3" /> {cfg.env.length} env
              </span>
            )}
          </div>
        )}
        {cfg.skills.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {cfg.skills.slice(0, 2).map((s) => (
              <span key={skillKey(s)} className="rounded border px-1.5 py-0.5 text-muted-foreground">
                {s.name}
              </span>
            ))}
            {cfg.skills.length > 2 && (
              <span className="rounded border px-1.5 py-0.5 text-muted-foreground" title={cfg.skills.slice(2).map((s) => s.name).join(", ")}>
                +{cfg.skills.length - 2}
              </span>
            )}
          </div>
        )}
        {(cfg.kind === "ai" || cfg.kind === "manager") && (
          <label className="nodrag flex items-center justify-between gap-2 pt-0.5 text-muted-foreground">
            Allow questions
            <Switch
              checked={cfg.allowQuestions}
              onCheckedChange={(v) => updateOverrides(id, { allowQuestions: v })}
              className="scale-75"
            />
          </label>
        )}
        {runNode?.error && <div className="text-red-400">{runNode.error}</div>}
      </div>
    </div>
  );
}

export const BlockNode = memo(BlockNodeImpl);
