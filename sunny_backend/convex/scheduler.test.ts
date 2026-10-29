// scheduler.test.ts
// Purpose: Tests for the scheduler (scheduler.ts, lib/schedule.ts), ported from the scheduler
// half of supabase/tests/scheduler.test.sql: expansion across the March 2027 and November
// 2026 New York DST changes, idempotence, no back-fill, the escalation ladder (prompt,
// reprompt, on-call alert, all-caregiver alert skipped once claimed), missed windows, audit of
// every state change, snooze, tasks added mid-window, bursts after a gap, inactive tasks,
// on-call fallback to primaries, schedule edits and deactivation, and the household timezone
// resync. The clock is driven by passing `now` to the internal functions and by faking Date
// for the public functions.
//
// Last modified: 2026-10-28

import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import schema from "./schema";

/** Every non-test module in the backend, for the convex-test harness. */
const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);

const MORNING_PROMPT = "It's 8 o'clock. Time for your morning pills, the small white ones.";

/**
 * purpose: A fresh in-memory backend.
 * @return: The convex-test harness typed with the schema.
 */
function makeBackend() {
  return convexTest(schema, modules);
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
 * purpose: Run the scheduler at an instant.
 * @param t: (TestConvex) Harness.
 * @param iso: (string) UTC instant.
 * @return: (Promise<object>) The tick counts.
 */
async function tick(t: TestConvex, iso: string) {
  return await t.mutation(internal.scheduler.tick, { now: Date.parse(iso) });
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
      await f.t.mutation(internal.scheduler.expand, { now: Date.parse("2027-03-13T11:00:00Z") }),
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
    const first = await outbox(f.t, i1);
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({
      kind: "senior_prompt",
      recipientDeviceId: f.deviceId,
      title: "Morning pills",
      body: MORNING_PROMPT,
      payload: { taskId, localDate: "2027-03-13", step: 0, action: "prompt_senior" },
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
    const fired = (await reload(f.t, i5)).firedSteps;
    expect(fired.map((s) => [s.position, s.notified])).toEqual([
      [0, false],
      [1, true],
      [2, false],
      [3, true],
    ]);
    const steps = new Set((await outbox(f.t, i5)).map((o) => o.payload["step"]));
    expect([...steps].sort()).toEqual([1, 3]);
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
    expect(await outbox(f.t, i1)).toHaveLength(0);
    const counts = await f.t.run(async (ctx) => ({
      instances: (await ctx.db.query("taskInstances").collect()).length,
      doses: (await ctx.db.query("doseLog").collect()).length,
      tasks: (await ctx.db.get(taskId)) === null,
    }));
    expect(counts).toEqual({ instances: 0, doses: 0, tasks: true });
  });
});
