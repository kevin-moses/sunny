// undoReopen.test.ts
// Purpose: Tests for the two ways back out of a confirm: undoPressedTask (a senior device takes
// back its own Done press for 60 seconds) and reopenTaskInstance (an editor caregiver reopens a
// task confirmed or resolved earlier today). The pure rules in lib/confirmRule.ts (seniorCanUndo,
// caregiverCanReopen, reopenedState) are tested directly, then through the mutations.
// Undo: restores the exact prior state (due, escalated, an early upcoming confirm, a snooze),
// allows an offline replayed press by the time the server recorded it, returns too_late
// (leaving the instance unchanged and writing an undo_not_applied row) for a late tap, another device's confirm, a voice-agent
// confirm, a caregiver's resolve and an instance that is gone, throws forbidden for another
// household, a caregiver or a viewer, falls back to the clock when no prior state was recorded,
// and audits the change with undo: true. Also: the caregiver's undoResolve still refuses a
// device's confirm. Reopen: from confirmed and from resolved, the three clock outcomes
// (before the window, inside it, at or after its end), the recorded prior state, anytime
// instances, confirmed yesterday refused, not-done refused, viewers, devices and other
// households forbidden, note and claim kept, the audit detail, the ladder continuing without
// repeating fired steps, and the day view's `reopenable` flag agreeing with the mutation.
// The clock is faked; the scheduler is driven through tickHousehold with an explicit now.
//
// Take-back stamp: a press made before an undo or reopen that a device's queue replays is
// rejected and audited, a fresh press confirms, a caregiver's Mark done still resolves. Also:
// undo twice, undo then reopen, a signed-out caller, a new confirm after a reopen, undo of a
// late confirm of a missed task, the clock fallback before and after the window, a slow
// press already past the undo window, a task confirmed the evening before reopened after
// midnight, and a deactivated, anytime, moved or deleted task (timed or anytime instance)
// refused by reopen and undo inside the undo window. Also: an Undo tapped offline (undoneAgoMs:
// judged at the tap time; Done, Undo, Done delivered in order ends confirmed), a reopen that
// stamps only a device confirm, and the exact pressWasTakenBack boundary.
//
// Press ids: the three lost-Done scenarios (a press resent at reconnect then Undo then Done; a
// resent undo after a later press; Done just after Undo on a slow network) end confirmed with
// ids and behave as before without them; a resend of an undone id is refused; an undo of
// another id is too_late; the last 8 taken-back ids are kept; after a caregiver reopen the time
// rule still refuses an older press with an id; a reopen of a device confirm records its id, so
// a resend of that press (age 0) is refused, also after a later undo by the device, while a
// reopen of a confirm without an id or of a caregiver's resolve leaves the list as it was; the
// confirm stores and the undo clears the id; a same-device no-op press joins confirmPressIds
// (not audited) and its Undo applies, while a no-op from another device, on another device's
// confirm or on a caregiver's resolve adds nothing; the cap of 4 keeps the confirming press;
// after a take-back a resend of any id of the confirmation is refused ("This press was taken
// back"); a reopen takes back and audits every id; an old-format undo audits the ids it took
// back; an invalid id on a no-op is never stored; a too_late undo writes undo_not_applied; a
// 100,000-character id leaves a small row without the id (missing and existing instance);
// confirmInstance refuses a press id from a caregiver actor; an invalid id for another
// household's instance is forbidden with no audit row and no raw id; the day entry (dayView and
// agent.today) carries confirmPressIds through confirm, a same-device no-op and an undo;
// invalid ids are refused; the id is audited on the confirm, the undo and a refused press; and
// queuedPressTakenBack and withTakenBackPressIds directly.
//
// Last modified: 2026-11-14

import workpoolTest from "@convex-dev/workpool/test";
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { confirmInstance } from "./instances";
import {
  MAX_CONFIRM_PRESS_IDS,
  MAX_TAKEN_BACK_PRESS_IDS,
  PRESS_BEFORE_TAKE_BACK,
  PRESS_ID_NOT_VALID,
  PRESS_TAKEN_BACK,
  withConfirmPressId,
  SENIOR_UNDO_MS,
  caregiverCanReopen,
  pressWasTakenBack,
  queuedPressTakenBack,
  reopenedState,
  seniorCanUndo,
  withTakenBackPressIds,
} from "./lib/confirmRule";
import schema from "./schema";

/** Every non-test module in the backend, for the convex-test harness. */
const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts", "!./**/*.helpers.ts"]);

/** The voice agent: acts for no caregiver, so its confirms have no confirmedBy. */
const AGENT = { kind: "agent" } as const;

/** The 08:00 task on 2027-03-14 (New York, daylight time): window 12:00Z to 13:00Z. */
const WINDOW_START = Date.parse("2027-03-14T12:00:00Z");
const WINDOW_END = Date.parse("2027-03-14T13:00:00Z");
const MINUTE = 60_000;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
});

afterEach(() => {
  vi.useRealTimers();
});

/**
 * purpose: Set the faked clock.
 * @param iso: (string) UTC instant.
 * @return: (number) The same instant in epoch ms.
 */
function at(iso: string): number {
  vi.setSystemTime(new Date(iso));
  return Date.parse(iso);
}

/**
 * purpose: A fresh in-memory backend.
 * @return: The convex-test harness typed with the schema.
 */
function makeBackend() {
  const t = convexTest(schema, modules);
  workpoolTest.register(t, "deliveryPool");
  return t;
}

/** The convex-test harness type. */
type TestConvex = ReturnType<typeof makeBackend>;

/** Household with Pat (primary), Max (member), Val (viewer), a phone and a display. */
interface Fixture {
  t: TestConvex;
  householdId: Id<"households">;
  medication: Id<"escalationPolicies">;
  instanceId: Id<"taskInstances">;
}

/**
 * purpose: Pair a device through a join code.
 * @param t: (TestConvex) Harness.
 * @param householdId: (Id<"households">) Household.
 * @param owner: (string) Subject of a primary caregiver of that household.
 * @param userId: (string) Device user id.
 * @param grants: ("senior_phone" | "home_display") Device kind.
 * @return: (Promise<void>)
 */
async function pair(
  t: TestConvex,
  householdId: Id<"households">,
  owner: string,
  userId: string,
  grants: "senior_phone" | "home_display",
): Promise<void> {
  const { code } = await t
    .withIdentity({ subject: owner })
    .mutation(api.households.createJoinCode, { householdId, grants });
  await t.mutation(internal.households.pairDevice, { code, userId });
}

/**
 * purpose: Build the household with the 08:00 medication task at a faked time.
 * @param iso: (string) UTC instant to start the clock at.
 * @param times: (string[]) The task's times; empty makes an anytime reminder instead.
 * @return: (Promise<Fixture>) The fixture; instanceId is the day's only instance.
 */
async function setup(iso = "2027-03-14T11:00:00Z", times: string[] = ["08:00"]): Promise<Fixture> {
  at(iso);
  const t = makeBackend();
  const pat = t.withIdentity({ subject: "pat" });
  const householdId = await pat.mutation(api.households.create, {
    seniorPreferredName: "Mom",
    timezone: "America/New_York",
    caregiverDisplayName: "Pat",
  });
  for (const [user, grants] of [
    ["max", "caregiver_member"],
    ["val", "caregiver_viewer"],
  ] as const) {
    const { code } = await pat.mutation(api.households.createJoinCode, { householdId, grants });
    await t.withIdentity({ subject: user }).mutation(api.households.redeemJoinCode, { code });
  }
  await pair(t, householdId, "pat", "phone", "senior_phone");
  await pair(t, householdId, "pat", "display", "home_display");
  const policies = await pat.query(api.tasks.listPolicies, { householdId });
  const medication = policies.find((p) => p.systemKey === "medication")!._id;
  await pat.mutation(api.tasks.create, {
    householdId,
    type: times.length > 0 ? "medication" : "reminder",
    title: "Morning pills",
    displayLabel: "Morning pills",
    times,
    escalationPolicyId: times.length > 0 ? medication : undefined,
  });
  const rows = await t.run(async (ctx) => await ctx.db.query("taskInstances").collect());
  return { t, householdId, medication, instanceId: rows[0]!._id };
}

/**
 * purpose: Run the scheduler for the fixture's household at an instant.
 * @param f: (Fixture) Fixture.
 * @param iso: (string) UTC instant.
 * @return: (Promise<void>)
 */
async function tick(f: Fixture, iso: string): Promise<void> {
  await f.t.mutation(internal.scheduler.tickHousehold, {
    householdId: f.householdId,
    now: Date.parse(iso),
  });
}

/**
 * purpose: Read the fixture's instance.
 * @param f: (Fixture) Fixture.
 * @return: (Promise<Doc<"taskInstances">>) The row.
 */
async function row(f: Fixture): Promise<Doc<"taskInstances">> {
  return (await f.t.run(async (ctx) => await ctx.db.get(f.instanceId)))!;
}

/**
 * purpose: Confirm the instance as an identity at an instant.
 * @param f: (Fixture) Fixture.
 * @param subject: (string) Identity ("phone", "display" or a caregiver).
 * @param iso: (string) UTC instant.
 * @return: (Promise<Doc<"taskInstances">>) The instance after the call.
 */
async function confirmAs(f: Fixture, subject: string, iso: string): Promise<Doc<"taskInstances">> {
  at(iso);
  return await f.t.withIdentity({ subject }).mutation(api.instances.confirmTaskInstance, {
    instanceId: f.instanceId,
    via: subject === "phone" || subject === "display" ? "button" : "caregiver",
  });
}

/**
 * purpose: Undo the instance as an identity at an instant.
 * @param f: (Fixture) Fixture.
 * @param subject: (string) Identity.
 * @param iso: (string | number) UTC instant, or epoch ms.
 * @return: (Promise<object>) The mutation result.
 */
async function undoAs(f: Fixture, subject: string, iso: string | number) {
  vi.setSystemTime(typeof iso === "number" ? iso : new Date(iso));
  return await f.t
    .withIdentity({ subject })
    .mutation(api.instances.undoPressedTask, { instanceId: f.instanceId });
}

/**
 * purpose: Reopen the instance as an identity at an instant.
 * @param f: (Fixture) Fixture.
 * @param subject: (string) Identity.
 * @param iso: (string) UTC instant.
 * @return: (Promise<Doc<"taskInstances">>) The instance after the call.
 */
async function reopenAs(f: Fixture, subject: string, iso: string): Promise<Doc<"taskInstances">> {
  at(iso);
  return await f.t
    .withIdentity({ subject })
    .mutation(api.instances.reopenTaskInstance, { instanceId: f.instanceId });
}

