// anytime.test.ts
// Purpose: Tests for anytime tasks (tasks without a time; lib/anytime.ts): expansion of their
// instances for today and tomorrow with a local-midnight window (one day when the task repeats
// the next day, so the next day's row replaces it; two days otherwise, so it carries over as
// Leftover) across the March 2027 New York DST change (idempotent); the scheduler opening
// them without prompting, escalating or notifying anyone (even when the task carries a policy)
// and marking them missed at the end of their window; todayInstances ordering (timed first,
// anytime last in a day), Leftover carry-over of an anytime instance whose task does not occur
// the next day (one-off, weekday before an off day) but not of a daily one, and not of a
// two-day-old one; resync removing open instances of the other kind when a task turns anytime
// or timed (history kept); a household timezone change moving open anytime instances in place
// (same local date, new local date, not yet opened in the new zone, one-off); a table of policy transitions on update;
// confirming them from the senior's device and as a caregiver; their absence from the daily
// digest facts; a bare "Done" not picking them; and the task validation and policy rules (a medication needs a time unless it
// is a valid as-needed medication; no policy for anytime tasks on create and on type/time
// changes). Fake timers drive the clock of the public functions; the internal scheduler takes
// an explicit `now`.
//
// Last modified: 2026-11-04

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { gatherDigestFacts } from "./lib/digestFacts";
import { anytimeWindow, compareDayOrder, isAnytimeTask } from "./lib/anytime";
import { isAsNeededTask } from "./tasks";
import { createFamilyHousehold, makeBackend } from "./testing.helpers";
import type { TestConvex } from "./testing.helpers";

/** 2027-03-13 10:00 in New York (EST); DST starts the next morning. */
const DAY_ONE = "2027-03-13T15:00:00Z";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

/** A household and its seeded policy ids. */
interface Fixture {
  t: TestConvex;
  householdId: Id<"households">;
  medication: Id<"escalationPolicies">;
  promptOnly: Id<"escalationPolicies">;
}

/**
 * purpose: Build the family household at a faked time.
 * @param iso: (string) UTC instant to start the clock at.
 * @return: (Promise<Fixture>) The fixture.
 */
async function setup(iso: string = DAY_ONE): Promise<Fixture> {
  vi.setSystemTime(new Date(iso));
  const t = makeBackend();
  const householdId = await createFamilyHousehold(t);
  const policies = await t.withIdentity({ subject: "pat" }).query(api.tasks.listPolicies, {
    householdId,
  });
  return {
    t,
    householdId,
    medication: policies.find((p) => p.systemKey === "medication")!._id,
    promptOnly: policies.find((p) => p.systemKey === "prompt_only")!._id,
  };
}

/**
 * purpose: Create a task as Pat through the public mutation.
 * @param f: (Fixture) Fixture.
 * @param fields: (object) Overrides of the defaults (a reminder with no times).
 * @return: (Promise<Id<"tasks">>) The task.
 */
async function makeTask(
  f: Fixture,
  fields: Partial<{
    type: "medication" | "reminder" | "routine";
    title: string;
    times: string[];
    escalationPolicyId: Id<"escalationPolicies">;
    asNeededMaxPerDay: number;
    onceOn: string;
    daysOfWeek: number[];
  }> = {},
): Promise<Id<"tasks">> {
  const title = fields.title ?? "Water plants";
  return await f.t.withIdentity({ subject: "pat" }).mutation(api.tasks.create, {
    householdId: f.householdId,
    type: "reminder",
    title,
    displayLabel: title,
    ...fields,
  });
}

/**
 * purpose: All of a task's instances, earliest first.
 * @param f: (Fixture) Fixture.
 * @param taskId: (Id<"tasks">) Task.
 * @return: (Promise<Doc<"taskInstances">[]>) The instances.
 */
async function instancesOf(f: Fixture, taskId: Id<"tasks">): Promise<Doc<"taskInstances">[]> {
  const rows = await f.t.run(
    async (ctx) =>
      await ctx.db
        .query("taskInstances")
        .withIndex("by_task_date_time", (q) => q.eq("taskId", taskId))
        .collect(),
  );
  return rows.sort((a, b) => a.localDate.localeCompare(b.localDate));
}

/**
 * purpose: Run tickHousehold for the household at an instant.
 * @param f: (Fixture) Fixture.
 * @param iso: (string) UTC instant.
 * @return: (Promise<{opened: number; stepsFired: number; missed: number}>) Tick counts.
 */
async function tick(f: Fixture, iso: string) {
  return await f.t.mutation(internal.scheduler.tickHousehold, {
    householdId: f.householdId,
    now: Date.parse(iso),
  });
}

