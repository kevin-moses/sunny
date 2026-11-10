// lib/doseLimits.ts
// Purpose: The label-limit arithmetic for an as-needed medication (notes/SPEC.md "A medication
// question: facts first, their decision"), kept free of database access so it is unit tested
// on its own. The voice agent reads these facts aloud and leaves the decision to the senior;
// nothing here decides whether a dose may be taken.
//
// Rules:
// - "Per day" is the household's local calendar day (local midnight to the next local
//   midnight), the same day the digest and the agent context count doses in.
// - "Hours apart" is measured between any two doses, across midnight too.
// - A dose is past a limit when it makes the day's count exceed maxPerDay, or when another dose
//   was taken less than minHoursBetween before or after it.
// - The next time a dose is within the label is the later of the last dose plus
//   minHoursBetween and, when the day's maximum is reached, the next local midnight; null when
//   that is not in the future (a dose is within the label now) or no limit is on file.
//
// Last modified: 2026-11-09

const HOUR_MS = 3_600_000;

/** The limits a caregiver copied from the label; null when not on file. */
export interface DoseLimits {
  maxPerDay: number | null;
  minHoursBetween: number | null;
}

/** The household-local day a count is made in, as epoch ms [start, end). */
export interface LocalDay {
  start: number;
  end: number;
}

/** What the agent says about one as-needed medication right now. */
export interface DoseStatus {
  /** Doses taken in the local day so far, ascending epoch ms. */
  takenToday: number[];
  /** The latest dose at or before now (may be before local midnight); null when none. */
  lastTakenAt: number | null;
  /** Doses left today under maxPerDay; null without a daily maximum. */
  remainingToday: number | null;
  /** Earliest instant another dose is within the label; null when it already is. */
  nextWithinLabelAt: number | null;
}

/** Which limits one dose went past. */
export interface LimitBreaches {
  overDailyMax: boolean;
  tooSoon: boolean;
}

/**
 * purpose: The facts about one as-needed medication at an instant.
 * @param limits: (DoseLimits) The label limits.
 * @param doses: (number[]) Dose instants in any order, including any before local midnight
 *        that minHoursBetween can reach.
 * @param day: (LocalDay) The household-local day containing now.
 * @param now: (number) Epoch ms.
 * @return: (DoseStatus) The facts.
 */
export function doseStatus(
  limits: DoseLimits,
  doses: readonly number[],
  day: LocalDay,
  now: number,
): DoseStatus {
  const past = doses.filter((d) => d <= now).sort((a, b) => a - b);
  const takenToday = past.filter((d) => d >= day.start && d < day.end);
  const lastTakenAt = past.at(-1) ?? null;
  let next = now;
  if (limits.minHoursBetween !== null && lastTakenAt !== null) {
    next = Math.max(next, lastTakenAt + limits.minHoursBetween * HOUR_MS);
  }
  if (limits.maxPerDay !== null && takenToday.length >= limits.maxPerDay) {
    next = Math.max(next, day.end);
  }
  return {
    takenToday,
    lastTakenAt,
    remainingToday:
      limits.maxPerDay === null ? null : Math.max(0, limits.maxPerDay - takenToday.length),
    nextWithinLabelAt: next > now ? next : null,
  };
}

/**
 * purpose: Which label limits a dose goes past, judged against the other doses.
 * @param limits: (DoseLimits) The label limits.
 * @param otherDoses: (number[]) Every other dose instant (not including this one).
 * @param takenAt: (number) The dose being judged, epoch ms.
 * @param day: (LocalDay) The local day whose count maxPerDay limits; a dose outside it is not
 *        counted against the maximum.
 * @return: (LimitBreaches) overDailyMax and tooSoon.
 */
export function limitBreaches(
  limits: DoseLimits,
  otherDoses: readonly number[],
  takenAt: number,
  day: LocalDay,
): LimitBreaches {
  /**
   * purpose: Whether a dose falls in the counted local day.
   * @param d: (number) Dose instant, epoch ms.
   * @return: (boolean) True inside [day.start, day.end).
   */
  const inDay = (d: number): boolean => d >= day.start && d < day.end;
  const countInDay = otherDoses.filter(inDay).length + 1;
  const minGap = limits.minHoursBetween === null ? null : limits.minHoursBetween * HOUR_MS;
  return {
    overDailyMax: limits.maxPerDay !== null && inDay(takenAt) && countInDay > limits.maxPerDay,
    tooSoon: minGap !== null && otherDoses.some((d) => Math.abs(d - takenAt) < minGap),
  };
}