/**
 * purpose: All audit rows of the instance, oldest first.
 * @param f: (Fixture) Fixture.
 * @return: (Promise<Doc<"auditLog">[]>) The rows.
 */
async function audits(f: Fixture): Promise<Doc<"auditLog">[]> {
  const rows = await f.t.run(async (ctx) => await ctx.db.query("auditLog").collect());
  return rows.filter((r) => r.entityId === f.instanceId);
}

describe("the pure rules", () => {
  const confirmed = { state: "confirmed", confirmedBy: "phone", confirmedAt: 1_000_000 } as const;

  test("seniorCanUndo allows exactly SENIOR_UNDO_MS after the confirm and no later", () => {
    expect(seniorCanUndo(confirmed, "phone", 1_000_000 + SENIOR_UNDO_MS)).toBe(true);
    expect(seniorCanUndo(confirmed, "phone", 1_000_000 + SENIOR_UNDO_MS + 1)).toBe(false);
  });

  test("seniorCanUndo measures from confirmReceivedAt when there is one", () => {
    const replayed = { ...confirmed, confirmedAt: 0, confirmReceivedAt: 1_000_000 };
    expect(seniorCanUndo(replayed, "phone", 1_000_000 + SENIOR_UNDO_MS)).toBe(true);
    expect(seniorCanUndo(replayed, "phone", 1_000_000 + SENIOR_UNDO_MS + 1)).toBe(false);
  });

  test("seniorCanUndo refuses another user, a resolved instance and an open one", () => {
    expect(seniorCanUndo(confirmed, "display", 1_000_000)).toBe(false);
    expect(seniorCanUndo({ ...confirmed, state: "resolved" }, "phone", 1_000_000)).toBe(false);
    expect(seniorCanUndo({ ...confirmed, state: "due" }, "phone", 1_000_000)).toBe(false);
    expect(seniorCanUndo({ state: "confirmed", confirmedBy: "phone" }, "phone", 1)).toBe(false);
  });

  test("caregiverCanReopen needs a done state confirmed today or belonging to today", () => {
    const tz = "America/New_York";
    const noon = Date.parse("2027-03-14T16:00:00Z");
    const lateNight = Date.parse("2027-03-15T03:59:59Z");
    const midnight = Date.parse("2027-03-15T04:00:00Z");
    const done = { state: "confirmed", confirmedAt: noon, localDate: "2027-03-14" } as const;
    expect(caregiverCanReopen(done, lateNight, tz)).toBe(true);
    expect(caregiverCanReopen({ ...done, state: "resolved" }, noon, tz)).toBe(true);
    expect(caregiverCanReopen(done, midnight, tz)).toBe(false);
    expect(caregiverCanReopen({ ...done, state: "due" }, noon, tz)).toBe(false);
    expect(caregiverCanReopen({ state: "confirmed", localDate: "2027-03-14" }, noon, tz)).toBe(
      true,
    );
  });

  test("caregiverCanReopen accepts today's task confirmed the evening before", () => {
    const tz = "America/New_York";
    const evening = Date.parse("2027-03-15T03:45:00Z");
    const after = Date.parse("2027-03-15T04:10:00Z");
    const early = { state: "confirmed", confirmedAt: evening, localDate: "2027-03-15" } as const;
    expect(caregiverCanReopen(early, after, tz)).toBe(true);
    expect(caregiverCanReopen({ ...early, localDate: "2027-03-14" }, after, tz)).toBe(false);
  });

  test("reopenedState follows the clock and the recorded prior state", () => {
    const timed = { scheduledTime: "08:00", windowStart: 100, windowEnd: 200 };
    expect(reopenedState(timed, 99)).toBe("upcoming");
    expect(reopenedState(timed, 100)).toBe("due");
    expect(reopenedState({ ...timed, resolvedFromState: "escalated" }, 150)).toBe("escalated");
    expect(reopenedState({ ...timed, resolvedFromState: "due" }, 150)).toBe("due");
    expect(reopenedState({ ...timed, resolvedFromState: "upcoming" }, 150)).toBe("due");
    expect(reopenedState({ ...timed, resolvedFromState: "missed" }, 150)).toBe("due");
    expect(reopenedState({ ...timed, resolvedFromState: "escalated" }, 200)).toBe("missed");
  });

  test("reopenedState never escalates an anytime instance", () => {
    const anytime = { scheduledTime: "anytime", windowStart: 100, windowEnd: 200 };
    expect(reopenedState({ ...anytime, resolvedFromState: "escalated" }, 150)).toBe("due");
  });
});

describe("confirm records the state it replaced for every actor", () => {
  test("a device confirm records the prior state and snooze", async () => {
    const f = await setup();
    await tick(f, "2027-03-14T12:00:00Z");
    const snoozedUntil = Date.parse("2027-03-14T12:30:00Z");
    await f.t.run(async (ctx) => await ctx.db.patch(f.instanceId, { snoozedUntil }));
    const done = await confirmAs(f, "phone", "2027-03-14T12:05:00Z");
    expect(done).toMatchObject({
      state: "confirmed",
      resolvedFromState: "due",
      resolvedFromSnoozedUntil: snoozedUntil,
    });
    expect(done.snoozedUntil).toBeUndefined();
  });

  test("a caregiver resolve still records them, and undoResolve restores them", async () => {
    const f = await setup();
    await tick(f, "2027-03-14T12:00:00Z");
    const done = await confirmAs(f, "max", "2027-03-14T12:05:00Z");
    expect(done).toMatchObject({ state: "resolved", resolvedFromState: "due" });
    at("2027-03-14T12:05:10Z");
    const undone = await f.t
      .withIdentity({ subject: "max" })
      .mutation(api.instances.undoResolve, { instanceId: f.instanceId });
    expect(undone.state).toBe("due");
  });

  test("a caregiver cannot use undoResolve on a device's confirm", async () => {
    const f = await setup();
    await tick(f, "2027-03-14T12:00:00Z");
    await confirmAs(f, "phone", "2027-03-14T12:05:00Z");
    at("2027-03-14T12:05:10Z");
    await expect(
      f.t
        .withIdentity({ subject: "max" })
        .mutation(api.instances.undoResolve, { instanceId: f.instanceId }),
    ).rejects.toMatchObject({ data: { code: "invalid" } });
    expect((await row(f)).state).toBe("confirmed");
  });
});

