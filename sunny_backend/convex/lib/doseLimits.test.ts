// lib/doseLimits.test.ts
// Purpose: Unit tests for the as-needed label arithmetic (lib/doseLimits.ts): doses counted in
// the local day only, the hours-apart rule across midnight, the next time a dose is within the
// label (later of the gap and the next midnight once the day's maximum is reached, null when it
// already is or no limit is on file), and which limits a new dose breaks.
//
// Last modified: 2026-11-09

import { describe, expect, test } from "vitest";
import { doseStatus, limitBreaches } from "./doseLimits";

const HOUR = 3_600_000;
/** A local day from 0 to 24 h (the arithmetic does not care about the zone). */
const DAY = { start: 0, end: 24 * HOUR };

describe("doseStatus", () => {
  test("the spec example: 3 a day, 6 hours apart, one at 11, asked at 2", () => {
    const status = doseStatus({ maxPerDay: 3, minHoursBetween: 6 }, [11 * HOUR], DAY, 14 * HOUR);
    expect(status).toEqual({
      takenToday: [11 * HOUR],
      lastTakenAt: 11 * HOUR,
      remainingToday: 2,
      nextWithinLabelAt: 17 * HOUR,
    });
  });

  test("a dose before midnight counts for the gap but not for today", () => {
    const status = doseStatus({ maxPerDay: 2, minHoursBetween: 8 }, [-2 * HOUR], DAY, 3 * HOUR);
    expect(status).toEqual({
      takenToday: [],
      lastTakenAt: -2 * HOUR,
      remainingToday: 2,
      nextWithinLabelAt: 6 * HOUR,
    });
  });

  test("once the day's maximum is reached the next is the next local midnight", () => {
    const status = doseStatus(
      { maxPerDay: 2, minHoursBetween: 1 },
      [HOUR, 3 * HOUR],
      DAY,
      5 * HOUR,
    );
    expect(status.remainingToday).toBe(0);
    expect(status.nextWithinLabelAt).toBe(DAY.end);
  });

  test("null when already within the label or when no limit is on file", () => {
    expect(
      doseStatus({ maxPerDay: 3, minHoursBetween: 4 }, [HOUR], DAY, 6 * HOUR).nextWithinLabelAt,
    ).toBeNull();
    expect(
      doseStatus({ maxPerDay: null, minHoursBetween: null }, [HOUR, 2 * HOUR], DAY, 3 * HOUR),
    ).toEqual({
      takenToday: [HOUR, 2 * HOUR],
      lastTakenAt: 2 * HOUR,
      remainingToday: null,
      nextWithinLabelAt: null,
    });
  });

  test("doses are sorted and future ones are ignored", () => {
    const status = doseStatus(
      { maxPerDay: 5, minHoursBetween: null },
      [9 * HOUR, 2 * HOUR, 20 * HOUR],
      DAY,
      10 * HOUR,
    );
    expect(status.takenToday).toEqual([2 * HOUR, 9 * HOUR]);
    expect(status.lastTakenAt).toBe(9 * HOUR);
  });
});

describe("limitBreaches", () => {
  test("within the label breaks nothing", () => {
    expect(limitBreaches({ maxPerDay: 3, minHoursBetween: 6 }, [HOUR], 8 * HOUR, DAY)).toEqual({
      overDailyMax: false,
      tooSoon: false,
    });
  });

  test("one more than the daily maximum is over; exactly the maximum is not", () => {
    const limits = { maxPerDay: 2, minHoursBetween: null };
    expect(limitBreaches(limits, [HOUR], 5 * HOUR, DAY).overDailyMax).toBe(false);
    expect(limitBreaches(limits, [HOUR, 2 * HOUR], 5 * HOUR, DAY).overDailyMax).toBe(true);
  });

  test("doses of another day do not count toward the maximum", () => {
    const limits = { maxPerDay: 1, minHoursBetween: null };
    expect(limitBreaches(limits, [-3 * HOUR], 5 * HOUR, DAY).overDailyMax).toBe(false);
    expect(limitBreaches(limits, [HOUR], -HOUR, DAY).overDailyMax).toBe(false);
  });

  test("too soon before or after another dose, across midnight too", () => {
    const limits = { maxPerDay: null, minHoursBetween: 4 };
    expect(limitBreaches(limits, [-HOUR], 2 * HOUR, DAY).tooSoon).toBe(true);
    expect(limitBreaches(limits, [6 * HOUR], 3 * HOUR, DAY).tooSoon).toBe(true);
    expect(limitBreaches(limits, [HOUR], 5 * HOUR, DAY).tooSoon).toBe(false);
  });
});