/**
 * purpose: Prompt and alert notifications queued so far (the kinds a task can send).
 * @param f: (Fixture) Fixture.
 * @return: (Promise<number>) The count.
 */
async function taskNotifications(f: Fixture): Promise<number> {
  const rows = await f.t.run(async (ctx) => await ctx.db.query("notificationOutbox").collect());
  return rows.filter((r) => r.kind === "senior_prompt" || r.kind === "caregiver_alert").length;
}

/**
 * purpose: Today's entries as Pat sees them at an instant.
 * @param f: (Fixture) Fixture.
 * @param iso: (string) UTC instant.
 * @return: (Promise<unknown[]>) The entries.
 */
async function todayAt(f: Fixture, iso: string) {
  vi.setSystemTime(new Date(iso));
  return await f.t
    .withIdentity({ subject: "pat" })
    .query(api.instances.today, { householdId: f.householdId });
}

describe("helpers", () => {
  test("isAnytimeTask is true only for a non-medication without times", () => {
    expect(isAnytimeTask({ type: "reminder", times: [] })).toBe(true);
    expect(isAnytimeTask({ type: "reminder", times: ["08:00"] })).toBe(false);
    expect(isAnytimeTask({ type: "medication", times: [] })).toBe(false);
  });

  test("compareDayOrder puts anytime after timed regardless of window start", () => {
    const timed = { scheduledTime: "20:00", windowStart: 200 };
    const anytime = { scheduledTime: "anytime", windowStart: 100 };
    expect([anytime, timed].sort(compareDayOrder)).toEqual([timed, anytime]);
  });

  test("anytimeWindow ends at the next midnight when the task repeats, else two days later", () => {
    const repeats = anytimeWindow("2027-03-13", "America/New_York", true);
    expect(repeats.windowStart).toBe(Date.parse("2027-03-13T05:00:00Z"));
    expect(repeats.windowEnd).toBe(Date.parse("2027-03-14T05:00:00Z"));
    const once = anytimeWindow("2027-03-13", "America/New_York", false);
    expect(once.windowEnd).toBe(Date.parse("2027-03-15T04:00:00Z"));
  });

  test("isAsNeededTask needs a medication, no times and a limit", () => {
    const base: Parameters<typeof isAsNeededTask>[0] = {
      type: "medication",
      times: [],
      asNeededMaxPerDay: 2,
    };
    expect(isAsNeededTask(base)).toBe(true);
    expect(isAsNeededTask({ ...base, type: "reminder" })).toBe(false);
    expect(isAsNeededTask({ ...base, times: ["08:00"] })).toBe(false);
    expect(isAsNeededTask({ type: "medication", times: [] })).toBe(false);
  });
});

describe("expansion", () => {
  test("a daily anytime task gets one-day windows for today and tomorrow", async () => {
    const f = await setup();
    const taskId = await makeTask(f);
    const rows = await instancesOf(f, taskId);
    expect(rows.map((r) => [r.localDate, r.scheduledTime, r.state])).toEqual([
      ["2027-03-13", "anytime", "upcoming"],
      ["2027-03-14", "anytime", "upcoming"],
    ]);
    expect(rows[0]!.windowStart).toBe(Date.parse("2027-03-13T05:00:00Z"));
    expect(rows[0]!.windowEnd).toBe(Date.parse("2027-03-14T05:00:00Z"));
    // The 14th is the 23-hour spring-forward day: midnight is EST, the end is EDT.
    expect(rows[1]!.windowStart).toBe(Date.parse("2027-03-14T05:00:00Z"));
    expect(rows[1]!.windowEnd).toBe(Date.parse("2027-03-15T04:00:00Z"));
  });

  test("a one-off anytime task keeps a two-day window across DST", async () => {
    const f = await setup();
    const taskId = await makeTask(f, { onceOn: "2027-03-13" });
    const rows = await instancesOf(f, taskId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.windowStart).toBe(Date.parse("2027-03-13T05:00:00Z"));
    expect(rows[0]!.windowEnd).toBe(Date.parse("2027-03-15T04:00:00Z"));
  });

  test("expansion is idempotent", async () => {
    const f = await setup();
    const taskId = await makeTask(f);
    const created = await f.t.mutation(internal.scheduler.expand, {
      now: Date.parse(DAY_ONE),
      taskId,
    });
    expect(created).toBe(0);
    expect(await instancesOf(f, taskId)).toHaveLength(2);
  });

  test("a task created late in the day still gets today's instance", async () => {
    const f = await setup("2027-03-14T03:30:00Z");
    const taskId = await makeTask(f);
    const rows = await instancesOf(f, taskId);
    expect(rows.map((r) => r.localDate)).toEqual(["2027-03-13", "2027-03-14"]);
  });

  test("respects the task's weekdays", async () => {
    const f = await setup();
    // 2027-03-13 is a Saturday; run only on Sunday (7).
    const taskId = await f.t.withIdentity({ subject: "pat" }).mutation(api.tasks.create, {
      householdId: f.householdId,
      type: "routine",
      title: "Sunday jobs",
      displayLabel: "Sunday jobs",
      daysOfWeek: [7],
    });
    const rows = await instancesOf(f, taskId);
    expect(rows.map((r) => r.localDate)).toEqual(["2027-03-14"]);
  });
});

