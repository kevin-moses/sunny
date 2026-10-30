// instances.test.ts
// Purpose: Tests for instances.ts, ported from the instance half of
// the former Supabase scheduler tests: confirm (device, caregiver, agent, early and late, the
// already-done guard), snooze, claim, today, confirmDueTask ("Done": no label, label,
// ambiguous, not found, already done, not due yet, prefer what is due now), senior reminders
// (create, recurring, cancel, blank query, past date) and dose logging. Also one access test
// per public function (outsider forbidden, viewer cannot write, device and caregiver rules
// differ), standing in for the former Supabase grant and RLS checks. Also: non-finite dose times and
// over-long reminder titles are rejected. The clock is driven by faking Date
// for public functions and by passing `now` to the exported core helpers.
//
// Last modified: 2026-10-29

import workpoolTest from "@convex-dev/workpool/test";
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { confirmDueTaskCore, confirmInstance, logDoseCore, snoozeInstance } from "./instances";
import schema from "./schema";

/** Every non-test module in the backend, for the convex-test harness. */
const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);

/** The backend actor used where a test passes an exact `now` to a core helper. */
const AGENT = { kind: "agent" } as const;

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

/** Household for Mom with Pat (primary), Max (member), Val (viewer) and two devices. */
interface Fixture {
  t: TestConvex;
  householdId: Id<"households">;
  medication: Id<"escalationPolicies">;
  promptOnly: Id<"escalationPolicies">;
  phone: Id<"devices">;
  display: Id<"devices">;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
});

afterEach(() => {
  vi.useRealTimers();
});

/**
 * purpose: Set the faked clock used by public functions.
 * @param iso: (string) UTC instant.
 * @return: (number) The same instant in epoch ms.
 */
function at(iso: string): number {
  vi.setSystemTime(new Date(iso));
  return Date.parse(iso);
}

/**
 * purpose: Pair a device through a join code.
 * @param t: (TestConvex) Harness.
 * @param householdId: (Id<"households">) Household.
 * @param asOwner: Identity-bound harness of a primary caregiver of that household.
 * @param userId: (string) Device user id.
 * @param grants: (string) Device kind.
 * @return: (Promise<Id<"devices">>) The device.
 */
async function pair(
  t: TestConvex,
  householdId: Id<"households">,
  asOwner: ReturnType<TestConvex["withIdentity"]>,
  userId: string,
  grants: "senior_phone" | "home_display",
): Promise<Id<"devices">> {
  const { code } = await asOwner.mutation(api.households.createJoinCode, { householdId, grants });
  return (await t.mutation(internal.households.pairDevice, { code, userId })).deviceId;
}

/**
 * purpose: Build the standard fixture at a faked time.
 * @param iso: (string) UTC instant to start the clock at.
 * @return: (Promise<Fixture>) The fixture.
 */
async function setup(iso: string): Promise<Fixture> {
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
  const phone = await pair(t, householdId, pat, "phone", "senior_phone");
  const display = await pair(t, householdId, pat, "display", "home_display");
  const policies = await pat.query(api.tasks.listPolicies, { householdId });
  return {
    t,
    householdId,
    medication: policies.find((p) => p.systemKey === "medication")!._id,
    promptOnly: policies.find((p) => p.systemKey === "prompt_only")!._id,
    phone,
    display,
  };
}

/**
 * purpose: Create a task as Pat.
 * @param f: (Fixture) Fixture.
 * @param title: (string) Title and display label.
 * @param times: (string[]) Local times.
 * @param policy: (Id<"escalationPolicies">, optional) Policy; defaults to Medication.
 * @return: (Promise<Id<"tasks">>) The task.
 */
async function makeTask(
  f: Fixture,
  title: string,
  times: string[],
  policy?: Id<"escalationPolicies">,
): Promise<Id<"tasks">> {
  return await f.t.withIdentity({ subject: "pat" }).mutation(api.tasks.create, {
    householdId: f.householdId,
    type: "medication",
    title,
    displayLabel: title,
    times,
    escalationPolicyId: policy ?? f.medication,
  });
}

