// confirmRule.test.ts
// Purpose: Tests that the day view's per-task `confirmable` flag and the confirm mutation agree
// (they share lib/confirmRule.ts): an upcoming task 61, 60 and 59 minutes before its window,
// due, escalated, missed (late), snoozed, already confirmed, and anytime. Also the optional
// pressedAgoMs argument of confirmTaskInstance, for a confirm pressed offline and replayed
// later (an age, so device clock skew cannot move the record): confirmedAt is now minus the
// age (also after the window closed or the task escalated), clamped to now and to the
// early-confirm point, audited, marked late with confirmReceivedAt (more than five minutes,
// exposed on the day view with its local time), NaN, Infinity and negative ages refused,
// refused from caregivers and the agent, allowed from a display device, only the named
// instance confirmed (a carried-over one from yesterday), not re-audited on a repeat, and not
// letting a too-early server time through. The clock is faked.
//
// Last modified: 2026-11-09

import workpoolTest from "@convex-dev/workpool/test";
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { confirmInstance } from "./instances";
import schema from "./schema";

/** Every non-test module in the backend, for the convex-test harness. */
const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);

/** The instance of the 08:00 task on 2027-03-14 starts at 12:00Z (New York, daylight time). */
const WINDOW_START = Date.parse("2027-03-14T12:00:00Z");
const HOUR = 3_600_000;

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
  return convexTest(schema, modules);
}

/** A household with Pat (primary), Max (member) and the paired phone "phone". */
interface Fixture {
  t: ReturnType<typeof makeBackend>;
  householdId: Id<"households">;
  instanceId: Id<"taskInstances">;
}

/**
 * purpose: Build the fixture: a household at 09:00Z with one 08:00 medication task, whose
 *          instance is upcoming (the scheduler is not run, so states are forced by tests).
 * @return: (Promise<Fixture>) The fixture.
 */
async function setup(): Promise<Fixture> {
  at("2027-03-14T09:00:00Z");
  const t = makeBackend();
  workpoolTest.register(t, "deliveryPool");
  const pat = t.withIdentity({ subject: "pat" });
  const householdId = await pat.mutation(api.households.create, {
    seniorPreferredName: "Mom",
    timezone: "America/New_York",
    caregiverDisplayName: "Pat",
  });
  const member = await pat.mutation(api.households.createJoinCode, {
    householdId,
    grants: "caregiver_member",
  });
  await t.withIdentity({ subject: "max" }).mutation(api.households.redeemJoinCode, {
    code: member.code,
  });
  const device = await pat.mutation(api.households.createJoinCode, {
    householdId,
    grants: "senior_phone",
  });
  await t.mutation(internal.households.pairDevice, { code: device.code, userId: "phone" });
  const display = await pat.mutation(api.households.createJoinCode, {
    householdId,
    grants: "home_display",
  });
  await t.mutation(internal.households.pairDevice, { code: display.code, userId: "display" });
  const policies = await pat.query(api.tasks.listPolicies, { householdId });
  await pat.mutation(api.tasks.create, {
    householdId,
    type: "medication",
    title: "Morning pills",
    displayLabel: "Morning pills",
    times: ["08:00"],
    escalationPolicyId: policies.find((p) => p.systemKey === "medication")!._id,
  });
  const rows = await t.run(async (ctx) => await ctx.db.query("taskInstances").collect());
  return { t, householdId, instanceId: rows[0]!._id };
}

/**
 * purpose: Force the instance's state and fields.
 * @param f: (Fixture) Fixture.
 * @param patch: (object) Fields to set.
 * @return: (Promise<void>)
 */
async function force(f: Fixture, patch: Record<string, unknown>): Promise<void> {
  await f.t.run(async (ctx) => await ctx.db.patch(f.instanceId, patch));
}

/**
 * purpose: Read the phone's `confirmable` flag for the fixture's instance, then try the
 *          confirm mutation as the phone, both at the current faked time.
 * @param f: (Fixture) Fixture.
 * @return: (Promise<object>) The flag and whether the mutation was accepted.
 */
async function flagAndConfirm(f: Fixture): Promise<{ flag: boolean; accepted: boolean }> {
  const asPhone = f.t.withIdentity({ subject: "phone" });
  const day = await asPhone.query(api.calendar.dayView, { householdId: f.householdId });
  const flag = day.tasks.find((x) => x.instanceId === f.instanceId)!.confirmable;
  const accepted = await asPhone
    .mutation(api.instances.confirmTaskInstance, { instanceId: f.instanceId, via: "phone_app" })
    .then(
      () => true,
      () => false,
    );
  return { flag, accepted };
}

