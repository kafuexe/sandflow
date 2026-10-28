// What agent steps cost: a price table for Claude models (Anthropic first-party API rates, USD per million tokens),
// and run totals. Other providers' models aren't priced: their steps show tokens only.

import type { NodeUsage, RunState } from "./types";

export interface ModelPrice {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

const price = (input: number, output: number, cacheRead = input / 10): ModelPrice => ({ input, output, cacheRead, cacheWrite: input * 1.25 });

/** Longest prefix first, so `claude-opus-5-5` isn't matched by `claude-opus-5`. */
const PRICES: [string, ModelPrice][] = [
  ["claude-fable-5-1", price(10, 50, 0.25)],
  ["claude-mythos-5-1", price(10, 50, 0.25)],
  ["claude-fable-5", price(10, 50)],
  ["claude-opus-5-5", price(4, 20, 0.2)],
  ["claude-opus-5", price(5, 25)],
  ["claude-opus-4", price(5, 25)],
  ["claude-sonnet-5-5", price(2, 10, 0.2)],
  ["claude-sonnet-5", price(2, 10)],
  ["claude-sonnet-4", price(3, 15)],
  ["claude-haiku-5-5", price(0.1, 0.5)],
  ["claude-haiku-4", price(1, 5)],
];

/** Claude Code's model aliases, as the current model of each line. */
const ALIASES: Record<string, string> = {
  fable: "claude-fable-5-1",
  opus: "claude-opus-5-5",
  sonnet: "claude-sonnet-5-5",
  haiku: "claude-haiku-5-5",
};

/** The price of a model id or alias (`claude-opus-5-5`, `anthropic.claude-sonnet-5-5`, `opus`), if it's a Claude model. */
export function modelPrice(model: string | undefined): ModelPrice | undefined {
  let m = model?.trim().toLowerCase();
  if (!m) return undefined;
  m = ALIASES[m] ?? m.replace(/^.*?(claude-)/, "$1").replace(/\[.*$/, "");
  return PRICES.find(([prefix]) => m === prefix || m!.startsWith(`${prefix}-`))?.[1];
}

/** USD for one agent result, or undefined when the model has no known price. */
export function usageCost(u: Omit<NodeUsage, "at" | "costUsd">, model: string | undefined): number | undefined {
  const p = modelPrice(model);
  if (!p) return undefined;
  const cost =
    (u.inputTokens * p.input + u.outputTokens * p.output + (u.cacheReadTokens ?? 0) * p.cacheRead + (u.cacheWriteTokens ?? 0) * p.cacheWrite) / 1e6;
  return Math.round(cost * 1e6) / 1e6;
}

export interface UsageTotal {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
  /** Some results had no price (another provider, or the CLI's default model): `costUsd` leaves them out. */
  unpriced: number;
}

export const emptyUsage = (): UsageTotal => ({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0, unpriced: 0 });

export function addUsage(total: UsageTotal, list: NodeUsage[] | undefined): UsageTotal {
  for (const u of list ?? []) {
    total.inputTokens += u.inputTokens;
    total.outputTokens += u.outputTokens;
    total.cacheReadTokens += u.cacheReadTokens ?? 0;
    total.cacheWriteTokens += u.cacheWriteTokens ?? 0;
    if (u.costUsd === undefined) total.unpriced++;
    else total.costUsd += u.costUsd;
  }
  return total;
}

/** One step's usage over all its executions. */
export const nodeUsage = (list: NodeUsage[] | undefined): UsageTotal => addUsage(emptyUsage(), list);

/**
 * A run's usage: its own steps, plus the child runs its Box Stacks started (`children`, when the caller has them).
 * A child run's own children are counted through it.
 */
export function runUsage(run: RunState, children: RunState[] = []): UsageTotal {
  const total = emptyUsage();
  for (const ns of Object.values(run.nodes)) addUsage(total, ns.usage);
  for (const c of children) {
    const t = runUsage(c);
    total.inputTokens += t.inputTokens;
    total.outputTokens += t.outputTokens;
    total.cacheReadTokens += t.cacheReadTokens;
    total.cacheWriteTokens += t.cacheWriteTokens;
    total.costUsd += t.costUsd;
    total.unpriced += t.unpriced;
  }
  total.costUsd = Math.round(total.costUsd * 1e6) / 1e6;
  return total;
}

export const tokensOf = (t: Pick<UsageTotal, "inputTokens" | "outputTokens" | "cacheReadTokens" | "cacheWriteTokens">) =>
  t.inputTokens + t.outputTokens + t.cacheReadTokens + t.cacheWriteTokens;

/** `$0.42`, `<$0.01`, `$12.30`. */
export function formatUsd(usd: number): string {
  if (usd > 0 && usd < 0.01) return "<$0.01";
  return `$${usd.toFixed(2)}`;
}

/** `12.3k`, `1.2M`. */
export function formatTokens(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(n);
}