/**
 * purpose: Instances of a household on a local date, ordered by window start.
 * @param f: (Fixture) Fixture.
 * @param date: (string) Local date.
 * @return: (Promise<Doc[]>) The instances.
 */
async function instancesOn(f: Fixture, date: string) {
  const rows = await f.t.run(
    async (ctx) =>
      await ctx.db
        .query("taskInstances")
        .withIndex("by_household_date", (q) =>
          q.eq("householdId", f.householdId).eq("localDate", date),
        )
        .collect(),
  );
  return rows.sort((a, b) => a.windowStart - b.windowStart);
}

/**
 * purpose: Run the scheduler at an instant: tickHousehold for every household, in order.
 * @param t: (TestConvex) Harness.
 * @param iso: (string) UTC instant.
 * @return: (Promise<void>)
 */
async function tick(t: TestConvex, iso: string): Promise<void> {
  const ids = await t.run(async (ctx) =>
    (await ctx.db.query("households").collect()).map((h) => h._id),
  );
  for (const householdId of ids) {
    await t.mutation(internal.scheduler.tickHousehold, {
      householdId,
      now: Date.parse(iso),
    });
  }
}

describe("confirmTaskInstance", () => {
  test("a device cannot confirm more than an hour early, the agent can at 30 minutes", async () => {
    const f = await setup("2027-03-14T10:00:00Z");
    await makeTask(f, "Morning pills", ["08:00"]);
    const [instance] = await instancesOn(f, "2027-03-14");
    const asPhone = f.t.withIdentity({ subject: "phone" });
    await expect(
      asPhone.mutation(api.instances.confirmTaskInstance, {
        instanceId: instance!._id,
        via: "button",
      }),
    ).rejects.toMatchObject({ data: { code: "invalid", message: "This task is not due yet" } });

    const confirmed = await f.t.run(
      async (ctx) =>
        await confirmInstance(
          ctx,
          AGENT,
          { instanceId: instance!._id, via: "voice" },
          Date.parse("2027-03-14T11:30:00Z"),
        ),
    );
    expect(confirmed).toMatchObject({
      state: "confirmed",
      confirmedAt: Date.parse("2027-03-14T11:30:00Z"),
      confirmedVia: "voice",
    });
  });

  test("confirming again keeps the first confirmation (already-done guard)", async () => {
    const f = await setup("2027-03-14T10:00:00Z");
    await makeTask(f, "Morning pills", ["08:00"]);
    const [instance] = await instancesOn(f, "2027-03-14");
    const confirm = async (iso: string) =>
      await f.t.run(
        async (ctx) =>
          await confirmInstance(
            ctx,
            AGENT,
            { instanceId: instance!._id, via: "button" },
            Date.parse(iso),
          ),
      );
    await confirm("2027-03-14T11:30:00Z");
    const again = await confirm("2027-03-14T12:10:00Z");
    expect(again.confirmedAt).toBe(Date.parse("2027-03-14T11:30:00Z"));
  });

  test("a device within an hour confirms; an editor caregiver resolves under their name", async () => {
    const f = await setup("2027-03-14T11:30:00Z");
    await makeTask(f, "Morning pills", ["08:00"]);
    await makeTask(f, "Evening pills", ["08:30"]);
    const [first, second] = await instancesOn(f, "2027-03-14");
    const device = await f.t
      .withIdentity({ subject: "phone" })
      .mutation(api.instances.confirmTaskInstance, { instanceId: first!._id, via: "button" });
    expect(device).toMatchObject({
      state: "confirmed",
      confirmedBy: "phone",
      confirmedVia: "button",
    });

    const caregiver = await f.t
      .withIdentity({ subject: "max" })
      .mutation(api.instances.confirmTaskInstance, {
        instanceId: second!._id,
        via: "phone_app",
        note: "Called her",
      });
    expect(caregiver).toMatchObject({
      state: "resolved",
      confirmedBy: "max",
      confirmedVia: "caregiver",
      resolutionNote: "Called her",
    });
  });

  test("confirming clears a snooze", async () => {
    const f = await setup("2027-03-14T11:00:00Z");
    await makeTask(f, "Morning pills", ["08:00"]);
    const [instance] = await instancesOn(f, "2027-03-14");
    await tick(f.t, "2027-03-14T12:00:00Z");
    at("2027-03-14T12:01:00Z");
    const asPhone = f.t.withIdentity({ subject: "phone" });
    await asPhone.mutation(api.instances.snoozeTaskInstance, { instanceId: instance!._id });
    const done = await asPhone.mutation(api.instances.confirmTaskInstance, {
      instanceId: instance!._id,
      via: "button",
    });
    expect(done.snoozedUntil).toBeUndefined();
  });

  test("an unknown instance is not found", async () => {
    const f = await setup("2027-03-14T11:00:00Z");
    await makeTask(f, "Morning pills", ["08:00"]);
    const [instance] = await instancesOn(f, "2027-03-14");
    await f.t.run(async (ctx) => {
      await ctx.db.delete(instance!._id);
    });
    await expect(
      f.t.withIdentity({ subject: "pat" }).mutation(api.instances.confirmTaskInstance, {
        instanceId: instance!._id,
        via: "phone_app",
      }),
    ).rejects.toMatchObject({ data: { code: "not_found" } });
  });

  test("access: outsiders, viewers and other households' devices are forbidden", async () => {
    const f = await setup("2027-03-14T11:30:00Z");
    await makeTask(f, "Morning pills", ["08:00"]);
    const [instance] = await instancesOn(f, "2027-03-14");
    const xen = f.t.withIdentity({ subject: "xen" });
    const other = await xen.mutation(api.households.create, {
      seniorPreferredName: "Dad",
      timezone: "America/Chicago",
      caregiverDisplayName: "Xen",
    });
    await pair(f.t, other, xen, "xdev", "senior_phone");
    const args = { instanceId: instance!._id, via: "phone_app" as const };
    for (const subject of ["nobody", "val", "xen", "xdev"]) {
      await expect(
        f.t.withIdentity({ subject }).mutation(api.instances.confirmTaskInstance, args),
        subject,
      ).rejects.toMatchObject({ data: { code: "forbidden" } });
    }
    await expect(f.t.mutation(api.instances.confirmTaskInstance, args)).rejects.toMatchObject({
      data: { code: "unauthenticated" },
    });
  });
});

