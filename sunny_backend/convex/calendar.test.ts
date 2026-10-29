// calendar.test.ts
// Purpose: Tests for calendar.ts with convex-test and a fake clock (vi.setSystemTime drives
// Date.now() inside the functions). Ports the calendar assertions of the pgTAP suite
// (calendar_jobs.test.sql): who may add, update and cancel; validation and normalization;
// created-by provenance; past-time and repeat rules; DST stability of a weekly event;
// update semantics (absent = unchanged, null = cleared, unknown keys rejected); soft
// delete; audit rows; listEvents range limits; and dayView (header, part-of-day
// boundaries, Next up with the 30 minute default, tasks, upcoming). Includes one access
// test per public function: outsiders, viewers and the paired device.
//
// Last modified: 2026-10-29

import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { addEventCore, cancelEventCore, updateEventCore } from "./calendar";
import { isAppError } from "./lib/errors";
import schema from "./schema";

/** Every non-test module in the backend, for the convex-test harness. */
const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);

const NY = "America/New_York";

/**
 * purpose: A fresh in-memory backend.
 * @return: The convex-test harness typed with the schema.
 */
function makeBackend() {
  return convexTest(schema, modules);
}

/** The convex-test harness type, with the schema's table types. */
type TestConvex = ReturnType<typeof makeBackend>;

/**
 * purpose: Epoch ms of a UTC instant.
 * @param iso: (string) ISO instant.
 * @return: (number) Epoch ms.
 */
function at(iso: string): number {
  return Date.parse(iso);
}

/**
 * purpose: Set the fake clock.
 * @param iso: (string) ISO instant.
 * @return: (void)
 */
function setNow(iso: string): void {
  vi.setSystemTime(new Date(iso));
}

/** A household with a primary (user_a), a member, a viewer, a paired device and an outsider. */
interface World {
  t: TestConvex;
  householdId: Id<"households">;
  primary: ReturnType<TestConvex["withIdentity"]>;
  member: ReturnType<TestConvex["withIdentity"]>;
  viewer: ReturnType<TestConvex["withIdentity"]>;
  device: ReturnType<TestConvex["withIdentity"]>;
  outsider: ReturnType<TestConvex["withIdentity"]>;
}

/**
 * purpose: Build the household and its people through the real households functions.
 * @return: (Promise<World>) Harness, household id and one handle per kind of caller.
 */
async function makeWorld(): Promise<World> {
  const t = makeBackend();
  const primary = t.withIdentity({ subject: "user_a" });
  const householdId = await primary.mutation(api.households.create, {
    seniorPreferredName: "Margaret",
    timezone: NY,
    caregiverDisplayName: "Anna",
  });
  const join = async (userId: string, grants: "caregiver_member" | "caregiver_viewer") => {
    const { code } = await primary.mutation(api.households.createJoinCode, {
      householdId,
      grants,
    });
    await t.withIdentity({ subject: userId }).mutation(api.households.redeemJoinCode, { code });
  };
  await join("user_b", "caregiver_member");
  await join("user_c", "caregiver_viewer");
  const { code } = await primary.mutation(api.households.createJoinCode, {
    householdId,
    grants: "home_display",
  });
  await t.mutation(internal.households.pairDevice, { code, userId: "device_1" });
  return {
    t,
    householdId,
    primary,
    member: t.withIdentity({ subject: "user_b" }),
    viewer: t.withIdentity({ subject: "user_c" }),
    device: t.withIdentity({ subject: "device_1", sunny_kind: "device" }),
    outsider: t.withIdentity({ subject: "user_x" }),
  };
}

/**
 * purpose: The application error code of a rejected promise.
 * @param promise: (Promise<unknown>) Call expected to reject.
 * @return: (Promise<string>) The code, or "other" when it is not an application error.
 */
async function errorCode(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (e) {
    for (const code of ["unauthenticated", "forbidden", "not_found", "invalid", "limit"] as const) {
      if (isAppError(e, code)) return code;
    }
    return "other";
  }
  return "none";
}

/**
 * purpose: The message of the application error of a rejected promise.
 * @param promise: (Promise<unknown>) Call expected to reject.
 * @return: (Promise<string>) The message.
 */
async function errorMessage(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (e) {
    return (e as { data: { message: string } }).data.message;
  }
  throw new Error("did not throw");
}

beforeEach(() => {
  vi.useFakeTimers();
  setNow("2027-03-01T12:00:00Z");
});

