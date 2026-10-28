// Hand-rolled argv parsing (no deps): `--flag`, `--flag value`, `--flag=value`, repeatable flags, `--` ends the
// options (what follows is kept as `rest`, e.g. the command `schedule add` runs later).

export type FlagKind = "bool" | "string" | "multi";
export type FlagSpec = Record<string, FlagKind>;

export interface Parsed {
  positionals: string[];
  flags: Record<string, string | boolean | string[] | undefined>;
  /** After `--`. */
  rest: string[];
}

export class UsageError extends Error {}

/** Short flags understood everywhere. */
const SHORT: Record<string, string> = { "-h": "--help", "-r": "-r", "-v": "--version" };

export function parseArgs(argv: string[], spec: FlagSpec): Parsed {
  const out: Parsed = { positionals: [], flags: {}, rest: [] };
  for (let i = 0; i < argv.length; i++) {
    let a = argv[i];
    if (a === "--") {
      out.rest = argv.slice(i + 1);
      break;
    }
    if (SHORT[a]) a = SHORT[a];
    if (!a.startsWith("--") || a === "-") {
      out.positionals.push(a);
      continue;
    }
    const eq = a.indexOf("=");
    const name = (eq > 0 ? a.slice(2, eq) : a.slice(2)).toLowerCase();
    const kind = spec[name];
    if (!kind) throw new UsageError(`Unknown option --${name}`);
    if (kind === "bool") {
      if (eq > 0) throw new UsageError(`--${name} takes no value`);
      out.flags[name] = true;
      continue;
    }
    let value: string | undefined = eq > 0 ? a.slice(eq + 1) : argv[++i];
    if (value === undefined || (eq < 0 && value.startsWith("--"))) throw new UsageError(`--${name} needs a value`);
    if (kind === "multi") out.flags[name] = [...((out.flags[name] as string[] | undefined) ?? []), value];
    else out.flags[name] = value;
  }
  return out;
}

/** `K=V` pairs (from --env) as an object; names are checked by the server. */
export function parseEnv(pairs: string[] = []): Record<string, string> {
  const env: Record<string, string> = {};
  for (const p of pairs) {
    const eq = p.indexOf("=");
    if (eq <= 0) throw new UsageError(`--env wants NAME=value (got "${p}")`);
    env[p.slice(0, eq)] = p.slice(eq + 1);
  }
  return env;
}

export function parsePort(v: unknown): number | undefined {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0 || n > 65535) throw new UsageError(`--port wants a port number (got "${v}")`);
  return n;
}

/**
 * `--at`: an ISO date-time, or HH:MM (today, or tomorrow when that time has passed). Must be in the future.
 */
export function parseAt(v: string, now = new Date()): Date {
  const hm = /^(\d{1,2}):(\d{2})$/.exec(v.trim());
  let d: Date;
  if (hm) {
    const [h, m] = [Number(hm[1]), Number(hm[2])];
    if (h > 23 || m > 59) throw new UsageError(`--at: "${v}" isn't a time`);
    d = new Date(now);
    d.setHours(h, m, 0, 0);
    if (d.getTime() <= now.getTime()) d.setDate(d.getDate() + 1);
  } else {
    d = new Date(v);
    if (Number.isNaN(d.getTime())) throw new UsageError(`--at wants an ISO date-time or HH:MM (got "${v}")`);
    if (d.getTime() <= now.getTime()) throw new UsageError(`--at ${v} is in the past`);
  }
  return d;
}