describe("snoozeTaskInstance", () => {
  test("snoozes an open instance for the requested minutes, 15 by default", async () => {
    const f = await setup("2027-03-14T11:00:00Z");
    await makeTask(f, "Morning pills", ["08:00"]);
    const [instance] = await instancesOn(f, "2027-03-14");
    await tick(f.t, "2027-03-14T12:00:00Z");
    const snoozed = await f.t.run(
      async (ctx) =>
        await snoozeInstance(
          ctx,
          AGENT,
          { instanceId: instance!._id, minutes: 20 },
          Date.parse("2027-03-14T12:05:00Z"),
        ),
    );
    expect(snoozed.snoozedUntil).toBe(Date.parse("2027-03-14T12:25:00Z"));
    const defaulted = await f.t.run(
      async (ctx) =>
        await snoozeInstance(
          ctx,
          AGENT,
          { instanceId: instance!._id },
          Date.parse("2027-03-14T12:10:00Z"),
        ),
    );
    expect(defaulted.snoozedUntil).toBe(Date.parse("2027-03-14T12:25:00Z"));
  });

  test("rejects minutes outside 1..120 and leaves instances that are not open unchanged", async () => {
    const f = await setup("2027-03-14T11:00:00Z");
    await makeTask(f, "Morning pills", ["08:00"]);
    const [instance] = await instancesOn(f, "2027-03-14");
    const asPhone = f.t.withIdentity({ subject: "phone" });
    for (const minutes of [0, 121, 1.5]) {
      await expect(
        asPhone.mutation(api.instances.snoozeTaskInstance, { instanceId: instance!._id, minutes }),
      ).rejects.toMatchObject({ data: { code: "invalid" } });
    }
    const upcoming = await asPhone.mutation(api.instances.snoozeTaskInstance, {
      instanceId: instance!._id,
      minutes: 120,
    });
    expect(upcoming.snoozedUntil).toBeUndefined();
  });

  test("access: only the household's devices may snooze", async () => {
    const f = await setup("2027-03-14T11:00:00Z");
    await makeTask(f, "Morning pills", ["08:00"]);
    const [instance] = await instancesOn(f, "2027-03-14");
    for (const subject of ["nobody", "pat", "max", "val"]) {
      await expect(
        f.t
          .withIdentity({ subject })
          .mutation(api.instances.snoozeTaskInstance, { instanceId: instance!._id }),
        subject,
      ).rejects.toMatchObject({ data: { code: "forbidden" } });
    }
    await expect(
      f.t
        .withIdentity({ subject: "display" })
        .mutation(api.instances.snoozeTaskInstance, { instanceId: instance!._id }),
    ).resolves.toBeDefined();
  });
});

