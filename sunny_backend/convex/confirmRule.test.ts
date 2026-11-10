// confirmRule.test.ts
// Purpose: Tests that the day view's per-task `confirmable` flag and the confirm mutation agree
// (they share lib/confirmRule.ts): an upcoming task 61, 60 and 59 minutes before its window,
// due, escalated, missed (late), snoozed, already confirmed, and anytime. Also the optional
// pressedAt argument of confirmTaskInstance, for a confirm pressed offline and replayed later:
// recorded as confirmedAt (also after the window closed), clamped to now and to the
// early-confirm point, audited with both times, refused from non-device callers, not
// re-audited on a repeat, and not letting a too-early server time through. The clock is faked.
//
// Last modified: 2026-11-09

import workpoolTest from "@convex-dev/workpool/test";
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
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

describe("pressedAt", () => {
  /**
   * purpose: Confirm the instance as the phone at `iso` with a press time.
   * @param f: (Fixture) Fixture.
   * @param iso: (string) Server time of the call.
   * @param pressedAt: (number) The press time sent.
   * @return: (Promise<object>) The instance after.
   */
  async function confirmAt(f: Fixture, iso: string, pressedAt: number) {
    at(iso);
    return await f.t
      .withIdentity({ subject: "phone" })
      .mutation(api.instances.confirmTaskInstance, {
        instanceId: f.instanceId,
        via: "phone_app",
        pressedAt,
      });
  }

  /**
   * purpose: The audit rows that carry a press time.
   * @param f: (Fixture) Fixture.
   * @return: (Promise<object[]>) The rows.
   */
  async function pressRows(f: Fixture) {
    const rows = await f.t.run(async (ctx) => await ctx.db.query("auditLog").collect());
    return rows.filter((r) => r.detail["pressedAt"] !== undefined);
  }

  test("a late replay is recorded at the press time and audits both times", async () => {
    const f = await setup();
    await force(f, { state: "due" });
    const pressed = Date.parse("2027-03-14T12:05:00Z");
    const row = await confirmAt(f, "2027-03-14T15:00:00Z", pressed);
    expect(row).toMatchObject({
      state: "confirmed",
      confirmedAt: pressed,
      confirmedVia: "phone_app",
    });
    const [audit] = await pressRows(f);
    expect(audit!.detail).toMatchObject({
      pressedAt: pressed,
      confirmedAt: pressed,
      receivedAt: Date.parse("2027-03-14T15:00:00Z"),
    });
  });

  test("a replay after the window closed and the task was marked missed keeps the press time", async () => {
    const f = await setup();
    await force(f, { state: "missed" });
    const pressed = Date.parse("2027-03-14T12:10:00Z");
    const row = await confirmAt(f, "2027-03-14T16:00:00Z", pressed);
    expect(row).toMatchObject({ state: "confirmed", confirmedAt: pressed });
  });

  test("a replay after the task escalated keeps the press time", async () => {
    const f = await setup();
    await force(f, { state: "escalated" });
    const pressed = Date.parse("2027-03-14T12:10:00Z");
    const row = await confirmAt(f, "2027-03-14T13:00:00Z", pressed);
    expect(row).toMatchObject({ state: "confirmed", confirmedAt: pressed });
  });

  test("a press time in the future is clamped to now", async () => {
    const f = await setup();
    await force(f, { state: "due" });
    const now = Date.parse("2027-03-14T12:30:00Z");
    const row = await confirmAt(f, "2027-03-14T12:30:00Z", now + HOUR);
    expect(row.confirmedAt).toBe(now);
  });

  test("a press time before the early-confirm point is clamped up to it", async () => {
    const f = await setup();
    await force(f, { state: "due" });
    const row = await confirmAt(f, "2027-03-14T12:30:00Z", WINDOW_START - 5 * HOUR);
    expect(row.confirmedAt).toBe(WINDOW_START - HOUR);
  });

  test("the early check still uses the server clock", async () => {
    const f = await setup();
    await expect(
      confirmAt(f, "2027-03-14T10:00:00Z", Date.parse("2027-03-14T11:30:00Z")),
    ).rejects.toMatchObject({ data: { code: "invalid", message: "This task is not due yet" } });
  });

  test("only a senior device may send a press time", async () => {
    const f = await setup();
    await force(f, { state: "due" });
    at("2027-03-14T12:30:00Z");
    await expect(
      f.t.withIdentity({ subject: "max" }).mutation(api.instances.confirmTaskInstance, {
        instanceId: f.instanceId,
        via: "caregiver",
        pressedAt: Date.now(),
      }),
    ).rejects.toMatchObject({ data: { code: "invalid" } });
  });

  test("a repeated confirm changes nothing and writes no second audit row", async () => {
    const f = await setup();
    await force(f, { state: "due" });
    const first = Date.parse("2027-03-14T12:20:00Z");
    await confirmAt(f, "2027-03-14T12:30:00Z", first);
    const again = await confirmAt(f, "2027-03-14T12:31:00Z", Date.parse("2027-03-14T12:25:00Z"));
    expect(again.confirmedAt).toBe(first);
    expect(await pressRows(f)).toHaveLength(1);
  });
});
