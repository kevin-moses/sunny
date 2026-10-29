// scheduler.test.ts
// Purpose: Tests for the scheduler (scheduler.ts, lib/schedule.ts), ported from the scheduler
// half of supabase/tests/scheduler.test.sql: expansion across the March 2027 and November
// 2026 New York DST changes, idempotence, no back-fill, the escalation ladder (prompt,
// reprompt, on-call alert, all-caregiver alert skipped once claimed), missed windows, audit of
// every state change, snooze, tasks added mid-window, bursts after a gap, inactive tasks,
// on-call fallback to primaries, schedule edits and deactivation, and the household timezone
// resync. Also: the tick fans out one tickHousehold per household (with paging), editing a
// policy mid-ladder neither re-fires nor skips steps (stable step ids), windows that cross
// midnight stay listed and confirmable, and deleting a task purges its rows in bounded
// batches while orphaned instances are harmless. The clock is driven by passing `now` to the
// internal functions and by faking timers for the public functions and scheduled functions.
//
// Last modified: 2026-10-29

import workpoolTest from "@convex-dev/workpool/test";
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { purgeTaskBatch } from "./lib/schedule";
import type { TickResult } from "./scheduler";
import schema from "./schema";

/** Every non-test module in the backend, for the convex-test harness. */
const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);

const MORNING_PROMPT = "It's 8 o'clock. Time for your morning pills, the small white ones.";

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

/** A household with Pat (primary, on call), Max (member), Val (viewer) and one device. */
interface Fixture {
  t: TestConvex;
  householdId: Id<"households">;
  medication: Id<"escalationPolicies">;
  promptOnly: Id<"escalationPolicies">;
  deviceId: Id<"devices">;
}