describe("undoPressedTask", () => {
  const CLEARED = {
    confirmedAt: undefined,
    confirmedBy: undefined,
    confirmedVia: undefined,
    confirmReceivedAt: undefined,
    resolvedFromState: undefined,
    resolvedFromSnoozedUntil: undefined,
  };

  test("restores a due instance and clears every confirmation field", async () => {
    const f = await setup();
    await tick(f, "2027-03-14T12:00:00Z");
    await confirmAs(f, "phone", "2027-03-14T12:05:00Z");
    const result = await undoAs(f, "phone", "2027-03-14T12:05:30Z");
    expect(result).toMatchObject({ status: "undone", instance: { state: "due" } });
    const after = await row(f);
    expect(after).toMatchObject({ state: "due" });
    for (const key of Object.keys(CLEARED)) expect(after, key).not.toHaveProperty(key);
  });

  test("restores an escalated instance", async () => {
    const f = await setup();
    await f.t.run(async (ctx) => await ctx.db.patch(f.instanceId, { state: "escalated" }));
    await confirmAs(f, "phone", "2027-03-14T12:05:00Z");
    expect(await undoAs(f, "phone", "2027-03-14T12:05:30Z")).toMatchObject({ status: "undone" });
    expect((await row(f)).state).toBe("escalated");
  });

  test("restores an upcoming instance confirmed early", async () => {
    const f = await setup("2027-03-14T11:30:00Z");
    expect((await confirmAs(f, "phone", "2027-03-14T11:30:00Z")).state).toBe("confirmed");
    expect(await undoAs(f, "phone", "2027-03-14T11:30:20Z")).toMatchObject({ status: "undone" });
    expect((await row(f)).state).toBe("upcoming");
  });

  test("restores the snooze the confirm cleared", async () => {
    const f = await setup();
    await tick(f, "2027-03-14T12:00:00Z");
    at("2027-03-14T12:02:00Z");
    const snoozed = await f.t
      .withIdentity({ subject: "phone" })
      .mutation(api.instances.snoozeTaskInstance, { instanceId: f.instanceId, minutes: 15 });
    await confirmAs(f, "phone", "2027-03-14T12:05:00Z");
    expect((await row(f)).snoozedUntil).toBeUndefined();
    await undoAs(f, "phone", "2027-03-14T12:05:20Z");
    expect(await row(f)).toMatchObject({ state: "due", snoozedUntil: snoozed.snoozedUntil });
  });

  test("an offline press recorded long ago can be undone just after it arrives", async () => {
    const f = await setup();
    await tick(f, "2027-03-14T12:00:00Z");
    at("2027-03-14T12:30:00Z");
    await f.t.withIdentity({ subject: "phone" }).mutation(api.instances.confirmPressedTask, {
      instanceId: f.instanceId,
      via: "button",
      pressedAgoMs: 20 * MINUTE,
    });
    const held = await row(f);
    expect(held.confirmedAt).toBe(Date.parse("2027-03-14T12:10:00Z"));
    expect(held.confirmReceivedAt).toBe(Date.parse("2027-03-14T12:30:00Z"));
    expect(await undoAs(f, "phone", "2027-03-14T12:30:45Z")).toMatchObject({
      status: "undone",
      instance: { state: "due" },
    });
  });

  // The harness advances the function clock a few ms per call, so these stay clear of the exact
  // edge (the pure rule test above covers it).
  test("works just inside SENIOR_UNDO_MS after the server recorded the confirm", async () => {
    const f = await setup();
    await tick(f, "2027-03-14T12:00:00Z");
    const recorded = (await confirmAs(f, "phone", "2027-03-14T12:05:00Z")).confirmedAt!;
    expect(await undoAs(f, "phone", recorded + SENIOR_UNDO_MS - 100)).toMatchObject({
      status: "undone",
    });
  });

  test("is too_late just past SENIOR_UNDO_MS and leaves the confirm in place", async () => {
    const f = await setup();
    await tick(f, "2027-03-14T12:00:00Z");
    const recorded = (await confirmAs(f, "phone", "2027-03-14T12:05:00Z")).confirmedAt!;
    expect(await undoAs(f, "phone", recorded + SENIOR_UNDO_MS + 100)).toEqual({
      status: "too_late",
    });
    expect((await row(f)).state).toBe("confirmed");
  });

  test("too late changes nothing and writes one undo_not_applied row", async () => {
    const f = await setup();
    await tick(f, "2027-03-14T12:00:00Z");
    await confirmAs(f, "phone", "2027-03-14T12:05:00Z");
    const before = await row(f);
    const auditCount = (await audits(f)).length;
    expect(await undoAs(f, "phone", "2027-03-14T12:07:00Z")).toEqual({ status: "too_late" });
    expect(await row(f)).toEqual(before);
    const rows = await audits(f);
    expect(rows.length).toBe(auditCount + 1);
    expect(rows.at(-1)).toMatchObject({
      action: "undo_not_applied",
      detail: {
        reason: "The task is not confirmed by this device within the undo window",
        undoneAgoMs: 0,
        tappedAt: Date.parse("2027-03-14T12:07:00Z"),
        receivedAt: Date.parse("2027-03-14T12:07:00Z"),
      },
    });
  });

  test("another device's confirm is too_late", async () => {
    const f = await setup();
    await tick(f, "2027-03-14T12:00:00Z");
    await confirmAs(f, "display", "2027-03-14T12:05:00Z");
    expect(await undoAs(f, "phone", "2027-03-14T12:05:10Z")).toEqual({ status: "too_late" });
    expect((await row(f)).state).toBe("confirmed");
  });

  test("a voice-agent confirm is too_late", async () => {
    const f = await setup();
    await tick(f, "2027-03-14T12:00:00Z");
    const now = at("2027-03-14T12:05:00Z");
    await f.t.run(
      async (ctx) =>
        await confirmInstance(ctx, AGENT, { instanceId: f.instanceId, via: "voice" }, now),
    );
    expect(await undoAs(f, "phone", "2027-03-14T12:05:10Z")).toEqual({ status: "too_late" });
    expect((await row(f)).state).toBe("confirmed");
  });

  test("a caregiver-resolved instance is too_late", async () => {
    const f = await setup();
    await tick(f, "2027-03-14T12:00:00Z");
    await confirmAs(f, "max", "2027-03-14T12:05:00Z");
    expect(await undoAs(f, "phone", "2027-03-14T12:05:10Z")).toEqual({ status: "too_late" });
    expect((await row(f)).state).toBe("resolved");
  });

  test("an instance that was never confirmed is too_late", async () => {
    const f = await setup();
    await tick(f, "2027-03-14T12:00:00Z");
    expect(await undoAs(f, "phone", "2027-03-14T12:05:10Z")).toEqual({ status: "too_late" });
    expect((await row(f)).state).toBe("due");
  });

  test("an instance that no longer exists is too_late, not an error", async () => {
    const f = await setup();
    await f.t.run(async (ctx) => await ctx.db.delete(f.instanceId));
    expect(await undoAs(f, "phone", "2027-03-14T12:05:10Z")).toEqual({ status: "too_late" });
  });

  test("another household's device is forbidden", async () => {
    const f = await setup();
    await tick(f, "2027-03-14T12:00:00Z");
    await confirmAs(f, "phone", "2027-03-14T12:05:00Z");
    const other = await f.t.withIdentity({ subject: "zed" }).mutation(api.households.create, {
      seniorPreferredName: "Dad",
      timezone: "America/New_York",
      caregiverDisplayName: "Zed",
    });
    await pair(f.t, other, "zed", "otherphone", "senior_phone");
    await expect(undoAs(f, "otherphone", "2027-03-14T12:05:10Z")).rejects.toMatchObject({
      data: { code: "forbidden" },
    });
    expect((await row(f)).state).toBe("confirmed");
  });

  test.each(["pat", "max", "val"])("caregiver %s is forbidden", async (subject) => {
    const f = await setup();
    await tick(f, "2027-03-14T12:00:00Z");
    await confirmAs(f, "phone", "2027-03-14T12:05:00Z");
    await expect(undoAs(f, subject, "2027-03-14T12:05:10Z")).rejects.toMatchObject({
      data: { code: "forbidden" },
    });
    expect((await row(f)).state).toBe("confirmed");
  });

  test("falls back to the clock when the prior state was never recorded", async () => {
    const f = await setup();
    await tick(f, "2027-03-14T12:00:00Z");
    await confirmAs(f, "phone", "2027-03-14T12:05:00Z");
    await f.t.run(
      async (ctx) => await ctx.db.patch(f.instanceId, { resolvedFromState: undefined }),
    );
    expect(await undoAs(f, "phone", "2027-03-14T12:05:20Z")).toMatchObject({
      status: "undone",
      instance: { state: "due" },
    });
  });

  test("is audited as a state change by the device with undo: true", async () => {
    const f = await setup();
    await tick(f, "2027-03-14T12:00:00Z");
    await confirmAs(f, "phone", "2027-03-14T12:05:00Z");
    await undoAs(f, "phone", "2027-03-14T12:05:30Z");
    const last = (await audits(f)).filter((r) => r.action === "state_change").at(-1)!;
    expect(last.detail).toMatchObject({ from: "confirmed", to: "due", undo: true });
    expect(last.actorUserId).toBe("phone");
    expect(last.actorKind).toBe("senior_device");
  });

  test("the scheduler carries on with the restored instance", async () => {
    const f = await setup("2027-03-14T11:30:00Z");
    await confirmAs(f, "phone", "2027-03-14T11:30:00Z");
    await undoAs(f, "phone", "2027-03-14T11:30:30Z");
    await tick(f, "2027-03-14T12:00:00Z");
    expect((await row(f)).state).toBe("due");
  });
});

describe("reopenTaskInstance", () => {
  test("reopens a device's confirm inside the window to due and clears the confirm", async () => {
    const f = await setup();
    await tick(f, "2027-03-14T12:00:00Z");
    await confirmAs(f, "display", "2027-03-14T12:05:00Z");
    const reopened = await reopenAs(f, "pat", "2027-03-14T12:20:00Z");
    expect(reopened.state).toBe("due");
    for (const key of [
      "confirmedAt",
      "confirmedBy",
      "confirmedVia",
      "confirmReceivedAt",
      "resolvedFromState",
      "resolvedFromSnoozedUntil",
    ]) {
      expect(reopened, key).not.toHaveProperty(key);
    }
  });

  test("reopens a caregiver's resolve, by a different editor", async () => {
    const f = await setup();
    await tick(f, "2027-03-14T12:00:00Z");
    await confirmAs(f, "max", "2027-03-14T12:05:00Z");
    expect((await reopenAs(f, "pat", "2027-03-14T12:10:00Z")).state).toBe("due");
  });

  test("an escalated instance is reopened as escalated", async () => {
    const f = await setup();
    await f.t.run(async (ctx) => await ctx.db.patch(f.instanceId, { state: "escalated" }));
    await confirmAs(f, "display", "2027-03-14T12:05:00Z");
    expect((await reopenAs(f, "pat", "2027-03-14T12:20:00Z")).state).toBe("escalated");
  });

  test("before the window it becomes upcoming", async () => {
    const f = await setup("2027-03-14T11:30:00Z");
    await confirmAs(f, "display", "2027-03-14T11:30:00Z");
    expect((await reopenAs(f, "pat", "2027-03-14T11:40:00Z")).state).toBe("upcoming");
  });

  test("at exactly the window end it becomes missed, and a minute before it is due", async () => {
    const f = await setup();
    await tick(f, "2027-03-14T12:00:00Z");
    await confirmAs(f, "display", "2027-03-14T12:30:00Z");
    expect((await reopenAs(f, "pat", "2027-03-14T12:59:00Z")).state).toBe("due");
    await confirmAs(f, "display", "2027-03-14T12:59:30Z");
    expect(WINDOW_END).toBe(Date.parse("2027-03-14T13:00:00Z"));
    expect((await reopenAs(f, "pat", "2027-03-14T13:00:00Z")).state).toBe("missed");
  });

  test("a late confirm of a missed task is reopened as missed", async () => {
    const f = await setup();
    await tick(f, "2027-03-14T12:00:00Z");
    await tick(f, "2027-03-14T13:00:00Z");
    await confirmAs(f, "display", "2027-03-14T13:10:00Z");
    expect((await reopenAs(f, "pat", "2027-03-14T13:20:00Z")).state).toBe("missed");
  });

  test("an instance confirmed before this change (no prior state) is reopened by the clock", async () => {
    const f = await setup();
    await tick(f, "2027-03-14T12:00:00Z");
    await confirmAs(f, "display", "2027-03-14T12:05:00Z");
    await f.t.run(
      async (ctx) => await ctx.db.patch(f.instanceId, { resolvedFromState: undefined }),
    );
    expect((await reopenAs(f, "pat", "2027-03-14T12:10:00Z")).state).toBe("due");
  });

  test("refuses a task confirmed yesterday, at household midnight", async () => {
    const f = await setup();
    await tick(f, "2027-03-14T12:00:00Z");
    await confirmAs(f, "display", "2027-03-14T12:05:00Z");
    expect((await reopenAs(f, "pat", "2027-03-15T03:59:59Z")).state).toBe("missed");
    await confirmAs(f, "display", "2027-03-15T03:59:59.5Z");
    await expect(reopenAs(f, "pat", "2027-03-15T04:00:00Z")).rejects.toMatchObject({
      data: {
        code: "invalid",
        message: "This task was marked done on an earlier day, so it can no longer be reopened.",
      },
    });
    expect((await row(f)).state).toBe("confirmed");
  });

  test("refuses a task that is not marked done", async () => {
    const f = await setup();
    await tick(f, "2027-03-14T12:00:00Z");
    await expect(reopenAs(f, "pat", "2027-03-14T12:10:00Z")).rejects.toMatchObject({
      data: { code: "invalid" },
    });
    expect((await row(f)).state).toBe("due");
  });

  test.each(["val", "phone", "display"])("%s is forbidden", async (subject) => {
    const f = await setup();
    await tick(f, "2027-03-14T12:00:00Z");
    await confirmAs(f, "display", "2027-03-14T12:05:00Z");
    await expect(reopenAs(f, subject, "2027-03-14T12:10:00Z")).rejects.toMatchObject({
      data: { code: "forbidden" },
    });
    expect((await row(f)).state).toBe("confirmed");
  });

  test("a caregiver of another household is forbidden", async () => {
    const f = await setup();
    await tick(f, "2027-03-14T12:00:00Z");
    await confirmAs(f, "display", "2027-03-14T12:05:00Z");
    await f.t.withIdentity({ subject: "zed" }).mutation(api.households.create, {
      seniorPreferredName: "Dad",
      timezone: "America/New_York",
      caregiverDisplayName: "Zed",
    });
    await expect(reopenAs(f, "zed", "2027-03-14T12:10:00Z")).rejects.toMatchObject({
      data: { code: "forbidden" },
    });
    expect((await row(f)).state).toBe("confirmed");
  });

  test("keeps the note and the claim", async () => {
    const f = await setup();
    await tick(f, "2027-03-14T12:00:00Z");
    at("2027-03-14T12:01:00Z");
    const asMax = f.t.withIdentity({ subject: "max" });
    await asMax.mutation(api.instances.claimTaskInstance, { instanceId: f.instanceId });
    await asMax.mutation(api.instances.setTaskNote, { instanceId: f.instanceId, note: "Hi" });
    await confirmAs(f, "display", "2027-03-14T12:05:00Z");
    expect(await reopenAs(f, "pat", "2027-03-14T12:10:00Z")).toMatchObject({
      state: "due",
      resolutionNote: "Hi",
      claimedBy: "max",
    });
  });

  test("is audited as a state change with reopen: true and the previous confirm", async () => {
    const f = await setup();
    await tick(f, "2027-03-14T12:00:00Z");
    const confirmed = await confirmAs(f, "display", "2027-03-14T12:05:00Z");
    await reopenAs(f, "pat", "2027-03-14T12:10:00Z");
    const last = (await audits(f)).filter((r) => r.action === "state_change").at(-1)!;
    expect(last.detail).toMatchObject({
      from: "confirmed",
      to: "due",
      reopen: true,
      confirmedAt: confirmed.confirmedAt,
      confirmedBy: "display",
      confirmedVia: "button",
    });
    expect(last.actorUserId).toBe("pat");
  });

  test("an anytime instance reopens as due while its window is open, never escalated", async () => {
    const f = await setup("2027-03-14T14:00:00Z", []);
    await confirmAs(f, "display", "2027-03-14T14:00:00Z");
    await f.t.run(
      async (ctx) => await ctx.db.patch(f.instanceId, { resolvedFromState: "escalated" }),
    );
    const reopened = await reopenAs(f, "pat", "2027-03-14T14:10:00Z");
    expect(reopened.state).toBe("due");
    expect(reopened.scheduledTime).toBe("anytime");
  });

  test("an anytime instance reopened after its window ended is missed", async () => {
    const f = await setup("2027-03-14T14:00:00Z", []);
    await confirmAs(f, "display", "2027-03-14T14:00:00Z");
    await f.t.run(
      async (ctx) =>
        await ctx.db.patch(f.instanceId, {
          windowEnd: Date.parse("2027-03-14T14:05:00Z"),
        }),
    );
    expect((await reopenAs(f, "pat", "2027-03-14T14:10:00Z")).state).toBe("missed");
  });

  test("the ladder continues: fired steps are not repeated and unfired ones fire", async () => {
    const f = await setup();
    await tick(f, "2027-03-14T12:00:00Z");
    await tick(f, "2027-03-14T12:15:00Z");
    const policy = (await f.t.run(async (ctx) => await ctx.db.get(f.medication)))!;
    const [first, second, third, fourth] = policy.steps;
    const firedBefore = (await row(f)).firedSteps;
    expect(firedBefore.map((s) => s.stepId)).toEqual([first!.id, second!.id]);

    await confirmAs(f, "display", "2027-03-14T12:20:00Z");
    await tick(f, "2027-03-14T12:30:00Z");
    expect((await row(f)).firedSteps).toEqual(firedBefore);

    expect((await reopenAs(f, "pat", "2027-03-14T12:35:00Z")).state).toBe("due");
    await tick(f, "2027-03-14T12:35:00Z");
    const afterReopen = await row(f);
    expect(afterReopen.firedSteps.slice(0, 2)).toEqual(firedBefore);
    expect(afterReopen.firedSteps.map((s) => s.stepId)).toEqual([first!.id, second!.id, third!.id]);
    expect(afterReopen.state).toBe("escalated");

    await tick(f, "2027-03-14T12:36:00Z");
    expect((await row(f)).firedSteps).toHaveLength(3);
    await tick(f, "2027-03-14T12:45:00Z");
    expect((await row(f)).firedSteps.map((s) => s.stepId)).toEqual([
      first!.id,
      second!.id,
      third!.id,
      fourth!.id,
    ]);
  });
});