describe("scheduler", () => {
  test("opening an anytime instance sends nothing and fires no step, even with a policy", async () => {
    const f = await setup();
    const taskId = await makeTask(f, { escalationPolicyId: f.promptOnly });
    const first = await tick(f, "2027-03-13T15:01:00Z");
    expect(first).toMatchObject({ opened: 1, stepsFired: 0 });
    for (const iso of [
      "2027-03-13T18:00:00Z",
      "2027-03-13T23:00:00Z",
      "2027-03-14T03:00:00Z",
      "2027-03-14T04:59:00Z",
    ]) {
      expect(await tick(f, iso)).toMatchObject({ stepsFired: 0, escalated: 0 });
    }
    const [today] = await instancesOf(f, taskId);
    expect(today!.state).toBe("due");
    expect(today!.firedSteps).toEqual([]);
    expect(await taskNotifications(f)).toBe(0);
  });

  test("a task created without a policy has none, and the tick still sends nothing", async () => {
    const f = await setup();
    const taskId = await makeTask(f);
    const task = await f.t.run(async (ctx) => await ctx.db.get(taskId));
    expect(task!.escalationPolicyId).toBeUndefined();
    await tick(f, "2027-03-13T16:00:00Z");
    expect(await taskNotifications(f)).toBe(0);
  });

  test("a daily anytime instance is missed at the end of its own day", async () => {
    const f = await setup();
    const taskId = await makeTask(f);
    await tick(f, "2027-03-13T15:01:00Z");
    // 2027-03-14 04:59Z is 23:59 on the 13th in New York (EST): still open.
    expect(await tick(f, "2027-03-14T04:59:00Z")).toMatchObject({ missed: 0 });
    expect((await instancesOf(f, taskId))[0]!.state).toBe("due");
    expect(await tick(f, "2027-03-14T05:00:00Z")).toMatchObject({ missed: 1 });
    expect((await instancesOf(f, taskId))[0]!.state).toBe("missed");
    expect(await taskNotifications(f)).toBe(0);
  });

  test("a one-off anytime instance is missed only after the next local day ends", async () => {
    const f = await setup();
    const taskId = await makeTask(f, { onceOn: "2027-03-13" });
    await tick(f, "2027-03-13T15:01:00Z");
    // 2027-03-15 03:59Z is 23:59 on the 14th in New York (EDT): still open.
    expect(await tick(f, "2027-03-15T03:59:00Z")).toMatchObject({ missed: 0 });
    expect((await instancesOf(f, taskId))[0]!.state).toBe("due");
    // 04:00Z is midnight at the end of the 14th: the 13th's instance is missed.
    expect(await tick(f, "2027-03-15T04:00:00Z")).toMatchObject({ missed: 1 });
    expect((await instancesOf(f, taskId))[0]!.state).toBe("missed");
    expect(await taskNotifications(f)).toBe(0);
  });
});

/**
 * purpose: Change the household's timezone as Pat through the public mutation.
 * @param f: (Fixture) Fixture.
 * @param timezone: (string) New IANA zone.
 * @return: (Promise<void>)
 */
async function changeZone(f: Fixture, timezone: string): Promise<void> {
  await f.t
    .withIdentity({ subject: "pat" })
    .mutation(api.households.update, { householdId: f.householdId, timezone });
}