beforeEach(() => {
  vi.useFakeTimers();
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
 * purpose: Build the standard household (New York) at the given faked time.
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
  const { code } = await pat.mutation(api.households.createJoinCode, {
    householdId,
    grants: "senior_phone",
  });
  const { deviceId } = await t.mutation(internal.households.pairDevice, { code, userId: "phone" });
  const policies = await pat.query(api.tasks.listPolicies, { householdId });
  return {
    t,
    householdId,
    medication: policies.find((p) => p.systemKey === "medication")!._id,
    promptOnly: policies.find((p) => p.systemKey === "prompt_only")!._id,
    deviceId,
  };
}

/**
 * purpose: Create a medication task as Pat on the medication policy.
 * @param f: (Fixture) Fixture.
 * @param fields: (object) Overrides: title, times, spokenPrompt, policy and more.
 * @return: (Promise<Id<"tasks">>) The task.
 */
async function makeTask(
  f: Fixture,
  fields: Partial<{
    title: string;
    times: string[];
    spokenPrompt: string;
    escalationPolicyId: Id<"escalationPolicies"> | null;
    windowMinutes: number;
    type: "medication" | "routine";
  }> = {},
): Promise<Id<"tasks">> {
  const { escalationPolicyId, title = "Morning pills", ...rest } = fields;
  return await f.t.withIdentity({ subject: "pat" }).mutation(api.tasks.create, {
    householdId: f.householdId,
    type: "medication",
    title,
    displayLabel: title,
    times: ["08:00"],
    escalationPolicyId:
      escalationPolicyId === null ? undefined : (escalationPolicyId ?? f.medication),
    ...rest,
  });
}

/**
 * purpose: Run the scheduler at an instant: tickHousehold for every household, with counts
 *          summed (what the cron's fan-out does, with an explicit clock).
 * @param t: (TestConvex) Harness.
 * @param iso: (string) UTC instant.
 * @return: (Promise<TickResult>) The summed tick counts.
 */
async function tick(t: TestConvex, iso: string): Promise<TickResult> {
  const now = Date.parse(iso);
  const ids = await t.run(async (ctx) =>
    (await ctx.db.query("households").collect()).map((h) => h._id),
  );
  const total: TickResult = {
    created: 0,
    opened: 0,
    stepsFired: 0,
    escalated: 0,
    missed: 0,
    noticed: 0,
  };
  for (const householdId of ids) {
    const result = await t.mutation(internal.scheduler.tickHousehold, { householdId, now });
    for (const key of Object.keys(total) as Array<keyof TickResult>) total[key] += result[key];
  }
  return total;
}

/**
 * purpose: The step ids of a policy, in order.
 * @param t: (TestConvex) Harness.
 * @param policyId: (Id<"escalationPolicies">) Policy.
 * @return: (Promise<string[]>) Step ids.
 */
async function stepIds(t: TestConvex, policyId: Id<"escalationPolicies">): Promise<string[]> {
  const policy = await t.run(async (ctx) => await ctx.db.get(policyId));
  return policy!.steps.map((s) => s.id);
}

/**
 * purpose: A task's instance on a local date.
 * @param t: (TestConvex) Harness.
 * @param taskId: (Id<"tasks">) Task.
 * @param date: (string) Local date.
 * @return: (Promise<Doc<"taskInstances">>) The instance (throws if missing).
 */
async function instanceOn(
  t: TestConvex,
  taskId: Id<"tasks">,
  date: string,
): Promise<Doc<"taskInstances">> {
  const rows = await t.run(
    async (ctx) =>
      await ctx.db
        .query("taskInstances")
        .withIndex("by_task_date_time", (q) => q.eq("taskId", taskId).eq("localDate", date))
        .collect(),
  );
  if (rows.length === 0) throw new Error(`No instance on ${date}`);
  return rows[0]!;
}

/**
 * purpose: Reload an instance.
 * @param t: (TestConvex) Harness.
 * @param id: (Id<"taskInstances">) Instance.
 * @return: (Promise<Doc<"taskInstances">>) Current row.
 */
async function reload(t: TestConvex, id: Id<"taskInstances">): Promise<Doc<"taskInstances">> {
  return (await t.run(async (ctx) => await ctx.db.get(id)))!;
}

/**
 * purpose: Outbox rows of an instance.
 * @param t: (TestConvex) Harness.
 * @param id: (Id<"taskInstances">) Instance.
 * @return: (Promise<Doc<"notificationOutbox">[]>) Rows.
 */
async function outbox(
  t: TestConvex,
  id: Id<"taskInstances">,
): Promise<Doc<"notificationOutbox">[]> {
  return await t.run(
    async (ctx) =>
      await ctx.db
        .query("notificationOutbox")
        .withIndex("by_task_instance", (q) => q.eq("taskInstanceId", id))
        .collect(),
  );
}

describe("expansion", () => {
  test("daily 08:00 stays 08:00 local across the March 2027 spring-forward", async () => {
    const f = await setup("2027-03-13T11:00:00Z");
    const taskId = await makeTask(f);
    const before = await instanceOn(f.t, taskId, "2027-03-13");
    const after = await instanceOn(f.t, taskId, "2027-03-14");
    expect(before.windowStart).toBe(Date.parse("2027-03-13T13:00:00Z"));
    expect(after.windowStart).toBe(Date.parse("2027-03-14T12:00:00Z"));
    expect(before.windowEnd).toBe(Date.parse("2027-03-13T14:00:00Z"));
    expect(before.state).toBe("upcoming");
  });

  test("daily 08:00 stays 08:00 local across the November 2026 fall-back", async () => {
    const f = await setup("2026-10-31T10:00:00Z");
    const taskId = await makeTask(f);
    const edt = await instanceOn(f.t, taskId, "2026-10-31");
    const est = await instanceOn(f.t, taskId, "2026-11-01");
    expect(edt.windowStart).toBe(Date.parse("2026-10-31T12:00:00Z"));
    expect(est.windowStart).toBe(Date.parse("2026-11-01T13:00:00Z"));
  });

  test("expansion is idempotent", async () => {
    const f = await setup("2027-03-13T11:00:00Z");
    await makeTask(f);
    expect(
      await f.t.mutation(internal.scheduler.expand, {
        now: Date.parse("2027-03-13T11:00:00Z"),
        householdId: f.householdId,
      }),
    ).toBe(0);
    const result = await tick(f.t, "2027-03-13T11:00:00Z");
    expect(result.created).toBe(0);
  });

  test("the tick creates tomorrow's instance once the day rolls over", async () => {
    const f = await setup("2027-03-13T11:00:00Z");
    const taskId = await makeTask(f);
    const result = await tick(f.t, "2027-03-14T11:00:00Z");
    expect(result.created).toBe(1);
    expect((await instanceOn(f.t, taskId, "2027-03-15")).windowStart).toBe(
      Date.parse("2027-03-15T12:00:00Z"),
    );
  });

  test("expand with a task id only touches that task", async () => {
    const f = await setup("2027-03-13T11:00:00Z");
    const first = await makeTask(f);
    const second = await makeTask(f, { title: "Evening pills", times: ["20:00"] });
    await f.t.run(async (ctx) => {
      for (const id of [first, second]) {
        const rows = await ctx.db
          .query("taskInstances")
          .withIndex("by_task_date_time", (q) => q.eq("taskId", id))
          .collect();
        for (const r of rows) await ctx.db.delete(r._id);
      }
    });
    const created = await f.t.mutation(internal.scheduler.expand, {
      now: Date.parse("2027-03-13T11:00:00Z"),
      taskId: first,
    });
    expect(created).toBe(2);
    await expect(instanceOn(f.t, second, "2027-03-13")).rejects.toThrow();
  });

  test("a window that closed before the task existed is not back-filled", async () => {
    const f = await setup("2027-03-13T15:00:00Z");
    const taskId = await makeTask(f);
    await expect(instanceOn(f.t, taskId, "2027-03-13")).rejects.toThrow();
    expect((await instanceOn(f.t, taskId, "2027-03-14")).state).toBe("upcoming");
  });

  test("a window still open when the task is created is created and opens on the next tick", async () => {
    const f = await setup("2027-03-13T13:20:00Z");
    const taskId = await makeTask(f);
    const instance = await instanceOn(f.t, taskId, "2027-03-13");
    expect(instance.state).toBe("upcoming");
    const result = await tick(f.t, "2027-03-13T13:21:00Z");
    expect(result.opened).toBe(1);
    expect((await reload(f.t, instance._id)).state).toBe("due");
  });

  test("tasks outside starts/ends, off their weekdays or on another once-on date have no instance", async () => {
    const f = await setup("2027-03-13T11:00:00Z");
    const pat = f.t.withIdentity({ subject: "pat" });
    const base = { householdId: f.householdId, type: "routine" as const, times: ["09:00"] };
    // 2027-03-13 is a Saturday (6); 2027-03-14 a Sunday (7).
    const weekdays = await pat.mutation(api.tasks.create, {
      ...base,
      title: "Weekdays",
      displayLabel: "Weekdays",
      daysOfWeek: [1, 2, 3, 4, 5],
    });
    const sunday = await pat.mutation(api.tasks.create, {
      ...base,
      title: "Sundays",
      displayLabel: "Sundays",
      daysOfWeek: [7],
    });
    const later = await pat.mutation(api.tasks.create, {
      ...base,
      title: "Later",
      displayLabel: "Later",
      startsOn: "2027-03-20",
    });
    const ended = await pat.mutation(api.tasks.create, {
      ...base,
      title: "Ended",
      displayLabel: "Ended",
      endsOn: "2027-03-12",
    });
    const once = await pat.mutation(api.tasks.create, {
      ...base,
      title: "Once",
      displayLabel: "Once",
      onceOn: "2027-03-14",
    });
    await expect(instanceOn(f.t, weekdays, "2027-03-13")).rejects.toThrow();
    await expect(instanceOn(f.t, weekdays, "2027-03-14")).rejects.toThrow();
    expect((await instanceOn(f.t, sunday, "2027-03-14")).scheduledTime).toBe("09:00");
    await expect(instanceOn(f.t, sunday, "2027-03-13")).rejects.toThrow();
    await expect(instanceOn(f.t, later, "2027-03-13")).rejects.toThrow();
    await expect(instanceOn(f.t, ended, "2027-03-13")).rejects.toThrow();
    expect((await instanceOn(f.t, once, "2027-03-14")).state).toBe("upcoming");
    await expect(instanceOn(f.t, once, "2027-03-13")).rejects.toThrow();
  });

  test("an unscheduled (as-needed) task creates no instances", async () => {
    const f = await setup("2027-03-13T11:00:00Z");
    const taskId = await makeTask(f, { times: [], type: "medication" });
    const rows = await f.t.run(
      async (ctx) =>
        await ctx.db
          .query("taskInstances")
          .withIndex("by_task_date_time", (q) => q.eq("taskId", taskId))
          .collect(),
    );
    expect(rows).toHaveLength(0);
  });
});

describe("escalation ladder", () => {
  test("walks prompt, reprompt, on-call alert, claim, skipped all-caregiver alert, missed, resolved", async () => {
    const f = await setup("2027-03-13T11:00:00Z");
    const taskId = await makeTask(f, { spokenPrompt: MORNING_PROMPT });
    const i1 = (await instanceOn(f.t, taskId, "2027-03-13"))._id;

    const opened = await tick(f.t, "2027-03-13T13:00:00Z");
    expect(opened).toMatchObject({ opened: 1, stepsFired: 1, escalated: 0, missed: 0 });
    expect((await reload(f.t, i1)).state).toBe("due");
    const ids = await stepIds(f.t, f.medication);
    const first = await outbox(f.t, i1);
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({
      kind: "senior_prompt",
      recipientDeviceId: f.deviceId,
      title: "Morning pills",
      body: MORNING_PROMPT,
      payload: { taskId, localDate: "2027-03-13", step: ids[0], action: "prompt_senior" },
    });

    await tick(f.t, "2027-03-13T13:00:30Z");
    expect(await outbox(f.t, i1)).toHaveLength(1);

    await tick(f.t, "2027-03-13T13:15:00Z");
    expect((await outbox(f.t, i1)).filter((o) => o.kind === "senior_prompt")).toHaveLength(2);

    const alertTick = await tick(f.t, "2027-03-13T13:30:00Z");
    expect(alertTick).toMatchObject({ stepsFired: 1, escalated: 1 });
    const alerts = (await outbox(f.t, i1)).filter((o) => o.kind === "caregiver_alert");
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({
      recipientUserId: "pat",
      title: "Mom hasn't confirmed Morning pills",
      body: "Due at 8:00 AM. Tap to claim it.",
    });
    expect((await reload(f.t, i1)).state).toBe("escalated");

    at("2027-03-13T13:30:00Z");
    const claimed = await f.t
      .withIdentity({ subject: "max" })
      .mutation(api.instances.claimTaskInstance, { instanceId: i1 });
    expect(claimed.claimedBy).toBe("max");

    await tick(f.t, "2027-03-13T13:45:00Z");
    expect((await outbox(f.t, i1)).filter((o) => o.kind === "caregiver_alert")).toHaveLength(1);

    const closed = await tick(f.t, "2027-03-13T14:00:00Z");
    expect(closed.missed).toBe(1);
    expect((await reload(f.t, i1)).state).toBe("missed");

    at("2027-03-13T14:10:00Z");
    const resolved = await f.t
      .withIdentity({ subject: "max" })
      .mutation(api.instances.confirmTaskInstance, {
        instanceId: i1,
        via: "phone_app",
        note: "Called her, she took them",
      });
    expect(resolved).toMatchObject({
      state: "resolved",
      confirmedVia: "caregiver",
      confirmedBy: "max",
      resolutionNote: "Called her, she took them",
    });

    const trail = await f.t.run(async (ctx) =>
      (
        await ctx.db
          .query("auditLog")
          .withIndex("by_household", (q) => q.eq("householdId", f.householdId))
          .collect()
      ).filter((a) => a.entityId === i1 && a.action === "state_change"),
    );
    expect(trail.map((a) => [a.detail["to"], a.actorKind])).toEqual([
      ["due", "system"],
      ["escalated", "system"],
      ["missed", "system"],
      ["resolved", "caregiver"],
    ]);
  });

  test("a claim and a snooze are audited", async () => {
    const f = await setup("2027-03-13T11:00:00Z");
    const taskId = await makeTask(f);
    const i1 = (await instanceOn(f.t, taskId, "2027-03-13"))._id;
    await tick(f.t, "2027-03-13T13:00:00Z");
    at("2027-03-13T13:01:00Z");
    await f.t.withIdentity({ subject: "phone" }).mutation(api.instances.snoozeTaskInstance, {
      instanceId: i1,
      minutes: 10,
    });
    await f.t.withIdentity({ subject: "pat" }).mutation(api.instances.claimTaskInstance, {
      instanceId: i1,
    });
    const actions = await f.t.run(async (ctx) =>
      (
        await ctx.db
          .query("auditLog")
          .withIndex("by_household", (q) => q.eq("householdId", f.householdId))
          .collect()
      )
        .filter((a) => a.entityId === i1)
        .map((a) => [a.action, a.actorKind]),
    );
    expect(actions).toEqual([
      ["state_change", "system"],
      ["snooze", "senior_device"],
      ["claim", "caregiver"],
    ]);
  });

  test("a confirmed instance is never prompted", async () => {
    const f = await setup("2027-03-14T10:00:00Z");
    const taskId = await makeTask(f);
    const i2 = (await instanceOn(f.t, taskId, "2027-03-14"))._id;
    at("2027-03-14T11:30:00Z");
    await f.t.withIdentity({ subject: "phone" }).mutation(api.instances.confirmTaskInstance, {
      instanceId: i2,
      via: "voice",
    });
    await tick(f.t, "2027-03-14T12:00:00Z");
    await tick(f.t, "2027-03-14T12:45:00Z");
    expect(await outbox(f.t, i2)).toHaveLength(0);
    expect((await reload(f.t, i2)).state).toBe("confirmed");
  });

  test("snoozing holds the reprompt but not the caregiver alert", async () => {
    const f = await setup("2027-03-15T22:00:00Z");
    const taskId = await makeTask(f, { title: "Evening pills", times: ["20:00"] });
    const i3 = (await instanceOn(f.t, taskId, "2027-03-15"))._id;
    await tick(f.t, "2027-03-16T00:00:00Z");
    at("2027-03-16T00:05:00Z");
    const snoozed = await f.t
      .withIdentity({ subject: "phone" })
      .mutation(api.instances.snoozeTaskInstance, { instanceId: i3, minutes: 20 });
    expect(snoozed.snoozedUntil).toBe(Date.parse("2027-03-16T00:25:00Z"));

    await tick(f.t, "2027-03-16T00:15:00Z");
    const prompts = async () =>
      (await outbox(f.t, i3)).filter((o) => o.kind === "senior_prompt").length;
    expect(await prompts()).toBe(1);

    await tick(f.t, "2027-03-16T00:30:00Z");
    expect(await prompts()).toBe(2);
    expect((await outbox(f.t, i3)).filter((o) => o.kind === "caregiver_alert")).toHaveLength(1);
  });

  test("a task added mid-window starts its ladder then, without paging at once", async () => {
    const f = await setup("2027-03-20T11:00:00Z");
    const taskId = await makeTask(f);
    await tick(f.t, "2027-03-20T12:00:00Z");
    const i6 = await instanceOn(f.t, taskId, "2027-03-21");
    await f.t.run(async (ctx) => {
      await ctx.db.patch(i6._id, { createdAt: Date.parse("2027-03-21T12:40:00Z") });
    });
    await tick(f.t, "2027-03-21T12:41:00Z");
    await tick(f.t, "2027-03-21T12:56:00Z");
    const rows = await outbox(f.t, i6._id);
    expect(rows.every((r) => r.kind === "senior_prompt")).toBe(true);
    expect(new Set(rows.map((r) => r.payload["step"])).size).toBe(2);
  });

  test("after a gap only the latest prompt and the latest alert are sent", async () => {
    const f = await setup("2027-03-20T11:00:00Z");
    const taskId = await makeTask(f, { title: "Lunch pills", times: ["12:00"] });
    await tick(f.t, "2027-03-20T16:00:00Z");
    const i5 = (await instanceOn(f.t, taskId, "2027-03-21"))._id;
    const result = await tick(f.t, "2027-03-21T16:50:00Z");
    expect(result.stepsFired).toBe(2);
    const ids = await stepIds(f.t, f.medication);
    const fired = (await reload(f.t, i5)).firedSteps;
    expect(fired.map((s) => [ids.indexOf(s.stepId), s.notified])).toEqual([
      [0, false],
      [1, true],
      [2, false],
      [3, true],
    ]);
    const steps = new Set((await outbox(f.t, i5)).map((o) => o.payload["step"]));
    expect([...steps].sort()).toEqual([ids[1], ids[3]].sort());
  });

  test("with no on-call caregiver the alert goes to every primary", async () => {
    const f = await setup("2027-03-13T11:00:00Z");
    await f.t.run(async (ctx) => {
      await ctx.db.patch(f.householdId, { onCallUserId: undefined });
    });
    const taskId = await makeTask(f);
    const i1 = (await instanceOn(f.t, taskId, "2027-03-13"))._id;
    await tick(f.t, "2027-03-13T13:30:00Z");
    const alerts = (await outbox(f.t, i1)).filter((o) => o.kind === "caregiver_alert");
    expect(alerts.map((a) => a.recipientUserId)).toEqual(["pat"]);
  });

  test("the all-caregiver alert reaches every member, viewers included", async () => {
    const f = await setup("2027-03-13T11:00:00Z");
    const taskId = await makeTask(f);
    const i1 = (await instanceOn(f.t, taskId, "2027-03-13"))._id;
    await tick(f.t, "2027-03-13T13:45:00Z");
    const alerts = (await outbox(f.t, i1)).filter(
      (o) => (o.payload["action"] as string) === "alert_all_caregivers",
    );
    expect(alerts.map((a) => a.recipientUserId).sort()).toEqual(["max", "pat", "val"]);
    expect(alerts[0]!.body).toBe("Due at 8:00 AM. No one has claimed it yet.");
  });

  test("a task with no policy never fires but still opens and closes", async () => {
    const f = await setup("2027-03-13T11:00:00Z");
    const taskId = await makeTask(f, { escalationPolicyId: null });
    const i1 = (await instanceOn(f.t, taskId, "2027-03-13"))._id;
    await tick(f.t, "2027-03-13T13:30:00Z");
    expect(await outbox(f.t, i1)).toHaveLength(0);
    expect((await reload(f.t, i1)).state).toBe("due");
    await tick(f.t, "2027-03-13T14:00:00Z");
    expect((await reload(f.t, i1)).state).toBe("missed");
  });

  test("an inactive task never fires", async () => {
    const f = await setup("2027-03-13T11:00:00Z");
    const taskId = await makeTask(f);
    const i1 = (await instanceOn(f.t, taskId, "2027-03-13"))._id;
    await tick(f.t, "2027-03-13T13:00:00Z");
    await f.t.run(async (ctx) => {
      await ctx.db.patch(taskId, { active: false });
    });
    await tick(f.t, "2027-03-13T13:30:00Z");
    expect(await outbox(f.t, i1)).toHaveLength(1);
  });

  test("a downtime that spans the whole window opens then closes it without prompts", async () => {
    const f = await setup("2027-03-13T11:00:00Z");
    const taskId = await makeTask(f);
    const i1 = (await instanceOn(f.t, taskId, "2027-03-13"))._id;
    const result = await tick(f.t, "2027-03-13T14:00:00Z");
    expect(result).toMatchObject({ opened: 1, stepsFired: 0, missed: 1 });
    expect(await outbox(f.t, i1)).toHaveLength(0);
  });

  test("steps are still recorded when the household has no device to prompt", async () => {
    const f = await setup("2027-03-13T11:00:00Z");
    await f.t.run(async (ctx) => {
      await ctx.db.delete(f.deviceId);
    });
    const taskId = await makeTask(f);
    const i1 = (await instanceOn(f.t, taskId, "2027-03-13"))._id;
    await tick(f.t, "2027-03-13T13:00:00Z");
    expect(await outbox(f.t, i1)).toHaveLength(0);
    expect((await reload(f.t, i1)).firedSteps).toHaveLength(1);
  });
});

describe("schedule edits", () => {
  test("changing times drops future upcoming instances, keeps opened ones and re-expands", async () => {
    const f = await setup("2027-03-15T22:00:00Z");
    const taskId = await makeTask(f, { title: "Evening pills", times: ["20:00"] });
    await tick(f.t, "2027-03-16T00:00:00Z");
    const i3 = await instanceOn(f.t, taskId, "2027-03-15");
    const i4 = await instanceOn(f.t, taskId, "2027-03-16");
    expect(i3.state).toBe("due");

    at("2027-03-16T00:10:00Z");
    await f.t.withIdentity({ subject: "pat" }).mutation(api.tasks.update, {
      householdId: f.householdId,
      taskId,
      times: ["21:00"],
    });
    expect(await f.t.run(async (ctx) => await ctx.db.get(i4._id))).toBeNull();
    expect((await reload(f.t, i3._id)).state).toBe("due");

    await tick(f.t, "2027-03-16T12:00:00Z");
    expect((await instanceOn(f.t, taskId, "2027-03-16")).scheduledTime).toBe("21:00");
  });

  test("deactivating removes open instances and their notifications", async () => {
    const f = await setup("2027-03-13T11:00:00Z");
    const taskId = await makeTask(f);
    const i1 = (await instanceOn(f.t, taskId, "2027-03-13"))._id;
    await tick(f.t, "2027-03-13T13:00:00Z");
    expect(await outbox(f.t, i1)).toHaveLength(1);
    at("2027-03-13T13:05:00Z");
    await f.t.withIdentity({ subject: "pat" }).mutation(api.tasks.update, {
      householdId: f.householdId,
      taskId,
      active: false,
    });
    const left = await f.t.run(
      async (ctx) =>
        await ctx.db
          .query("taskInstances")
          .withIndex("by_task_date_time", (q) => q.eq("taskId", taskId))
          .collect(),
    );
    expect(left).toHaveLength(0);
    expect(await outbox(f.t, i1)).toHaveLength(0);
  });

  test("an edit that is not a schedule change leaves instances and scheduleChangedAt alone", async () => {
    const f = await setup("2027-03-13T11:00:00Z");
    const taskId = await makeTask(f);
    const before = await instanceOn(f.t, taskId, "2027-03-14");
    at("2027-03-13T12:00:00Z");
    await f.t.withIdentity({ subject: "pat" }).mutation(api.tasks.update, {
      householdId: f.householdId,
      taskId,
      displayLabel: "Morning meds",
    });
    expect((await instanceOn(f.t, taskId, "2027-03-14"))._id).toBe(before._id);
    const task = await f.t.run(async (ctx) => await ctx.db.get(taskId));
    expect(task!.scheduleChangedAt).toBeLessThan(Date.parse("2027-03-13T11:01:00Z"));
  });

  test("a schedule change stamps scheduleChangedAt", async () => {
    const f = await setup("2027-03-13T11:00:00Z");
    const taskId = await makeTask(f);
    at("2027-03-13T12:00:00Z");
    await f.t.withIdentity({ subject: "pat" }).mutation(api.tasks.update, {
      householdId: f.householdId,
      taskId,
      windowMinutes: 90,
    });
    const task = await f.t.run(async (ctx) => await ctx.db.get(taskId));
    expect(task!.scheduleChangedAt).toBeGreaterThanOrEqual(Date.parse("2027-03-13T12:00:00Z"));
  });
});

describe("household timezone change", () => {
  test("moves future windows to the new zone and leaves them alone when the zone is unchanged", async () => {
    const f = await setup("2027-04-01T05:00:00Z");
    const pat = f.t.withIdentity({ subject: "pat" });
    await pat.mutation(api.households.update, {
      householdId: f.householdId,
      timezone: "America/Chicago",
    });
    const taskId = await makeTask(f, { title: "Walk", times: ["09:00"] });
    const chicago = await instanceOn(f.t, taskId, "2027-04-01");
    expect(chicago.windowStart).toBe(Date.parse("2027-04-01T14:00:00Z"));

    await pat.mutation(api.households.update, {
      householdId: f.householdId,
      timezone: "america/chicago",
    });
    expect((await instanceOn(f.t, taskId, "2027-04-01"))._id).toBe(chicago._id);

    await pat.mutation(api.households.update, {
      householdId: f.householdId,
      timezone: "America/Los_Angeles",
    });
    expect(await f.t.run(async (ctx) => await ctx.db.get(chicago._id))).toBeNull();
    const la = await instanceOn(f.t, taskId, "2027-04-01");
    expect(la.windowStart).toBe(Date.parse("2027-04-01T16:00:00Z"));
    await tick(f.t, "2027-04-01T05:00:00Z");
    expect((await instanceOn(f.t, taskId, "2027-04-01")).windowStart).toBe(la.windowStart);
  });
});

describe("cascade", () => {
  test("removing a task removes its instances, notifications and dose log rows", async () => {
    const f = await setup("2027-03-13T11:00:00Z");
    const taskId = await makeTask(f);
    const i1 = (await instanceOn(f.t, taskId, "2027-03-13"))._id;
    await tick(f.t, "2027-03-13T13:00:00Z");
    at("2027-03-13T13:05:00Z");
    await f.t.withIdentity({ subject: "pat" }).mutation(api.instances.logDose, {
      householdId: f.householdId,
      taskId,
      takenAt: Date.parse("2027-03-13T13:04:00Z"),
      via: "phone_app",
    });
    await f.t.withIdentity({ subject: "pat" }).mutation(api.tasks.remove, {
      householdId: f.householdId,
      taskId,
    });
    await f.t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await outbox(f.t, i1)).toHaveLength(0);
    const counts = await f.t.run(async (ctx) => ({
      instances: (await ctx.db.query("taskInstances").collect()).length,
      doses: (await ctx.db.query("doseLog").collect()).length,
      tasks: (await ctx.db.get(taskId)) === null,
    }));
    expect(counts).toEqual({ instances: 0, doses: 0, tasks: true });
  });
});