describe("claimTaskInstance", () => {
  test("first claim wins and an instance that is not open is not claimable", async () => {
    const f = await setup("2027-03-14T11:00:00Z");
    await makeTask(f, "Morning pills", ["08:00"]);
    const [instance] = await instancesOn(f, "2027-03-14");
    const asMax = f.t.withIdentity({ subject: "max" });
    const early = await asMax.mutation(api.instances.claimTaskInstance, {
      instanceId: instance!._id,
    });
    expect(early.claimedBy).toBeUndefined();

    await tick(f.t, "2027-03-14T12:00:00Z");
    at("2027-03-14T12:05:00Z");
    const first = await asMax.mutation(api.instances.claimTaskInstance, {
      instanceId: instance!._id,
    });
    expect(first.claimedBy).toBe("max");
    const second = await f.t
      .withIdentity({ subject: "pat" })
      .mutation(api.instances.claimTaskInstance, { instanceId: instance!._id });
    expect(second.claimedBy).toBe("max");
  });

  test("a missed instance can still be claimed", async () => {
    const f = await setup("2027-03-14T11:00:00Z");
    await makeTask(f, "Morning pills", ["08:00"]);
    const [instance] = await instancesOn(f, "2027-03-14");
    await tick(f.t, "2027-03-14T13:00:00Z");
    at("2027-03-14T13:05:00Z");
    const claimed = await f.t
      .withIdentity({ subject: "pat" })
      .mutation(api.instances.claimTaskInstance, { instanceId: instance!._id });
    expect(claimed).toMatchObject({ state: "missed", claimedBy: "pat" });
  });

  test("access: only editor caregivers of the household may claim", async () => {
    const f = await setup("2027-03-14T11:00:00Z");
    await makeTask(f, "Morning pills", ["08:00"]);
    const [instance] = await instancesOn(f, "2027-03-14");
    for (const subject of ["nobody", "val", "phone", "display"]) {
      await expect(
        f.t
          .withIdentity({ subject })
          .mutation(api.instances.claimTaskInstance, { instanceId: instance!._id }),
        subject,
      ).rejects.toMatchObject({ data: { code: "forbidden" } });
    }
  });
});

describe("today", () => {
  test("lists the day's instances in schedule order for caregivers and devices", async () => {
    const f = await setup("2027-03-20T11:00:00Z");
    await makeTask(f, "Lunch pills", ["12:00"]);
    await makeTask(f, "Morning pills", ["08:00"]);
    for (const subject of ["pat", "val", "phone"]) {
      const entries = await f.t
        .withIdentity({ subject })
        .query(api.instances.today, { householdId: f.householdId });
      expect(
        entries.map((e) => [e.displayLabel, e.scheduledTime, e.state]),
        subject,
      ).toEqual([
        ["Morning pills", "08:00", "upcoming"],
        ["Lunch pills", "12:00", "upcoming"],
      ]);
    }
  });

  test("absent optional values are null, not missing keys", async () => {
    const f = await setup("2027-03-20T11:00:00Z");
    await makeTask(f, "Lunch pills", ["12:00"]);
    const [entry] = await f.t
      .withIdentity({ subject: "pat" })
      .query(api.instances.today, { householdId: f.householdId });
    expect(entry).toMatchObject({ pillDescription: null, confirmedAt: null, confirmedVia: null });
  });

  test("access: outsiders and other households' devices cannot read the day", async () => {
    const f = await setup("2027-03-20T11:00:00Z");
    await expect(
      f.t
        .withIdentity({ subject: "nobody" })
        .query(api.instances.today, { householdId: f.householdId }),
    ).rejects.toMatchObject({ data: { code: "forbidden" } });
  });
});

