import { describe, expect, it } from "vitest";
import { describeSchedule, nextFire, upcoming, validateSchedule } from "../shared/schedule";

/** Local wall-clock date (tests stay timezone-independent). */
const L = (y: number, mo: number, d: number, h = 0, mi = 0, s = 0) => new Date(y, mo - 1, d, h, mi, s);

describe("schedule: once", () => {
  it("fires once at the given local time, never again", () => {
    const spec = { kind: "once" as const, at: "2026-10-01T09:00" };
    expect(nextFire(spec, L(2026, 9, 30))?.getTime()).toBe(L(2026, 10, 1, 9).getTime());
    expect(nextFire(spec, L(2026, 10, 1, 9))).toBeUndefined();
  });
});

describe("schedule: interval", () => {
  it("counts from the start in seconds / minutes / hours", () => {
    const start = "2026-01-05T00:00";
    expect(nextFire({ kind: "interval", every: 15, unit: "minutes", start }, L(2026, 3, 3, 10, 7))?.getTime()).toBe(
      L(2026, 3, 3, 10, 15).getTime(),
    );
    expect(nextFire({ kind: "interval", every: 30, unit: "seconds", start }, L(2026, 3, 3, 10, 7, 30))?.getTime()).toBe(
      L(2026, 3, 3, 10, 8, 0).getTime(),
    );
    expect(nextFire({ kind: "interval", every: 6, unit: "hours", start }, L(2026, 3, 3, 13))?.getTime()).toBe(
      L(2026, 3, 3, 18).getTime(),
    );
  });

  it("keeps wall-clock time for days and weeks", () => {
    const start = "2026-01-05T09:30"; // a Monday
    expect(nextFire({ kind: "interval", every: 1, unit: "days", start }, L(2026, 7, 14, 10))?.getTime()).toBe(
      L(2026, 7, 15, 9, 30).getTime(),
    );
    expect(nextFire({ kind: "interval", every: 2, unit: "weeks", start }, L(2026, 1, 6))?.getTime()).toBe(
      L(2026, 1, 19, 9, 30).getTime(),
    );
  });

  it("adds months, clamping to the last day of short months", () => {
    const start = "2026-01-31T08:00";
    const got = upcoming({ kind: "interval", every: 1, unit: "months", start }, L(2026, 1, 31, 9), 3).map((d) => d.getTime());
    expect(got).toEqual([L(2026, 2, 28, 8), L(2026, 3, 31, 8), L(2026, 4, 30, 8)].map((d) => d.getTime()));
  });

  it("before the start, the first fire is the start itself", () => {
    expect(nextFire({ kind: "interval", every: 1, unit: "days", start: "2027-01-01T00:00" }, L(2026, 1, 1))?.getTime()).toBe(
      L(2027, 1, 1).getTime(),
    );
  });
});

describe("schedule: cron", () => {
  it("supports seconds, weekdays and timezones", () => {
    const spec = { kind: "cron" as const, expr: "0 30 9 * * 1-5", timezone: "UTC" };
    // Sat 2026-10-03 → next weekday 09:30 UTC is Mon 2026-10-05
    expect(nextFire(spec, new Date("2026-10-03T12:00:00Z"))?.toISOString()).toBe("2026-10-05T09:30:00.000Z");
  });
  it("supports 5-field cron and complex rules (last Friday of the month)", () => {
    expect(nextFire({ kind: "cron", expr: "0 12 * * 5L", timezone: "UTC" }, new Date("2026-10-01T00:00:00Z"))?.toISOString()).toBe(
      "2026-10-30T12:00:00.000Z",
    );
  });
});

describe("schedule: validation and description", () => {
  it("rejects bad specs", () => {
    expect(validateSchedule({ kind: "cron", expr: "not a cron" })).toMatch(/cron/i);
    expect(validateSchedule({ kind: "cron", expr: "* * * * *", timezone: "Mars/Olympus" })).toMatch(/timezone/i);
    expect(validateSchedule({ kind: "once", at: "yesterday-ish" })).toMatch(/date/i);
    expect(validateSchedule({ kind: "interval", every: 0, unit: "minutes" })).toMatch(/every/i);
    expect(validateSchedule({ kind: "interval", every: 5, unit: "fortnights" as never })).toMatch(/unit/i);
    expect(validateSchedule({ kind: "interval", every: 1, unit: "seconds" })).toMatch(/at least/i);
    expect(validateSchedule({ kind: "cron", expr: "0 9 * * 1-5" })).toBeUndefined();
  });
  it("describes specs for humans", () => {
    expect(describeSchedule({ kind: "interval", every: 1, unit: "hours" })).toBe("Every hour");
    expect(describeSchedule({ kind: "interval", every: 3, unit: "days" })).toBe("Every 3 days");
    expect(describeSchedule({ kind: "cron", expr: "0 9 * * 1-5", timezone: "UTC" })).toBe("Cron 0 9 * * 1-5 (UTC)");
    expect(describeSchedule({ kind: "once", at: "2026-10-01T09:00" })).toContain("Once");
  });
});
