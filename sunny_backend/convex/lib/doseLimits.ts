import { DAY_MS, HOUR_MS } from "./time";

const DAY_WINDOW_MS = DAY_MS;

export interface DoseLimits {
  maxPerDay: number | null;
  minHoursBetween: number | null;
}

interface LocalDay {
  start: number;
  end: number;
}

export type DayOf = (instant: number) => LocalDay;

interface DoseStatus {
  takenToday: number[];
  takenLast24h: number[];
  lastTakenAt: number | null;
  remainingToday: number | null;
  nextWithinLabelAt: number | null;
}

export interface LimitBreaches {
  overDailyMax: boolean;
  tooSoon: boolean;
  count: number;
}

function between(doses: readonly number[], from: number, to: number): number[] {
  return doses.filter((d) => d > from && d <= to).sort((a, b) => a - b);
}

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

export function limitBreaches(
  limits: DoseLimits,
  otherDoses: readonly number[],
  takenAt: number,
  dayOf: DayOf,
): LimitBreaches {
  const all = [...otherDoses, takenAt];
  const day = dayOf(takenAt);
  const dayCount = all.filter((d) => d >= day.start && d < day.end).length;
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

export function daysUsed(
  doses: readonly number[],
  dayOf: DayOf,
  now: number,
  days: number,
): number {
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
