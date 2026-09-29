// Schedule maths shared by the trigger service (to arm timers) and the UI (to preview next runs).

import { Cron } from "croner";
import type { IntervalUnit, ScheduleSpec } from "./types";

/** Anchor used when an interval has no explicit start: a Monday at local midnight. */
export const DEFAULT_INTERVAL_START = "2026-01-05T00:00";

export const INTERVAL_UNITS: IntervalUnit[] = ["seconds", "minutes", "hours", "days", "weeks", "months"];

/** Shortest allowed period, so a typo can't hammer agents. */
const MIN_INTERVAL_MS = 10_000;

const UNIT_MS: Partial<Record<IntervalUnit, number>> = { seconds: 1_000, minutes: 60_000, hours: 3_600_000 };

function parseLocal(s: string | undefined): Date | undefined {
  if (!s?.trim()) return undefined;
  const d = new Date(s.trim()); // `YYYY-MM-DDTHH:mm` without zone = local time
  return Number.isNaN(d.getTime()) ? undefined : d;
}

const daysInMonth = (y: number, m: number) => new Date(y, m + 1, 0).getDate();

/** `start` + k units, keeping the local wall-clock time for days/weeks/months (DST-safe). */
function addUnits(start: Date, unit: IntervalUnit, k: number): Date {
  const ms = UNIT_MS[unit];
  if (ms) return new Date(start.getTime() + k * ms);
  const d = new Date(start);
  if (unit === "days") d.setDate(d.getDate() + k);
  else if (unit === "weeks") d.setDate(d.getDate() + 7 * k);
  else {
    const total = start.getMonth() + k;
    const y = start.getFullYear() + Math.floor(total / 12);
    const m = ((total % 12) + 12) % 12;
    d.setFullYear(y, m, Math.min(start.getDate(), daysInMonth(y, m)));
  }
  return d;
}

/** Rough period in ms, used to jump close to the answer before stepping. */
const approxMs = (unit: IntervalUnit) =>
  UNIT_MS[unit] ?? { days: 86_400_000, weeks: 604_800_000, months: 2_629_746_000 }[unit as "days" | "weeks" | "months"];

/** First fire time strictly after `after`, or undefined when the schedule is finished / invalid. */
export function nextFire(spec: ScheduleSpec, after: Date): Date | undefined {
  if (validateSchedule(spec)) return undefined;
  switch (spec.kind) {
    case "once": {
      const at = parseLocal(spec.at)!;
      return at.getTime() > after.getTime() ? at : undefined;
    }
    case "interval": {
      const start = parseLocal(spec.start ?? DEFAULT_INTERVAL_START)!;
      if (start.getTime() > after.getTime()) return start;
      const step = spec.every;
      let k = Math.max(0, Math.floor((after.getTime() - start.getTime()) / (approxMs(spec.unit) * step)) - 1) * step;
      let t = addUnits(start, spec.unit, k);
      while (t.getTime() <= after.getTime()) {
        k += step;
        t = addUnits(start, spec.unit, k);
      }
      return t;
    }
    case "cron": {
      const job = new Cron(spec.expr.trim(), { timezone: spec.timezone?.trim() || undefined, paused: true });
      return job.nextRun(after) ?? undefined;
    }
  }
}

/** The next `n` fire times after `from`. */
export function upcoming(spec: ScheduleSpec, from: Date, n: number): Date[] {
  const out: Date[] = [];
  let t: Date | undefined = from;
  while (out.length < n && (t = nextFire(spec, t))) out.push(t);
  return out;
}

/** Problem with a schedule, or undefined when valid. */
export function validateSchedule(spec: ScheduleSpec | undefined): string | undefined {
  if (!spec) return "Missing schedule";
  switch (spec.kind) {
    case "once":
      return parseLocal(spec.at) ? undefined : "Enter a valid date and time";
    case "interval": {
      if (!INTERVAL_UNITS.includes(spec.unit)) return `Unknown interval unit "${spec.unit}"`;
      if (!Number.isInteger(spec.every) || spec.every < 1) return "\"Every\" must be a whole number ≥ 1";
      if (spec.start && !parseLocal(spec.start)) return "Enter a valid start date and time";
      if ((UNIT_MS[spec.unit] ?? Infinity) * spec.every < MIN_INTERVAL_MS) return "Interval must be at least 10 seconds";
      return undefined;
    }
    case "cron": {
      const tz = spec.timezone?.trim();
      if (tz) {
        try {
          new Intl.DateTimeFormat("en-US", { timeZone: tz });
        } catch {
          return `Unknown timezone "${tz}"`;
        }
      }
      try {
        new Cron(spec.expr.trim(), { timezone: tz || undefined, paused: true });
        return undefined;
      } catch (e) {
        return `Invalid cron expression: ${(e as Error).message}`;
      }
    }
    default:
      return "Unknown schedule kind";
  }
}

export function describeSchedule(spec: ScheduleSpec | undefined): string {
  if (!spec) return "No schedule";
  switch (spec.kind) {
    case "once": {
      const at = parseLocal(spec.at);
      return `Once at ${at ? at.toLocaleString() : spec.at}`;
    }
    case "interval": {
      const unit = spec.every === 1 ? spec.unit.replace(/s$/, "") : spec.unit;
      return spec.every === 1 ? `Every ${unit}` : `Every ${spec.every} ${unit}`;
    }
    case "cron":
      return `Cron ${spec.expr.trim()}${spec.timezone?.trim() ? ` (${spec.timezone.trim()})` : ""}`;
  }
}