describe("confirmDueTask", () => {
  /** Morning 08:00, Lunch 12:00 (blank prompt) and Evening 21:00 on 2027-03-20 (EDT). */
  async function dayFixture(): Promise<Fixture> {
    const f = await setup("2027-03-20T11:00:00Z");
    await makeTask(f, "Morning pills", ["08:00"]);
    await makeTask(f, "Lunch pills", ["12:00"]);
    await makeTask(f, "Evening pills", ["21:00"]);
    await tick(f.t, "2027-03-20T11:00:00Z");
    await tick(f.t, "2027-03-20T12:00:00Z");
    return f;
  }

  /** Press Done as the backend at an exact instant. */
  async function done(f: Fixture, iso: string, label?: string, via: "button" | "voice" = "button") {
    return await f.t.run(
      async (ctx) =>
        await confirmDueTaskCore(
          ctx,
          AGENT,
          { householdId: f.householdId, via, label },
          Date.parse(iso),
        ),
    );
  }

  test("the day lists three instances and Done with no label confirms the one that is due", async () => {
    const f = await dayFixture();
    const entries = await f.t
      .withIdentity({ subject: "phone" })
      .query(api.instances.today, { householdId: f.householdId });
    expect(entries).toHaveLength(3);
    const result = await done(f, "2027-03-20T12:05:00Z");
    expect(result).toMatchObject({
      status: "confirmed",
      displayLabel: "Morning pills",
      state: "confirmed",
      confirmedAt: Date.parse("2027-03-20T12:05:00Z"),
    });
  });

  test("a second Done with nothing due changes nothing", async () => {
    const f = await dayFixture();
    await done(f, "2027-03-20T12:05:00Z");
    expect((await done(f, "2027-03-20T12:06:00Z")).status).toBe("nothing_due");
  });

  test("asking again by label reports the original confirmation time (double-dose guard)", async () => {
    const f = await dayFixture();
    await done(f, "2027-03-20T12:05:00Z");
    const again = await done(f, "2027-03-20T12:30:00Z", "MORNING", "voice");
    expect(again).toMatchObject({
      status: "already_done",
      confirmedAt: Date.parse("2027-03-20T12:05:00Z"),
    });
  });

  test("a task hours away is not due yet and stays unconfirmed", async () => {
    const f = await dayFixture();
    const result = await done(f, "2027-03-20T12:30:00Z", "lunch", "voice");
    expect(result).toMatchObject({ status: "not_due_yet", displayLabel: "Lunch pills" });
    const lunch = (await instancesOn(f, "2027-03-20")).find((i) => i.scheduledTime === "12:00");
    expect(lunch?.state).toBe("upcoming");
  });

  test("several open matches ask which one, and unknown labels are not found", async () => {
    const f = await dayFixture();
    await done(f, "2027-03-20T12:05:00Z");
    const ambiguous = await done(f, "2027-03-20T15:30:00Z", "pills", "voice");
    expect(ambiguous.status).toBe("ambiguous");
    expect(ambiguous.options?.map((o) => o.displayLabel)).toEqual(["Lunch pills", "Evening pills"]);
    expect((await done(f, "2027-03-20T15:30:00Z", "insulin", "voice")).status).toBe("not_found");
  });

  test("a label prefers the dose that is due now over a later one", async () => {
    const f = await dayFixture();
    await done(f, "2027-03-20T12:05:00Z");
    await tick(f.t, "2027-03-20T16:00:00Z");
    const result = await done(f, "2027-03-20T16:05:00Z", "pills", "voice");
    expect(result).toMatchObject({ status: "confirmed", displayLabel: "Lunch pills" });
  });

  test("both paired devices get the defaulted spoken prompt", async () => {
    const f = await dayFixture();
    await tick(f.t, "2027-03-20T16:00:00Z");
    const lunch = (await instancesOn(f, "2027-03-20")).find((i) => i.scheduledTime === "12:00")!;
    const rows = await f.t.run(
      async (ctx) =>
        await ctx.db
          .query("notificationOutbox")
          .withIndex("by_task_instance", (q) => q.eq("taskInstanceId", lunch._id))
          .collect(),
    );
    expect(rows.map((r) => r.body)).toEqual(["Time for Lunch pills.", "Time for Lunch pills."]);
    expect(rows.map((r) => r.recipientDeviceId).sort()).toEqual([f.phone, f.display].sort());
  });

  test("a device presses Done through the public function", async () => {
    const f = await dayFixture();
    at("2027-03-20T12:05:00Z");
    const result = await f.t
      .withIdentity({ subject: "phone" })
      .mutation(api.instances.confirmDueTask, { householdId: f.householdId, via: "widget" });
    expect(result).toMatchObject({ status: "confirmed", displayLabel: "Morning pills" });
  });

  test("access: only the household's devices may press Done", async () => {
    const f = await dayFixture();
    for (const subject of ["nobody", "pat", "max", "val"]) {
      await expect(
        f.t
          .withIdentity({ subject })
          .mutation(api.instances.confirmDueTask, { householdId: f.householdId, via: "button" }),
        subject,
      ).rejects.toMatchObject({ data: { code: "forbidden" } });
    }
  });
});