afterEach(() => {
  vi.useRealTimers();
});

describe("fake clock", () => {
  test("Date.now() inside a function follows vi.setSystemTime", async () => {
    const w = await makeWorld();
    setNow("2027-03-18T13:00:00Z");
    const view = await w.primary.query(api.calendar.dayView, { householdId: w.householdId });
    expect(view.localNow).toBe("2027-03-18T09:00:00");
  });
});

describe("addEvent", () => {
  test("a member adds an event; text is trimmed, blanks are absent, the caregiver is recorded", async () => {
    const w = await makeWorld();
    const event = await w.member.mutation(api.calendar.addEvent, {
      householdId: w.householdId,
      title: " Physiotherapy ",
      onDate: "2027-03-18",
      startTime: "14:00",
      durationMinutes: 60,
      place: " Riverside Clinic ",
      notes: "   ",
      label: "",
    });
    expect(event).toMatchObject({
      title: "Physiotherapy",
      label: "Physiotherapy",
      place: "Riverside Clinic",
      notes: null,
      durationMinutes: 60,
      createdVia: "caregiver",
      cancelled: false,
      nextOccurrence: { localDate: "2027-03-18", startsAt: at("2027-03-18T18:00:00Z") },
    });
    const row = await w.t.run(async (ctx) => await ctx.db.get(event.eventId));
    expect(row?.createdBy).toBe("user_b");
    expect(row?.notes).toBeUndefined();
    expect(row?.label).toBeUndefined();
  });

  test("repeat days are deduplicated and sorted", async () => {
    const w = await makeWorld();
    const event = await w.primary.mutation(api.calendar.addEvent, {
      householdId: w.householdId,
      title: "Walk",
      onDate: "2027-03-08",
      startTime: "10:00",
      repeatDays: [4, 2, 4],
      repeatUntil: "2027-03-25",
    });
    expect(event.repeatDays).toEqual([2, 4]);
  });

  test("the audit row records the insert with title, date, time and provenance", async () => {
    const w = await makeWorld();
    const event = await w.primary.mutation(api.calendar.addEvent, {
      householdId: w.householdId,
      title: "Lunch",
      onDate: "2027-03-19",
      startTime: "12:00",
    });
    const rows = await w.t.run(async (ctx) => await ctx.db.query("auditLog").collect());
    const row = rows.find((r) => r.entity === "event" && r.entityId === event.eventId);
    expect(row).toMatchObject({
      action: "insert",
      actorKind: "caregiver",
      actorUserId: "user_a",
      detail: {
        title: "Lunch",
        startsOn: "2027-03-19",
        startTime: "12:00",
        createdVia: "caregiver",
      },
    });
  });

  test("addEventCore with an agent actor records createdVia agent and honours the explicit now", async () => {
    const w = await makeWorld();
    const event = await w.t.run(
      async (ctx) =>
        await addEventCore(
          ctx,
          { kind: "agent" },
          w.householdId,
          { title: "Walk", onDate: "2027-03-02", startTime: "09:00" },
          at("2027-03-02T10:00:00Z"),
        ),
    );
    expect(event.createdVia).toBe("agent");
    expect(event.nextOccurrence?.localDate).toBe("2027-03-02");
    const row = await w.t.run(async (ctx) => await ctx.db.get(event.eventId));
    expect(row?.createdBy).toBeUndefined();
  });

  test("rejects a one-off event whose start has passed", async () => {
    const w = await makeWorld();
    setNow("2027-03-01T15:00:00Z");
    const call = w.primary.mutation(api.calendar.addEvent, {
      householdId: w.householdId,
      title: "Late",
      onDate: "2027-03-01",
      startTime: "09:00",
    });
    expect(await errorMessage(call)).toBe("That time has already passed");
  });

  test("rejects repeatUntil without repeat days", async () => {
    const w = await makeWorld();
    const call = w.primary.mutation(api.calendar.addEvent, {
      householdId: w.householdId,
      title: "Bad",
      onDate: "2027-03-20",
      startTime: "09:00",
      repeatUntil: "2027-03-30",
    });
    expect(await errorCode(call)).toBe("invalid");
  });

  test("rejects repeatUntil before the start date", async () => {
    const w = await makeWorld();
    const call = w.primary.mutation(api.calendar.addEvent, {
      householdId: w.householdId,
      title: "Bad",
      onDate: "2027-03-20",
      startTime: "09:00",
      repeatDays: [1],
      repeatUntil: "2027-03-19",
    });
    expect(await errorCode(call)).toBe("invalid");
  });

  test.each([
    ["a title over 200 characters", { title: "x".repeat(201) }],
    ["a blank title", { title: "   " }],
    ["a label over 80 characters", { label: "x".repeat(81) }],
    ["a place over 300 characters", { place: "x".repeat(301) }],
    ["a visitor name over 120 characters", { visitorName: "x".repeat(121) }],
    ["notes over 2000 characters", { notes: "x".repeat(2001) }],
    ["a duration of 0", { durationMinutes: 0 }],
    ["a duration over 1440", { durationMinutes: 1441 }],
    ["a fractional duration", { durationMinutes: 1.5 }],
    ["empty repeat days", { repeatDays: [] }],
    ["a repeat day of 8", { repeatDays: [8] }],
    ["a repeat day of 0", { repeatDays: [0] }],
    ["a malformed date", { onDate: "2027-3-18" }],
    ["an impossible date", { onDate: "2027-02-30" }],
    ["a malformed time", { startTime: "2pm" }],
    ["an out of range time", { startTime: "24:00" }],
  ])("rejects %s", async (_name, override) => {
    const w = await makeWorld();
    const call = w.primary.mutation(api.calendar.addEvent, {
      householdId: w.householdId,
      title: "Ok",
      onDate: "2027-03-18",
      startTime: "09:00",
      ...override,
    });
    expect(await errorCode(call)).toBe("invalid");
  });

  test("accepts text exactly at the length limits", async () => {
    const w = await makeWorld();
    const event = await w.primary.mutation(api.calendar.addEvent, {
      householdId: w.householdId,
      title: "x".repeat(200),
      label: "x".repeat(80),
      place: "x".repeat(300),
      visitorName: "x".repeat(120),
      notes: "x".repeat(2000),
      durationMinutes: 1440,
      onDate: "2027-03-18",
      startTime: "09:00",
    });
    expect(event.title).toHaveLength(200);
  });

  test("access: a viewer, the device and an outsider cannot add events", async () => {
    const w = await makeWorld();
    const args = {
      householdId: w.householdId,
      title: "Lunch",
      onDate: "2027-03-19",
      startTime: "12:00",
    };
    expect(await errorCode(w.viewer.mutation(api.calendar.addEvent, args))).toBe("forbidden");
    expect(await errorCode(w.device.mutation(api.calendar.addEvent, args))).toBe("forbidden");
    expect(await errorCode(w.outsider.mutation(api.calendar.addEvent, args))).toBe("forbidden");
    expect(await errorCode(w.t.mutation(api.calendar.addEvent, args))).toBe("unauthenticated");
  });
});