describe("tick fan-out", () => {
  test("tick schedules one tickHousehold per household with the same now", async () => {
    const f = await setup("2027-03-13T11:00:00Z");
    const taskId = await makeTask(f);
    const xen = f.t.withIdentity({ subject: "xen" });
    const other = await xen.mutation(api.households.create, {
      seniorPreferredName: "Dad",
      timezone: "America/New_York",
      caregiverDisplayName: "Xen",
    });
    const otherTask = await xen.mutation(api.tasks.create, {
      householdId: other,
      type: "routine",
      title: "Walk",
      displayLabel: "Walk",
      times: ["08:00"],
    });
    const now = Date.parse("2027-03-13T13:00:00Z");
    const scheduled = await f.t.mutation(internal.scheduler.tick, { now });
    expect(scheduled).toBe(2);
    const jobs = await f.t.run(
      async (ctx) => await ctx.db.system.query("_scheduled_functions").collect(),
    );
    const ticks = jobs.filter((j) => j.name.endsWith("scheduler:tickHousehold"));
    expect(ticks).toHaveLength(2);
    expect(ticks.map((j) => (j.args[0] as { now: number }).now)).toEqual([now, now]);
    expect(new Set(ticks.map((j) => (j.args[0] as { householdId: string }).householdId))).toEqual(
      new Set([f.householdId, other]),
    );
    await f.t.finishAllScheduledFunctions(vi.runAllTimers);
    expect((await instanceOn(f.t, taskId, "2027-03-13")).state).toBe("due");
    expect((await instanceOn(f.t, otherTask, "2027-03-13")).state).toBe("due");
  });

  test("tick pages through households and schedules every one exactly once", async () => {
    const f = await setup("2027-03-13T11:00:00Z");
    for (const subject of ["xen", "yan"]) {
      await f.t.withIdentity({ subject }).mutation(api.households.create, {
        seniorPreferredName: subject,
        timezone: "America/Chicago",
        caregiverDisplayName: subject,
      });
    }
    const now = Date.parse("2027-03-13T13:00:00Z");
    expect(await f.t.mutation(internal.scheduler.tick, { now, pageSize: 1 })).toBe(1);
    await f.t.finishAllScheduledFunctions(vi.runAllTimers);
    const jobs = await f.t.run(
      async (ctx) => await ctx.db.system.query("_scheduled_functions").collect(),
    );
    const households = jobs
      .filter((j) => j.name.endsWith("scheduler:tickHousehold"))
      .map((j) => (j.args[0] as { householdId: string }).householdId);
    expect(households).toHaveLength(3);
    expect(new Set(households).size).toBe(3);
  });
});