describe("senior reminders", () => {
  /** Fixture where the prompt-only policy was renamed, at 2027-03-20 12:00Z. */
  async function reminderFixture(): Promise<Fixture> {
    const f = await setup("2027-03-20T12:00:00Z");
    await f.t.withIdentity({ subject: "pat" }).mutation(api.tasks.updatePolicy, {
      householdId: f.householdId,
      policyId: f.promptOnly,
      name: "Gentle nudge",
    });
    return f;
  }

  test("the device creates a one-off reminder on the prompt-only policy, even after a rename", async () => {
    const f = await reminderFixture();
    const task = await f.t
      .withIdentity({ subject: "phone" })
      .mutation(api.instances.createSeniorReminder, {
        householdId: f.householdId,
        title: "call the plumber",
        time: "10:00",
        onDate: "2027-03-22",
      });
    expect(task).toMatchObject({
      type: "reminder",
      displayLabel: "Call the plumber",
      spokenPrompt: "Reminder: call the plumber.",
      createdByKind: "senior",
      createdBy: "phone",
      onceOn: "2027-03-22",
      windowMinutes: 30,
      escalationPolicyId: f.promptOnly,
      active: true,
    });
    expect(task.daysOfWeek).toBeUndefined();
  });

  test("recurring reminders keep their weekdays; all seven days means every day", async () => {
    const f = await reminderFixture();
    const asPhone = f.t.withIdentity({ subject: "phone" });
    const base = { householdId: f.householdId, time: "09:00" };
    const some = await asPhone.mutation(api.instances.createSeniorReminder, {
      ...base,
      title: "water the plants",
      days: [4, 1],
    });
    expect(some.daysOfWeek).toEqual([1, 4]);
    const every = await asPhone.mutation(api.instances.createSeniorReminder, {
      ...base,
      title: "take a walk",
      days: [1, 2, 3, 4, 5, 6, 7],
    });
    expect(every.daysOfWeek).toBeUndefined();
    const dated = await asPhone.mutation(api.instances.createSeniorReminder, {
      ...base,
      title: "dentist",
      onDate: "2027-03-25",
      days: [1],
    });
    expect(dated.daysOfWeek).toBeUndefined();
  });

  test("rejects blank titles, bad times, bad dates and dates that have passed", async () => {
    const f = await reminderFixture();
    const asPhone = f.t.withIdentity({ subject: "phone" });
    const base = { householdId: f.householdId, title: "x", time: "10:00" };
    for (const bad of [
      { title: "  " },
      { time: "25:00" },
      { onDate: "2027-13-01" },
      { onDate: "2020-01-01" },
      { days: [0] },
    ]) {
      await expect(
        asPhone.mutation(api.instances.createSeniorReminder, { ...base, ...bad }),
        JSON.stringify(bad),
      ).rejects.toMatchObject({ data: { code: "invalid" } });
    }
    await expect(
      asPhone.mutation(api.instances.createSeniorReminder, { ...base, onDate: "2020-01-01" }),
    ).rejects.toMatchObject({ data: { message: "That date has already passed" } });
    await expect(
      asPhone.mutation(api.instances.createSeniorReminder, { ...base, title: "x".repeat(201) }),
    ).rejects.toMatchObject({ data: { code: "invalid" } });
    await expect(
      asPhone.mutation(api.instances.createSeniorReminder, { ...base, title: "x".repeat(200) }),
    ).resolves.toBeDefined();
  });

  test("a today reminder is allowed", async () => {
    const f = await reminderFixture();
    const task = await f.t
      .withIdentity({ subject: "phone" })
      .mutation(api.instances.createSeniorReminder, {
        householdId: f.householdId,
        title: "stretch",
        time: "13:00",
        onDate: "2027-03-20",
      });
    expect(task.onceOn).toBe("2027-03-20");
  });

  test("cancel: vague queries are ambiguous, clear ones cancel, caregiver tasks and blanks match nothing", async () => {
    const f = await reminderFixture();
    await makeTask(f, "Morning pills", ["08:00"]);
    const asPhone = f.t.withIdentity({ subject: "phone" });
    const base = { householdId: f.householdId, time: "10:00" };
    await asPhone.mutation(api.instances.createSeniorReminder, {
      ...base,
      title: "call the plumber",
      onDate: "2027-03-22",
    });
    await asPhone.mutation(api.instances.createSeniorReminder, {
      ...base,
      title: "water the plants",
      days: [1, 4],
    });
    const cancel = async (query: string) =>
      await asPhone.mutation(api.instances.cancelSeniorReminder, {
        householdId: f.householdId,
        query,
      });
    expect(await cancel("the p")).toEqual({
      status: "ambiguous",
      titles: ["call the plumber", "water the plants"],
    });
    expect(await cancel("Plumber")).toEqual({ status: "cancelled", titles: ["call the plumber"] });
    expect((await cancel("Morning")).status).toBe("not_found");
    expect((await cancel("  ")).status).toBe("not_found");
    expect((await cancel("plumber")).status).toBe("not_found");
  });

  test("cancelling removes the reminder's open instances so nothing keeps prompting", async () => {
    const f = await setup("2027-03-21T13:00:00Z");
    const asPhone = f.t.withIdentity({ subject: "phone" });
    await asPhone.mutation(api.instances.createSeniorReminder, {
      householdId: f.householdId,
      title: "stretch",
      time: "10:00",
    });
    await tick(f.t, "2027-03-21T14:00:00Z");
    expect((await instancesOn(f, "2027-03-21")).map((i) => i.state)).toEqual(["due"]);
    at("2027-03-21T14:05:00Z");
    const result = await asPhone.mutation(api.instances.cancelSeniorReminder, {
      householdId: f.householdId,
      query: "stretch",
    });
    expect(result.status).toBe("cancelled");
    expect(await instancesOn(f, "2027-03-21")).toHaveLength(0);
    expect(await instancesOn(f, "2027-03-22")).toHaveLength(0);
  });

  test("access: only the household's devices may create or cancel reminders", async () => {
    const f = await reminderFixture();
    for (const subject of ["nobody", "pat", "val"]) {
      await expect(
        f.t.withIdentity({ subject }).mutation(api.instances.createSeniorReminder, {
          householdId: f.householdId,
          title: "x",
          time: "10:00",
        }),
        subject,
      ).rejects.toMatchObject({ data: { code: "forbidden" } });
      await expect(
        f.t
          .withIdentity({ subject })
          .mutation(api.instances.cancelSeniorReminder, { householdId: f.householdId, query: "x" }),
        subject,
      ).rejects.toMatchObject({ data: { code: "forbidden" } });
    }
  });
});

