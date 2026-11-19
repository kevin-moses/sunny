export const MS_PER_DAY = 86_400_000;

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

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

export function formatLocalDate(time: number): string {
  return new Date(time).toISOString().slice(0, 10);
}

export function addDays(time: number, days: number): number {
  return time + days * MS_PER_DAY;
}

export function daysBetween(from: number, to: number): number {
  return Math.round((to - from) / MS_PER_DAY);
}

export function weekdayName(time: number): string {
  return WEEKDAYS[new Date(time).getUTCDay()];
}

export function monthName(time: number): string {
  return MONTHS[new Date(time).getUTCMonth()];
}

export function dayOfMonth(time: number): number {
  return new Date(time).getUTCDate();
}

export function yearOf(time: number): number {
  return new Date(time).getUTCFullYear();
}

export function localClockTime(timezone: string, at: number): string | null {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(new Date(at));
    const get = (type: string): string => parts.find((part) => part.type === type)?.value ?? '';
    const time = `${get('hour')}:${get('minute')}`;
    return /^\d{2}:\d{2}$/.test(time) ? time : null;
  } catch {
    return null;
  }
}

export function currentLocalDate(timezone: string, now: number): string | null {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(new Date(now));
    const get = (type: string): string => parts.find((part) => part.type === type)?.value ?? '';
    const date = `${get('year')}-${get('month')}-${get('day')}`;
    return /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null;
  } catch {
    return null;
  }
}