describe("the day view's reopenable flag agrees with the mutation", () => {
  /**
   * purpose: Read the flag for the fixture's instance and try the reopen, both at the current
   *          faked time.
   * @param f: (Fixture) Fixture.
   * @return: (Promise<object>) The flag and whether the mutation was accepted.
   */
  async function flagAndReopen(f: Fixture): Promise<{ flag: boolean; accepted: boolean }> {
    const pat = f.t.withIdentity({ subject: "pat" });
    const day = await pat.query(api.calendar.dayView, { householdId: f.householdId });
    const flag = day.tasks.find((x) => x.instanceId === f.instanceId)!.reopenable;
    const accepted = await pat
      .mutation(api.instances.reopenTaskInstance, { instanceId: f.instanceId })
      .then(
        () => true,
        () => false,
      );
    return { flag, accepted };
  }

  test("an open task is not reopenable", async () => {
    const f = await setup();
    await tick(f, "2027-03-14T12:00:00Z");
    at("2027-03-14T12:10:00Z");
    expect(await flagAndReopen(f)).toEqual({ flag: false, accepted: false });
  });

  test.each(["display", "max"])("a task %s marked done today is reopenable", async (subject) => {
    const f = await setup();
    await tick(f, "2027-03-14T12:00:00Z");
    await confirmAs(f, subject, "2027-03-14T12:05:00Z");
    at("2027-03-14T12:10:00Z");
    expect(await flagAndReopen(f)).toEqual({ flag: true, accepted: true });
  });

  test("a task confirmed late tonight is reopenable until household midnight", async () => {
    const f = await setup();
    await tick(f, "2027-03-14T12:00:00Z");
    await confirmAs(f, "display", "2027-03-14T12:05:00Z");
    at("2027-03-15T03:59:59Z");
    expect(await flagAndReopen(f)).toEqual({ flag: true, accepted: true });
  });

  test.each([
    ["deactivated", { active: false }],
    ["switched to anytime", { type: "reminder" as const, times: [] }],
    ["moved to another time", { times: ["09:00"] }],
  ])("a task that was %s is not reopenable", async (_name, changes) => {
    const f = await setup();
    await tick(f, "2027-03-14T12:00:00Z");
    await confirmAs(f, "display", "2027-03-14T12:05:00Z");
    at("2027-03-14T12:06:00Z");
    await f.t.withIdentity({ subject: "pat" }).mutation(api.tasks.update, {
      householdId: f.householdId,
      taskId: (await row(f)).taskId,
      ...changes,
    });
    at("2027-03-14T12:10:00Z");
    expect(await flagAndReopen(f)).toEqual({ flag: false, accepted: false });
  });

  test("a task confirmed yesterday is not reopenable", async () => {
    const f = await setup();
    await f.t.run(async (ctx) => {
      await ctx.db.patch(f.instanceId, {
        state: "confirmed",
        confirmedAt: Date.parse("2027-03-14T12:05:00Z"),
        confirmedBy: "display",
      });
    });
    at("2027-03-15T14:00:00Z");
    const day = await f.t
      .withIdentity({ subject: "pat" })
      .query(api.instances.today, { householdId: f.householdId });
    expect(day.find((x) => x.instanceId === f.instanceId)).toBeUndefined();
    await expect(
      f.t
        .withIdentity({ subject: "pat" })
        .mutation(api.instances.reopenTaskInstance, { instanceId: f.instanceId }),
    ).rejects.toMatchObject({ data: { code: "invalid" } });
  });
});