describe("updateEvent", () => {
  /**
   * purpose: A weekly Tuesday and Thursday walk and a one-off physio.
   * @param w: (World) The world.
   * @return: (Promise) Both events.
   */
  async function seed(w: World) {
    const walk = await w.primary.mutation(api.calendar.addEvent, {
      householdId: w.householdId,
      title: "Walk with Sarah",
      onDate: "2027-03-08",
      startTime: "10:00",
      place: "Park",
      repeatDays: [2, 4],
      repeatUntil: "2027-03-25",
    });
    const physio = await w.primary.mutation(api.calendar.addEvent, {
      householdId: w.householdId,
      title: "Physiotherapy",
      onDate: "2027-03-18",
      startTime: "14:00",
      durationMinutes: 60,
    });
    return { walk, physio };
  }

  test("moving the start time moves the next occurrence", async () => {
    const w = await makeWorld();
    const { physio } = await seed(w);
    const updated = await w.primary.mutation(api.calendar.updateEvent, {
      householdId: w.householdId,
      eventId: physio.eventId,
      changes: { startTime: "15:00" },
    });
    expect(updated.nextOccurrence?.startsAt).toBe(at("2027-03-18T19:00:00Z"));
    expect(updated.title).toBe("Physiotherapy");
  });

  test("absent keys are unchanged", async () => {
    const w = await makeWorld();
    const { walk } = await seed(w);
    const updated = await w.primary.mutation(api.calendar.updateEvent, {
      householdId: w.householdId,
      eventId: walk.eventId,
      changes: { title: "Walk with Anna" },
    });
    expect(updated).toMatchObject({
      title: "Walk with Anna",
      place: "Park",
      repeatDays: [2, 4],
      repeatUntil: "2027-03-25",
    });
  });

  test("a key given as null clears the field", async () => {
    const w = await makeWorld();
    const { physio } = await seed(w);
    const updated = await w.primary.mutation(api.calendar.updateEvent, {
      householdId: w.householdId,
      eventId: physio.eventId,
      changes: { durationMinutes: null },
    });
    expect(updated.durationMinutes).toBeNull();
    const row = await w.t.run(async (ctx) => await ctx.db.get(physio.eventId));
    expect(row?.durationMinutes).toBeUndefined();
  });

  test("a blank string clears an optional text field", async () => {
    const w = await makeWorld();
    const { walk } = await seed(w);
    const updated = await w.primary.mutation(api.calendar.updateEvent, {
      householdId: w.householdId,
      eventId: walk.eventId,
      changes: { place: "  " },
    });
    expect(updated.place).toBeNull();
  });

  test("repeatDays null makes a weekly event one-off, and days can be set again", async () => {
    const w = await makeWorld();
    const { walk } = await seed(w);
    const oneOff = await w.primary.mutation(api.calendar.updateEvent, {
      householdId: w.householdId,
      eventId: walk.eventId,
      changes: { repeatDays: null, repeatUntil: null, onDate: "2027-03-30" },
    });
    expect(oneOff.repeatDays).toBeNull();
    expect(oneOff.repeatUntil).toBeNull();
    const weekly = await w.primary.mutation(api.calendar.updateEvent, {
      householdId: w.householdId,
      eventId: walk.eventId,
      changes: { repeatDays: [4, 2], repeatUntil: "2027-03-25", onDate: "2027-03-08" },
    });
    expect(weekly.repeatDays).toEqual([2, 4]);
    const audit = await w.t.run(async (ctx) => await ctx.db.query("auditLog").collect());
    expect(audit.filter((r) => r.entityId === walk.eventId && r.action === "update")).toHaveLength(
      2,
    );
  });

  test("clearing repeatDays while repeatUntil stays is rejected", async () => {
    const w = await makeWorld();
    const { walk } = await seed(w);
    const call = w.primary.mutation(api.calendar.updateEvent, {
      householdId: w.householdId,
      eventId: walk.eventId,
      changes: { repeatDays: null },
    });
    expect(await errorCode(call)).toBe("invalid");
  });

  test("unknown keys are rejected", async () => {
    const w = await makeWorld();
    const { physio } = await seed(w);
    const call = w.primary.mutation(api.calendar.updateEvent, {
      householdId: w.householdId,
      eventId: physio.eventId,
      changes: { color: "red" } as never,
    });
    expect(await errorCode(call)).toBe("other");
  });

  test("a required field cannot be null", async () => {
    const w = await makeWorld();
    const { physio } = await seed(w);
    const call = w.primary.mutation(api.calendar.updateEvent, {
      householdId: w.householdId,
      eventId: physio.eventId,
      changes: { title: null } as never,
    });
    expect(await errorCode(call)).toBe("other");
  });

  test("changing the date to the past is rejected, but other fields are not time checked", async () => {
    const w = await makeWorld();
    const { physio } = await seed(w);
    setNow("2027-03-18T19:00:00Z");
    const moved = w.primary.mutation(api.calendar.updateEvent, {
      householdId: w.householdId,
      eventId: physio.eventId,
      changes: { startTime: "09:00" },
    });
    expect(await errorMessage(moved)).toBe("That time has already passed");
    const retitled = await w.primary.mutation(api.calendar.updateEvent, {
      householdId: w.householdId,
      eventId: physio.eventId,
      changes: { title: "Physio" },
    });
    expect(retitled.title).toBe("Physio");
  });

  test("an event of another household is not found", async () => {
    const w = await makeWorld();
    const { physio } = await seed(w);
    const otherId = await w.outsider.mutation(api.households.create, {
      seniorPreferredName: "Other",
      timezone: NY,
      caregiverDisplayName: "Xavier",
    });
    const call = w.outsider.mutation(api.calendar.updateEvent, {
      householdId: otherId,
      eventId: physio.eventId,
      changes: { title: "Hijack" },
    });
    expect(await errorCode(call)).toBe("not_found");
  });

  test("a cancelled event cannot be changed", async () => {
    const w = await makeWorld();
    const { physio } = await seed(w);
    await w.primary.mutation(api.calendar.cancelEvent, {
      householdId: w.householdId,
      eventId: physio.eventId,
    });
    const call = w.primary.mutation(api.calendar.updateEvent, {
      householdId: w.householdId,
      eventId: physio.eventId,
      changes: { title: "Back" },
    });
    expect(await errorCode(call)).toBe("not_found");
  });

  test("updateEventCore runs with an agent actor and explicit now", async () => {
    const w = await makeWorld();
    const { physio } = await seed(w);
    const updated = await w.t.run(
      async (ctx) =>
        await updateEventCore(
          ctx,
          { kind: "agent" },
          w.householdId,
          physio.eventId,
          { place: "Home" },
          at("2027-03-10T12:00:00Z"),
        ),
    );
    expect(updated.place).toBe("Home");
    const audit = await w.t.run(async (ctx) => await ctx.db.query("auditLog").collect());
    const row = audit.find((r) => r.action === "update");
    expect(row?.actorKind).toBe("agent");
    expect(row?.actorUserId).toBeUndefined();
  });

  test("access: a viewer, the device and an outsider cannot update events", async () => {
    const w = await makeWorld();
    const { physio } = await seed(w);
    const args = { householdId: w.householdId, eventId: physio.eventId, changes: { title: "x" } };
    expect(await errorCode(w.viewer.mutation(api.calendar.updateEvent, args))).toBe("forbidden");
    expect(await errorCode(w.device.mutation(api.calendar.updateEvent, args))).toBe("forbidden");
    expect(await errorCode(w.outsider.mutation(api.calendar.updateEvent, args))).toBe("forbidden");
  });
});

