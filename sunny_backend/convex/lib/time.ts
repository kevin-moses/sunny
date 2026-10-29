// lib/time.ts
// Purpose: Household-local date and time math, replacing Postgres's
// `timestamp at time zone` and date arithmetic. Instants are epoch ms; local dates are
// "YYYY-MM-DD", local times "HH:MM"; weekdays are ISO (1 = Monday). Uses Intl only, no
// dependency. Local times that do not exist (the spring-forward gap) resolve with the
// offset in effect before the change (2:30 becomes 3:30 daylight time), and repeated
// times (fall-back) resolve to the later, standard-time instant, matching Postgres.
//
// Zone names are validated and canonicalized through canonicalTimezone.
//
// Last modified: 2026-10-28

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;
const PROBE_MS = 26 * 3_600_000;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

const formatters = new Map<string, Intl.DateTimeFormat>();

/**
 * purpose: A cached formatter that splits an instant into wall-clock parts in a zone.
 * @param timezone: (string) IANA zone.
 * @return: (Intl.DateTimeFormat) Formatter with numeric, 24-hour parts.
 */
function formatter(timezone: string): Intl.DateTimeFormat {
  let f = formatters.get(timezone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(timezone, f);
  }
  return f;
}

/** Wall-clock fields of an instant in a zone. */
interface WallClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

/**
 * purpose: Wall-clock fields of an instant in a zone.
 * @param instant: (number) Epoch ms.
 * @param timezone: (string) IANA zone.
 * @return: (WallClock) Local year, month, day, hour, minute, second.
 */
function wallClock(instant: number, timezone: string): WallClock {
  const parts: Record<string, number> = {};
  for (const p of formatter(timezone).formatToParts(new Date(instant))) {
    if (p.type !== "literal") parts[p.type] = Number(p.value);
  }
  return {
    year: parts.year!,
    month: parts.month!,
    day: parts.day!,
    hour: parts.hour!,
    minute: parts.minute!,
    second: parts.second!,
  };
}

/**
 * purpose: The zone's UTC offset at an instant.
 * @param instant: (number) Epoch ms.
 * @param timezone: (string) IANA zone.
 * @return: (number) Offset in ms (negative west of UTC).
 */
function offsetAt(instant: number, timezone: string): number {
  const w = wallClock(instant, timezone);
  const asUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
  return asUtc - Math.floor(instant / 1000) * 1000;
}

/**
 * purpose: True for an IANA region zone ("America/New_York") the runtime knows.
 *          Abbreviations and POSIX strings ("EST", "PST8PDT") are rejected because they
 *          do not follow local DST rules.
 * @param timezone: (string) Candidate zone.
 * @return: (boolean) Whether it is usable as a household timezone.
 */
export function isValidTimezone(timezone: string): boolean {
  return canonicalTimezone(timezone) !== null;
}

/**
 * purpose: Intl's canonical spelling of a region zone, so "america/new_york" is stored as
 *          "America/New_York". Same validity rules as isValidTimezone.
 * @param timezone: (string) Candidate zone.
 * @return: (string | null) Canonical zone name, or null when not a usable region zone.
 */
export function canonicalTimezone(timezone: string): string | null {
  if (!timezone.includes("/")) return null;
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: timezone }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
}

/**
 * purpose: Parse a local date.
 * @param date: (string) "YYYY-MM-DD".
 * @return: ([number, number, number]) Year, month (1-12), day.
 * @raises Error when malformed or not a real calendar date.
 */
function parseDate(date: string): [number, number, number] {
  const m = DATE_RE.exec(date);
  if (!m) throw new Error(`Bad date ${date}`);
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const check = new Date(Date.UTC(y, mo - 1, d));
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) {
    throw new Error(`Bad date ${date}`);
  }
  return [y, mo, d];
}

/**
 * purpose: Parse a local time.
 * @param time: (string) "HH:MM", 24-hour.
 * @return: ([number, number]) Hour and minute.
 * @raises Error when malformed.
 */
function parseTime(time: string): [number, number] {
  const m = TIME_RE.exec(time);
  if (!m) throw new Error(`Bad time ${time}`);
  return [Number(m[1]), Number(m[2])];
}

/**
 * purpose: True when the string is a real "YYYY-MM-DD" date.
 * @param date: (string) Candidate.
 * @return: (boolean) Whether it parses.
 */
export function isLocalDate(date: string): boolean {
  try {
    parseDate(date);
    return true;
  } catch {
    return false;
  }
}

/**
 * purpose: True when the string is a 24-hour "HH:MM" time.
 * @param time: (string) Candidate.
 * @return: (boolean) Whether it parses.
 */
export function isLocalTime(time: string): boolean {
  return TIME_RE.test(time);
}

/**
 * purpose: The instant a household-local date and time happen.
 * @param date: (string) Local "YYYY-MM-DD".
 * @param time: (string) Local "HH:MM".
 * @param timezone: (string) IANA zone.
 * @return: (number) Epoch ms. Gap times use the offset before the change; repeated times
 *          use the later (standard-time) instant.
 */