describe("more undo and reopen cases", () => {
  test("a signed-out caller gets unauthenticated from both mutations", async () => {
    const f = await setup();
    await tick(f, "2027-03-14T12:00:00Z");
    await confirmAs(f, "phone", "2027-03-14T12:05:00Z");
    at("2027-03-14T12:05:10Z");
    await expect(
      f.t.mutation(api.instances.undoPressedTask, { instanceId: f.instanceId }),
    ).rejects.toMatchObject({ data: { code: "unauthenticated" } });
    await expect(
      f.t.mutation(api.instances.reopenTaskInstance, { instanceId: f.instanceId }),
    ).rejects.toMatchObject({ data: { code: "unauthenticated" } });
    expect((await row(f)).state).toBe("confirmed");
  });

  test("undoing twice: the second is too_late", async () => {
    const f = await setup();
    await tick(f, "2027-03-14T12:00:00Z");
    await confirmAs(f, "phone", "2027-03-14T12:05:00Z");
    expect(await undoAs(f, "phone", "2027-03-14T12:05:10Z")).toMatchObject({ status: "undone" });
    expect(await undoAs(f, "phone", "2027-03-14T12:05:20Z")).toEqual({ status: "too_late" });
    expect((await row(f)).state).toBe("due");
  });

  test("after an undo a caregiver cannot reopen: the task is not done", async () => {
    const f = await setup();
    await tick(f, "2027-03-14T12:00:00Z");
    await confirmAs(f, "phone", "2027-03-14T12:05:00Z");
    await undoAs(f, "phone", "2027-03-14T12:05:10Z");
    await expect(reopenAs(f, "pat", "2027-03-14T12:06:00Z")).rejects.toMatchObject({
      data: { code: "invalid", message: expect.stringContaining("not marked done") },
    });
  });

  test("a new confirm after a reopen records a fresh prior state and can be undone and reopened", async () => {
    const f = await setup();
    await tick(f, "2027-03-14T12:00:00Z");
    await confirmAs(f, "display", "2027-03-14T12:05:00Z");
    await reopenAs(f, "pat", "2027-03-14T12:10:00Z");
    const again = await confirmAs(f, "phone", "2027-03-14T12:12:00Z");
    expect(again).toMatchObject({ state: "confirmed", resolvedFromState: "due" });
    expect(await undoAs(f, "phone", "2027-03-14T12:12:30Z")).toMatchObject({
      status: "undone",
      instance: { state: "due" },
    });
    await confirmAs(f, "phone", "2027-03-14T12:14:00Z");
    expect((await reopenAs(f, "pat", "2027-03-14T12:20:00Z")).state).toBe("due");
  });

  test("undo of a late confirm of a missed instance restores missed", async () => {
    const f = await setup();
    await tick(f, "2027-03-14T12:00:00Z");
    await tick(f, "2027-03-14T13:00:00Z");
    expect((await row(f)).state).toBe("missed");
    await confirmAs(f, "phone", "2027-03-14T13:10:00Z");
    expect(await undoAs(f, "phone", "2027-03-14T13:10:20Z")).toMatchObject({
      status: "undone",
      instance: { state: "missed" },
    });
  });

  test("with no recorded prior state, undo falls back to the clock: upcoming before the window", async () => {
    const f = await setup("2027-03-14T11:30:00Z");
    await confirmAs(f, "phone", "2027-03-14T11:30:00Z");
    await f.t.run(
      async (ctx) => await ctx.db.patch(f.instanceId, { resolvedFromState: undefined }),
    );
    expect(await undoAs(f, "phone", "2027-03-14T11:30:20Z")).toMatchObject({
      status: "undone",
      instance: { state: "upcoming" },
    });
  });

  test("with no recorded prior state, undo falls back to the clock: missed after the window", async () => {
    const f = await setup();
    await tick(f, "2027-03-14T12:00:00Z");
    await tick(f, "2027-03-14T13:00:00Z");
    await confirmAs(f, "phone", "2027-03-14T13:10:00Z");
    await f.t.run(
      async (ctx) => await ctx.db.patch(f.instanceId, { resolvedFromState: undefined }),
    );
    expect(await undoAs(f, "phone", "2027-03-14T13:10:20Z")).toMatchObject({
      status: "undone",
      instance: { state: "missed" },
    });
  });

  test("a press that took 2 minutes to arrive is already past the undo window when it lands", async () => {
    const f = await setup();
    await tick(f, "2027-03-14T12:00:00Z");
    at("2027-03-14T12:10:00Z");
    await f.t.withIdentity({ subject: "phone" }).mutation(api.instances.confirmPressedTask, {
      instanceId: f.instanceId,
      via: "button",
      pressedAgoMs: 2 * MINUTE,
    });
    expect((await row(f)).confirmReceivedAt).toBeUndefined();
    expect(await undoAs(f, "phone", "2027-03-14T12:10:01Z")).toEqual({ status: "too_late" });
  });

  test("a 00:30 task confirmed at 23:45 the evening before can be reopened at 00:10", async () => {
    const f = await setup("2027-03-15T03:45:00Z", ["00:30"]);
    expect((await row(f)).localDate).toBe("2027-03-15");
    await confirmAs(f, "display", "2027-03-15T03:45:00Z");
    at("2027-03-15T04:10:00Z");
    const day = await f.t
      .withIdentity({ subject: "pat" })
      .query(api.calendar.dayView, { householdId: f.householdId });
    expect(day.tasks.find((x) => x.instanceId === f.instanceId)!.reopenable).toBe(true);
    expect((await reopenAs(f, "pat", "2027-03-15T04:10:00Z")).state).toBe("upcoming");
  });
});

describe("a press made before a take-back does not confirm again", () => {
  /**
   * purpose: Send a held press through confirmPressedTask as an identity at an instant.
   * @param f: (Fixture) Fixture.
   * @param subject: (string) Device identity.
   * @param iso: (string) UTC instant the press arrives.
   * @param ageMs: (number) The press age.
   * @return: (Promise<object>) The PressResult.
   */
  async function press(f: Fixture, subject: string, iso: string, ageMs: number) {
    at(iso);
    return await f.t.withIdentity({ subject }).mutation(api.instances.confirmPressedTask, {
      instanceId: f.instanceId,
      via: "button",
      pressedAgoMs: ageMs,
    });
  }

  /**
   * purpose: The press_not_applied audit rows of the instance.
   * @param f: (Fixture) Fixture.
   * @return: (Promise<Doc<"auditLog">[]>) The rows.
   */
  async function notApplied(f: Fixture): Promise<Doc<"auditLog">[]> {
    return (await audits(f)).filter((r) => r.action === "press_not_applied");
  }

  test("after the senior's undo, the same press replayed is rejected, audited, and the task stays open", async () => {
    const f = await setup();
    await tick(f, "2027-03-14T12:00:00Z");
    expect(await press(f, "phone", "2027-03-14T12:05:00Z", 1000)).toMatchObject({
      status: "confirmed",
    });
    await undoAs(f, "phone", "2027-03-14T12:05:20Z");
    const replay = await press(f, "phone", "2027-03-14T12:06:00Z", 61_000);
    expect(replay).toMatchObject({
      status: "rejected",
      reason: expect.stringContaining("taken back"),
    });
    expect((await row(f)).state).toBe("due");
    expect(await notApplied(f)).toHaveLength(1);
  });

  test("after the senior's undo, a fresh press confirms", async () => {
    const f = await setup();
    await tick(f, "2027-03-14T12:00:00Z");
    await press(f, "phone", "2027-03-14T12:05:00Z", 1000);
    await undoAs(f, "phone", "2027-03-14T12:05:20Z");
    expect(await press(f, "phone", "2027-03-14T12:06:00Z", 0)).toMatchObject({
      status: "confirmed",
    });
    expect((await row(f)).state).toBe("confirmed");
  });

  test("after a caregiver's reopen, the same press replayed is rejected and a fresh press confirms", async () => {
    const f = await setup();
    await tick(f, "2027-03-14T12:00:00Z");
    await press(f, "display", "2027-03-14T12:05:00Z", 1000);
    await reopenAs(f, "pat", "2027-03-14T12:10:00Z");
    expect(await press(f, "display", "2027-03-14T12:11:00Z", 7 * MINUTE)).toMatchObject({
      status: "rejected",
      reason: expect.stringContaining("taken back"),
    });
    expect((await row(f)).state).toBe("due");
    expect(await notApplied(f)).toHaveLength(1);
    expect(await press(f, "display", "2027-03-14T12:12:00Z", 0)).toMatchObject({
      status: "confirmed",
    });
  });

  test("after a reopen a caregiver's Mark done still resolves", async () => {
    const f = await setup();
    await tick(f, "2027-03-14T12:00:00Z");
    await confirmAs(f, "display", "2027-03-14T12:05:00Z");
    await reopenAs(f, "pat", "2027-03-14T12:10:00Z");
    expect((await confirmAs(f, "max", "2027-03-14T12:11:00Z")).state).toBe("resolved");
  });

  test("a press without an age confirms after a take-back", async () => {
    const f = await setup();
    await tick(f, "2027-03-14T12:00:00Z");
    await confirmAs(f, "phone", "2027-03-14T12:05:00Z");
    await undoAs(f, "phone", "2027-03-14T12:05:20Z");
    expect((await confirmAs(f, "phone", "2027-03-14T12:06:00Z")).state).toBe("confirmed");
  });
});

describe("a task that no longer runs is not reopened", () => {
  /**
   * purpose: Change the fixture's task as Pat through the real tasks.update.
   * @param f: (Fixture) Fixture.
   * @param changes: (object) The fields to change.
   * @return: (Promise<void>)
   */
  async function updateTask(f: Fixture, changes: Record<string, unknown>): Promise<void> {
    const instance = await row(f);
    await f.t.withIdentity({ subject: "pat" }).mutation(api.tasks.update, {
      householdId: f.householdId,
      taskId: instance.taskId,
      ...changes,
    });
  }

  test.each([
    ["deactivated", { active: false }],
    ["made anytime", { type: "reminder" as const, times: [] }],
    ["moved to another time", { times: ["09:00"] }],
  ])(
    "a task %s keeps its confirmed row, which undo (in its window) and reopen refuse",
    async (_name, changes) => {
      const f = await setup();
      await tick(f, "2027-03-14T12:00:00Z");
      await confirmAs(f, "phone", "2027-03-14T12:05:00Z");
      at("2027-03-14T12:05:10Z");
      await updateTask(f, changes);
      expect((await row(f)).state).toBe("confirmed");
      expect(await undoAs(f, "phone", "2027-03-14T12:05:20Z")).toEqual({ status: "too_late" });
      expect((await row(f)).state).toBe("confirmed");
      await expect(reopenAs(f, "pat", "2027-03-14T12:07:00Z")).rejects.toMatchObject({
        data: { code: "invalid", message: "This task is no longer on the schedule." },
      });
    },
  );

  test("a deleted task is refused the same way", async () => {
    const f = await setup();
    await tick(f, "2027-03-14T12:00:00Z");
    await confirmAs(f, "phone", "2027-03-14T12:05:00Z");
    const { taskId } = await row(f);
    await f.t.run(async (ctx) => await ctx.db.delete(taskId));
    expect(await undoAs(f, "phone", "2027-03-14T12:05:20Z")).toEqual({ status: "too_late" });
    await expect(reopenAs(f, "pat", "2027-03-14T12:07:00Z")).rejects.toMatchObject({
      data: { code: "invalid", message: "This task is no longer on the schedule." },
    });
  });

  test("an anytime instance whose task became timed is refused by undo and reopen", async () => {
    const f = await setup("2027-03-14T14:00:00Z", []);
    await confirmAs(f, "phone", "2027-03-14T14:00:00Z");
    at("2027-03-14T14:00:10Z");
    await updateTask(f, { type: "medication", times: ["09:00"] });
    expect((await row(f)).state).toBe("confirmed");
    expect(await undoAs(f, "phone", "2027-03-14T14:00:20Z")).toEqual({ status: "too_late" });
    await expect(reopenAs(f, "pat", "2027-03-14T14:01:00Z")).rejects.toMatchObject({
      data: { code: "invalid", message: "This task is no longer on the schedule." },
    });
  });

  test("an anytime instance whose task is still anytime can be undone", async () => {
    const f = await setup("2027-03-14T14:00:00Z", []);
    await confirmAs(f, "phone", "2027-03-14T14:00:00Z");
    expect(await undoAs(f, "phone", "2027-03-14T14:00:20Z")).toMatchObject({
      status: "undone",
    });
  });

  test("an anytime instance whose task is still anytime can be reopened", async () => {
    const f = await setup("2027-03-14T14:00:00Z", []);
    await confirmAs(f, "phone", "2027-03-14T14:00:00Z");
    expect((await reopenAs(f, "pat", "2027-03-14T14:05:00Z")).state).toBe("due");
  });
});

