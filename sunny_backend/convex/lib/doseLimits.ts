// lib/doseLimits.ts
// Purpose: The label-limit arithmetic for an as-needed medication (notes/SPEC.md "A medication
// question: facts first, their decision"), kept free of database access so it is unit tested
// on its own. The voice agent reads these facts aloud and leaves the decision to the senior;
// nothing here decides whether a dose may be taken.
//
// Rules (the safest reading of a label's "up to N a day"):
// - The maximum applies to the trailing 24 hours AND to the household's local calendar day;
//   a dose is within the label only when both counts stay within it. It is spoken as "in 24
//   hours".
// - "Hours apart" is measured between any two doses, across midnight too.
// - A dose is judged by its own time (a back-dated dose against its own day and the 24 hours
//   around it): it is past the maximum when any 24-hour window containing it, or its own local
//   day, then holds more than maxPerDay doses; it is too soon when another dose is less than
//   minHoursBetween before or after it.
// - The next time a dose is within the label is the latest of: now, the last dose plus
//   minHoursBetween, the moment enough doses have left the trailing 24 hours, and, when today's
//   count is at the maximum, the next local midnight. Null when that is not in the future.
// - Days used: distinct local days with a dose among the last N local days (today included),
//   for the repeated-use check.
//
// Last modified: 2026-11-09

import { DAY_MS, HOUR_MS } from "./time";

/** The trailing window the maximum applies to. */
const DAY_WINDOW_MS = DAY_MS;

/** The limits a caregiver copied from the label; null when not on file. */
export interface DoseLimits {
  maxPerDay: number | null;
  minHoursBetween: number | null;
}

/** A household-local day as epoch ms [start, end). */
interface LocalDay {
  start: number;
  end: number;
}

/** The household-local day containing an instant. */
export type DayOf = (instant: number) => LocalDay;

/** What the agent says about one as-needed medication right now. */
interface DoseStatus {
  /** Doses taken in the local day so far, ascending epoch ms. */
  takenToday: number[];
  /** Doses taken in the trailing 24 hours, ascending epoch ms. */
  takenLast24h: number[];
  /** The latest dose at or before now; null when none. */
  lastTakenAt: number | null;
  /** Doses left under maxPerDay, by the stricter of the two counts; null without a maximum. */
  remainingToday: number | null;
  /** Earliest instant another dose is within the label; null when it already is. */
  nextWithinLabelAt: number | null;
}

/** Which limits one dose went past, and the count past the maximum. */
export interface LimitBreaches {
  overDailyMax: boolean;
  tooSoon: boolean;
  /** The largest number of doses (this one included) in its local day or in any 24 hours
   * containing it. */
  count: number;
}

/**
 * purpose: Doses in the half-open range (from, to].
 * @param doses: (readonly number[]) Dose instants.
 * @param from: (number) Start, exclusive.
 * @param to: (number) End, inclusive.
 * @return: (number[]) The doses in range, ascending.
 */
function between(doses: readonly number[], from: number, to: number): number[] {
  return doses.filter((d) => d > from && d <= to).sort((a, b) => a - b);
}

/**
 * purpose: The facts about one as-needed medication at an instant.
 * @param limits: (DoseLimits) The label limits.
 * @param doses: (number[]) Dose instants in any order, covering at least the last 24 hours.
 * @param dayOf: (DayOf) The household-local day of an instant.
 * @param now: (number) Epoch ms.
 * @return: (DoseStatus) The facts.
 */
export function doseStatus(
  limits: DoseLimits,
  doses: readonly number[],
  dayOf: DayOf,
  now: number,
): DoseStatus {
  const day = dayOf(now);
  const past = doses.filter((d) => d <= now).sort((a, b) => a - b);
  const takenToday = past.filter((d) => d >= day.start && d < day.end);
  const takenLast24h = between(past, now - DAY_WINDOW_MS, now);
  const lastTakenAt = past.at(-1) ?? null;
  const max = limits.maxPerDay;
  let next = now;
  if (limits.minHoursBetween !== null && lastTakenAt !== null) {
    next = Math.max(next, lastTakenAt + limits.minHoursBetween * HOUR_MS);
  }
  if (max !== null && takenLast24h.length >= max) {
    // Another fits once the dose max-th from the end has left the trailing 24 hours.
    next = Math.max(next, takenLast24h[takenLast24h.length - max]! + DAY_WINDOW_MS);
  }
  if (max !== null && takenToday.length >= max) next = Math.max(next, day.end);
  return {
    takenToday,
    takenLast24h,
    lastTakenAt,
    remainingToday:
      max === null ? null : Math.max(0, max - Math.max(takenToday.length, takenLast24h.length)),
    nextWithinLabelAt: next > now ? next : null,
  };
}

/**
 * purpose: Which label limits a dose goes past, judged at the dose's own time against the
 *          other doses.
 * @param limits: (DoseLimits) The label limits.
 * @param otherDoses: (number[]) Every other dose instant (not including this one).
 * @param takenAt: (number) The dose being judged, epoch ms.
 * @param dayOf: (DayOf) The household-local day of an instant.
 * @return: (LimitBreaches) overDailyMax, tooSoon and the count.
 */
export function limitBreaches(
  limits: DoseLimits,
  otherDoses: readonly number[],
  takenAt: number,
  dayOf: DayOf,
): LimitBreaches {
  const all = [...otherDoses, takenAt];
  const day = dayOf(takenAt);
  const dayCount = all.filter((d) => d >= day.start && d < day.end).length;
  // Every 24-hour window containing takenAt ends at takenAt or at a later dose within 24 h.
  const ends = all.filter((d) => d >= takenAt && d < takenAt + DAY_WINDOW_MS);
  const windowCount = Math.max(...ends.map((end) => between(all, end - DAY_WINDOW_MS, end).length));
  const count = Math.max(dayCount, windowCount);
  const minGap = limits.minHoursBetween === null ? null : limits.minHoursBetween * HOUR_MS;
  return {
    overDailyMax: limits.maxPerDay !== null && count > limits.maxPerDay,
    tooSoon: minGap !== null && otherDoses.some((d) => Math.abs(d - takenAt) < minGap),
    count,
  };
}

/**
 * purpose: Distinct local days with a dose among the last `days` local days, today included.
 * @param doses: (readonly number[]) Dose instants.
 * @param dayOf: (DayOf) The household-local day of an instant.
 * @param now: (number) Epoch ms.
 * @param days: (number) How many local days to look at.
 * @return: (number) Days with at least one dose.
 */
export function daysUsed(
  doses: readonly number[],
  dayOf: DayOf,
  now: number,
  days: number,
): number {
  // Day starts, newest first; each dose is placed by comparing numbers, not by a zone lookup.
  const starts = [dayOf(now).start];
  for (let i = 1; i < days; i++) starts.push(dayOf(starts[i - 1]! - 1).start);
  const used = new Set<number>();
  for (const d of doses) {
    if (d > now) continue;
    const start = starts.find((s) => s <= d);
    if (start !== undefined) used.add(start);
  }
  return used.size;
}