describe("cancelEvent", () => {
  test("a member cancels an event; it disappears from listings and cannot be cancelled again", async () => {
    const w = await makeWorld();
    const lunch = await w.primary.mutation(api.calendar.addEvent, {
      householdId: w.householdId,
      title: "Lunch with Ann",
      onDate: "2027-03-18",
      startTime: "12:00",
    });
    const cancelled = await w.member.mutation(api.calendar.cancelEvent, {
      householdId: w.householdId,
      eventId: lunch.eventId,
    });
    expect(cancelled.cancelled).toBe(true);
    const row = await w.t.run(async (ctx) => await ctx.db.get(lunch.eventId));
    expect(row?.deletedAt).toBeGreaterThanOrEqual(at("2027-03-01T12:00:00Z"));
    expect(row?.deletedAt).toBeLessThan(at("2027-03-01T12:00:01Z"));
    const listed = await w.primary.query(api.calendar.listEvents, {
      householdId: w.householdId,
      from: "2027-03-18",
      to: "2027-03-18",
    });
    expect(listed).toHaveLength(0);
    const again = w.primary.mutation(api.calendar.cancelEvent, {
      householdId: w.householdId,
      eventId: lunch.eventId,
    });
    expect(await errorCode(again)).toBe("not_found");
  });

  test("changes are audited with the cancellation named", async () => {
    const w = await makeWorld();
    const lunch = await w.primary.mutation(api.calendar.addEvent, {
      householdId: w.householdId,
      title: "Lunch",
      onDate: "2027-03-18",
      startTime: "12:00",
    });
    await w.primary.mutation(api.calendar.cancelEvent, {
      householdId: w.householdId,
      eventId: lunch.eventId,
    });
    const rows = await w.t.run(async (ctx) => await ctx.db.query("auditLog").collect());
    expect(rows.filter((r) => r.entityId === lunch.eventId).map((r) => r.action)).toEqual([
      "insert",
      "cancel",
    ]);
  });

  test("an event of another household is not found", async () => {
    const w = await makeWorld();
    const lunch = await w.primary.mutation(api.calendar.addEvent, {
      householdId: w.householdId,
      title: "Lunch",
      onDate: "2027-03-18",
      startTime: "12:00",
    });
    const otherId = await w.outsider.mutation(api.households.create, {
      seniorPreferredName: "Other",
      timezone: NY,
      caregiverDisplayName: "Xavier",
    });
    const call = w.outsider.mutation(api.calendar.cancelEvent, {
      householdId: otherId,
      eventId: lunch.eventId,
    });
    expect(await errorCode(call)).toBe("not_found");
  });

  test("cancelEventCore runs with an agent actor and records its now", async () => {
    const w = await makeWorld();
    const lunch = await w.primary.mutation(api.calendar.addEvent, {
      householdId: w.householdId,
      title: "Lunch",
      onDate: "2027-03-18",
      startTime: "12:00",
    });
    await w.t.run(
      async (ctx) =>
        await cancelEventCore(
          ctx,
          { kind: "agent" },
          w.householdId,
          lunch.eventId,
          at("2027-03-05T00:00:00Z"),
        ),
    );
    const row = await w.t.run(async (ctx) => await ctx.db.get(lunch.eventId));
    expect(row?.deletedAt).toBe(at("2027-03-05T00:00:00Z"));
  });

  test("access: a viewer, the device and an outsider cannot cancel events", async () => {
    const w = await makeWorld();
    const lunch = await w.primary.mutation(api.calendar.addEvent, {
      householdId: w.householdId,
      title: "Lunch",
      onDate: "2027-03-18",
      startTime: "12:00",
    });
    const args = { householdId: w.householdId, eventId: lunch.eventId };
    expect(await errorCode(w.viewer.mutation(api.calendar.cancelEvent, args))).toBe("forbidden");
    expect(await errorCode(w.device.mutation(api.calendar.cancelEvent, args))).toBe("forbidden");
    expect(await errorCode(w.outsider.mutation(api.calendar.cancelEvent, args))).toBe("forbidden");
  });
});