describe("confirmable flag and the confirm mutation agree", () => {
  test.each([
    ["61 minutes early", "2027-03-14T10:59:00Z", false],
    ["60 minutes early", "2027-03-14T11:00:00Z", true],
    ["59 minutes early", "2027-03-14T11:01:00Z", true],
  ])("an upcoming task %s", async (_name, iso, expected) => {
    const f = await setup();
    at(iso);
    expect(await flagAndConfirm(f)).toEqual({ flag: expected, accepted: expected });
  });

  test.each(["due", "escalated", "missed"] as const)("a %s task", async (state) => {
    const f = await setup();
    await force(f, { state });
    at("2027-03-14T12:30:00Z");
    expect(await flagAndConfirm(f)).toEqual({ flag: true, accepted: true });
  });

  test("a snoozed due task is still confirmable", async () => {
    const f = await setup();
    await force(f, { state: "due", snoozedUntil: Date.parse("2027-03-14T13:00:00Z") });
    at("2027-03-14T12:10:00Z");
    expect(await flagAndConfirm(f)).toEqual({ flag: true, accepted: true });
  });

  test("a confirmed task is not confirmable (confirming it again changes nothing)", async () => {
    const f = await setup();
    await force(f, { state: "confirmed", confirmedAt: WINDOW_START });
    at("2027-03-14T12:30:00Z");
    expect(await flagAndConfirm(f)).toEqual({ flag: false, accepted: true });
  });

  test("an anytime task is confirmable all day", async () => {
    const f = await setup();
    await f.t.withIdentity({ subject: "pat" }).mutation(api.tasks.create, {
      householdId: f.householdId,
      type: "reminder",
      title: "Water plants",
      displayLabel: "Water plants",
      times: [],
    });
    at("2027-03-14T14:00:00Z");
    const asPhone = f.t.withIdentity({ subject: "phone" });
    const day = await asPhone.query(api.calendar.dayView, { householdId: f.householdId });
    const entry = day.tasks.find((x) => x.displayLabel === "Water plants")!;
    expect(entry.confirmable).toBe(true);
    await expect(
      asPhone.mutation(api.instances.confirmTaskInstance, {
        instanceId: entry.instanceId,
        via: "phone_app",
      }),
    ).resolves.toMatchObject({ state: "confirmed" });
  });
});