describe("an Undo tapped offline", () => {
  /**
   * purpose: Send an Undo with the age of the tap, as the phone's queue would.
   * @param f: (Fixture) Fixture.
   * @param iso: (string) UTC instant it arrives.
   * @param agoMs: (number) How long before arrival it was tapped.
   * @return: (Promise<object>) The UndoPressResult.
   */
  async function undoAgo(f: Fixture, iso: string, agoMs: number) {
    at(iso);
    return await f.t
      .withIdentity({ subject: "phone" })
      .mutation(api.instances.undoPressedTask, { instanceId: f.instanceId, undoneAgoMs: agoMs });
  }

  /**
   * purpose: Send a held Done press with its age, as the phone's queue would.
   * @param f: (Fixture) Fixture.
   * @param iso: (string) UTC instant it arrives.
   * @param agoMs: (number) How long before arrival it was pressed.
   * @return: (Promise<object>) The PressResult.
   */
  async function pressAgo(f: Fixture, iso: string, agoMs: number) {
    at(iso);
    return await f.t.withIdentity({ subject: "phone" }).mutation(api.instances.confirmPressedTask, {
      instanceId: f.instanceId,
      via: "button",
      pressedAgoMs: agoMs,
    });
  }

  test("tapped at +20 s and arriving at +5 min is applied, stamped with the tap time", async () => {
    const f = await setup();
    await tick(f, "2027-03-14T12:00:00Z");
    await confirmAs(f, "phone", "2027-03-14T12:05:00Z");
    expect(await undoAgo(f, "2027-03-14T12:10:00Z", 280_000)).toMatchObject({
      status: "undone",
    });
    const stamp = (await row(f)).confirmTakenBackAt!;
    expect(Math.abs(stamp - Date.parse("2027-03-14T12:05:20Z"))).toBeLessThan(1000);
  });

  test("tapped at +70 s is too_late even though it arrives later", async () => {
    const f = await setup();
    await tick(f, "2027-03-14T12:00:00Z");
    await confirmAs(f, "phone", "2027-03-14T12:05:00Z");
    expect(await undoAgo(f, "2027-03-14T12:10:00Z", 230_000)).toEqual({ status: "too_late" });
    expect((await row(f)).state).toBe("confirmed");
  });

  test("an age that is negative or not finite is invalid", async () => {
    const f = await setup();
    await tick(f, "2027-03-14T12:00:00Z");
    await confirmAs(f, "phone", "2027-03-14T12:05:00Z");
    await expect(undoAgo(f, "2027-03-14T12:05:10Z", -1)).rejects.toMatchObject({
      data: { code: "invalid" },
    });
  });

  test("Done, Undo, Done all tapped offline and delivered in order end confirmed", async () => {
    const f = await setup();
    await tick(f, "2027-03-14T12:00:00Z");
    const arrive = "2027-03-14T12:20:00Z";
    expect(await pressAgo(f, arrive, 900_000)).toMatchObject({ status: "confirmed" });
    expect(await undoAgo(f, arrive, 890_000)).toMatchObject({ status: "undone" });
    expect(await pressAgo(f, arrive, 880_000)).toMatchObject({ status: "confirmed" });
    const after = await row(f);
    expect(after.state).toBe("confirmed");
    expect(Math.abs(after.confirmedAt! - Date.parse("2027-03-14T12:05:20Z"))).toBeLessThan(1000);
  });

  test("the old first press replayed last leaves the second Done in place", async () => {
    const f = await setup();
    await tick(f, "2027-03-14T12:00:00Z");
    const arrive = "2027-03-14T12:20:00Z";
    await pressAgo(f, arrive, 900_000);
    await undoAgo(f, arrive, 890_000);
    await pressAgo(f, arrive, 880_000);
    const second = await row(f);
    await pressAgo(f, arrive, 900_100);
    expect(await row(f)).toEqual(second);
  });

  test("the old first press replayed right after the Undo is rejected", async () => {
    const f = await setup();
    await tick(f, "2027-03-14T12:00:00Z");
    const arrive = "2027-03-14T12:20:00Z";
    await pressAgo(f, arrive, 900_000);
    await undoAgo(f, arrive, 890_000);
    expect(await pressAgo(f, arrive, 900_100)).toMatchObject({ status: "rejected" });
    expect((await row(f)).state).toBe("due");
  });
});

describe("reopen stamps only a device's confirm", () => {
  test("reopening a caregiver's resolve leaves the senior's queued press applicable", async () => {
    const f = await setup();
    await tick(f, "2027-03-14T12:00:00Z");
    await confirmAs(f, "max", "2027-03-14T12:03:00Z");
    const reopened = await reopenAs(f, "pat", "2027-03-14T12:04:00Z");
    expect(reopened.state).toBe("due");
    expect(reopened.confirmTakenBackAt).toBeUndefined();
    at("2027-03-14T12:05:30Z");
    const result = await f.t
      .withIdentity({ subject: "phone" })
      .mutation(api.instances.confirmPressedTask, {
        instanceId: f.instanceId,
        via: "button",
        pressedAgoMs: 330_000,
      });
    expect(result).toMatchObject({ status: "confirmed" });
    expect((await row(f)).state).toBe("confirmed");
  });

  test("reopening a device's confirm stamps it", async () => {
    const f = await setup();
    await tick(f, "2027-03-14T12:00:00Z");
    await confirmAs(f, "display", "2027-03-14T12:03:00Z");
    const reopened = await reopenAs(f, "pat", "2027-03-14T12:04:00Z");
    expect(reopened.confirmTakenBackAt).toBeGreaterThanOrEqual(Date.parse("2027-03-14T12:04:00Z"));
  });
});

describe("pressWasTakenBack", () => {
  test("refuses a press at the stamp and allows one a millisecond after", () => {
    expect(pressWasTakenBack(1000, 1000)).toBe(true);
    expect(pressWasTakenBack(999, 1000)).toBe(true);
    expect(pressWasTakenBack(1001, 1000)).toBe(false);
  });

  test("never refuses when nothing was taken back", () => {
    expect(pressWasTakenBack(0, undefined)).toBe(false);
  });
});

