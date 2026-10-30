// eventNotices.test.ts
// Purpose: Tests for the day-of event notices (lib/eventNotices.ts, run from the per-household
// scheduler tick), ported from the "Day-of notices" section of
// the former Supabase calendar job tests and extended: nothing before the household's notice
// time, announcement at the notice time, events later that day versus already started, an
// event added after the notice time announced on the next tick, once per occurrence, a weekly
// repeat giving one notice per day, cancelled events, every member (not devices) receiving one
// outbox row with the SQL wording and a camelCase payload, the DST change day, a timezone far
// from UTC where local today differs from UTC today, and paused households (the SQL does not
// skip them). The clock is driven by passing `now` to tickHousehold.
//
// Last modified: 2026-10-29

import { describe, expect, test, vi } from "vitest";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { createFamilyHousehold, insertEvent, makeBackend } from "./testing.helpers";
import type { TestConvex } from "./testing.helpers";

/** A household with Pat (primary), Max (member), Val (viewer) and one paired device. */
interface Fixture {
  t: TestConvex;
  householdId: Id<"households">;
}

/**
 * purpose: Build the standard household in the given timezone.
 * @param timezone: (string) IANA zone of the household.
 * @return: (Promise<Fixture>) The fixture.
 */
async function setup(timezone = "America/New_York"): Promise<Fixture> {
  const t = makeBackend();
  return { t, householdId: await createFamilyHousehold(t, timezone) };
}

/**
 * purpose: Insert an event directly.
 * @param f: (Fixture) Fixture.
 * @param fields: (object) Event fields; title, startsOn and startTime are required.
 * @return: (Promise<Id<"events">>) The event.
 */
async function addEvent(
  f: Fixture,
  fields: Partial<Doc<"events">> & { title: string; startsOn: string; startTime: string },
): Promise<Id<"events">> {
  return await insertEvent(f.t, f.householdId, fields);
}

/**
 * purpose: Run the household's scheduler tick at an instant.
 * @param f: (Fixture) Fixture.
 * @param iso: (string) UTC instant.
 * @return: (Promise<number>) Occurrences announced.
 */
async function tickAt(f: Fixture, iso: string): Promise<number> {
  const result = await f.t.mutation(internal.scheduler.tickHousehold, {
    householdId: f.householdId,
    now: Date.parse(iso),
  });
  return result.noticed;
}

/**
 * purpose: All event_notice outbox rows of the household.
 * @param f: (Fixture) Fixture.
 * @return: (Promise<Doc<"notificationOutbox">[]>) Rows.
 */
async function notices(f: Fixture): Promise<Doc<"notificationOutbox">[]> {
  const rows = await f.t.run(async (ctx) => await ctx.db.query("notificationOutbox").collect());
  return rows.filter((r) => r.kind === "event_notice");
}

