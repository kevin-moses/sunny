export const MINUTE_MS = 60_000;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;
const MAX_UTC_OFFSET_HOURS = 14;
const MIN_UTC_OFFSET_HOURS = -12;
const PROBE_MS = (MAX_UTC_OFFSET_HOURS - MIN_UTC_OFFSET_HOURS) * HOUR_MS;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

const formatters = new Map<string, Intl.DateTimeFormat>();

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

interface WallClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

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

export function offsetAt(instant: number, timezone: string): number {
  const w = wallClock(instant, timezone);
  const asUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
  return asUtc - Math.floor(instant / 1000) * 1000;
}

function firstInstantWithNewOffset(from: number, to: number, timezone: string): number {
  const old = offsetAt(from, timezone);
  let before = from;
  let after = to;
  while (after - before > 1) {
    const mid = Math.floor((before + after) / 2);
    if (offsetAt(mid, timezone) === old) before = mid;
    else after = mid;
  }
  return after;
}

export function offsetChanges(from: number, until: number, timezone: string): number[] {
  const changes: number[] = [];
  let start = from;
  let offset = offsetAt(start, timezone);
  while (start < until) {
    const end = Math.min(start + HOUR_MS, until);
    const next = offsetAt(end, timezone);
    if (next !== offset) changes.push(firstInstantWithNewOffset(start, end, timezone));
    start = end;
    offset = next;
  }
  return changes;
}

export function isValidTimezone(timezone: string): boolean {
  return canonicalTimezone(timezone) !== null;
}

export function canonicalTimezone(timezone: string): string | null {
  if (!timezone.includes("/")) return null;
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: timezone }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
}

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

function parseTime(time: string): [number, number] {
  const m = TIME_RE.exec(time);
  if (!m) throw new Error(`Bad time ${time}`);
  return [Number(m[1]), Number(m[2])];
}

export function isLocalDate(date: string): boolean {
  try {
    parseDate(date);
    return true;
  } catch {
    return false;
  }
}

export function isLocalTime(time: string): boolean {
  return TIME_RE.test(time);
}

export function wallClockMs(date: string, time: string): number {
  const [y, mo, d] = parseDate(date);
  const [h, mi] = parseTime(time);
  return Date.UTC(y, mo - 1, d, h, mi);
}

export function zonedInstant(date: string, time: string, timezone: string): number {
  const wall = wallClockMs(date, time);
  const before = offsetAt(wall - PROBE_MS, timezone);
  const after = offsetAt(wall + PROBE_MS, timezone);
  const roundTrips = (t: number): boolean => offsetAt(t, timezone) === wall - t;
  if (roundTrips(wall - after)) return wall - after;
  if (roundTrips(wall - before)) return wall - before;
  return wall - before;
}

export function localDate(instant: number, timezone: string): string {
  const w = wallClock(instant, timezone);
  return `${w.year}-${pad(w.month)}-${pad(w.day)}`;
}

export function localTime(instant: number, timezone: string): string {
  const w = wallClock(instant, timezone);
  return `${pad(w.hour)}:${pad(w.minute)}`;
}

export function localDateTime(instant: number, timezone: string): string {
  const w = wallClock(instant, timezone);
  return `${w.year}-${pad(w.month)}-${pad(w.day)}T${pad(w.hour)}:${pad(w.minute)}:${pad(w.second)}`;
}

export function localMidnight(instant: number, timezone: string): number {
  return zonedInstant(localDate(instant, timezone), "00:00", timezone);
}

export function dayRange(date: string, timezone: string): { start: number; end: number } {
  return {
    start: zonedInstant(date, "00:00", timezone),
    end: zonedInstant(addDays(date, 1), "00:00", timezone),
  };
}

export function addDays(date: string, days: number): string {
  const [y, mo, d] = parseDate(date);
  return new Date(Date.UTC(y, mo - 1, d + days)).toISOString().slice(0, 10);
}

export function daysBetween(from: string, to: string): number {
  const [y1, m1, d1] = parseDate(from);
  const [y2, m2, d2] = parseDate(to);
  return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / DAY_MS);
}

export function isoWeekday(date: string): number {
  const [y, mo, d] = parseDate(date);
  const js = new Date(Date.UTC(y, mo - 1, d)).getUTCDay();
  return js === 0 ? 7 : js;
}

export function minutes(count: number): number {
  return count * MINUTE_MS;
}

export function partOfDay(time: string): "morning" | "afternoon" | "evening" | "night" {
  if (time >= "05:00" && time < "12:00") return "morning";
  if (time >= "12:00" && time < "17:00") return "afternoon";
  if (time >= "17:00" && time < "21:00") return "evening";
  return "night";
}

export function formatTime12(time: string): string {
  const [h, m] = parseTime(time);
  return `${h % 12 === 0 ? 12 : h % 12}:${pad(m)} ${h < 12 ? "AM" : "PM"}`;
}

export const WEEKDAY_NAMES = [
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
  "Sunday",
];

export const WEEKDAY_CODES = WEEKDAY_NAMES.map((name) => name.slice(0, 3).toLowerCase());

export function weekdayCodes(days: readonly number[] | null | undefined): string[] | null {
  return days ? days.map((d) => WEEKDAY_CODES[d - 1]!) : null;
}
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

export function weekdayName(date: string): string {
  return WEEKDAY_NAMES[isoWeekday(date) - 1]!;
}

export function dateLabel(date: string): string {
  const [, mo, d] = parseDate(date);
  return `${MONTH_NAMES[mo - 1]} ${d}`;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}
