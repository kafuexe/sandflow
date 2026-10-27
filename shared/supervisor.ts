// The supervisor's settings and the rules it reads off a node's config (see backend/supervisor.ts). Shared with the
// UI (Settings → Supervisor, the per-flow Overseer, a block's time limit).

import type { OverseerSettings, ResolvedConfig, Settings, SupervisorSettings } from "./types";

export const SUPERVISOR_DEFAULTS = {
  enabled: true,
  pollSeconds: 10,
  /** Quiet this long → a warning flag (agents / other nodes). */
  silentAgentSeconds: 10 * 60,
  silentOtherSeconds: 15 * 60,
  stuckAfterSeconds: 30 * 60,
  remindAfterSeconds: 30 * 60,
  /** A reminder repeats at most this often. */
  remindEverySeconds: 60 * 60,
  /** Executions in a run before an unchanged output counts as a loop. */
  loopWarnAfter: 5,
  /** A container is looked up at most this often. */
  sandboxCheckSeconds: 60,
  /** Shell command blocks without their own `timeoutSeconds`. */
  shellTimeoutSeconds: 30 * 60,
  /** A driver lock not refreshed for this many polls is stale when its owner can't be checked. */
  staleLockPolls: 10,
  overseerEverySeconds: 5 * 60,
  overseerModel: "haiku",
  /** Sandcastle's own idle timeout sits this far above `stuckAfterSeconds`: the supervisor decides, not sandcastle. */
  idleMarginSeconds: 5 * 60,
} as const;

export interface EffectiveSupervisor {
  enabled: boolean;
  pollSeconds: number;
  /** undefined: per kind (SUPERVISOR_DEFAULTS.silentAgentSeconds / silentOtherSeconds). */
  silentAfterSeconds?: number;
  stuckAfterSeconds: number;
  remindAfterSeconds: number;
}

const num = (v: unknown, min: number, max: number): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? Math.max(min, Math.min(max, Math.round(v))) : undefined;

/** Settings → Supervisor with the defaults filled in. */
export function supervisorSettings(s?: SupervisorSettings): EffectiveSupervisor {
  const silent = num(s?.silentAfterSeconds, 10, 7 * 86400);
  return {
    enabled: s?.enabled !== false,
    pollSeconds: num(s?.pollSeconds, 1, 3600) ?? SUPERVISOR_DEFAULTS.pollSeconds,
    ...(silent !== undefined ? { silentAfterSeconds: silent } : {}),
    stuckAfterSeconds: num(s?.stuckAfterSeconds, 30, 7 * 86400) ?? SUPERVISOR_DEFAULTS.stuckAfterSeconds,
    remindAfterSeconds: num(s?.remindAfterSeconds, 30, 7 * 86400) ?? SUPERVISOR_DEFAULTS.remindAfterSeconds,
  };
}

/** Settings → Supervisor as saved: numbers in range, unset ones left out (they take the defaults). */
export function validateSupervisorSettings(s: SupervisorSettings): SupervisorSettings {
  const out: SupervisorSettings = {};
  if (s.enabled === false) out.enabled = false;
  const set = (k: Exclude<keyof SupervisorSettings, "enabled">, min: number, max: number) => {
    if (s[k] === undefined || s[k] === null) return;
    const v = num(Number(s[k]), min, max);
    if (v === undefined) throw new Error(`Supervisor: ${k} must be a number of seconds`);
    out[k] = v;
  };
  set("pollSeconds", 1, 3600);
  set("silentAfterSeconds", 10, 7 * 86400);
  set("stuckAfterSeconds", 30, 7 * 86400);
  set("remindAfterSeconds", 30, 7 * 86400);
  return out;
}

/** A flow's overseer setting, normalised (undefined = off). */
export function validateOverseer(o: OverseerSettings | undefined): OverseerSettings | undefined {
  if (!o?.enabled) return undefined;
  const model = o.model?.trim();
  if (model && !/^[\w.:/@\[\]-]{1,120}$/.test(model)) throw new Error(`Invalid overseer model "${model}"`);
  const every = num(o.everySeconds, 30, 86400);
  return { enabled: true, ...(model ? { model } : {}), ...(every !== undefined ? { everySeconds: every } : {}) };
}

/** Agent nodes: what the overseer looks at, and what "silent" is measured against. */
export const isAgentKind = (cfg: Pick<ResolvedConfig, "kind">) => cfg.kind === "ai" || cfg.kind === "manager";

/** A node's time limit in seconds (undefined: none). Shell commands default to 30 min; 0 turns a limit off. */
export function nodeTimeoutSeconds(cfg: Pick<ResolvedConfig, "kind" | "autoAction" | "timeoutSeconds">): number | undefined {
  const t = cfg.timeoutSeconds ?? (cfg.kind === "auto" && cfg.autoAction === "shell" ? SUPERVISOR_DEFAULTS.shellTimeoutSeconds : undefined);
  return t && t > 0 ? t : undefined;
}

/** Sandcastle's idle timeout for agents: above `stuckAfterSeconds`, so the supervisor decides (undefined: its own default). */
export function agentIdleTimeoutSeconds(settings: Pick<Settings, "supervisor">): number | undefined {
  const s = supervisorSettings(settings.supervisor);
  return s.enabled ? s.stuckAfterSeconds + SUPERVISOR_DEFAULTS.idleMarginSeconds : undefined;
}