describe("household timezone change", () => {
  test("the same local date: today's row keeps its id, state and note, with new-zone bounds", async () => {
    const f = await setup();
    const taskId = await makeTask(f);
    await tick(f, "2027-03-13T15:01:00Z");
    const [today] = await instancesOf(f, taskId);
    await f.t.withIdentity({ subject: "pat" }).mutation(api.instances.setTaskNote, {
      instanceId: today!._id,
      note: "Watered the ferns",
    });
    await changeZone(f, "America/Chicago");
    const rows = await instancesOf(f, taskId);
    expect(rows.map((r) => r.localDate)).toEqual(["2027-03-13", "2027-03-14"]);
    expect(rows[0]!._id).toBe(today!._id);
    expect(rows[0]!.state).toBe("due");
    expect(rows[0]!.resolutionNote).toBe("Watered the ferns");
    // Chicago is still on CST on the 13th and 14th (DST starts at 2:00 on the 14th).
    expect(rows[0]!.windowStart).toBe(Date.parse("2027-03-13T06:00:00Z"));
    expect(rows[0]!.windowEnd).toBe(Date.parse("2027-03-14T06:00:00Z"));
    expect(rows[1]!.windowStart).toBe(Date.parse("2027-03-14T06:00:00Z"));
    expect(rows[1]!.windowEnd).toBe(Date.parse("2027-03-15T05:00:00Z"));
  });

  test("a new local date: the old row ends at the new midnight and is missed, no duplicates", async () => {
    const f = await setup();
    const taskId = await makeTask(f);
    await tick(f, "2027-03-13T15:01:00Z");
    const [old] = await instancesOf(f, taskId);
    // 15:00Z is 04:00 on the 14th in Auckland (NZDT, UTC+13).
    await changeZone(f, "Pacific/Auckland");
    const rows = await instancesOf(f, taskId);
    expect(rows.map((r) => r.localDate)).toEqual(["2027-03-13", "2027-03-14", "2027-03-15"]);
    expect(rows[0]!._id).toBe(old!._id);
    expect(rows[0]!.windowStart).toBe(Date.parse("2027-03-12T11:00:00Z"));
    expect(rows[0]!.windowEnd).toBe(Date.parse("2027-03-13T11:00:00Z"));
    expect(rows[0]!.state).toBe("due");
    expect(await tick(f, "2027-03-13T15:02:00Z")).toMatchObject({ missed: 1 });
    const after = await instancesOf(f, taskId);
    expect(after.map((r) => [r.localDate, r.state])).toEqual([
      ["2027-03-13", "missed"],
      ["2027-03-14", "due"],
      ["2027-03-15", "upcoming"],
    ]);
  });

  test("moving west before the window opens sends a due instance back to upcoming", async () => {
    const f = await setup("2027-03-13T05:30:00Z");
    const taskId = await makeTask(f);
    await tick(f, "2027-03-13T05:31:00Z");
    const [today] = await instancesOf(f, taskId);
    expect(today!.state).toBe("due");
    // 05:30Z is 21:30 on the 12th in Los Angeles: the 13th has not started there.
    await changeZone(f, "America/Los_Angeles");
    const rows = await instancesOf(f, taskId);
    expect(rows.map((r) => [r.localDate, r.state])).toEqual([
      ["2027-03-12", "upcoming"],
      ["2027-03-13", "upcoming"],
    ]);
    expect(rows[1]!._id).toBe(today!._id);
    expect(rows[1]!.windowStart).toBe(Date.parse("2027-03-13T08:00:00Z"));
    const audits = await f.t.run(async (ctx) => await ctx.db.query("auditLog").collect());
    expect(
      audits.filter((a) => a.entityId === today!._id && a.action === "state_change").length,
    ).toBe(2);
  });

  test("a one-off task keeps its two-day window in the new zone", async () => {
    const f = await setup();
    const taskId = await makeTask(f, { onceOn: "2027-03-13" });
    await tick(f, "2027-03-13T15:01:00Z");
    await changeZone(f, "America/Chicago");
    const rows = await instancesOf(f, taskId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.windowStart).toBe(Date.parse("2027-03-13T06:00:00Z"));
    expect(rows[0]!.windowEnd).toBe(Date.parse("2027-03-15T05:00:00Z"));
  });
});