describe("listEvents", () => {
  test("a weekly event stays at 10:00 local across spring-forward and stops at repeatUntil", async () => {
    const w = await makeWorld();
    await w.primary.mutation(api.calendar.addEvent, {
      householdId: w.householdId,
      title: "Walk",
      onDate: "2027-03-08",
      startTime: "10:00",
      repeatDays: [2, 4],
      repeatUntil: "2027-03-25",
    });
    const out = await w.primary.query(api.calendar.listEvents, {
      householdId: w.householdId,
      from: "2027-03-08",
      to: "2027-03-31",
    });
    expect(out.map((o) => [o.localDate, o.startsAt])).toEqual([
      ["2027-03-09", at("2027-03-09T15:00:00Z")],
      ["2027-03-11", at("2027-03-11T15:00:00Z")],
      ["2027-03-16", at("2027-03-16T14:00:00Z")],
      ["2027-03-18", at("2027-03-18T14:00:00Z")],
      ["2027-03-23", at("2027-03-23T14:00:00Z")],
      ["2027-03-25", at("2027-03-25T14:00:00Z")],
    ]);
  });

  test("a one-off event has its end from the duration; occurrences are earliest first", async () => {
    const w = await makeWorld();
    await w.primary.mutation(api.calendar.addEvent, {
      householdId: w.householdId,
      title: "Later",
      onDate: "2027-03-18",
      startTime: "16:00",
    });
    await w.primary.mutation(api.calendar.addEvent, {
      householdId: w.householdId,
      title: "Physiotherapy",
      onDate: "2027-03-18",
      startTime: "14:00",
      durationMinutes: 60,
    });
    const out = await w.primary.query(api.calendar.listEvents, {
      householdId: w.householdId,
      from: "2027-03-18",
      to: "2027-03-18",
    });
    expect(out.map((o) => o.title)).toEqual(["Physiotherapy", "Later"]);
    expect(out[0]!.endsAt).toBe(at("2027-03-18T19:00:00Z"));
    expect(out[1]!.endsAt).toBeNull();
  });

  test("the range is limited to 0 to 92 days", async () => {
    const w = await makeWorld();
    const list = (from: string, to: string) =>
      w.primary.query(api.calendar.listEvents, { householdId: w.householdId, from, to });
    expect(await list("2027-03-01", "2027-03-01")).toEqual([]);
    expect(await list("2027-01-01", "2027-04-03")).toEqual([]);
    expect(await errorMessage(list("2027-01-01", "2027-04-04"))).toBe(
      "Date range must be 0 to 92 days",
    );
    expect(await errorCode(list("2027-03-02", "2027-03-01"))).toBe("invalid");
    expect(await errorCode(list("2027-03-01", "soon"))).toBe("invalid");
  });

  test("access: every caregiver role and the paired device can read; an outsider cannot", async () => {
    const w = await makeWorld();
    const args = { householdId: w.householdId, from: "2027-03-01", to: "2027-03-31" };
    expect(await w.viewer.query(api.calendar.listEvents, args)).toEqual([]);
    expect(await w.member.query(api.calendar.listEvents, args)).toEqual([]);
    expect(await w.device.query(api.calendar.listEvents, args)).toEqual([]);
    expect(await errorCode(w.outsider.query(api.calendar.listEvents, args))).toBe("forbidden");
    expect(await errorCode(w.t.query(api.calendar.listEvents, args))).toBe("unauthenticated");
  });
});

