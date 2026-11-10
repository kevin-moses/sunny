// lib/doseLimits.test.ts
// Purpose: Unit tests for the as-needed label arithmetic (lib/doseLimits.ts): the maximum
// applied to both the trailing 24 hours and the local calendar day (the stricter wins), the
// hours-apart rule across midnight, the next time a dose is within the label (including the
// 12:05 AM case after an evening at the maximum), judging a back-dated dose by its own day and
// the 24 hours around it, and the count of days used in the last week. Local days here are
// fixed 24-hour blocks from 0 (the arithmetic only needs a day-of function).
//
// Last modified: 2026-11-09

import { describe, expect, test } from "vitest";
import { daysUsed, doseStatus, limitBreaches } from "./doseLimits";
import type { DayOf } from "./doseLimits";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** Local days are [n * 24h, (n + 1) * 24h). */
const dayOf: DayOf = (t) => {
  const start = Math.floor(t / DAY) * DAY;
  return { start, end: start + DAY };
};

describe("doseStatus", () => {
  test("the spec example: 3 a day, 6 hours apart, one at 11, asked at 2", () => {
    const status = doseStatus({ maxPerDay: 3, minHoursBetween: 6 }, [11 * HOUR], dayOf, 14 * HOUR);
    expect(status).toEqual({
      takenToday: [11 * HOUR],
      takenLast24h: [11 * HOUR],
      lastTakenAt: 11 * HOUR,
      remainingToday: 2,
      nextWithinLabelAt: 17 * HOUR,
    });
  });

  test("after four evening doses, 12:05 AM is not within a 4-in-24-hours label", () => {
    const evening = [18 * HOUR, 20 * HOUR, 22 * HOUR, 23 * HOUR];
    const now = DAY + 5 * 60_000;
    const status = doseStatus({ maxPerDay: 4, minHoursBetween: 1 }, evening, dayOf, now);
    expect(status.takenToday).toEqual([]);
    expect(status.takenLast24h).toEqual(evening);
    expect(status.remainingToday).toBe(0);
    // The first of the four leaves the trailing 24 hours at 6 PM the next day.
    expect(status.nextWithinLabelAt).toBe(DAY + 18 * HOUR);
  });

  test("the calendar day also limits: the later of midnight and the 24-hour window", () => {
    const status = doseStatus(
      { maxPerDay: 2, minHoursBetween: null },
      [HOUR, 3 * HOUR],
      dayOf,
      5 * HOUR,
    );
    expect(status.remainingToday).toBe(0);
    expect(status.nextWithinLabelAt).toBe(DAY + HOUR);
  });

  test("a dose before midnight counts for the gap and the 24 hours, not for today", () => {
    const status = doseStatus({ maxPerDay: 2, minHoursBetween: 8 }, [-2 * HOUR], dayOf, 3 * HOUR);
    expect(status).toMatchObject({
      takenToday: [],
      takenLast24h: [-2 * HOUR],
      remainingToday: 1,
      nextWithinLabelAt: 6 * HOUR,
    });
  });

  test("null when already within the label or when no limit is on file", () => {
    expect(
      doseStatus({ maxPerDay: 3, minHoursBetween: 4 }, [HOUR], dayOf, 6 * HOUR).nextWithinLabelAt,
    ).toBeNull();
    expect(
      doseStatus({ maxPerDay: null, minHoursBetween: null }, [HOUR, 2 * HOUR], dayOf, 3 * HOUR),
    ).toMatchObject({ remainingToday: null, nextWithinLabelAt: null });
  });

  test("a dose exactly 24 hours old has left the window", () => {
    const status = doseStatus({ maxPerDay: 1, minHoursBetween: null }, [0], dayOf, DAY);
    expect(status.takenLast24h).toEqual([]);
    expect(status.nextWithinLabelAt).toBeNull();
  });

  test("doses are sorted and future ones are ignored", () => {
    const status = doseStatus(
      { maxPerDay: 5, minHoursBetween: null },
      [9 * HOUR, 2 * HOUR, 20 * HOUR],
      dayOf,
      10 * HOUR,
    );
    expect(status.takenToday).toEqual([2 * HOUR, 9 * HOUR]);
    expect(status.lastTakenAt).toBe(9 * HOUR);
  });
});

describe("limitBreaches", () => {
  test("within the label breaks nothing", () => {
    expect(limitBreaches({ maxPerDay: 3, minHoursBetween: 6 }, [HOUR], 8 * HOUR, dayOf)).toEqual({
      overDailyMax: false,
      tooSoon: false,
      count: 2,
    });
  });

  test("one more than the maximum is over; exactly the maximum is not", () => {
    const limits = { maxPerDay: 2, minHoursBetween: null };
    expect(limitBreaches(limits, [HOUR], 5 * HOUR, dayOf).overDailyMax).toBe(false);
    expect(limitBreaches(limits, [HOUR, 2 * HOUR], 5 * HOUR, dayOf)).toMatchObject({
      overDailyMax: true,
      count: 3,
    });
  });

  test("doses before midnight count within 24 hours", () => {
    const limits = { maxPerDay: 2, minHoursBetween: null };
    expect(limitBreaches(limits, [-2 * HOUR, HOUR], 3 * HOUR, dayOf)).toMatchObject({
      overDailyMax: true,
      count: 3,
    });
    expect(limitBreaches(limits, [-22 * HOUR], 3 * HOUR, dayOf).overDailyMax).toBe(false);
  });

  test("a back-dated dose is judged against its own day", () => {
    // Said at 00:30 on day 1: "I took one an hour ago" (23:30 on day 0).
    const limits = { maxPerDay: 3, minHoursBetween: null };
    const result = limitBreaches(limits, [20 * HOUR, 21 * HOUR, 22 * HOUR], 23.5 * HOUR, dayOf);
    expect(result).toMatchObject({ overDailyMax: true, count: 4 });
  });

  test("a back-dated dose also counts in windows ending at later doses", () => {
    const limits = { maxPerDay: 2, minHoursBetween: null };
    expect(limitBreaches(limits, [6 * HOUR, 7 * HOUR], 5 * HOUR, dayOf).overDailyMax).toBe(true);
  });

  test("too soon before or after another dose, across midnight too", () => {
    const limits = { maxPerDay: null, minHoursBetween: 4 };
    expect(limitBreaches(limits, [-HOUR], 2 * HOUR, dayOf).tooSoon).toBe(true);
    expect(limitBreaches(limits, [6 * HOUR], 3 * HOUR, dayOf).tooSoon).toBe(true);
    expect(limitBreaches(limits, [HOUR], 5 * HOUR, dayOf).tooSoon).toBe(false);
  });
});

describe("daysUsed", () => {
  test("counts distinct local days with a dose in the last 7, today included", () => {
    const now = 6 * DAY + 12 * HOUR;
    const doses = [-HOUR, 1 * HOUR, 3 * HOUR, DAY + HOUR, 3 * DAY, 6 * DAY + HOUR];
    // Day -1 is outside; days 0, 1, 3 and 6 count.
    expect(daysUsed(doses, dayOf, now, 7)).toBe(4);
    expect(daysUsed(doses, dayOf, now, 1)).toBe(1);
  });
});