describe("today", () => {
  test("lists a day's timed tasks first and anytime tasks last", async () => {
    const f = await setup();
    await makeTask(f, { title: "Water plants" });
    await makeTask(f, { type: "medication", title: "Evening pills", times: ["20:00"] });
    await makeTask(f, { type: "routine", title: "Morning stretch", times: ["11:00"] });
    const entries = (await todayAt(f, DAY_ONE)) as Array<{
      displayLabel: string;
      scheduledTime: string;
    }>;
    expect(entries.map((e) => [e.displayLabel, e.scheduledTime])).toEqual([
      ["Morning stretch", "11:00"],
      ["Evening pills", "20:00"],
      ["Water plants", "anytime"],
    ]);
  });

  test("yesterday's open anytime instance is carried over after yesterday's timed leftovers", async () => {
    const f = await setup();
    await makeTask(f, { title: "Water plants", onceOn: "2027-03-13" });
    await makeTask(f, { type: "medication", title: "Late pills", times: ["23:30"] });
    await tick(f, "2027-03-13T15:01:00Z");
    // 00:10 on the 14th in New York is 05:10Z: the 23:30 pills (2h window) are still due.
    await tick(f, "2027-03-14T05:10:00Z");
    const entries = (await todayAt(f, "2027-03-14T05:10:00Z")) as Array<{
      displayLabel: string;
      localDate: string;
      carriedOver: boolean;
    }>;
    expect(entries.map((e) => [e.displayLabel, e.localDate, e.carriedOver])).toEqual([
      ["Late pills", "2027-03-13", true],
      ["Water plants", "2027-03-13", true],
      ["Late pills", "2027-03-14", false],
    ]);
  });

  test("a daily anytime task's next day replaces the undone one: no Leftover row", async () => {
    const f = await setup();
    const taskId = await makeTask(f);
    await tick(f, "2027-03-13T15:01:00Z");
    await tick(f, "2027-03-14T15:00:00Z");
    const entries = (await todayAt(f, "2027-03-14T15:00:00Z")) as Array<{
      displayLabel: string;
      localDate: string;
      carriedOver: boolean;
    }>;
    expect(entries.map((e) => [e.displayLabel, e.localDate, e.carriedOver])).toEqual([
      ["Water plants", "2027-03-14", false],
    ]);
    expect((await instancesOf(f, taskId))[0]!.state).toBe("missed");
  });

  test("a weekday-only anytime task before an off day is a Leftover on the off day", async () => {
    const f = await setup();
    // 2027-03-13 is a Saturday (6); the task does not run on Sunday.
    await makeTask(f, { daysOfWeek: [6] });
    await tick(f, "2027-03-13T15:01:00Z");
    await tick(f, "2027-03-14T15:00:00Z");
    const entries = (await todayAt(f, "2027-03-14T15:00:00Z")) as Array<{
      localDate: string;
      carriedOver: boolean;
    }>;
    expect(entries.map((e) => [e.localDate, e.carriedOver])).toEqual([["2027-03-13", true]]);
  });

  test("Done by label on day two of a daily anytime task picks today's instance", async () => {
    const f = await setup();
    const taskId = await makeTask(f);
    await tick(f, "2027-03-13T15:01:00Z");
    await tick(f, "2027-03-14T15:00:00Z");
    vi.setSystemTime(new Date("2027-03-14T15:00:00Z"));
    const done = await f.t
      .withIdentity({ subject: "phone" })
      .mutation(api.instances.confirmDueTask, {
        householdId: f.householdId,
        via: "button",
        label: "water",
      });
    expect(done.status).toBe("confirmed");
    const rows = await instancesOf(f, taskId);
    expect(rows.find((r) => r.localDate === "2027-03-14")!.state).toBe("confirmed");
    expect(rows.find((r) => r.localDate === "2027-03-13")!.state).toBe("missed");
  });

  test("an anytime instance two days old is no longer listed", async () => {
    const f = await setup();
    await makeTask(f, { title: "Water plants", onceOn: "2027-03-13" });
    await tick(f, "2027-03-13T15:01:00Z");
    await tick(f, "2027-03-15T04:00:00Z");
    const entries = (await todayAt(f, "2027-03-15T15:00:00Z")) as Array<{ localDate: string }>;
    expect(entries.every((e) => e.localDate >= "2027-03-14")).toBe(true);
    expect(entries.some((e) => e.localDate === "2027-03-13")).toBe(false);
  });

  test("a done anytime instance from yesterday is not a leftover", async () => {
    const f = await setup();
    const taskId = await makeTask(f);
    await tick(f, "2027-03-13T15:01:00Z");
    const [first] = await instancesOf(f, taskId);
    await f.t
      .withIdentity({ subject: "pat" })
      .mutation(api.instances.confirmTaskInstance, { instanceId: first!._id, via: "phone_app" });
    const entries = (await todayAt(f, "2027-03-14T15:00:00Z")) as Array<{ carriedOver: boolean }>;
    expect(entries.some((e) => e.carriedOver)).toBe(false);
  });
});

describe("confirming", () => {
  test("the senior's device can tick an anytime task any time that day", async () => {
    const f = await setup();
    const taskId = await makeTask(f);
    await tick(f, "2027-03-13T15:01:00Z");
    const [first] = await instancesOf(f, taskId);
    vi.setSystemTime(new Date("2027-03-13T23:00:00Z"));
    const done = await f.t
      .withIdentity({ subject: "phone" })
      .mutation(api.instances.confirmTaskInstance, { instanceId: first!._id, via: "button" });
    expect(done.state).toBe("confirmed");
  });

  test("a caregiver can mark it done and the instance becomes resolved", async () => {
    const f = await setup();
    const taskId = await makeTask(f);
    const [first] = await instancesOf(f, taskId);
    const done = await f.t
      .withIdentity({ subject: "max" })
      .mutation(api.instances.confirmTaskInstance, { instanceId: first!._id, via: "phone_app" });
    expect(done.state).toBe("resolved");
  });
});

