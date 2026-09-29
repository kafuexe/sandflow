import { useMemo } from "react";
import { useStore } from "@/lib/store";
import { flowSteps, type FlowStep } from "@/lib/timeline";
import { resolveNode } from "../../../shared/resolve";
import type { Flow, ResolvedConfig, RunState } from "../../../shared/types";

export interface RunFlow {
  /** The flow as it is now (undefined if it was deleted since the run). */
  flow?: Flow;
  steps: FlowStep[];
  label(nodeId: string): string;
  cfg(nodeId: string): ResolvedConfig | undefined;
}

/** Labels, block configs and step order for a run's nodes, looked up in the flow's current definition. */
export function useRunFlow(run: Pick<RunState, "flowId" | "nodes">): RunFlow {
  const flows = useStore((s) => s.data?.flows);
  const blocks = useStore((s) => s.data?.blocks);
  return useMemo(() => {
    const flow = flows?.find((f) => f.id === run.flowId);
    const all = flow && blocks ? flowSteps(flow, blocks) : [];
    const labels = new Map(all.map((s) => [s.id, s.label]));
    // Only nodes that existed when the run started (the flow may have gained nodes since).
    const steps = all.filter((s) => s.id in run.nodes);
    const cfgs = new Map<string, ResolvedConfig | undefined>();
    return {
      flow,
      steps: steps.length ? steps : Object.keys(run.nodes).map((id) => ({ id, label: id })),
      label: (id) => labels.get(id) ?? id,
      cfg(id) {
        if (!cfgs.has(id)) {
          const node = flow?.nodes.find((n) => n.id === id);
          let cfg: ResolvedConfig | undefined;
          try {
            cfg = node && blocks ? resolveNode(node, blocks) : undefined;
          } catch {
            cfg = undefined;
          }
          cfgs.set(id, cfg);
        }
        return cfgs.get(id);
      },
    };
  }, [flows, blocks, run.flowId, run.nodes]);
}
