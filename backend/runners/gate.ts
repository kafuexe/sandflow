// How a gate leaves, by failure level (shared/gates.ts): Checks and verdict agents both end here.
// A `block` failure is kept on the gate's node state until that gate passes; Create MR refuses while any is kept.

import { FinalError } from "../../shared/gates";
import { nodeLabel } from "../../shared/resolve";
import { exitHandle } from "../../shared/subflow";
import type { FlowNode, GateFailLevel, RunState } from "../../shared/types";
import type { NodeResult, RunContext } from "../engine";

export interface GateOutcome {
  /** Undefined = passed. */
  level?: GateFailLevel;
  /** What failed, one line (the run log, the flag, the stop error). */
  failures?: string;
  artifact?: string;
  /** Leaving through `pass` / through `fail`. */
  passSteer?: string;
  failSteer?: string;
}

export function gateResult(ctx: RunContext, node: FlowNode, o: GateOutcome): NodeResult {
  const label = nodeLabel(node, ctx.blocks);
  const ns = ctx.nodeState?.(node.id);
  const pass = (artifact = o.artifact): NodeResult => {
    if (ns?.gateBlock) {
      ns.gateBlock = undefined;
      ctx.log("info", "Passed — its blocking failure is cleared", node.id);
      ctx.journal?.();
    }
    return { exit: "pass", outputs: { artifact, steer: o.passSteer } };
  };
  if (!o.level) return pass();
  const what = o.failures || "failed";
  if (o.level === "note") {
    ctx.log("warn", `Failed (${what}) — on failure: note, so it counts as PASS`, node.id);
    return pass(`${o.artifact ?? ""}\n\n(Failure recorded as a note — counted as PASS.)`.trim());
  }
  if (o.level === "stop") throw new FinalError(`Gate "${label}" failed (on failure: stop): ${what}`);

  // Sub-flow nodes see their own flow here, so this is the edge the engine would follow.
  const failWired = (ctx.flow?.edges ?? []).some((e) => e.source === node.id && e.sourceHandle === exitHandle("fail"));
  const flags: NodeResult["flags"] = [];
  if (o.level === "block") {
    if (ns) {
      ns.gateBlock = { message: what, at: Date.now() };
      ctx.journal?.();
    }
    flags.push({ severity: "warning", message: `${label} failed (${what}) — Create MR is blocked until it passes` });
    // Nothing to fix it: the flow goes on through pass, but it can't ship.
    if (!failWired) return { exit: "pass", outputs: { artifact: o.artifact, steer: o.passSteer }, flags };
  } else if (!failWired) {
    flags.push({ severity: "warning", message: `${label} failed (${what}) and nothing is connected to its fail exit — that path ends here` });
  }
  return { exit: "fail", outputs: { artifact: o.artifact, steer: o.failSteer }, ...(flags.length ? { flags } : {}) };
}

/** Gates whose blocking failure is still kept on the run (labels and what failed). */
export function blockingGates(run: RunState, label: (key: string) => string): string[] {
  return Object.entries(run.nodes)
    .filter(([, s]) => s.gateBlock)
    .map(([k, s]) => `${label(k)} (${s.gateBlock!.message})`);
}