describe("dayView", () => {
  /**
   * purpose: A weekly Tuesday and Thursday 10:00 walk (no duration) and a 14:00 physio of 60
   *          minutes, both on Thursday 2027-03-18; the clock is left on 2027-03-01.
   * @param w: (World) The world.
   * @return: (Promise<void>) Resolves when added.
   */
  async function seed(w: World): Promise<void> {
    await w.primary.mutation(api.calendar.addEvent, {
      householdId: w.householdId,
      title: "Walk with Sarah",
      onDate: "2027-03-08",
      startTime: "10:00",
      repeatDays: [2, 4],
      repeatUntil: "2027-03-25",
    });
    await w.primary.mutation(api.calendar.addEvent, {
      householdId: w.householdId,
      title: "Physiotherapy",
      label: "Physio",
      onDate: "2027-03-18",
      startTime: "14:00",
      durationMinutes: 60,
    });
  }

  /**
   * purpose: The day view at an instant.
   * @param w: (World) The world.
   * @param iso: (string) ISO instant to set the clock to.
   * @return: (Promise) The day view.
   */
  async function viewAt(w: World, iso: string) {
    setNow(iso);
    return await w.primary.query(api.calendar.dayView, { householdId: w.householdId });
  }

  test("at 9 AM Thursday the view shows the date, header, walk next and both of today's events", async () => {
    const w = await makeWorld();
    await seed(w);
    const view = await viewAt(w, "2027-03-18T13:00:00Z");
    expect(view).toMatchObject({
      seniorPreferredName: "Margaret",
      timezone: NY,
      localNow: "2027-03-18T09:00:00",
      localDate: "2027-03-18",
      weekday: "Thursday",
      dateLabel: "March 18",
      header: "Thursday morning",
    });
    expect(view.nextUp?.title).toBe("Walk with Sarah");
    expect(view.eventsToday.map((e) => e.title)).toEqual(["Walk with Sarah", "Physiotherapy"]);
    expect(view.tasks).toEqual([]);
  });

  test("an event without a duration stays Next up for 30 minutes, then the next takes over", async () => {
    const w = await makeWorld();
    await seed(w);
    expect((await viewAt(w, "2027-03-18T14:29:00Z")).nextUp?.title).toBe("Walk with Sarah");
    expect((await viewAt(w, "2027-03-18T14:30:00Z")).nextUp?.label).toBe("Physio");
    expect((await viewAt(w, "2027-03-18T14:31:00Z")).nextUp?.label).toBe("Physio");
  });

  test("an event with a duration stays Next up until it ends", async () => {
    const w = await makeWorld();
    await seed(w);
    expect((await viewAt(w, "2027-03-18T18:59:00Z")).nextUp?.title).toBe("Physiotherapy");
    const after = await viewAt(w, "2027-03-18T19:00:00Z");
    expect(after.nextUp?.localDate).toBe("2027-03-23");
  });

  test("Next up reaches into the coming days, and upcoming lists the week after today", async () => {
    const w = await makeWorld();
    await seed(w);
    const view = await viewAt(w, "2027-03-18T20:00:00Z");
    expect(view.nextUp?.localDate).toBe("2027-03-23");
    expect(view.upcoming.map((u) => u.localDate)).toEqual(["2027-03-23", "2027-03-25"]);
    const evening = await viewAt(w, "2027-03-22T12:00:00Z");
    expect(evening.nextUp).toMatchObject({ title: "Walk with Sarah", localDate: "2027-03-23" });
    expect(evening.eventsToday).toEqual([]);
  });

  test("an event more than 7 days ahead is not shown", async () => {
    const w = await makeWorld();
    await w.primary.mutation(api.calendar.addEvent, {
      householdId: w.householdId,
      title: "Far",
      onDate: "2027-03-26",
      startTime: "09:00",
    });
    expect((await viewAt(w, "2027-03-18T12:00:00Z")).nextUp).toBeNull();
    expect((await viewAt(w, "2027-03-19T12:00:00Z")).nextUp?.title).toBe("Far");
  });

  test("part of day boundaries (America/New_York, daylight time)", async () => {
    const w = await makeWorld();
    const cases: [string, string][] = [
      ["2027-03-18T08:59:00Z", "Thursday night"],
      ["2027-03-18T09:00:00Z", "Thursday morning"],
      ["2027-03-18T15:59:00Z", "Thursday morning"],
      ["2027-03-18T16:00:00Z", "Thursday afternoon"],
      ["2027-03-18T20:59:00Z", "Thursday afternoon"],
      ["2027-03-18T21:00:00Z", "Thursday evening"],
      ["2027-03-19T00:59:00Z", "Thursday evening"],
      ["2027-03-19T01:00:00Z", "Thursday night"],
      ["2027-03-19T02:30:00Z", "Thursday night"],
    ];
    for (const [iso, header] of cases) {
      expect((await viewAt(w, iso)).header).toBe(header);
    }
  });

  test("today is the household-local date, not the UTC date", async () => {
    const w = await makeWorld();
    const view = await viewAt(w, "2027-03-19T02:30:00Z");
    expect(view.localDate).toBe("2027-03-18");
    expect(view.dateLabel).toBe("March 18");
  });

  test("cancelled events disappear from the view", async () => {
    const w = await makeWorld();
    const lunch = await w.primary.mutation(api.calendar.addEvent, {
      householdId: w.householdId,
      title: "Lunch",
      onDate: "2027-03-18",
      startTime: "12:00",
    });
    await w.primary.mutation(api.calendar.cancelEvent, {
      householdId: w.householdId,
      eventId: lunch.eventId,
    });
    const view = await viewAt(w, "2027-03-18T12:00:00Z");
    expect(view.eventsToday).toEqual([]);
    expect(view.nextUp).toBeNull();
  });

  test("includes today's task instances in window order", async () => {
    const w = await makeWorld();
    await w.t.run(async (ctx) => {
      const taskId = await ctx.db.insert("tasks", {
        householdId: w.householdId,
        type: "medication",
        title: "Morning pills",
        displayLabel: "Morning pills",
        spokenPrompt: "Time for your morning pills.",
        checklistItems: [],
        times: ["08:00", "20:00"],
        windowMinutes: 60,
        createdByKind: "caregiver",
        active: true,
        scheduleChangedAt: 0,
      });
      const base = {
        taskId,
        householdId: w.householdId,
        localDate: "2027-03-18",
        state: "upcoming" as const,
        createdAt: 0,
        firedSteps: [],
      };
      await ctx.db.insert("taskInstances", {
        ...base,
        scheduledTime: "20:00",
        windowStart: at("2027-03-19T00:00:00Z"),
        windowEnd: at("2027-03-19T01:00:00Z"),
      });
      await ctx.db.insert("taskInstances", {
        ...base,
        scheduledTime: "08:00",
        windowStart: at("2027-03-18T12:00:00Z"),
        windowEnd: at("2027-03-18T13:00:00Z"),
      });
    });
    const view = await viewAt(w, "2027-03-18T13:00:00Z");
    expect(view.tasks.map((t) => t.scheduledTime)).toEqual(["08:00", "20:00"]);
    expect(view.tasks[0]!.displayLabel).toBe("Morning pills");
  });

  test("the minute argument is ignored", async () => {
    const w = await makeWorld();
    setNow("2027-03-18T13:00:00Z");
    const a = await w.primary.query(api.calendar.dayView, { householdId: w.householdId });
    const b = await w.primary.query(api.calendar.dayView, {
      householdId: w.householdId,
      minute: 123,
    });
    expect(b).toEqual(a);
  });

  test("access: the paired device, a viewer and a member can read; an outsider cannot", async () => {
    const w = await makeWorld();
    const args = { householdId: w.householdId };
    expect((await w.device.query(api.calendar.dayView, args)).seniorPreferredName).toBe("Margaret");
    expect((await w.viewer.query(api.calendar.dayView, args)).timezone).toBe(NY);
    expect((await w.member.query(api.calendar.dayView, args)).timezone).toBe(NY);
    expect(await errorCode(w.outsider.query(api.calendar.dayView, args))).toBe("forbidden");
    expect(await errorCode(w.t.query(api.calendar.dayView, args))).toBe("unauthenticated");
  });
});