export function zonedInstant(date: string, time: string, timezone: string): number {
  const [y, mo, d] = parseDate(date);
  const [h, mi] = parseTime(time);
  const wall = Date.UTC(y, mo - 1, d, h, mi);
  // Offsets well before and after any transition near this wall time. Offsets span
  // -12h..+14h, so probing the wall time (read as UTC) by +/-26h always lands on the far
  // side of a transition whose instant is within a day of the wall time.
  const before = offsetAt(wall - PROBE_MS, timezone);
  const after = offsetAt(wall + PROBE_MS, timezone);
  const roundTrips = (t: number) => offsetAt(t, timezone) === wall - t;
  if (roundTrips(wall - after)) return wall - after;
  if (roundTrips(wall - before)) return wall - before;
  return wall - before;
}

/**
 * purpose: Household-local date of an instant.
 * @param instant: (number) Epoch ms.
 * @param timezone: (string) IANA zone.
 * @return: (string) "YYYY-MM-DD".
 */
export function localDate(instant: number, timezone: string): string {
  const w = wallClock(instant, timezone);
  return `${w.year}-${pad(w.month)}-${pad(w.day)}`;
}

/**
 * purpose: Household-local time of an instant, to the minute.
 * @param instant: (number) Epoch ms.
 * @param timezone: (string) IANA zone.
 * @return: (string) "HH:MM".
 */
export function localTime(instant: number, timezone: string): string {
  const w = wallClock(instant, timezone);
  return `${pad(w.hour)}:${pad(w.minute)}`;
}

/**
 * purpose: Household-local date and time of an instant, ISO style without an offset.
 * @param instant: (number) Epoch ms.
 * @param timezone: (string) IANA zone.
 * @return: (string) "YYYY-MM-DDTHH:MM:SS".
 */
export function localDateTime(instant: number, timezone: string): string {
  const w = wallClock(instant, timezone);
  return `${w.year}-${pad(w.month)}-${pad(w.day)}T${pad(w.hour)}:${pad(w.minute)}:${pad(w.second)}`;
}

/**
 * purpose: Midnight at the start of the instant's local day.
 * @param instant: (number) Epoch ms.
 * @param timezone: (string) IANA zone.
 * @return: (number) Epoch ms of local 00:00 that day.
 */
export function localMidnight(instant: number, timezone: string): number {
  return zonedInstant(localDate(instant, timezone), "00:00", timezone);
}

/**
 * purpose: Add days to a local date.
 * @param date: (string) "YYYY-MM-DD".
 * @param days: (number) Days to add (may be negative).
 * @return: (string) The resulting "YYYY-MM-DD".
 */
export function addDays(date: string, days: number): string {
  const [y, mo, d] = parseDate(date);
  return new Date(Date.UTC(y, mo - 1, d + days)).toISOString().slice(0, 10);
}

/**
 * purpose: Whole days from one local date to another.
 * @param from: (string) "YYYY-MM-DD".
 * @param to: (string) "YYYY-MM-DD".
 * @return: (number) to - from in days.
 */
export function daysBetween(from: string, to: string): number {
  const [y1, m1, d1] = parseDate(from);
  const [y2, m2, d2] = parseDate(to);
  return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / DAY_MS);
}

/**
 * purpose: ISO weekday of a local date.
 * @param date: (string) "YYYY-MM-DD".
 * @return: (number) 1 = Monday ... 7 = Sunday.
 */
export function isoWeekday(date: string): number {
  const [y, mo, d] = parseDate(date);
  const js = new Date(Date.UTC(y, mo - 1, d)).getUTCDay();
  return js === 0 ? 7 : js;
}

/**
 * purpose: Minutes as ms, for window and offset arithmetic.
 * @param count: (number) Minutes.
 * @return: (number) Milliseconds.
 */
export function minutes(count: number): number {
  return count * MINUTE_MS;
}

/**
 * purpose: "morning" (5-12), "afternoon" (12-17), "evening" (17-21) or "night".
 * @param time: (string) Local "HH:MM".
 * @return: (string) Part of day.
 */
export function partOfDay(time: string): "morning" | "afternoon" | "evening" | "night" {
  if (time >= "05:00" && time < "12:00") return "morning";
  if (time >= "12:00" && time < "17:00") return "afternoon";
  if (time >= "17:00" && time < "21:00") return "evening";
  return "night";
}

/**
 * purpose: "8:00 AM" style time for notification text.
 * @param time: (string) Local "HH:MM".
 * @return: (string) 12-hour time with AM or PM.
 */
export function formatTime12(time: string): string {
  const [h, m] = parseTime(time);
  return `${h % 12 === 0 ? 12 : h % 12}:${pad(m)} ${h < 12 ? "AM" : "PM"}`;
}

const WEEKDAY_NAMES = [
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
  "Sunday",
];
const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

/**
 * purpose: English weekday name of a local date.
 * @param date: (string) "YYYY-MM-DD".
 * @return: (string) e.g. "Thursday".
 */
export function weekdayName(date: string): string {
  return WEEKDAY_NAMES[isoWeekday(date) - 1]!;
}

/**
 * purpose: "October 29" style label of a local date.
 * @param date: (string) "YYYY-MM-DD".
 * @return: (string) Month name and day of month.
 */
export function dateLabel(date: string): string {
  const [, mo, d] = parseDate(date);
  return `${MONTH_NAMES[mo - 1]} ${d}`;
}

/**
 * purpose: Zero-pad to two digits.
 * @param n: (number) Value.
 * @return: (string) Two-digit string.
 */
function pad(n: number): string {
  return String(n).padStart(2, "0");
}