describe("press ids", () => {
  /** Well-formed press ids (16 or more URL-safe characters). */
  const A = "pressAAAAAAAAAAAAAAA";
  const B = "pressBBBBBBBBBBBBBBB";

  /**
   * purpose: Send a queued press from the phone, as its queue would.
   * @param f: (Fixture) Fixture.
   * @param iso: (string) UTC instant it arrives.
   * @param agoMs: (number) Press age sent with it.
   * @param pressId: (string | undefined) Its id, or none (an entry stored before ids).
   * @return: (Promise<object>) The PressResult.
   */
  async function press(f: Fixture, iso: string, agoMs: number, pressId?: string) {
    at(iso);
    return await f.t.withIdentity({ subject: "phone" }).mutation(api.instances.confirmPressedTask, {
      instanceId: f.instanceId,
      via: "button",
      pressedAgoMs: agoMs,
      pressId,
    });
  }

  /**
   * purpose: Send a queued Undo from the phone, as its queue would.
   * @param f: (Fixture) Fixture.
   * @param iso: (string) UTC instant it arrives.
   * @param agoMs: (number) Tap age sent with it.
   * @param pressId: (string | undefined) The id of the press it takes back, or none.
   * @return: (Promise<object>) The UndoPressResult.
   */
  async function undo(f: Fixture, iso: string, agoMs: number, pressId?: string) {
    at(iso);
    return await f.t.withIdentity({ subject: "phone" }).mutation(api.instances.undoPressedTask, {
      instanceId: f.instanceId,
      undoneAgoMs: agoMs,
      pressId,
    });
  }

  /**
   * purpose: A fixture whose instance is due (the scheduler ran at 12:00Z).
   * @return: (Promise<Fixture>) The fixture.
   */
  async function dueFixture(): Promise<Fixture> {
    const f = await setup();
    await tick(f, "2027-03-14T12:00:00Z");
    return f;
  }

  /**
   * purpose: Scenario (a): press A was held by the client on a dead socket and resent on
   *          reconnect at 12:20 with its original age 0; the queued Undo (tapped 12:10) stamps
   *          the take-back at 12:20; the second Done (pressed 12:15, offline) arrives last.
   * @param ids: (boolean) Whether the entries carry press ids.
   * @return: (Promise<object>) The fixture and the result of the second press.
   */
  async function resentPressScenario(ids: boolean) {
    const f = await dueFixture();
    expect(await press(f, "2027-03-14T12:20:00Z", 0, ids ? A : undefined)).toMatchObject({
      status: "confirmed",
    });
    expect(await undo(f, "2027-03-14T12:20:01Z", 601_000, ids ? A : undefined)).toMatchObject({
      status: "undone",
    });
    const result = await press(f, "2027-03-14T12:20:02Z", 302_000, ids ? B : undefined);
    return { f, result };
  }

  test("(a) a press resent at reconnect, then Undo, then Done ends confirmed with ids", async () => {
    const { f, result } = await resentPressScenario(true);
    expect(result).toMatchObject({ status: "confirmed" });
    expect((await row(f)).state).toBe("confirmed");
    expect((await row(f)).confirmPressIds).toEqual([B]);
  });

  test("(a) without ids the time rule still refuses that second press, as before", async () => {
    const { f, result } = await resentPressScenario(false);
    expect(result).toMatchObject({ status: "rejected" });
    expect((await row(f)).state).toBe("due");
  });

  test("(b) a resent undo answers too_late and leaves the later press confirmed", async () => {
    const f = await dueFixture();
    await press(f, "2027-03-14T12:05:00Z", 0, A);
    await undo(f, "2027-03-14T12:05:10Z", 0, A);
    await press(f, "2027-03-14T12:05:20Z", 0, B);
    expect(await undo(f, "2027-03-14T12:05:30Z", 20_000, A)).toEqual({ status: "too_late" });
    const after = await row(f);
    expect(after.state).toBe("confirmed");
    expect(after.confirmPressIds).toEqual([B]);
  });

  test("(b) without ids the resent undo still takes the later press back, as before", async () => {
    const f = await dueFixture();
    await press(f, "2027-03-14T12:05:00Z", 0);
    await undo(f, "2027-03-14T12:05:10Z", 0);
    await press(f, "2027-03-14T12:05:20Z", 0);
    expect(await undo(f, "2027-03-14T12:05:30Z", 20_000)).toMatchObject({ status: "undone" });
  });

  test("(c) on a slow network a Done just after Undo is applied with ids", async () => {
    const f = await dueFixture();
    await press(f, "2027-03-14T12:05:00Z", 0, A);
    // The Undo was tapped at 12:05:10 and took 3 s to arrive; Done was tapped at 12:05:11.
    await undo(f, "2027-03-14T12:05:13Z", 0, A);
    expect(await press(f, "2027-03-14T12:05:14Z", 3000, B)).toMatchObject({
      status: "confirmed",
    });
    expect((await row(f)).state).toBe("confirmed");
  });

  test("(c) without ids that Done is refused, as before", async () => {
    const f = await dueFixture();
    await press(f, "2027-03-14T12:05:00Z", 0);
    await undo(f, "2027-03-14T12:05:13Z", 0);
    expect(await press(f, "2027-03-14T12:05:14Z", 3000)).toMatchObject({ status: "rejected" });
  });

  test("a resend of an undone press id is refused, even after the device's own undo", async () => {
    const f = await dueFixture();
    await press(f, "2027-03-14T12:05:00Z", 0, A);
    await undo(f, "2027-03-14T12:05:10Z", 0, A);
    expect(await press(f, "2027-03-14T12:05:20Z", 0, A)).toMatchObject({ status: "rejected" });
    expect((await row(f)).state).toBe("due");
  });

  test("an undo of another press id answers too_late and changes nothing", async () => {
    const f = await dueFixture();
    await press(f, "2027-03-14T12:05:00Z", 0, A);
    expect(await undo(f, "2027-03-14T12:05:10Z", 0, B)).toEqual({ status: "too_late" });
    expect((await row(f)).state).toBe("confirmed");
  });

  test("keeps the last 8 taken-back ids: a ninth pushes out the first", async () => {
    const f = await dueFixture();
    const ids = Array.from({ length: 9 }, (_, i) => `press${i}xxxxxxxxxxxxxxx`);
    let instant = Date.parse("2027-03-14T12:05:00Z");
    for (const id of ids) {
      await press(f, new Date(instant).toISOString(), 0, id);
      await undo(f, new Date(instant + 1000).toISOString(), 0, id);
      instant += 2000;
    }
    const after = await row(f);
    expect(after.takenBackPressIds).toEqual(ids.slice(1));
    expect(after.confirmTakenBackBy).toBe("phone");
  });

  test("after a caregiver reopen the time rule still refuses an older press with an id", async () => {
    const f = await dueFixture();
    await press(f, "2027-03-14T12:05:00Z", 0, A);
    const reopened = await reopenAs(f, "pat", "2027-03-14T12:06:00Z");
    expect(reopened.confirmTakenBackBy).toBe("pat");
    expect(await press(f, "2027-03-14T12:06:30Z", 60_000, B)).toMatchObject({
      status: "rejected",
    });
    expect(await press(f, "2027-03-14T12:06:40Z", 0, B)).toMatchObject({ status: "confirmed" });
  });

  test("after a reopen of a device confirm a resend of that press with age 0 is refused", async () => {
    const f = await dueFixture();
    await press(f, "2027-03-14T12:05:00Z", 0, A);
    const reopened = await reopenAs(f, "pat", "2027-03-14T12:06:00Z");
    expect(reopened.takenBackPressIds).toEqual([A]);
    expect(await press(f, "2027-03-14T12:06:30Z", 0, A)).toMatchObject({ status: "rejected" });
    expect((await row(f)).state).toBe("due");
  });

  test("a press reopened by a caregiver stays refused after a later undo by the device", async () => {
    const f = await dueFixture();
    await press(f, "2027-03-14T12:05:00Z", 0, A);
    await reopenAs(f, "pat", "2027-03-14T12:06:00Z");
    await press(f, "2027-03-14T12:07:00Z", 0, B);
    expect(await undo(f, "2027-03-14T12:07:10Z", 0, B)).toMatchObject({ status: "undone" });
    expect((await row(f)).confirmTakenBackBy).toBe("phone");
    expect(await press(f, "2027-03-14T12:07:20Z", 0, A)).toMatchObject({ status: "rejected" });
    expect((await row(f)).state).toBe("due");
  });

  test("a reopen of a confirm without an id leaves takenBackPressIds as it was", async () => {
    const f = await dueFixture();
    await press(f, "2027-03-14T12:05:00Z", 0, A);
    await undo(f, "2027-03-14T12:05:10Z", 0, A);
    await press(f, "2027-03-14T12:05:20Z", 0);
    const reopened = await reopenAs(f, "pat", "2027-03-14T12:06:00Z");
    expect(reopened.takenBackPressIds).toEqual([A]);
  });

  test("a reopen of a caregiver's resolve leaves takenBackPressIds as it was", async () => {
    const f = await dueFixture();
    await press(f, "2027-03-14T12:05:00Z", 0, A);
    await undo(f, "2027-03-14T12:05:10Z", 0, A);
    await confirmAs(f, "max", "2027-03-14T12:05:20Z");
    const reopened = await reopenAs(f, "pat", "2027-03-14T12:06:00Z");
    expect(reopened.takenBackPressIds).toEqual([A]);
    expect(reopened.confirmTakenBackBy).toBe("phone");
  });

  test("the confirm stores the id and an undo clears it and records it", async () => {
    const f = await dueFixture();
    await press(f, "2027-03-14T12:05:00Z", 0, A);
    expect((await row(f)).confirmPressIds).toEqual([A]);
    await undo(f, "2027-03-14T12:05:10Z", 0, A);
    expect((await row(f)).confirmPressIds).toBeUndefined();
    expect((await row(f)).takenBackPressIds).toEqual([A]);
  });

  test.each(["short", "has spaces in it okay", "x".repeat(65), "bad/char/in/the/id/x"])(
    "an invalid press id (%s) is refused",
    async (bad) => {
      const f = await dueFixture();
      expect(await press(f, "2027-03-14T12:05:00Z", 0, bad)).toMatchObject({
        status: "rejected",
        reason: "The press id is not valid",
      });
      await press(f, "2027-03-14T12:05:10Z", 0, A);
      await expect(undo(f, "2027-03-14T12:05:20Z", 0, bad)).rejects.toMatchObject({
        data: { code: "invalid" },
      });
    },
  );

  test("the confirm, the undo and a refused press record the press id in the audit", async () => {
    const f = await dueFixture();
    await press(f, "2027-03-14T12:05:00Z", 0, A);
    await undo(f, "2027-03-14T12:05:10Z", 0, A);
    await press(f, "2027-03-14T12:05:20Z", 0, A);
    const rows = await audits(f);
    const changes = rows.filter((r) => r.action === "state_change");
    expect(changes.at(-2)!.detail).toMatchObject({ to: "confirmed", pressId: A });
    expect(changes.at(-1)!.detail).toMatchObject({ undo: true, pressId: A });
    const refused = rows.filter((r) => r.action === "press_not_applied").at(-1)!;
    expect(refused.detail).toMatchObject({ pressId: A, reason: PRESS_TAKEN_BACK });
  });

  /** A third well-formed press id. */
  const C = "pressCCCCCCCCCCCCCCC";

  /**
   * purpose: Send a queued press from a given device identity.
   * @param f: (Fixture) Fixture.
   * @param subject: (string) "phone" or "display".
   * @param iso: (string) UTC instant it arrives.
   * @param pressId: (string) Its id.
   * @return: (Promise<object>) The PressResult.
   */
  async function pressFrom(f: Fixture, subject: string, iso: string, pressId: string) {
    at(iso);
    return await f.t.withIdentity({ subject }).mutation(api.instances.confirmPressedTask, {
      instanceId: f.instanceId,
      via: "button",
      pressedAgoMs: 0,
      pressId,
    });
  }

  test("a same-device press that lands as a no-op joins the confirmation and its Undo applies", async () => {
    const f = await dueFixture();
    await press(f, "2027-03-14T12:05:00Z", 0, A);
    const auditCount = (await audits(f)).length;
    expect(await press(f, "2027-03-14T12:05:05Z", 0, B)).toMatchObject({ status: "confirmed" });
    expect((await row(f)).confirmPressIds).toEqual([A, B]);
    expect((await audits(f)).length).toBe(auditCount);
    expect(await undo(f, "2027-03-14T12:05:10Z", 0, B)).toMatchObject({ status: "undone" });
    const after = await row(f);
    expect(after.state).toBe("due");
    expect(after.confirmPressIds).toBeUndefined();
    expect(after.takenBackPressIds).toEqual([A, B]);
  });

  test("a no-op press from another device user adds no id, and its undo is too_late", async () => {
    const f = await dueFixture();
    await press(f, "2027-03-14T12:05:00Z", 0, A);
    expect(await pressFrom(f, "display", "2027-03-14T12:05:05Z", C)).toMatchObject({
      status: "confirmed",
    });
    expect((await row(f)).confirmPressIds).toEqual([A]);
    const undone = await f.t
      .withIdentity({ subject: "display" })
      .mutation(api.instances.undoPressedTask, { instanceId: f.instanceId, pressId: C });
    expect(undone).toEqual({ status: "too_late" });
    expect((await row(f)).state).toBe("confirmed");
  });

  test("a no-op press on a caregiver's resolve adds no id", async () => {
    const f = await dueFixture();
    await confirmAs(f, "max", "2027-03-14T12:05:00Z");
    await press(f, "2027-03-14T12:05:05Z", 0, A);
    expect((await row(f)).confirmPressIds).toBeUndefined();
    expect(await undo(f, "2027-03-14T12:05:10Z", 0, A)).toEqual({ status: "too_late" });
  });

  test("a no-op press on another device's confirm adds no id", async () => {
    const f = await dueFixture();
    await pressFrom(f, "display", "2027-03-14T12:05:00Z", C);
    await press(f, "2027-03-14T12:05:05Z", 0, A);
    expect((await row(f)).confirmPressIds).toEqual([C]);
    expect(await undo(f, "2027-03-14T12:05:10Z", 0, A)).toEqual({ status: "too_late" });
  });

  test("the cap of 4 keeps the confirming press, and its Undo still applies", async () => {
    const f = await dueFixture();
    const others = ["n1", "n2", "n3", "n4"].map((n) => `press${n}xxxxxxxxxxxxx`);
    await press(f, "2027-03-14T12:05:00Z", 0, A);
    for (const [i, id] of others.entries()) {
      await press(f, `2027-03-14T12:05:0${i + 1}Z`, 0, id);
    }
    expect((await row(f)).confirmPressIds).toEqual([A, ...others.slice(1)]);
    expect(await undo(f, "2027-03-14T12:05:10Z", 0, A)).toMatchObject({ status: "undone" });
  });

  test("after the take-back a resend of any id of the confirmation is refused", async () => {
    const f = await dueFixture();
    await press(f, "2027-03-14T12:05:00Z", 0, A);
    await press(f, "2027-03-14T12:05:05Z", 0, B);
    await undo(f, "2027-03-14T12:05:10Z", 0, B);
    for (const id of [A, B]) {
      expect(await press(f, "2027-03-14T12:05:20Z", 0, id)).toMatchObject({
        status: "rejected",
        reason: PRESS_TAKEN_BACK,
      });
    }
    expect((await row(f)).state).toBe("due");
  });

  test("a resend of an undone press on a later confirm does not join it, so its resent undo is too_late", async () => {
    const f = await dueFixture();
    await press(f, "2027-03-14T12:05:00Z", 0, A);
    await undo(f, "2027-03-14T12:05:10Z", 0, A);
    await press(f, "2027-03-14T12:05:20Z", 0, B);
    await press(f, "2027-03-14T12:05:25Z", 0, A);
    expect((await row(f)).confirmPressIds).toEqual([B]);
    expect(await undo(f, "2027-03-14T12:05:30Z", 20_000, A)).toEqual({ status: "too_late" });
    expect((await row(f)).state).toBe("confirmed");
  });

  test("a reopen takes back every id of the confirmation and audits them", async () => {
    const f = await dueFixture();
    await press(f, "2027-03-14T12:05:00Z", 0, A);
    await press(f, "2027-03-14T12:05:05Z", 0, B);
    const reopened = await reopenAs(f, "pat", "2027-03-14T12:06:00Z");
    expect(reopened.takenBackPressIds).toEqual([A, B]);
    expect(reopened.confirmPressIds).toBeUndefined();
    const last = (await audits(f)).filter((r) => r.action === "state_change").at(-1)!;
    expect(last.detail).toMatchObject({ reopen: true, takenBackPressIds: [A, B] });
    expect(await press(f, "2027-03-14T12:06:10Z", 0, B)).toMatchObject({ status: "rejected" });
  });

  test("an old-format undo (no id) audits the ids it actually took back", async () => {
    const f = await dueFixture();
    await press(f, "2027-03-14T12:05:00Z", 0, A);
    await undo(f, "2027-03-14T12:05:10Z", 0);
    const last = (await audits(f)).filter((r) => r.action === "state_change").at(-1)!;
    expect(last.detail).toMatchObject({ undo: true, takenBackPressIds: [A] });
    expect(last.detail).not.toHaveProperty("pressId");
  });

  test("an invalid id on a no-op press is refused and never stored", async () => {
    const f = await dueFixture();
    await press(f, "2027-03-14T12:05:00Z", 0, A);
    expect(await press(f, "2027-03-14T12:05:05Z", 0, "bad id")).toMatchObject({
      status: "rejected",
      reason: PRESS_ID_NOT_VALID,
    });
    expect((await row(f)).confirmPressIds).toEqual([A]);
  });

  test("an undo answered too_late is audited with its reason, valid id, tap age and times", async () => {
    const f = await dueFixture();
    await press(f, "2027-03-14T12:05:00Z", 0, A);
    expect(await undo(f, "2027-03-14T12:05:30Z", 10_000, B)).toEqual({ status: "too_late" });
    const row1 = (await audits(f)).filter((r) => r.action === "undo_not_applied").at(-1)!;
    expect(row1.detail).toEqual({
      reason: "This press is not part of the task's confirmation",
      instanceId: f.instanceId,
      undoneAgoMs: 10_000,
      tappedAt: Date.parse("2027-03-14T12:05:20Z"),
      receivedAt: Date.parse("2027-03-14T12:05:30Z"),
      pressId: B,
    });
  });

  test.each(["missing instance", "existing instance"])(
    "a 100,000-character id leaves a small audit row without the id (%s)",
    async (which) => {
      const f = await dueFixture();
      if (which === "missing instance") {
        await f.t.run(async (ctx) => await ctx.db.delete(f.instanceId));
      }
      const huge = "x".repeat(100_000);
      expect(await press(f, "2027-03-14T12:05:00Z", 0, huge)).toMatchObject({
        status: "rejected",
        reason: PRESS_ID_NOT_VALID,
      });
      const rows = await f.t.run(async (ctx) => await ctx.db.query("auditLog").collect());
      const refused = rows.filter((r) => r.action === "press_not_applied");
      expect(refused).toHaveLength(1);
      expect(refused[0]!.detail).not.toHaveProperty("pressId");
      expect(JSON.stringify(refused[0]!.detail).length).toBeLessThan(1000);
    },
  );

  test("an invalid id for another household's instance is forbidden, with no row and no raw id", async () => {
    const f = await dueFixture();
    const other = await f.t.withIdentity({ subject: "zed" }).mutation(api.households.create, {
      seniorPreferredName: "Dad",
      timezone: "America/New_York",
      caregiverDisplayName: "Zed",
    });
    await pair(f.t, other, "zed", "otherphone", "senior_phone");
    const before = await f.t.run(async (ctx) => await ctx.db.query("auditLog").collect());
    const raw = "not a valid id " + "y".repeat(500);
    at("2027-03-14T12:05:00Z");
    await expect(
      f.t.withIdentity({ subject: "otherphone" }).mutation(api.instances.confirmPressedTask, {
        instanceId: f.instanceId,
        via: "button",
        pressedAgoMs: 0,
        pressId: raw,
      }),
    ).rejects.toMatchObject({ data: { code: "forbidden" } });
    const after = await f.t.run(async (ctx) => await ctx.db.query("auditLog").collect());
    expect(after).toHaveLength(before.length);
    expect(JSON.stringify(after)).not.toContain("yyyyyyyy");
    expect((await row(f)).state).toBe("due");
  });

  test("the day entry carries confirmPressIds: the confirm, a same-device no-op, then [] after undo", async () => {
    const f = await dueFixture();
    /**
     * purpose: The fixture's entry as the phone reads it (calendar.dayView) and as the voice
     *          agent's context reads it (agent.today), which share lib/today's builder.
     * @return: (Promise<string[][]>) confirmPressIds from both, in that order.
     */
    const ids = async (): Promise<string[][]> => {
      const day = await f.t
        .withIdentity({ subject: "phone" })
        .query(api.calendar.dayView, { householdId: f.householdId });
      const agent = await f.t.query(api.agent.today, {
        agentKey: "test-agent-key",
        householdId: f.householdId,
      });
      return [day.tasks, agent].map(
        (list) => list.find((e) => e.instanceId === f.instanceId)!.confirmPressIds,
      );
    };
    const saved = process.env.SUNNY_AGENT_KEY;
    process.env.SUNNY_AGENT_KEY = "test-agent-key";
    try {
      await press(f, "2027-03-14T12:05:00Z", 0, A);
      expect(await ids()).toEqual([[A], [A]]);
      await press(f, "2027-03-14T12:05:05Z", 0, B);
      expect(await ids()).toEqual([
        [A, B],
        [A, B],
      ]);
      await undo(f, "2027-03-14T12:05:10Z", 0, B);
      expect(await ids()).toEqual([[], []]);
    } finally {
      if (saved === undefined) delete process.env.SUNNY_AGENT_KEY;
      else process.env.SUNNY_AGENT_KEY = saved;
    }
  });

  test("confirmInstance refuses a press id from a caregiver actor", async () => {
    const f = await dueFixture();
    at("2027-03-14T12:05:00Z");
    await expect(
      f.t.run(async (ctx) => {
        const member = await ctx.db
          .query("householdMembers")
          .filter((q) => q.eq(q.field("userId"), "pat"))
          .first();
        const actor = {
          kind: "caregiver" as const,
          userId: "pat",
          householdId: f.householdId,
          role: "primary" as const,
          member: member!,
        };
        return await confirmInstance(
          ctx,
          actor,
          { instanceId: f.instanceId, via: "caregiver", pressId: A },
          Date.now(),
        );
      }),
    ).rejects.toMatchObject({
      data: { code: "invalid", message: "Only the senior's device can send a press id" },
    });
  });
});