describe("event notices", () => {
  test("nothing before the notice time, announced at it", async () => {
    const f = await setup();
    await addEvent(f, { title: "Physiotherapy", startsOn: "2027-03-18", startTime: "15:00" });
    expect(await tickAt(f, "2027-03-18T11:59:00Z")).toBe(0);
    expect(await notices(f)).toHaveLength(0);
    expect(await tickAt(f, "2027-03-18T12:00:00Z")).toBe(1);
    expect(await notices(f)).toHaveLength(3);
  });

  test("uses the SQL wording and a camelCase payload", async () => {
    const f = await setup();
    const eventId = await addEvent(f, {
      title: "Physiotherapy",
      startsOn: "2027-03-18",
      startTime: "15:00",
      place: "Riverside Clinic",
    });
    await tickAt(f, "2027-03-18T12:00:00Z");
    const [row] = await notices(f);
    expect(row!.title).toBe("Today: Physiotherapy at 3:00 PM");
    expect(row!.body).toBe("Mom has Physiotherapy at 3:00 PM today at Riverside Clinic.");
    expect(row!.payload).toEqual({ eventId, localDate: "2027-03-18" });
    expect(row!.eventId).toBe(eventId);
    expect(row!.householdId).toBe(f.householdId);
  });

  test("the body has no place clause when the event has no place", async () => {
    const f = await setup();
    await addEvent(f, { title: "Haircut", startsOn: "2027-03-18", startTime: "09:30" });
    await tickAt(f, "2027-03-18T12:00:00Z");
    expect((await notices(f))[0]!.body).toBe("Mom has Haircut at 9:30 AM today.");
  });

  test("every member gets one row and devices get none", async () => {
    const f = await setup();
    await addEvent(f, { title: "Physiotherapy", startsOn: "2027-03-18", startTime: "15:00" });
    await tickAt(f, "2027-03-18T12:00:00Z");
    const rows = await notices(f);
    expect(rows.map((r) => r.recipientUserId).sort()).toEqual(["max", "pat", "val"]);
    expect(rows.every((r) => r.recipientDeviceId === undefined)).toBe(true);
  });

  test("an event that already started is not announced, a later one is", async () => {
    const f = await setup();
    await addEvent(f, { title: "Coffee", startsOn: "2027-03-18", startTime: "11:05" });
    await addEvent(f, { title: "Haircut", startsOn: "2027-03-18", startTime: "16:00" });
    expect(await tickAt(f, "2027-03-18T15:06:00Z")).toBe(1);
    const rows = await notices(f);
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.title.includes("Haircut"))).toBe(true);
  });

  test("an event added after the notice time is announced on the next tick", async () => {
    const f = await setup();
    await addEvent(f, { title: "Physiotherapy", startsOn: "2027-03-18", startTime: "15:00" });
    expect(await tickAt(f, "2027-03-18T12:00:00Z")).toBe(1);
    await addEvent(f, { title: "Haircut", startsOn: "2027-03-18", startTime: "17:00" });
    expect(await tickAt(f, "2027-03-18T14:00:00Z")).toBe(1);
    expect(await notices(f)).toHaveLength(6);
  });

  test("each occurrence is announced once", async () => {
    const f = await setup();
    await addEvent(f, { title: "Physiotherapy", startsOn: "2027-03-18", startTime: "15:00" });
    expect(await tickAt(f, "2027-03-18T12:00:00Z")).toBe(1);
    expect(await tickAt(f, "2027-03-18T12:01:00Z")).toBe(0);
    expect(await notices(f)).toHaveLength(3);
    const marks = await f.t.run(async (ctx) => await ctx.db.query("eventNotices").collect());
    expect(marks).toHaveLength(1);
    expect(marks[0]!.localDate).toBe("2027-03-18");
  });

  test("a weekly repeat gives one notice per day it occurs", async () => {
    const f = await setup();
    // 2027-03-18 is a Thursday (4); the repeat is Thursday and Friday.
    await addEvent(f, {
      title: "Walk",
      startsOn: "2027-03-01",
      startTime: "15:00",
      repeatDays: [4, 5],
    });
    expect(await tickAt(f, "2027-03-18T12:00:00Z")).toBe(1);
    expect(await tickAt(f, "2027-03-18T13:00:00Z")).toBe(0);
    expect(await tickAt(f, "2027-03-19T12:00:00Z")).toBe(1);
    expect(await tickAt(f, "2027-03-20T12:00:00Z")).toBe(0);
    expect(await notices(f)).toHaveLength(6);
  });

  test("a repeat past its end date is not announced", async () => {
    const f = await setup();
    await addEvent(f, {
      title: "Walk",
      startsOn: "2027-03-01",
      startTime: "15:00",
      repeatDays: [4],
      repeatUntil: "2027-03-11",
    });
    expect(await tickAt(f, "2027-03-18T12:00:00Z")).toBe(0);
  });

  test("a cancelled event is not announced, and notices already queued stay", async () => {
    const f = await setup();
    const cancelled = await addEvent(f, {
      title: "Dentist",
      startsOn: "2027-03-18",
      startTime: "14:00",
    });
    await addEvent(f, { title: "Physiotherapy", startsOn: "2027-03-18", startTime: "15:00" });
    await f.t.run(async (ctx) => await ctx.db.patch(cancelled, { deletedAt: 1 }));
    expect(await tickAt(f, "2027-03-18T12:00:00Z")).toBe(1);
    expect((await notices(f)).every((r) => r.title.includes("Physiotherapy"))).toBe(true);
    await f.t.run(async (ctx) => {
      const live = await ctx.db
        .query("events")
        .collect()
        .then((all) => all.find((e) => e.title === "Physiotherapy")!);
      await ctx.db.patch(live._id, { deletedAt: 2 });
    });
    expect(await tickAt(f, "2027-03-18T12:05:00Z")).toBe(0);
    expect(await notices(f)).toHaveLength(3);
  });

  test("the notice time is the household's own", async () => {
    const f = await setup();
    await f.t.run(async (ctx) => await ctx.db.patch(f.householdId, { eventNoticeTime: "10:30" }));
    await addEvent(f, { title: "Physiotherapy", startsOn: "2027-03-18", startTime: "15:00" });
    expect(await tickAt(f, "2027-03-18T14:29:00Z")).toBe(0);
    expect(await tickAt(f, "2027-03-18T14:30:00Z")).toBe(1);
  });

  test("the DST change day follows local time", async () => {
    const f = await setup();
    // New York springs forward on 2027-03-14: 08:00 is 12:00Z (EDT) that day, 13:00Z the day before.
    await addEvent(f, { title: "Brunch", startsOn: "2027-03-13", startTime: "12:00" });
    await addEvent(f, { title: "Lunch", startsOn: "2027-03-14", startTime: "12:00" });
    expect(await tickAt(f, "2027-03-13T12:59:00Z")).toBe(0);
    expect(await tickAt(f, "2027-03-13T13:00:00Z")).toBe(1);
    expect(await tickAt(f, "2027-03-14T11:59:00Z")).toBe(0);
    expect(await tickAt(f, "2027-03-14T12:00:00Z")).toBe(1);
    const rows = await notices(f);
    expect(rows.map((r) => r.payload.localDate).sort()).toEqual([
      "2027-03-13",
      "2027-03-13",
      "2027-03-13",
      "2027-03-14",
      "2027-03-14",
      "2027-03-14",
    ]);
  });

  test("a zone far from UTC uses its own local today", async () => {
    const f = await setup("Pacific/Auckland");
    // 2027-03-17 20:00Z is 2027-03-18 09:00 in Auckland (UTC+13).
    await addEvent(f, { title: "Bowls", startsOn: "2027-03-18", startTime: "15:00" });
    await addEvent(f, { title: "Yesterday", startsOn: "2027-03-17", startTime: "15:00" });
    expect(await tickAt(f, "2027-03-17T18:59:00Z")).toBe(0);
    expect(await tickAt(f, "2027-03-17T20:00:00Z")).toBe(1);
    const rows = await notices(f);
    expect(rows).toHaveLength(3);
    expect(rows[0]!.payload.localDate).toBe("2027-03-18");
  });

  test("a paused household is still announced, as in the SQL", async () => {
    const f = await setup();
    await f.t.run(async (ctx) => await ctx.db.patch(f.householdId, { backgroundPaused: true }));
    await addEvent(f, { title: "Physiotherapy", startsOn: "2027-03-18", startTime: "15:00" });
    expect(await tickAt(f, "2027-03-18T12:00:00Z")).toBe(1);
  });

  test("the cron fan-out schedules tickHousehold, which runs the notice pass", async () => {
    const f = await setup();
    await addEvent(f, { title: "Physiotherapy", startsOn: "2027-03-18", startTime: "15:00" });
    vi.useFakeTimers();
    try {
      await f.t.mutation(internal.scheduler.tick, { now: Date.parse("2027-03-18T12:00:00Z") });
      await f.t.finishAllScheduledFunctions(vi.runAllTimers);
    } finally {
      vi.useRealTimers();
    }
    expect(await notices(f)).toHaveLength(3);
  });
});