describe("editing a policy mid-ladder", () => {
  test("removing step 1 neither re-sends the on-call alert nor skips the all-caregivers step", async () => {
    const f = await setup("2027-03-13T11:00:00Z");
    const taskId = await makeTask(f);
    const i1 = (await instanceOn(f.t, taskId, "2027-03-13"))._id;
    await tick(f.t, "2027-03-13T13:00:00Z");
    await tick(f.t, "2027-03-13T13:15:00Z");
    await tick(f.t, "2027-03-13T13:30:00Z");
    const ids = await stepIds(f.t, f.medication);
    expect((await reload(f.t, i1)).firedSteps.map((s) => s.stepId)).toEqual(ids.slice(0, 3));

    const pat = f.t.withIdentity({ subject: "pat" });
    const policy = (await pat.query(api.tasks.listPolicies, { householdId: f.householdId })).find(
      (p) => p._id === f.medication,
    )!;
    await pat.mutation(api.tasks.updatePolicy, {
      householdId: f.householdId,
      policyId: f.medication,
      steps: policy.steps.filter((_, index) => index !== 1),
    });
    expect(await stepIds(f.t, f.medication)).toEqual([ids[0], ids[2], ids[3]]);

    const early = await tick(f.t, "2027-03-13T13:44:00Z");
    expect(early.stepsFired).toBe(0);
    const late = await tick(f.t, "2027-03-13T13:45:00Z");
    expect(late.stepsFired).toBe(1);
    const rows = await outbox(f.t, i1);
    expect(rows.filter((r) => r.payload["step"] === ids[2])).toHaveLength(1);
    expect(rows.filter((r) => r.payload["step"] === ids[3])).toHaveLength(3);
    expect((await reload(f.t, i1)).firedSteps.map((s) => s.stepId)).toEqual(ids);
  });
});

