// upcomingTasks.test.ts
// Purpose: Tests for the future-day task projection (lib/upcomingTasks.ts) and for the
// upcomingTasks field of calendar.dayView. The pure projection is tested with plain task
// objects: weekday-only tasks, one-off tasks, starts/ends bounds, inactive tasks, as-needed
// medications, anytime entries, several times, ordering (timed first, anytime last), and the
// 6 day range across the March 2027 DST change. dayView is tested end to end: tasks created
// through the public mutation appear on later days only, and a viewer can read the field; a
// paired senior device gets an empty upcomingTasks while a caregiver gets the planned tasks.
//
// Last modified: 2026-11-04

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { projectTasks } from "./lib/upcomingTasks";
import type { ProjectableTask } from "./lib/upcomingTasks";
import { createFamilyHousehold, makeBackend } from "./testing.helpers";

/** 2027-03-13 (a Saturday) 10:00 in New York; DST starts on the 14th. */
const SATURDAY = "2027-03-13T15:00:00Z";

let counter = 0;

/**
 * purpose: A plain task with defaults: an active reminder at 09:00 every day.
 * @param overrides: (Partial<ProjectableTask>) Fields to set.
 * @return: (ProjectableTask) The task.
 */
function makeTask(overrides: Partial<ProjectableTask> = {}): ProjectableTask {
  counter += 1;
  return {
    _id: `task${counter}` as Id<"tasks">,
    active: true,
    type: "reminder",
    times: ["09:00"],
    title: "Task",
    displayLabel: "Task",
    ...overrides,
  };
}

describe("projectTasks", () => {
  test("covers the 6 days after today, not today", () => {
    const out = projectTasks([makeTask()], "2027-03-13", 6);
    expect(out.map((t) => t.localDate)).toEqual([
      "2027-03-14",
      "2027-03-15",
      "2027-03-16",
      "2027-03-17",
      "2027-03-18",
      "2027-03-19",
    ]);
  });

  test("a weekday-only task appears only on its weekdays", () => {
    const monday = makeTask({ daysOfWeek: [1] });
    const out = projectTasks([monday], "2027-03-13", 6);
    expect(out.map((t) => t.localDate)).toEqual(["2027-03-15"]);
  });

  test("a one-off task appears only on its date, as an anytime entry when it has no times", () => {
    const renewal = makeTask({ times: [], onceOn: "2027-03-15", displayLabel: "License" });
    const out = projectTasks([renewal], "2027-03-13", 6);
    expect(out).toEqual([
      expect.objectContaining({
        localDate: "2027-03-15",
        scheduledTime: "anytime",
        displayLabel: "License",
      }),
    ]);
  });

  test("a one-off task outside the range is left out", () => {
    expect(projectTasks([makeTask({ onceOn: "2027-03-20" })], "2027-03-13", 6)).toEqual([]);
    expect(projectTasks([makeTask({ onceOn: "2027-03-13" })], "2027-03-13", 6)).toEqual([]);
  });

  test("startsOn and endsOn bound the days", () => {
    const task = makeTask({ startsOn: "2027-03-16", endsOn: "2027-03-17" });
    const out = projectTasks([task], "2027-03-13", 6);
    expect(out.map((t) => t.localDate)).toEqual(["2027-03-16", "2027-03-17"]);
  });

  test("inactive tasks are excluded", () => {
    expect(projectTasks([makeTask({ active: false })], "2027-03-13", 6)).toEqual([]);
  });

  test("an as-needed medication (no times) is excluded", () => {
    const prn = makeTask({ type: "medication", times: [] });
    expect(projectTasks([prn], "2027-03-13", 6)).toEqual([]);
  });

  test("a task with several times has one entry per time", () => {
    const meds = makeTask({ type: "medication", times: ["08:00", "20:00"], onceOn: "2027-03-16" });
    const out = projectTasks([meds], "2027-03-13", 6);
    expect(out.map((t) => t.scheduledTime)).toEqual(["08:00", "20:00"]);
  });

  test("a day's entries are timed by time, then anytime last", () => {
    const anytime = makeTask({ times: [], displayLabel: "Water plants" });
    const late = makeTask({ times: ["18:00"], displayLabel: "Evening" });
    const early = makeTask({ times: ["07:30"], displayLabel: "Morning" });
    const out = projectTasks([anytime, late, early], "2027-03-13", 1);
    expect(out.map((t) => t.displayLabel)).toEqual(["Morning", "Evening", "Water plants"]);
  });

  test("ties in time are ordered by label", () => {
    const b = makeTask({ displayLabel: "B" });
    const a = makeTask({ displayLabel: "A" });
    expect(projectTasks([b, a], "2027-03-13", 1).map((t) => t.displayLabel)).toEqual(["A", "B"]);
  });

  test("days stay in date order across a DST change", () => {
    const out = projectTasks([makeTask()], "2027-03-12", 4);
    expect(out.map((t) => t.localDate)).toEqual([
      "2027-03-13",
      "2027-03-14",
      "2027-03-15",
      "2027-03-16",
    ]);
  });
});

describe("dayView upcomingTasks", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(SATURDAY));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("lists future tasks by day (no today, no as-needed medication) within 6 days", async () => {
    const t = makeBackend();
    const householdId = await createFamilyHousehold(t);
    const pat = t.withIdentity({ subject: "pat" });
    await pat.mutation(api.tasks.create, {
      householdId,
      type: "reminder",
      title: "Renew license",
      displayLabel: "License renewal",
      onceOn: "2027-03-15",
    });
    await pat.mutation(api.tasks.create, {
      householdId,
      type: "medication",
      title: "Vitamin",
      displayLabel: "Vitamin",
      times: ["08:00"],
    });
    await pat.mutation(api.tasks.create, {
      householdId,
      type: "medication",
      title: "Aspirin",
      displayLabel: "Aspirin",
      asNeededMaxPerDay: 2,
    });
    const view = await pat.query(api.calendar.dayView, { householdId });
    const monday = view.upcomingTasks.filter((u) => u.localDate === "2027-03-15");
    expect(monday.map((u) => [u.scheduledTime, u.displayLabel])).toEqual([
      ["08:00", "Vitamin"],
      ["anytime", "License renewal"],
    ]);
    expect(view.upcomingTasks.some((u) => u.localDate === "2027-03-13")).toBe(false);
    expect(view.upcomingTasks.some((u) => u.localDate === "2027-03-19")).toBe(true);
    expect(view.upcomingTasks.some((u) => u.localDate === "2027-03-20")).toBe(false);
    expect(view.upcomingTasks.some((u) => u.displayLabel === "Aspirin")).toBe(false);
  });

  test("a senior device gets no upcomingTasks while a caregiver gets them", async () => {
    const t = makeBackend();
    const householdId = await createFamilyHousehold(t);
    await t.withIdentity({ subject: "pat" }).mutation(api.tasks.create, {
      householdId,
      type: "reminder",
      title: "Renew license",
      displayLabel: "License renewal",
      onceOn: "2027-03-15",
    });
    const asCaregiver = await t
      .withIdentity({ subject: "val" })
      .query(api.calendar.dayView, { householdId });
    const asDevice = await t
      .withIdentity({ subject: "phone", sunny_kind: "device" })
      .query(api.calendar.dayView, { householdId });
    expect(asCaregiver.upcomingTasks.map((u) => u.displayLabel)).toEqual(["License renewal"]);
    expect(asDevice.upcomingTasks).toEqual([]);
    expect(asDevice.tasks).toEqual(asCaregiver.tasks);
  });
});
