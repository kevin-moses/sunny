import workpoolTest from "@convex-dev/workpool/test";
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { confirmInstance } from "./instances";
import { receivedDaysLater } from "./lib/today";
import schema from "./schema";

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);

const WINDOW_START = Date.parse("2027-03-14T12:00:00Z");
const HOUR = 3_600_000;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
});

afterEach(() => {
  vi.useRealTimers();
});

function at(iso: string): number {
  vi.setSystemTime(new Date(iso));
  return Date.parse(iso);
}

function makeBackend() {
  return convexTest(schema, modules);
}

interface Fixture {
  t: ReturnType<typeof makeBackend>;
  householdId: Id<"households">;
  instanceId: Id<"taskInstances">;
}

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
  await pat.mutation(api.tasks.create, {
    householdId,
    type: "medication",
    title: "Morning pills",
    displayLabel: "Morning pills",
    times: ["08:00"],
  });
  const rows = await t.run(async (ctx) => await ctx.db.query("taskInstances").collect());
  return { t, householdId, instanceId: rows[0]!._id };
}

async function force(f: Fixture, patch: Record<string, unknown>): Promise<void> {
  await f.t.run(async (ctx) => await ctx.db.patch(f.instanceId, patch));
}

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

describe("confirmPressedTask (pressedAgoMs)", () => {
  let pressCount = 0;

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
      .mutation(api.instances.confirmPressedTask, {
        instanceId: options.instanceId ?? f.instanceId,
        via: options.via ?? "phone_app",
        pressedAgoMs,
        pressId: `press${String((pressCount += 1)).padStart(12, "0")}`,
      });
  }

  async function confirmed(...args: Parameters<typeof confirmAgo>) {
    const result = await confirmAgo(...args);
    if (result.status !== "confirmed") throw new Error(`rejected: ${result.reason}`);
    return result.instance;
  }

  async function auditRows(f: Fixture, action: string) {
    const rows = await f.t.run(async (ctx) => await ctx.db.query("auditLog").collect());
    return rows.filter((r) => r.action === action);
  }

  test("a late replay is recorded at now minus the age, audited, and marked as received late", async () => {
    const f = await setup();
    await force(f, { state: "due" });
    const now = Date.parse("2027-03-14T15:00:00Z");
    const pressed = Date.parse("2027-03-14T12:05:00Z");
    const row = await confirmed(f, "2027-03-14T15:00:00Z", now - pressed);
    expect(row).toMatchObject({
      state: "confirmed",
      confirmedAt: pressed,
      confirmedVia: "phone_app",
      confirmReceivedAt: now,
    });
    const [audit] = await auditRows(f, "state_change");
    expect(audit!.detail).toMatchObject({
      pressedAgoMs: now - pressed,
      confirmedAt: pressed,
      receivedAt: now,
      replayed: true,
    });
  });

  test("a live press (age near zero) is recorded now and not marked late", async () => {
    const f = await setup();
    await force(f, { state: "due" });
    const now = Date.parse("2027-03-14T12:30:00Z");
    const row = await confirmed(f, "2027-03-14T12:30:00Z", 800);
    expect(row.confirmedAt).toBe(now - 800);
    expect(row.confirmReceivedAt).toBeUndefined();
  });

  test("the late-synced mark needs more than five minutes", async () => {
    const f = await setup();
    await force(f, { state: "due" });
    const row = await confirmed(f, "2027-03-14T12:30:00Z", 5 * 60_000);
    expect(row.confirmReceivedAt).toBeUndefined();
    const g = await setup();
    await force(g, { state: "due" });
    const late = await confirmed(g, "2027-03-14T12:30:00Z", 5 * 60_000 + 1);
    expect(late.confirmReceivedAt).toBe(Date.parse("2027-03-14T12:30:00Z"));
  });

  test("the day view carries the received time, its local time and the days later", async () => {
    const f = await setup();
    await force(f, { state: "due" });
    await confirmed(f, "2027-03-14T15:00:00Z", 3 * HOUR);
    const day = await f.t
      .withIdentity({ subject: "pat" })
      .query(api.calendar.dayView, { householdId: f.householdId });
    const entry = day.tasks.find((x) => x.instanceId === f.instanceId)!;
    expect(entry).toMatchObject({
      confirmedLocalTime: "08:00",
      confirmReceivedAt: Date.parse("2027-03-14T15:00:00Z"),
      confirmReceivedLocalTime: "11:00",
      confirmReceivedDaysLater: 0,
    });
  });

  test("a press at 11:30 PM that reaches the server after midnight is one day later", async () => {
    const f = await setup();
    await force(f, { state: "due", windowEnd: Date.parse("2027-03-15T05:00:00Z") });
    const pressed = Date.parse("2027-03-15T03:30:00Z");
    const received = Date.parse("2027-03-15T06:10:00Z");
    await confirmed(f, "2027-03-15T06:10:00Z", received - pressed);
    const row = await f.t.run(async (ctx) => await ctx.db.get(f.instanceId));
    expect(receivedDaysLater(row!, "America/New_York")).toBe(1);
    expect(
      receivedDaysLater({ confirmedAt: pressed, confirmReceivedAt: pressed }, "America/New_York"),
    ).toBe(0);
    expect(receivedDaysLater({ confirmedAt: pressed }, "America/New_York")).toBeNull();
  });

  test("a replay after the task was marked missed keeps the press time", async () => {
    const f = await setup();
    await force(f, { state: "missed" });
    const pressed = Date.parse("2027-03-14T12:10:00Z");
    const row = await confirmed(
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
    const row = await confirmed(
      f,
      "2027-03-14T13:00:00Z",
      Date.parse("2027-03-14T13:00:00Z") - pressed,
    );
    expect(row).toMatchObject({ state: "confirmed", confirmedAt: pressed });
  });

  test("a replay pressed within the early window keeps its press time", async () => {
    const f = await setup();
    const now = Date.parse("2027-03-14T12:30:00Z");
    const pressed = Date.parse("2027-03-14T11:50:00Z");
    const row = await confirmed(f, "2027-03-14T12:30:00Z", now - pressed);
    expect(row).toMatchObject({ confirmedAt: pressed, confirmReceivedAt: now });
  });

  test("a replay pressed before the early window is refused and audited (task moved while offline)", async () => {
    const f = await setup();
    const result = await confirmAgo(f, "2027-03-14T12:30:00Z", 2 * HOUR);
    expect(result).toEqual({
      status: "rejected",
      reason: "This task was not due yet when it was pressed",
    });
    const [row] = await auditRows(f, "press_not_applied");
    expect(row!.detail).toMatchObject({ pressedAgoMs: 2 * HOUR });
    const after = await f.t.run(async (ctx) => await ctx.db.get(f.instanceId));
    expect(after!.state).toBe("upcoming");
  });

  test("a stale card pressed the morning after is refused, not recorded as last night's dose", async () => {
    const f = await setup();
    await force(f, { state: "missed" });
    const result = await confirmAgo(f, "2027-03-15T12:30:00Z", 20 * 60_000);
    expect(result).toEqual({
      status: "rejected",
      reason: "This press was too long after the task's window",
    });
    expect(await auditRows(f, "press_not_applied")).toHaveLength(1);
  });

  test("a replay pressed within the grace after the window still counts", async () => {
    const f = await setup();
    await force(f, { state: "missed" });
    const windowEnd = (await f.t.run(async (ctx) => await ctx.db.get(f.instanceId)))!.windowEnd;
    const received = windowEnd + 5 * HOUR;
    const pressed = windowEnd + 2 * HOUR;
    const row = await confirmed(f, new Date(received).toISOString(), received - pressed);
    expect(row.confirmedAt).toBe(pressed);
  });

  test("a live press on a task that is too early is refused with a result, not an error, and audited", async () => {
    const f = await setup();
    const result = await confirmAgo(f, "2027-03-14T10:00:00Z", 1000);
    expect(result).toEqual({ status: "rejected", reason: "This task is not due yet" });
    const [row] = await auditRows(f, "press_not_applied");
    expect(row!.detail).toMatchObject({
      reason: "This task is not due yet",
      pressedAgoMs: 1000,
      receivedAt: Date.parse("2027-03-14T10:00:00Z"),
    });
    expect(row!.entityId).toBe(f.instanceId);
    const after = await f.t.run(async (ctx) => await ctx.db.get(f.instanceId));
    expect(after!.state).toBe("upcoming");
  });

  test("a replayed press for a task that no longer exists returns rejected and writes an audit row", async () => {
    const f = await setup();
    await f.t.run(async (ctx) => await ctx.db.delete(f.instanceId));
    const result = await confirmAgo(f, "2027-03-14T12:30:00Z", 20 * 60_000);
    expect(result).toEqual({ status: "rejected", reason: "The task no longer exists" });
    const [row] = await auditRows(f, "press_not_applied");
    expect(row).toMatchObject({ actorKind: "senior_device", entity: "task_instance" });
    expect(row!.detail).toMatchObject({
      instanceId: f.instanceId,
      pressedAgoMs: 20 * 60_000,
      pressedAt: Date.parse("2027-03-14T12:10:00Z"),
    });
  });

  test("an instance of another household throws instead of being recorded", async () => {
    const f = await setup();
    const xen = f.t.withIdentity({ subject: "xen" });
    const other = await xen.mutation(api.households.create, {
      seniorPreferredName: "Dad",
      timezone: "America/Chicago",
      caregiverDisplayName: "Xen",
    });
    await xen.mutation(api.tasks.create, {
      householdId: other,
      type: "medication",
      title: "Dad pills",
      displayLabel: "Dad pills",
      times: ["08:00"],
    });
    const theirs = await f.t.run(
      async (ctx) =>
        (await ctx.db.query("taskInstances").collect()).find((i) => i.householdId === other)!._id,
    );
    await expect(
      confirmAgo(f, "2027-03-14T12:30:00Z", 1000, { instanceId: theirs }),
    ).rejects.toMatchObject({ data: { code: "forbidden" } });
    expect(await auditRows(f, "press_not_applied")).toHaveLength(0);
  });

  test.each([Number.NaN, Number.POSITIVE_INFINITY, -1])("refuses an age of %s", async (bad) => {
    const f = await setup();
    await force(f, { state: "due" });
    await expect(confirmAgo(f, "2027-03-14T12:30:00Z", bad)).rejects.toMatchObject({
      data: { code: "invalid" },
    });
  });

  test("a caregiver may not use confirmPressedTask", async () => {
    const f = await setup();
    await force(f, { state: "due" });
    await expect(
      confirmAgo(f, "2027-03-14T12:30:00Z", 1000, { subject: "max", via: "caregiver" }),
    ).rejects.toMatchObject({ data: { code: "forbidden" } });
  });

  test("the agent may not send a press age to the confirm core", async () => {
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
    const row = await confirmed(f, "2027-03-14T12:30:00Z", 2000, {
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
    const row = await confirmed(f, "2027-03-14T12:30:00Z", 1000, { instanceId: yesterday });
    expect(row).toMatchObject({ state: "confirmed", localDate: "2027-03-13" });
    const today = await f.t.run(async (ctx) => await ctx.db.get(f.instanceId));
    expect(today!.state).toBe("due");
  });

  test("a repeated press changes nothing and writes no second audit row", async () => {
    const f = await setup();
    await force(f, { state: "due" });
    await confirmed(f, "2027-03-14T12:30:00Z", 10 * 60_000);
    const again = await confirmed(f, "2027-03-14T12:31:00Z", 6 * 60_000);
    expect(again.confirmedAt).toBe(Date.parse("2027-03-14T12:20:00Z"));
    expect(await auditRows(f, "state_change")).toHaveLength(1);
  });
});

describe("confirmReceivedAt is only for late-synced device presses", () => {
  test("a caregiver mark-done never sets it", async () => {
    const f = await setup();
    await force(f, { state: "due" });
    at("2027-03-14T14:00:00Z");
    const row = await f.t
      .withIdentity({ subject: "max" })
      .mutation(api.instances.confirmTaskInstance, { instanceId: f.instanceId, via: "caregiver" });
    expect(row).toMatchObject({ state: "resolved" });
    expect(row.confirmReceivedAt).toBeUndefined();
  });

  test("a voice confirm never sets it", async () => {
    const f = await setup();
    await force(f, { state: "due" });
    const row = await f.t.run(
      async (ctx) =>
        await confirmInstance(
          ctx,
          { kind: "agent" },
          { instanceId: f.instanceId, via: "voice" },
          Date.parse("2027-03-14T14:00:00Z"),
        ),
    );
    expect(row).toMatchObject({ state: "confirmed", confirmedVia: "voice" });
    expect(row.confirmReceivedAt).toBeUndefined();
  });

  test("undoing a caregiver's mark-done clears it", async () => {
    const f = await setup();
    await force(f, { state: "due" });
    at("2027-03-14T14:00:00Z");
    const asMax = f.t.withIdentity({ subject: "max" });
    await asMax.mutation(api.instances.confirmTaskInstance, {
      instanceId: f.instanceId,
      via: "caregiver",
    });
    await force(f, { confirmReceivedAt: Date.parse("2027-03-14T14:00:00Z") });
    const undone = await asMax.mutation(api.instances.undoResolve, { instanceId: f.instanceId });
    expect(undone.state).toBe("due");
    expect(undone.confirmReceivedAt).toBeUndefined();
  });
});
