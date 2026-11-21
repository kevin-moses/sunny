import { oneOf, sure } from "./jevConfidence";
import type { Picked } from "./jevConfidence";
import {
  MONTH_NAMES,
  WEEKDAY_NAMES,
  addDays,
  daysBetween,
  isLocalDate,
  isoWeekday,
  weekdayName,
} from "./time";

const PAST_DATE_DAYS = 180;
const DAYS_IN_WEEK = 7;
const DATE_FORMS = ["calendar_date", "today", "tomorrow", "weekday", "not_stated"] as const;
const WEEKS = ["this_week", "next_week", "unqualified"] as const;
export const NOT_STATED = "not_stated";

type Week = (typeof WEEKS)[number];

export interface Slot {
  date: string;
  time: string | null;
}

export const SLOT_PARTS = [
  "date_form",
  "month",
  "day",
  "year",
  "weekday",
  "week",
  "hour",
  "minute",
  "half",
] as const;

export type SlotPart = (typeof SLOT_PARTS)[number];

export type SlotPicks = (part: SlotPart) => Picked;

function calendarDate(year: number, month: number, day: number): string | null {
  const date = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  return isLocalDate(date) ? date : null;
}

export function weekdayDate(anchor: string, weekday: string, week: Week): string | null {
  const offset = WEEKDAY_NAMES.indexOf(weekday);
  if (offset < 0) return null;
  const monday = addDays(anchor, 1 - isoWeekday(anchor));
  switch (week) {
    case "this_week": {
      const date = addDays(monday, offset);
      return date < anchor ? null : date;
    }
    case "next_week": {
      const date = addDays(monday, DAYS_IN_WEEK + offset);
      return daysBetween(anchor, date) < DAYS_IN_WEEK ? null : date;
    }
    case "unqualified": {
      const ahead = (offset + 1 - isoWeekday(anchor) + DAYS_IN_WEEK) % DAYS_IN_WEEK;
      return ahead === 0 ? null : addDays(anchor, ahead);
    }
  }
}

function inferYear(month: number, day: number, anchor: string): string | null {
  const year = Number(anchor.slice(0, 4));
  const dates = [year - 1, year, year + 1].flatMap((y) => calendarDate(y, month, day) ?? []);
  const lastPast = dates.findLast((d) => d < anchor);
  if (lastPast !== undefined && daysBetween(lastPast, anchor) <= PAST_DATE_DAYS) return null;
  return dates.find((d) => d >= anchor) ?? null;
}

export function resolveDate(picks: SlotPicks, anchor: string): string | null {
  switch (oneOf(DATE_FORMS, sure(picks("date_form")))) {
    case null:
    case "not_stated":
      return null;
    case "today":
      return anchor;
    case "tomorrow":
      return addDays(anchor, 1);
    case "weekday": {
      const week = oneOf(WEEKS, sure(picks("week")));
      return week === null ? null : weekdayDate(anchor, sure(picks("weekday")) ?? "", week);
    }
    case "calendar_date": {
      const month = MONTH_NAMES.indexOf(sure(picks("month")) ?? "") + 1;
      const day = Number(sure(picks("day")));
      const year = sure(picks("year"));
      if (month === 0 || !Number.isInteger(day) || day < 1 || year === null) return null;
      if (year === "other_year") return null;
      const date =
        year === NOT_STATED
          ? inferYear(month, day, anchor)
          : calendarDate(Number(year), month, day);
      if (date === null) return null;
      const named = sure(picks("weekday"));
      if (named === null) return null;
      return named === NOT_STATED || weekdayName(date) === named ? date : null;
    }
  }
}

export function resolveTime(picks: SlotPicks): string | null {
  const hour = sure(picks("hour"));
  const minute = sure(picks("minute"));
  const half = sure(picks("half"));
  if (
    hour === null ||
    hour === NOT_STATED ||
    minute === null ||
    minute === "other" ||
    half === null
  ) {
    return null;
  }
  const h12 = Number(hour) % 12;
  return `${String(half === "pm" ? h12 + 12 : h12).padStart(2, "0")}:${minute}`;
}

export function resolveSlot(picks: SlotPicks, anchor: string): Slot | null {
  const date = resolveDate(picks, anchor);
  return date === null ? null : { date, time: resolveTime(picks) };
}