describe("Done without a label", () => {
  test("never picks an anytime task, but a label does", async () => {
    const f = await setup();
    const taskId = await makeTask(f);
    await tick(f, "2027-03-13T15:01:00Z");
    const phone = f.t.withIdentity({ subject: "phone" });
    const bare = await phone.mutation(api.instances.confirmDueTask, {
      householdId: f.householdId,
      via: "button",
    });
    expect(bare.status).toBe("nothing_due");
    const named = await phone.mutation(api.instances.confirmDueTask, {
      householdId: f.householdId,
      via: "button",
      label: "water",
    });
    expect(named.status).toBe("confirmed");
    expect((await instancesOf(f, taskId))[0]!.state).toBe("confirmed");
  });
});

describe("daily digest", () => {
  test("leaves anytime instances out of the facts, whatever their outcome", async () => {
    const f = await setup();
    await makeTask(f, { title: "Water plants" });
    await makeTask(f, { type: "medication", title: "Morning pills", times: ["11:00"] });
    await tick(f, "2027-03-13T15:01:00Z");
    const facts = await f.t.run(async (ctx) => {
      const household = (await ctx.db.get(f.householdId))!;
      return await gatherDigestFacts(ctx, household, "2027-03-13");
    });
    expect(facts.tasks.map((t) => t.label)).toEqual(["Morning pills"]);
  });
});