describe("windows that cross midnight", () => {
  /**
   * purpose: A household with a 23:30 task (120 minute window) and a 00:05 task, with the
   *          clock at 00:10 local on 2027-03-16 (New York) and the 23:30 window still open.
   * @return: (Promise<Fixture & {late: Id<"tasks">}>) The fixture and the late task.
   */
  async function atMidnightCrossing() {
    const f = await setup("2027-03-15T20:00:00Z");
    const late = await makeTask(f, { title: "Night pills", times: ["23:30"], windowMinutes: 120 });
    await makeTask(f, { title: "Early walk", times: ["00:05"], windowMinutes: 60 });
    await tick(f.t, "2027-03-16T03:30:00Z");
    await tick(f.t, "2027-03-16T04:10:00Z");
    at("2027-03-16T04:10:00Z");
    return { ...f, late };
  }

  test("yesterday's open instance is listed before today's in today and dayView", async () => {
    const f = await atMidnightCrossing();
    const pat = f.t.withIdentity({ subject: "pat" });
    const today = await pat.query(api.instances.today, { householdId: f.householdId });
    // Yesterday's open instance first, then today's own (the daily task's 23:30 is upcoming).
    expect(today.map((e) => [e.displayLabel, e.scheduledTime, e.state])).toEqual([
      ["Night pills", "23:30", "escalated"],
      ["Early walk", "00:05", "due"],
      ["Night pills", "23:30", "upcoming"],
    ]);
    const view = await pat.query(api.calendar.dayView, { householdId: f.householdId });
    expect(view.localDate).toBe("2027-03-16");
    expect(view.tasks.map((e) => e.displayLabel)).toEqual([
      "Night pills",
      "Early walk",
      "Night pills",
    ]);
  });

  test("confirmDueTask with no label confirms yesterday's open instance", async () => {
    const f = await atMidnightCrossing();
    const result = await f.t
      .withIdentity({ subject: "phone" })
      .mutation(api.instances.confirmDueTask, { householdId: f.householdId, via: "button" });
    expect(result).toMatchObject({ status: "confirmed", displayLabel: "Night pills" });
    const instance = await instanceOn(f.t, f.late, "2027-03-15");
    expect(instance.state).toBe("confirmed");
  });

  test("yesterday's instances that are confirmed or missed are not listed", async () => {
    const f = await atMidnightCrossing();
    await f.t
      .withIdentity({ subject: "phone" })
      .mutation(api.instances.confirmDueTask, { householdId: f.householdId, via: "button" });
    const pat = f.t.withIdentity({ subject: "pat" });
    const confirmed = await pat.query(api.instances.today, { householdId: f.householdId });
    expect(confirmed.map((e) => [e.displayLabel, e.state])).toEqual([
      ["Early walk", "due"],
      ["Night pills", "upcoming"],
    ]);

    const g = await setup("2027-03-15T20:00:00Z");
    await makeTask(g, { title: "Night pills", times: ["23:30"], windowMinutes: 120 });
    await tick(g.t, "2027-03-16T03:30:00Z");
    await tick(g.t, "2027-03-16T05:31:00Z");
    at("2027-03-16T05:31:00Z");
    const missed = await g.t
      .withIdentity({ subject: "pat" })
      .query(api.instances.today, { householdId: g.householdId });
    expect(missed.map((e) => e.state)).toEqual(["upcoming"]);
  });
});

