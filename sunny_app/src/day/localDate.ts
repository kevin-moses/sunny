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

const ZONED_FORMATS = {
  clock: {
    locale: 'en-US',
    options: { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' },
    fields: ['hour', 'minute'],
    separator: ':',
    shape: /^\d{2}:\d{2}$/,
  },
  date: {
    locale: 'en-CA',
    options: { year: 'numeric', month: '2-digit', day: '2-digit' },
    fields: ['year', 'month', 'day'],
    separator: '-',
    shape: /^\d{4}-\d{2}-\d{2}$/,
  },
} as const;

const formatters = new Map<string, Intl.DateTimeFormat>();

function zonedText(kind: keyof typeof ZONED_FORMATS, timezone: string, at: number): string | null {
  const format = ZONED_FORMATS[kind];
  const key = `${kind} ${timezone}`;
  try {
    let formatter = formatters.get(key);
    if (formatter === undefined) {
      formatter = new Intl.DateTimeFormat(format.locale, { ...format.options, timeZone: timezone });
      formatters.set(key, formatter);
    }
    const parts = formatter.formatToParts(new Date(at));
    const text = format.fields
      .map((type) => parts.find((part) => part.type === type)?.value ?? '')
      .join(format.separator);
    return format.shape.test(text) ? text : null;
  } catch {
    return null;
  }
}

export function localClockTime(timezone: string, at: number): string | null {
  return zonedText('clock', timezone, at);
}

export function currentLocalDate(timezone: string, now: number): string | null {
  return zonedText('date', timezone, now);
}