describe("task validation and policies", () => {
  /**
   * purpose: A task row.
   * @param f: (Fixture) Fixture.
   * @param id: (Id<"tasks">) Task.
   * @return: (Promise<Doc<"tasks">>) The row.
   */
  async function row(f: Fixture, id: Id<"tasks">): Promise<Doc<"tasks">> {
    return (await f.t.run(async (ctx) => await ctx.db.get(id)))!;
  }

  /**
   * purpose: Update a task as Pat.
   * @param f: (Fixture) Fixture.
   * @param taskId: (Id<"tasks">) Task.
   * @param changes: (object) The change fields.
   * @return: (Promise<Doc<"tasks">>) The task after the change.
   */
  async function update(
    f: Fixture,
    taskId: Id<"tasks">,
    changes: Record<string, unknown>,
  ): Promise<Doc<"tasks">> {
    await f.t
      .withIdentity({ subject: "pat" })
      .mutation(api.tasks.update, { householdId: f.householdId, taskId, ...changes });
    return await row(f, taskId);
  }

  test.each(["reminder", "routine", "appointment", "checklist"] as const)(
    "a %s task without times is accepted",
    async (type) => {
      const f = await setup();
      const id = await f.t.withIdentity({ subject: "pat" }).mutation(api.tasks.create, {
        householdId: f.householdId,
        type,
        title: "x",
        displayLabel: "x",
      });
      expect((await row(f, id)).times).toEqual([]);
    },
  );

  test("a medication without times and without a limit is rejected", async () => {
    const f = await setup();
    await expect(makeTask(f, { type: "medication", title: "Pills" })).rejects.toThrow(
      /A medication needs at least one time/,
    );
  });

  test("a medication without times is accepted as an as-needed medication with a limit", async () => {
    const f = await setup();
    const id = await makeTask(f, {
      type: "medication",
      title: "Pain relief",
      asNeededMaxPerDay: 3,
    });
    expect((await row(f, id)).escalationPolicyId).toBe(f.medication);
    expect(await instancesOf(f, id)).toHaveLength(0);
  });

  test("a timed non-medication task keeps the prompt-only default, a medication the medication one", async () => {
    const f = await setup();
    const reminder = await makeTask(f, { times: ["09:00"] });
    const pills = await makeTask(f, { type: "medication", title: "Pills", times: ["08:00"] });
    expect((await row(f, reminder)).escalationPolicyId).toBe(f.promptOnly);
    expect((await row(f, pills)).escalationPolicyId).toBe(f.medication);
  });

  test("an anytime task gets no policy", async () => {
    const f = await setup();
    expect((await row(f, await makeTask(f))).escalationPolicyId).toBeUndefined();
  });

  test("emptying a task's times makes it anytime and drops its seeded policy", async () => {
    const f = await setup();
    const id = await makeTask(f, { times: ["09:00"] });
    const after = await update(f, id, { times: [] });
    expect(after.escalationPolicyId).toBeUndefined();
    const rows = await instancesOf(f, id);
    expect(rows.some((r) => r.scheduledTime === "anytime")).toBe(true);
  });

  test("giving an anytime task times restores its type's default policy", async () => {
    const f = await setup();
    const id = await makeTask(f);
    expect((await update(f, id, { times: ["09:00"] })).escalationPolicyId).toBe(f.promptOnly);
  });

  test("an anytime task changed to a medication with times gets the medication policy", async () => {
    const f = await setup();
    const id = await makeTask(f);
    const after = await update(f, id, { type: "medication", times: ["08:00"] });
    expect(after.escalationPolicyId).toBe(f.medication);
  });

  test("a custom policy survives becoming anytime", async () => {
    const f = await setup();
    const custom = await f.t.withIdentity({ subject: "pat" }).mutation(api.tasks.createPolicy, {
      householdId: f.householdId,
      name: "Custom",
      steps: [{ action: "prompt_senior", offsetMinutes: 0, skipIfClaimed: false }],
    });
    const id = await makeTask(f, { times: ["09:00"], escalationPolicyId: custom });
    expect((await update(f, id, { times: [] })).escalationPolicyId).toBe(custom);
  });

  test("an explicit policy in the same update wins", async () => {
    const f = await setup();
    const id = await makeTask(f, { times: ["09:00"] });
    const after = await update(f, id, { times: [], escalationPolicyId: f.medication });
    expect(after.escalationPolicyId).toBe(f.medication);
  });

  test("clearing the limits of an untimed medication is rejected", async () => {
    const f = await setup();
    const id = await makeTask(f, {
      type: "medication",
      title: "Pain relief",
      asNeededMaxPerDay: 3,
    });
    await expect(update(f, id, { asNeededMaxPerDay: null })).rejects.toThrow(/A medication needs/);
    expect((await row(f, id)).asNeededMaxPerDay).toBe(3);
  });

  test("an ex-medication with leftover limits is anytime, not as-needed", async () => {
    const f = await setup();
    const id = await makeTask(f, {
      type: "medication",
      title: "Pain relief",
      asNeededMaxPerDay: 3,
    });
    const after = await update(f, id, { type: "reminder" });
    expect(isAsNeededTask(after)).toBe(false);
    expect(isAnytimeTask(after)).toBe(true);
    expect(after.escalationPolicyId).toBeUndefined();
  });

  test("a medication cannot be made untimed unless it is as-needed", async () => {
    const f = await setup();
    const id = await makeTask(f, { type: "medication", title: "Pills", times: ["08:00"] });
    await expect(update(f, id, { times: [] })).rejects.toThrow(/A medication needs/);
    const withLimit = await update(f, id, { times: [], asNeededMaxPerDay: 2 });
    expect(withLimit.times).toEqual([]);
  });

  test("changing a timed medication to a reminder with no times makes it anytime", async () => {
    const f = await setup();
    const id = await makeTask(f, { type: "medication", title: "Pills", times: ["08:00"] });
    const after = await update(f, id, { type: "reminder", times: [] });
    expect(after.escalationPolicyId).toBeUndefined();
  });

  test("an older untimed medication stays editable for unrelated fields but not reactivation", async () => {
    const f = await setup();
    const id = await makeTask(f, { type: "medication", title: "Pills", times: ["08:00"] });
    await f.t.run(async (ctx) => {
      await ctx.db.patch(id, { times: [], active: false });
    });
    expect((await update(f, id, { title: "Pills (old)" })).title).toBe("Pills (old)");
    await expect(update(f, id, { active: true })).rejects.toThrow(/A medication needs/);
  });
});

/**
 * purpose: A task row.
 * @param f: (Fixture) Fixture.
 * @param id: (Id<"tasks">) Task.
 * @return: (Promise<Doc<"tasks">>) The row.
 */
async function taskRow(f: Fixture, id: Id<"tasks">): Promise<Doc<"tasks">> {
  return (await f.t.run(async (ctx) => await ctx.db.get(id)))!;
}

/**
 * purpose: Update a task as Pat and return the row after the change.
 * @param f: (Fixture) Fixture.
 * @param taskId: (Id<"tasks">) Task.
 * @param changes: (object) The change fields.
 * @return: (Promise<Doc<"tasks">>) The task after the change.
 */
async function updateTask(
  f: Fixture,
  taskId: Id<"tasks">,
  changes: Record<string, unknown>,
): Promise<Doc<"tasks">> {
  await f.t
    .withIdentity({ subject: "pat" })
    .mutation(api.tasks.update, { householdId: f.householdId, taskId, ...changes });
  return await taskRow(f, taskId);
}

