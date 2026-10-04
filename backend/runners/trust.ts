// Whose code a block runs, and whether it may run on this machine. Your own blocks (and anything you type on
// a node) are always trusted; code that comes from a pack only when that pack is marked as trusted.

import { CORE_PACK } from "../../shared/packs";
import { templateChain } from "../../shared/resolve";
import type { BlockConfig, FlowNode } from "../../shared/types";
import type { RunContext } from "../engine";

/**
 * Whose code a node runs for a given config field: the pack of the block (in the template chain) that set it,
 * or nobody's (undefined) when you set it yourself — on your own block or on the node.
 */
export function codeOwner(ctx: RunContext, node: FlowNode, pick: (c: BlockConfig) => string | undefined): string | undefined {
  if (pick(node.data.overrides ?? {})?.trim()) return undefined;
  let chain;
  try {
    chain = templateChain(node.data.blockId, ctx.blocks);
  } catch {
    return undefined;
  }
  for (const b of [...chain].reverse()) if (pick(b.config)?.trim()) return b.pack === CORE_PACK ? undefined : b.pack;
  return undefined;
}

/** The pack whose files a node uses ($PACK_DIR): the nearest pack block in its template chain. */
export function filesPack(ctx: RunContext, node: FlowNode): string | undefined {
  try {
    return [...templateChain(node.data.blockId, ctx.blocks)].reverse().find((b) => b.pack && b.pack !== CORE_PACK)?.pack;
  } catch {
    return undefined;
  }
}

/** May code from `pack` run on this machine? Your own code always may. */
export function trustedOnHost(ctx: RunContext, pack: string | undefined): boolean {
  return !pack || !!ctx.packs?.runtime(pack)?.trustHost;
}
