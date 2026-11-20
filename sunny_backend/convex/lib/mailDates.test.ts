import { describe, expect, test } from "vitest";
import { resolveDate, resolveSlot, resolveTime, weekdayDate } from "./mailDates";
import type { SlotPicks } from "./mailDates";
import { ANCHOR } from "./mailFixtures.helpers";

function picks(parts: Partial<Record<keyof SlotPicks, string>>, probability = 0.95): SlotPicks {
  const pick = (choice: string) => ({ choice, probability });
  return {
    date_form: pick(parts.date_form ?? "not_stated"),
    month: pick(parts.month ?? "not_stated"),
    day: pick(parts.day ?? "not_stated"),
    year: pick(parts.year ?? "not_stated"),
    weekday: pick(parts.weekday ?? "not_stated"),
    week: pick(parts.week ?? "unqualified"),
    hour: pick(parts.hour ?? "not_stated"),
    minute: pick(parts.minute ?? "00"),
    half: pick(parts.half ?? "am"),
  };
}

describe("date resolution against the day the email arrived", () => {
  test.each([
    [
      "a full date whose weekday matches",
      {
        date_form: "calendar_date",
        month: "December",
        day: "10",
        year: "2026",
        weekday: "Thursday",
      },
      "2026-12-10",
    ],
    [
      "a full date whose weekday does not match",
      { date_form: "calendar_date", month: "December", day: "10", year: "2026", weekday: "Friday" },
      null,
    ],
    [
      "a date without a year later this year",
      { date_form: "calendar_date", month: "December", day: "5" },
      "2026-12-05",
    ],
    [
      "a date without a year early next year",
      { date_form: "calendar_date", month: "January", day: "11" },
      "2027-01-11",
    ],
    [
      "a date without a year a few days ago",
      { date_form: "calendar_date", month: "November", day: "16" },
      null,
    ],
    [
      "a date without a year past by fewer than 180 days",
      { date_form: "calendar_date", month: "June", day: "1" },
      null,
    ],
    [
      "a date without a year past by more than 180 days",
      { date_form: "calendar_date", month: "March", day: "3" },
      "2027-03-03",
    ],
    [
      "a day that does not exist",
      { date_form: "calendar_date", month: "February", day: "30", year: "2027" },
      null,
    ],
    [
      "a year outside the options",
      { date_form: "calendar_date", month: "March", day: "3", year: "other_year" },
      null,
    ],
    ["a date with no day", { date_form: "calendar_date", month: "March" }, null],
    ["today", { date_form: "today" }, "2026-11-18"],
    ["tomorrow", { date_form: "tomorrow" }, "2026-11-19"],
    ["a bare weekday later this week", { date_form: "weekday", weekday: "Sunday" }, "2026-11-22"],
    ["a bare weekday that is today", { date_form: "weekday", weekday: "Wednesday" }, null],
    ["this Friday", { date_form: "weekday", weekday: "Friday", week: "this_week" }, "2026-11-20"],
    [
      "next Thursday",
      { date_form: "weekday", weekday: "Thursday", week: "next_week" },
      "2026-11-26",
    ],
    [
      "next Tuesday, 6 days away",
      { date_form: "weekday", weekday: "Tuesday", week: "next_week" },
      null,
    ],
    ["a weekday form with no weekday", { date_form: "weekday" }, null],
    ["no date", {}, null],
  ])("%s", (_, parts, expected) => {
    expect(resolveDate(picks(parts), ANCHOR)).toBe(expected);
  });

  test.each([
    ["December 30", "December", "30", "2027-01-05", null],
    ["January 5", "January", "5", "2026-12-20", "2027-01-05"],
    ["October 25", "October", "25", "2026-11-19", null],
    ["May 23", "May", "23", "2026-11-19", null],
    ["May 22", "May", "22", "2026-11-19", "2027-05-22"],
    ["November 19", "November", "19", "2026-11-19", "2026-11-19"],
    ["February 29", "February", "29", "2026-11-19", null],
  ])("%s with no year, read on %s", (_, month, day, anchor, expected) => {
    expect(resolveDate(picks({ date_form: "calendar_date", month, day }), anchor)).toBe(expected);
  });

  test("a part read with low probability leaves the date unread", () => {
    const parts = picks({
      date_form: "calendar_date",
      month: "December",
      day: "10",
      year: "2026",
      weekday: "Thursday",
    });
    expect(
      resolveDate({ ...parts, month: { choice: "December", probability: 0.6 } }, ANCHOR),
    ).toBeNull();
  });
});

describe("the product's weekday convention", () => {
  test.each([
    ["Monday 2026-11-16", "Tuesday", "unqualified", "2026-11-17"],
    ["Monday 2026-11-16", "Tuesday", "this_week", "2026-11-17"],
    ["Monday 2026-11-16", "Tuesday", "next_week", "2026-11-24"],
    ["Tuesday 2026-11-17", "Tuesday", "unqualified", null],
    ["Tuesday 2026-11-17", "Tuesday", "this_week", "2026-11-17"],
    ["Tuesday 2026-11-17", "Tuesday", "next_week", "2026-11-24"],
    ["Wednesday 2026-11-18", "Monday", "this_week", null],
    ["Wednesday 2026-11-18", "Sunday", "this_week", "2026-11-22"],
    ["Wednesday 2026-11-18", "Tuesday", "unqualified", "2026-11-24"],
    ["Wednesday 2026-11-18", "Wednesday", "next_week", "2026-11-25"],
    ["Wednesday 2026-11-18", "Tuesday", "next_week", null],
    ["Saturday 2026-11-21", "Tuesday", "this_week", null],
    ["Saturday 2026-11-21", "Tuesday", "unqualified", "2026-11-24"],
    ["Saturday 2026-11-21", "Tuesday", "next_week", null],
    ["Saturday 2026-11-21", "Sunday", "this_week", "2026-11-22"],
    ["Sunday 2026-11-22", "Monday", "unqualified", "2026-11-23"],
    ["Sunday 2026-11-22", "Monday", "this_week", null],
    ["Sunday 2026-11-22", "Monday", "next_week", null],
    ["Sunday 2026-11-22", "Sunday", "next_week", "2026-11-29"],
  ] as const)("on %s, %s (%s) is %s", (received, weekday, week, expected) => {
    expect(weekdayDate(received.split(" ")[1]!, weekday, week)).toBe(expected);
  });
});

describe("time resolution", () => {
  test.each([
    [{ hour: "2", minute: "15", half: "pm" }, "14:15"],
    [{ hour: "9", minute: "40", half: "am" }, "09:40"],
    [{ hour: "12", minute: "00", half: "pm" }, "12:00"],
    [{ hour: "12", minute: "00", half: "am" }, "00:00"],
    [{ hour: "not_stated" }, null],
    [{ hour: "3", minute: "other", half: "pm" }, null],
  ])("%o", (parts, expected) => {
    expect(resolveTime(picks(parts))).toBe(expected);
  });

  test("an unsettled half of the day leaves the time unread", () => {
    const parts = picks({ hour: "1", minute: "00", half: "pm" });
    expect(resolveTime({ ...parts, half: { choice: "pm", probability: 0.55 } })).toBeNull();
  });

  test("a slot keeps its date when the time is not stated", () => {
    expect(resolveSlot(picks({ date_form: "tomorrow" }), ANCHOR)).toEqual({
      date: "2026-11-19",
      time: null,
    });
  });
});