describe("turning a task anytime or timed", () => {
  test("timed to anytime removes the open timed instances and adds anytime ones", async () => {
    const f = await setup();
    const id = await makeTask(f, { times: ["20:00"] });
    await updateTask(f, id, { times: [] });
    const rows = await instancesOf(f, id);
    expect(rows.map((r) => [r.localDate, r.scheduledTime])).toEqual([
      ["2027-03-13", "anytime"],
      ["2027-03-14", "anytime"],
    ]);
  });

  test("a due timed instance is removed too, a resolved one stays as history", async () => {
    const f = await setup();
    const id = await makeTask(f, { times: ["11:00", "11:30"] });
    const due = await makeTask(f, { title: "Stretch", times: ["11:00"] });
    // 11:05 local (EST) is 16:05Z: the 11:00 instances are due, 11:30 upcoming.
    await tick(f, "2027-03-13T16:05:00Z");
    const [first] = await instancesOf(f, id);
    await f.t
      .withIdentity({ subject: "pat" })
      .mutation(api.instances.confirmTaskInstance, { instanceId: first!._id, via: "phone_app" });
    await updateTask(f, id, { times: [] });
    await updateTask(f, due, { times: [] });
    const kept = await instancesOf(f, id);
    expect(kept.filter((r) => r.scheduledTime !== "anytime").map((r) => r.state)).toEqual([
      "resolved",
    ]);
    expect((await instancesOf(f, due)).every((r) => r.scheduledTime === "anytime")).toBe(true);
  });

  test("anytime to timed removes the open anytime instances and adds timed ones", async () => {
    const f = await setup();
    const id = await makeTask(f);
    await tick(f, "2027-03-13T15:01:00Z");
    await updateTask(f, id, { times: ["20:00"] });
    const rows = await instancesOf(f, id);
    expect(rows.map((r) => [r.localDate, r.scheduledTime])).toEqual([
      ["2027-03-13", "20:00"],
      ["2027-03-14", "20:00"],
    ]);
  });

  test("a done anytime instance stays when the task becomes timed", async () => {
    const f = await setup();
    const id = await makeTask(f);
    const [first] = await instancesOf(f, id);
    await f.t
      .withIdentity({ subject: "pat" })
      .mutation(api.instances.confirmTaskInstance, { instanceId: first!._id, via: "phone_app" });
    await updateTask(f, id, { times: ["20:00"] });
    const rows = await instancesOf(f, id);
    expect(rows.filter((r) => r.scheduledTime === "anytime").map((r) => r.state)).toEqual([
      "resolved",
    ]);
  });
});

describe("policy transitions on update", () => {
  type Expect = "none" | "promptOnly" | "medication" | "custom";
  const cases: Array<
    [string, Parameters<typeof makeTask>[1], Record<string, unknown>, Expect, boolean]
  > = [
    [
      "timed to anytime clears the seeded policy",
      { times: ["09:00"] },
      { times: [] },
      "none",
      false,
    ],
    ["anytime to timed restores the default", {}, { times: ["09:00"] }, "promptOnly", false],
    ["reminder to medication", { times: ["09:00"] }, { type: "medication" }, "medication", false],
    [
      "medication to reminder",
      { type: "medication", times: ["09:00"] },
      { type: "reminder" },
      "promptOnly",
      false,
    ],
    ["custom policy kept becoming anytime", { times: ["09:00"] }, { times: [] }, "custom", true],
    [
      "custom policy kept across the medication boundary",
      { times: ["09:00"] },
      { type: "medication" },
      "custom",
      true,
    ],
    [
      "explicit policy wins over the anytime rule",
      { times: ["09:00"] },
      { times: [], escalationPolicyId: "medication" },
      "medication",
      false,
    ],
    [
      "medication to anytime routine",
      { type: "medication", times: ["09:00"] },
      { type: "routine", times: [] },
      "none",
      false,
    ],
  ];

  test.each(cases)("%s", async (_name, create, changes, expected, withCustom) => {
    const f = await setup();
    let custom: Id<"escalationPolicies"> | undefined;
    if (withCustom) {
      custom = await f.t.withIdentity({ subject: "pat" }).mutation(api.tasks.createPolicy, {
        householdId: f.householdId,
        name: "Custom",
        steps: [{ action: "prompt_senior", offsetMinutes: 0, skipIfClaimed: false }],
      });
    }
    const id = await makeTask(f, { ...create, ...(custom ? { escalationPolicyId: custom } : {}) });
    const patch = { ...changes };
    if (patch.escalationPolicyId === "medication") patch.escalationPolicyId = f.medication;
    const after = await updateTask(f, id, patch);
    const want = {
      none: undefined,
      promptOnly: f.promptOnly,
      medication: f.medication,
      custom,
    }[expected];
    expect(after.escalationPolicyId).toBe(want);
  });
});
