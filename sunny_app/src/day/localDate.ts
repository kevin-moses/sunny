// sunny_app/src/day/localDate.ts
//
// Purpose: Calendar arithmetic on household-local "YYYY-MM-DD" dates, shared by the senior
// day clock and the caregiver app. A date is parsed once into a UTC-midnight timestamp that is
// used purely as a day counter (no timezone conversion happens anywhere), then shifted,
// compared and named with the helpers here, and formatted back to a string only at the edge.
// Invalid input parses to null; the helpers that take a timestamp never see an invalid one.
//
// Last modified: 2026-10-31

/** Milliseconds in a day; local dates are counted as UTC midnights. */
export const MS_PER_DAY = 86_400_000;

/** Full weekday names, Sunday first (index matches Date.getUTCDay). */
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** Full month names, January first (index matches Date.getUTCMonth). */
const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

/**
 * purpose: Parse a "YYYY-MM-DD" local date into a UTC timestamp used as a day counter.
 * @param localDate: (string) Date from the backend.
 * @return: (number | null) Milliseconds at UTC midnight, or null when invalid.
 */
export function parseLocalDate(localDate: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(localDate);
  if (match === null) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const time = Date.UTC(year, month - 1, day);
  const parsed = new Date(time);
  const valid =
    parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month - 1 &&
    parsed.getUTCDate() === day;
  return valid ? time : null;
}

/**
 * purpose: Format a day counter back to a local date string.
 * @param time: (number) UTC-midnight timestamp from parseLocalDate or addDays.
 * @return: (string) "YYYY-MM-DD".
 */
export function formatLocalDate(time: number): string {
  return new Date(time).toISOString().slice(0, 10);
}

/**
 * purpose: Shift a day counter by a number of days.
 * @param time: (number) UTC-midnight timestamp.
 * @param days: (number) Days to add; may be negative.
 * @return: (number) The shifted timestamp.
 */
export function addDays(time: number, days: number): number {
  return time + days * MS_PER_DAY;
}

/**
 * purpose: Whole days from one day counter to another.
 * @param from: (number) UTC-midnight timestamp.
 * @param to: (number) UTC-midnight timestamp.
 * @return: (number) Days from `from` to `to`; negative when `to` is earlier.
 */
export function daysBetween(from: number, to: number): number {
  return Math.round((to - from) / MS_PER_DAY);
}

/**
 * purpose: Full weekday name of a day counter.
 * @param time: (number) UTC-midnight timestamp.
 * @return: (string) For example "Friday".
 */
export function weekdayName(time: number): string {
  return WEEKDAYS[new Date(time).getUTCDay()];
}

/**
 * purpose: Full month name of a day counter.
 * @param time: (number) UTC-midnight timestamp.
 * @return: (string) For example "October".
 */
export function monthName(time: number): string {
  return MONTHS[new Date(time).getUTCMonth()];
}

/**
 * purpose: Day of the month of a day counter.
 * @param time: (number) UTC-midnight timestamp.
 * @return: (number) 1 to 31.
 */
export function dayOfMonth(time: number): number {
  return new Date(time).getUTCDate();
}

/**
 * purpose: Calendar year of a day counter.
 * @param time: (number) UTC-midnight timestamp.
 * @return: (number) For example 2026.
 */
export function yearOf(time: number): number {
  return new Date(time).getUTCFullYear();
}