describe("pressedAgoMs", () => {
  /**
   * purpose: Confirm the instance as the given identity at `iso` with a press age.
   * @param f: (Fixture) Fixture.
   * @param iso: (string) Server time of the call.
   * @param pressedAgoMs: (number) The press age sent.
   * @param options: ({ subject, via, instanceId }) Caller, surface and instance overrides.
   * @return: (Promise<object>) The instance after.
   */
  async function confirmAgo(
    f: Fixture,
    iso: string,
    pressedAgoMs: number,
    options: {
      subject?: string;
      via?: "phone_app" | "button" | "caregiver";
      instanceId?: Id<"taskInstances">;
    } = {},
  ) {
    at(iso);
    return await f.t
      .withIdentity({ subject: options.subject ?? "phone" })
      .mutation(api.instances.confirmTaskInstance, {
        instanceId: options.instanceId ?? f.instanceId,
        via: options.via ?? "phone_app",
        pressedAgoMs,
      });
  }

  /**
   * purpose: The audit rows that carry a press age.
   * @param f: (Fixture) Fixture.
   * @return: (Promise<object[]>) The rows.
   */
  async function pressRows(f: Fixture) {
    const rows = await f.t.run(async (ctx) => await ctx.db.query("auditLog").collect());
    return rows.filter((r) => r.detail["pressedAgoMs"] !== undefined);
  }

  test("a late replay is recorded at now minus the age, audited, and marked as received late", async () => {
    const f = await setup();
    await force(f, { state: "due" });
    const now = Date.parse("2027-03-14T15:00:00Z");
    const pressed = Date.parse("2027-03-14T12:05:00Z");
    const row = await confirmAgo(f, "2027-03-14T15:00:00Z", now - pressed);
    expect(row).toMatchObject({
      state: "confirmed",
      confirmedAt: pressed,
      confirmedVia: "phone_app",
      confirmReceivedAt: now,
    });
    const [audit] = await pressRows(f);
    expect(audit!.detail).toMatchObject({
      pressedAgoMs: now - pressed,
      confirmedAt: pressed,
      receivedAt: now,
    });
  });

  test("a live press (age near zero) is recorded now and not marked late", async () => {
    const f = await setup();
    await force(f, { state: "due" });
    const now = Date.parse("2027-03-14T12:30:00Z");
    const row = await confirmAgo(f, "2027-03-14T12:30:00Z", 800);
    expect(row.confirmedAt).toBe(now - 800);
    expect(row.confirmReceivedAt).toBeUndefined();
  });

  test("the late-synced mark needs more than five minutes", async () => {
    const f = await setup();
    await force(f, { state: "due" });
    const row = await confirmAgo(f, "2027-03-14T12:30:00Z", 5 * 60_000);
    expect(row.confirmReceivedAt).toBeUndefined();
    const g = await setup();
    await force(g, { state: "due" });
    const late = await confirmAgo(g, "2027-03-14T12:30:00Z", 5 * 60_000 + 1);
    expect(late.confirmReceivedAt).toBe(Date.parse("2027-03-14T12:30:00Z"));
  });

  test("the day view carries confirmReceivedAt and its local time", async () => {
    const f = await setup();
    await force(f, { state: "due" });
    await confirmAgo(f, "2027-03-14T15:00:00Z", 3 * HOUR);
    const day = await f.t
      .withIdentity({ subject: "pat" })
      .query(api.calendar.dayView, { householdId: f.householdId });
    const entry = day.tasks.find((x) => x.instanceId === f.instanceId)!;
    expect(entry).toMatchObject({
      confirmedLocalTime: "08:00",
      confirmReceivedAt: Date.parse("2027-03-14T15:00:00Z"),
      confirmReceivedLocalTime: "11:00",
    });
  });

  test("a replay after the window closed and the task was marked missed keeps the press time", async () => {
    const f = await setup();
    await force(f, { state: "missed" });
    const pressed = Date.parse("2027-03-14T12:10:00Z");
    const row = await confirmAgo(
      f,
      "2027-03-14T16:00:00Z",
      Date.parse("2027-03-14T16:00:00Z") - pressed,
    );
    expect(row).toMatchObject({ state: "confirmed", confirmedAt: pressed });
  });

  test("a replay after the task escalated keeps the press time", async () => {
    const f = await setup();
    await force(f, { state: "escalated" });
    const pressed = Date.parse("2027-03-14T12:10:00Z");
    const row = await confirmAgo(
      f,
      "2027-03-14T13:00:00Z",
      Date.parse("2027-03-14T13:00:00Z") - pressed,
    );
    expect(row).toMatchObject({ state: "confirmed", confirmedAt: pressed });
  });

  test("an age that would put the press before the early-confirm point is clamped up to it", async () => {
    const f = await setup();
    await force(f, { state: "due" });
    const row = await confirmAgo(f, "2027-03-14T12:30:00Z", 50 * HOUR);
    expect(row.confirmedAt).toBe(WINDOW_START - HOUR);
  });

  test("the early check still uses the server clock", async () => {
    const f = await setup();
    await expect(confirmAgo(f, "2027-03-14T10:00:00Z", 1000)).rejects.toMatchObject({
      data: { code: "invalid", message: "This task is not due yet" },
    });
  });

  test.each([Number.NaN, Number.POSITIVE_INFINITY, -1])("refuses an age of %s", async (bad) => {
    const f = await setup();
    await force(f, { state: "due" });
    await expect(confirmAgo(f, "2027-03-14T12:30:00Z", bad)).rejects.toMatchObject({
      data: { code: "invalid" },
    });
  });

  test("a caregiver may not send a press age", async () => {
    const f = await setup();
    await force(f, { state: "due" });
    await expect(
      confirmAgo(f, "2027-03-14T12:30:00Z", 1000, { subject: "max", via: "caregiver" }),
    ).rejects.toMatchObject({ data: { code: "invalid" } });
  });

  test("the agent may not send a press age", async () => {
    const f = await setup();
    await force(f, { state: "due" });
    at("2027-03-14T12:30:00Z");
    await expect(
      f.t.run(
        async (ctx) =>
          await confirmInstance(
            ctx,
            { kind: "agent" },
            { instanceId: f.instanceId, via: "voice", pressedAgoMs: 1000 },
            Date.now(),
          ),
      ),
    ).rejects.toMatchObject({ data: { code: "invalid" } });
  });

  test("a display device confirming via button may send a press age", async () => {
    const f = await setup();
    await force(f, { state: "due" });
    const row = await confirmAgo(f, "2027-03-14T12:30:00Z", 2000, {
      subject: "display",
      via: "button",
    });
    expect(row).toMatchObject({ state: "confirmed", confirmedVia: "button" });
  });

  test("a carried-over instance from yesterday confirms only that instance", async () => {
    const f = await setup();
    await force(f, { state: "due" });
    const yesterday = await f.t.run(async (ctx) => {
      const base = (await ctx.db.get(f.instanceId))!;
      const { _id, _creationTime, ...rest } = base;
      return await ctx.db.insert("taskInstances", {
        ...rest,
        localDate: "2027-03-13",
        windowStart: base.windowStart - 24 * HOUR,
        windowEnd: base.windowEnd - 24 * HOUR,
        state: "due",
      });
    });
    const row = await confirmAgo(f, "2027-03-14T12:30:00Z", 1000, { instanceId: yesterday });
    expect(row).toMatchObject({ state: "confirmed", localDate: "2027-03-13" });
    const today = await f.t.run(async (ctx) => await ctx.db.get(f.instanceId));
    expect(today!.state).toBe("due");
  });

  test("a repeated confirm changes nothing and writes no second audit row", async () => {
    const f = await setup();
    await force(f, { state: "due" });
    await confirmAgo(f, "2027-03-14T12:30:00Z", 10 * 60_000);
    const again = await confirmAgo(f, "2027-03-14T12:31:00Z", 6 * 60_000);
    expect(again.confirmedAt).toBe(Date.parse("2027-03-14T12:20:00Z"));
    expect(await pressRows(f)).toHaveLength(1);
  });
});