describe("logDose", () => {
  /** An as-needed task (no times). */
  async function doseFixture() {
    const f = await setup("2027-03-20T12:00:00Z");
    const taskId = await f.t.withIdentity({ subject: "pat" }).mutation(api.tasks.create, {
      householdId: f.householdId,
      type: "medication",
      title: "Ibuprofen",
      displayLabel: "Ibuprofen",
      asNeededMaxPerDay: 3,
    });
    return { f, taskId };
  }

  test("editors and devices log doses reported under their own id", async () => {
    const { f, taskId } = await doseFixture();
    for (const [subject, via] of [
      ["pat", "phone_app"],
      ["phone", "button"],
    ] as const) {
      const id = await f.t.withIdentity({ subject }).mutation(api.instances.logDose, {
        householdId: f.householdId,
        taskId,
        takenAt: Date.now() - 1000,
        via,
        note: "with food",
      });
      const row = await f.t.run(async (ctx) => await ctx.db.get(id));
      expect(row).toMatchObject({ reportedBy: subject, reportedVia: via, note: "with food" });
    }
  });

  test("a dose more than five minutes ahead is rejected, within five is accepted", async () => {
    const { f, taskId } = await doseFixture();
    const asPat = f.t.withIdentity({ subject: "pat" });
    const base = { householdId: f.householdId, taskId, via: "phone_app" as const };
    await expect(
      asPat.mutation(api.instances.logDose, { ...base, takenAt: Date.now() + 6 * 60_000 }),
    ).rejects.toMatchObject({ data: { code: "invalid" } });
    await expect(
      asPat.mutation(api.instances.logDose, { ...base, takenAt: Date.now() + 4 * 60_000 }),
    ).resolves.toBeDefined();
  });

  test("a non-finite dose time is rejected as invalid", async () => {
    const { f, taskId } = await doseFixture();
    const asPat = f.t.withIdentity({ subject: "pat" });
    const base = { householdId: f.householdId, taskId, via: "phone_app" as const };
    for (const takenAt of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      await expect(
        asPat.mutation(api.instances.logDose, { ...base, takenAt }),
        String(takenAt),
      ).rejects.toMatchObject({ data: { code: "invalid" } });
    }
    expect(await f.t.run(async (ctx) => (await ctx.db.query("doseLog").collect()).length)).toBe(0);
  });

  test("the core helper allows the agent with no reporter and checks the clock it is given", async () => {
    const { f, taskId } = await doseFixture();
    const now = Date.parse("2027-03-20T12:00:00Z");
    const args = { householdId: f.householdId, taskId, via: "voice" as const };
    const id = await f.t.run(
      async (ctx) => await logDoseCore(ctx, AGENT, { ...args, takenAt: now + 5 * 60_000 }, now),
    );
    expect((await f.t.run(async (ctx) => await ctx.db.get(id)))?.reportedBy).toBeUndefined();
    await expect(
      f.t.run(
        async (ctx) =>
          await logDoseCore(ctx, AGENT, { ...args, takenAt: now + 5 * 60_000 + 1 }, now),
      ),
    ).rejects.toMatchObject({ data: { code: "invalid" } });
  });

  test("a task from another household is not found", async () => {
    const { f, taskId } = await doseFixture();
    const xen = f.t.withIdentity({ subject: "xen" });
    const other = await xen.mutation(api.households.create, {
      seniorPreferredName: "Dad",
      timezone: "America/Chicago",
      caregiverDisplayName: "Xen",
    });
    await expect(
      xen.mutation(api.instances.logDose, {
        householdId: other,
        taskId,
        takenAt: Date.now(),
        via: "phone_app",
      }),
    ).rejects.toMatchObject({ data: { code: "not_found" } });
  });

  test("access: viewers, outsiders and other households' devices are forbidden", async () => {
    const { f, taskId } = await doseFixture();
    const xen = f.t.withIdentity({ subject: "xen" });
    const other = await xen.mutation(api.households.create, {
      seniorPreferredName: "Dad",
      timezone: "America/Chicago",
      caregiverDisplayName: "Xen",
    });
    await pair(f.t, other, xen, "xdev", "senior_phone");
    for (const subject of ["nobody", "val", "xen", "xdev"]) {
      await expect(
        f.t.withIdentity({ subject }).mutation(api.instances.logDose, {
          householdId: f.householdId,
          taskId,
          takenAt: Date.now(),
          via: "phone_app",
        }),
        subject,
      ).rejects.toMatchObject({ data: { code: "forbidden" } });
    }
  });
});