describe("queuedPressTakenBack", () => {
  const stamped = { confirmTakenBackAt: 1000, confirmTakenBackBy: "phone" };

  /**
   * purpose: Ask the rule about one press.
   * @param pressedAt: (number) When it was pressed.
   * @param pressId: (string | undefined) Its id.
   * @param userId: (string) The device sending it.
   * @param instance: (object) The take-back fields.
   * @return: (boolean) Whether it is refused (the rule gives a reason).
   */
  const refused = (
    pressedAt: number,
    pressId: string | undefined,
    userId: string,
    instance: Parameters<typeof queuedPressTakenBack>[1] = stamped,
  ) => queuedPressTakenBack({ pressedAt, pressId, userId }, instance) !== null;

  test("gives the list check and the time rule different reasons", () => {
    const undone = { ...stamped, takenBackPressIds: ["p"] };
    expect(queuedPressTakenBack({ pressedAt: 5000, pressId: "p", userId: "x" }, undone)).toBe(
      PRESS_TAKEN_BACK,
    );
    expect(queuedPressTakenBack({ pressedAt: 999, pressId: undefined, userId: "x" }, stamped)).toBe(
      PRESS_BEFORE_TAKE_BACK,
    );
    expect(PRESS_TAKEN_BACK).toBe("This press was taken back");
  });

  test("uses the time rule for a press without an id", () => {
    expect(refused(1000, undefined, "phone")).toBe(true);
    expect(refused(1001, undefined, "phone")).toBe(false);
  });

  test("skips the time rule after the same device's own take-back", () => {
    expect(refused(999, "p", "phone")).toBe(false);
  });

  test("keeps the time rule after another user's take-back", () => {
    expect(refused(999, "p", "display")).toBe(true);
  });

  test("refuses an undone id whatever the time", () => {
    expect(refused(5000, "p", "phone", { ...stamped, takenBackPressIds: ["p"] })).toBe(true);
  });

  test("withTakenBackPressIds adds nothing for no ids and caps the list", () => {
    expect(withTakenBackPressIds(undefined, undefined)).toBeUndefined();
    const full = Array.from({ length: MAX_TAKEN_BACK_PRESS_IDS }, (_, i) => `id${i}`);
    expect(withTakenBackPressIds(full, ["new"])).toEqual([...full.slice(1), "new"]);
  });

  test("withConfirmPressId keeps the confirming press first and the newest three others", () => {
    expect(withConfirmPressId(undefined, "a")).toEqual(["a"]);
    expect(withConfirmPressId(["a"], "a")).toEqual(["a"]);
    let ids = ["c0"];
    for (const id of ["n1", "n2", "n3", "n4"]) ids = withConfirmPressId(ids, id);
    expect(ids).toEqual(["c0", "n2", "n3", "n4"]);
    expect(ids).toHaveLength(MAX_CONFIRM_PRESS_IDS);
  });
});