describe("bounded task deletion", () => {
  /**
   * purpose: Give a task many instances (some with notifications) and dose log rows directly.
   * @param f: (Fixture) Fixture.
   * @param taskId: (Id<"tasks">) Task.
   * @param instances: (number) Instances to insert.
   * @param doses: (number) Dose log rows to insert.
   * @return: (Promise<void>)
   */
  async function bulkUp(f: Fixture, taskId: Id<"tasks">, instances: number, doses: number) {
    await f.t.run(async (ctx) => {
      for (let i = 0; i < instances; i += 1) {
        const id = await ctx.db.insert("taskInstances", {
          taskId,
          householdId: f.householdId,
          localDate: `2020-${String(1 + (i % 12)).padStart(2, "0")}-${String(1 + Math.floor(i / 12)).padStart(2, "0")}`,
          scheduledTime: "08:00",
          windowStart: i,
          windowEnd: i + 1,
          state: "missed",
          createdAt: 0,
          firedSteps: [],
        });
        if (i % 50 === 0) {
          await ctx.db.insert("notificationOutbox", {
            householdId: f.householdId,
            kind: "senior_prompt",
            taskInstanceId: id,
            recipientDeviceId: f.deviceId,
            title: "t",
            body: "b",
            payload: {},
          });
        }
      }
      for (let i = 0; i < doses; i += 1) {
        await ctx.db.insert("doseLog", {
          householdId: f.householdId,
          taskId,
          takenAt: i,
          reportedVia: "phone_app",
        });
      }
    });
  }

  /**
   * purpose: Row counts for a deleted-task check.
   * @param f: (Fixture) Fixture.
   * @return: (Promise<object>) Instances, notifications, doses.
   */
  async function counts(f: Fixture) {
    return await f.t.run(async (ctx) => ({
      instances: (await ctx.db.query("taskInstances").collect()).length,
      notifications: (await ctx.db.query("notificationOutbox").collect()).length,
      doses: (await ctx.db.query("doseLog").collect()).length,
    }));
  }

  test("one purge batch removes at most 200 instances and reports more remain", async () => {
    const f = await setup("2027-03-13T11:00:00Z");
    const taskId = await makeTask(f, { times: [] });
    await bulkUp(f, taskId, 450, 250);
    const more = await f.t.run(async (ctx) => await purgeTaskBatch(ctx, f.householdId, taskId));
    expect(more).toBe(true);
    expect((await counts(f)).instances).toBe(250);
    expect((await counts(f)).doses).toBe(250);
  });

  test("removing a task with hundreds of rows deletes the task now and the rest in batches", async () => {
    const f = await setup("2027-03-13T11:00:00Z");
    const taskId = await makeTask(f, { times: [] });
    await bulkUp(f, taskId, 450, 250);
    await f.t.withIdentity({ subject: "pat" }).mutation(api.tasks.remove, {
      householdId: f.householdId,
      taskId,
    });
    expect(await f.t.run(async (ctx) => await ctx.db.get(taskId))).toBeNull();
    const audit = await f.t.run(async (ctx) => await ctx.db.query("auditLog").collect());
    expect(audit.filter((r) => r.entity === "task" && r.action === "delete")).toHaveLength(1);
    expect((await counts(f)).instances).toBe(450);

    await f.t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await counts(f)).toEqual({ instances: 0, notifications: 0, doses: 0 });
  });

  test("orphaned instances do not break today, the scheduler or confirm while the purge is pending", async () => {
    const f = await setup("2027-03-13T11:00:00Z");
    const taskId = await makeTask(f);
    const i1 = (await instanceOn(f.t, taskId, "2027-03-13"))._id;
    await tick(f.t, "2027-03-13T13:00:00Z");
    const pat = f.t.withIdentity({ subject: "pat" });
    await pat.mutation(api.tasks.remove, { householdId: f.householdId, taskId });
    at("2027-03-13T13:20:00Z");

    expect(await pat.query(api.instances.today, { householdId: f.householdId })).toEqual([]);
    expect((await pat.query(api.calendar.dayView, { householdId: f.householdId })).tasks).toEqual(
      [],
    );
    const result = await tick(f.t, "2027-03-13T13:30:00Z");
    expect(result.stepsFired).toBe(0);
    const done = await f.t
      .withIdentity({ subject: "phone" })
      .mutation(api.instances.confirmDueTask, { householdId: f.householdId, via: "button" });
    expect(done.status).toBe("nothing_due");
    await pat.mutation(api.instances.confirmTaskInstance, { instanceId: i1, via: "phone_app" });

    await f.t.finishAllScheduledFunctions(vi.runAllTimers);
    expect((await counts(f)).instances).toBe(0);
  });
});
