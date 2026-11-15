import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import type { FiredStep } from "./lib/escalation";
import type { LegacyReport } from "./migrations";
import { UNKNOWN_AGENT_CONFIG, ladderFiredSteps } from "./migrations";
import { createHousehold, insertRequest, makeBackend, type TestConvex } from "./testing.helpers";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

type PolicyStep = Doc<"escalationPolicies">["steps"][number];

const OLD_MEDICATION: PolicyStep[] = [
  { id: "p0", offsetMinutes: 0, action: "prompt_senior", skipIfClaimed: false },
  { id: "p15", offsetMinutes: 15, action: "prompt_senior", skipIfClaimed: false },
  { id: "a30", offsetMinutes: 30, action: "alert_on_call", skipIfClaimed: false },
  { id: "a45", offsetMinutes: 45, action: "alert_all_caregivers", skipIfClaimed: true },
];

const OLD_PROMPT_ONLY: PolicyStep[] = [
  { id: "q0", offsetMinutes: 0, action: "prompt_senior", skipIfClaimed: false },
];

const CLEAN: LegacyReport = {
  householdsWithOnCall: 0,
  membersWithDigestOptOut: 0,
  escalationPolicies: 0,
  tasksWithPolicy: 0,
  tasksWithoutHighPriority: 0,
  tasksOverCaps: 0,
  instancesWithLegacySteps: 0,
  agentRequestsWithoutConfig: 0,
  doseLogWithoutLoggedAt: 0,
};

function fired(
  stepId: string,
  action: FiredStep["action"],
  notified: boolean,
  firedAt = 1,
): FiredStep {
  return { stepId, action, firedAt, notified };
}

async function insertPolicy(
  t: TestConvex,
  householdId: Id<"households">,
  systemKey: "medication" | "prompt_only",
  steps: PolicyStep[],
): Promise<Id<"escalationPolicies">> {
  return await t.run(
    async (ctx) =>
      await ctx.db.insert("escalationPolicies", { householdId, name: systemKey, systemKey, steps }),
  );
}

async function insertTask(
  t: TestConvex,
  householdId: Id<"households">,
  fields: Partial<Omit<Doc<"tasks">, "_id" | "_creationTime" | "householdId">> = {},
): Promise<Id<"tasks">> {
  return await t.run(
    async (ctx) =>
      await ctx.db.insert("tasks", {
        householdId,
        type: "routine",
        title: "Walk",
        displayLabel: "Walk",
        spokenPrompt: "Time for Walk.",
        checklistItems: [],
        times: ["09:00"],
        windowMinutes: 60,
        createdByKind: "caregiver",
        active: true,
        scheduleChangedAt: 0,
        ...fields,
      }),
  );
}

async function task(t: TestConvex, id: Id<"tasks">): Promise<Doc<"tasks">> {
  return (await t.run(async (ctx) => await ctx.db.get(id)))!;
}

async function report(t: TestConvex): Promise<LegacyReport> {
  return await t.query(internal.migrations.legacyReport, {});
}

async function auditCount(t: TestConvex): Promise<number> {
  return await t.run(async (ctx) => (await ctx.db.query("auditLog").collect()).length);
}

describe("ladderFiredSteps", () => {
  test("maps the old default ladder onto the code ladder, the two alerts into one", () => {
    expect(
      ladderFiredSteps([
        fired("p0", "prompt_senior", false, 1),
        fired("p15", "prompt_senior", true, 2),
        fired("a30", "alert_on_call", true, 3),
        fired("a45", "alert_all_caregivers", false, 4),
      ]),
    ).toEqual([
      fired("prompt", "prompt_senior", false, 1),
      fired("prompt_again", "prompt_senior", true, 2),
      fired("alert", "alert_all_caregivers", true, 3),
    ]);
  });

  test("a later notified alert marks the merged alert notified", () => {
    expect(
      ladderFiredSteps([
        fired("a30", "alert_all_caregivers", false, 3),
        fired("a45", "alert_all_caregivers", true, 4),
      ]),
    ).toEqual([fired("alert", "alert_all_caregivers", true, 3)]);
  });

  test("prompts beyond the ladder's two are dropped", () => {
    const steps = ["x", "y", "z"].map((id, i) => fired(id, "prompt_senior", true, i));
    expect(ladderFiredSteps(steps).map((s) => s.stepId)).toEqual(["prompt", "prompt_again"]);
  });

  test("steps already on the code ladder are returned unchanged", () => {
    const steps = [
      fired("prompt", "prompt_senior", true, 1),
      fired("alert", "alert_all_caregivers", true, 2),
      fired("prompt_again", "prompt_senior", false, 3),
    ];
    expect(ladderFiredSteps(steps)).toEqual(steps);
  });
});

describe("migrations.tasks", () => {
  async function legacyTasks(t: TestConvex) {
    const householdId = await createHousehold(t);
    const medication = await insertPolicy(t, householdId, "medication", OLD_MEDICATION);
    const promptOnly = await insertPolicy(t, householdId, "prompt_only", OLD_PROMPT_ONLY);
    return {
      householdId,
      alertingRoutine: await insertTask(t, householdId, { escalationPolicyId: medication }),
      quietRoutine: await insertTask(t, householdId, { escalationPolicyId: promptOnly }),
      pills: await insertTask(t, householdId, {
        type: "medication",
        escalationPolicyId: promptOnly,
      }),
      noPolicy: await insertTask(t, householdId),
      chosen: await insertTask(t, householdId, { highPriority: true }),
      long: await insertTask(t, householdId, {
        title: "T".repeat(250),
        displayLabel: "L".repeat(70),
        spokenPrompt: `  ${"S".repeat(310)}  `,
        pillDescription: "P".repeat(210),
        checklistItems: Array.from({ length: 55 }, () => "C".repeat(205)),
        times: Array.from(
          { length: 26 },
          (_, i) => `${String(i % 24).padStart(2, "0")}:${i < 24 ? "00" : "30"}`,
        ),
        highPriority: false,
      }),
    };
  }

  test("sets high priority from the old policy, clears the policy and clips over-cap fields", async () => {
    const t = makeBackend();
    const f = await legacyTasks(t);
    const result = await t.mutation(internal.migrations.tasks, {});
    expect(result).toEqual({ scanned: 6, changed: 5, isDone: true });
    expect(await task(t, f.alertingRoutine)).toMatchObject({ highPriority: true });
    expect(await task(t, f.quietRoutine)).toMatchObject({ highPriority: false });
    expect(await task(t, f.pills)).toMatchObject({ highPriority: false });
    expect(await task(t, f.noPolicy)).toMatchObject({ highPriority: false });
    expect(await task(t, f.chosen)).toMatchObject({ highPriority: true });
    for (const id of [f.alertingRoutine, f.quietRoutine, f.pills, f.noPolicy, f.chosen, f.long]) {
      expect((await task(t, id)).escalationPolicyId).toBeUndefined();
    }
    const long = await task(t, f.long);
    expect(long.title).toHaveLength(200);
    expect(long.displayLabel).toHaveLength(60);
    expect(long.spokenPrompt).toBe("S".repeat(300));
    expect(long.pillDescription).toHaveLength(200);
    expect(long.checklistItems).toHaveLength(50);
    expect(long.checklistItems.every((item) => item.length === 200)).toBe(true);
    expect(long.times).toHaveLength(24);
  });

  test("a second run changes nothing and writes no audit rows", async () => {
    const t = makeBackend();
    await legacyTasks(t);
    await t.mutation(internal.migrations.tasks, {});
    const audits = await auditCount(t);
    expect(await t.mutation(internal.migrations.tasks, {})).toEqual({
      scanned: 6,
      changed: 0,
      isDone: true,
    });
    expect(await auditCount(t)).toBe(audits);
  });

  test("a small batch schedules the rest and finishes every page", async () => {
    const t = makeBackend();
    const f = await legacyTasks(t);
    expect(await t.mutation(internal.migrations.tasks, { batchSize: 2 })).toMatchObject({
      scanned: 2,
      isDone: false,
    });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await task(t, f.long)).toMatchObject({ highPriority: false });
    const after = await report(t);
    expect(after).toMatchObject({
      tasksWithPolicy: 0,
      tasksWithoutHighPriority: 0,
      tasksOverCaps: 0,
    });
  });
});

describe("migrations.escalationPolicies", () => {
  test("deletes only policies no task still uses, and the rest once the tasks are migrated", async () => {
    const t = makeBackend();
    const householdId = await createHousehold(t);
    const used = await insertPolicy(t, householdId, "medication", OLD_MEDICATION);
    await insertPolicy(t, householdId, "prompt_only", OLD_PROMPT_ONLY);
    await insertTask(t, householdId, { escalationPolicyId: used });
    expect(await t.mutation(internal.migrations.escalationPolicies, {})).toEqual({
      scanned: 2,
      changed: 1,
      isDone: true,
    });
    expect(await t.run(async (ctx) => await ctx.db.get(used))).not.toBeNull();
    await t.mutation(internal.migrations.tasks, {});
    expect(await t.mutation(internal.migrations.escalationPolicies, {})).toMatchObject({
      changed: 1,
    });
    expect(await t.mutation(internal.migrations.escalationPolicies, {})).toEqual({
      scanned: 0,
      changed: 0,
      isDone: true,
    });
    expect((await report(t)).escalationPolicies).toBe(0);
  });
});

describe("migrations.households and householdMembers", () => {
  test("clear onCallUserId and digestOptOut, then change nothing", async () => {
    const t = makeBackend();
    const householdId = await createHousehold(t, { subject: "pat" });
    await createHousehold(t, { subject: "kim" });
    await t.run(async (ctx) => {
      await ctx.db.patch(householdId, { onCallUserId: "pat" });
      for (const member of await ctx.db.query("householdMembers").collect()) {
        await ctx.db.patch(member._id, { digestOptOut: true });
      }
    });
    expect(await report(t)).toMatchObject({ householdsWithOnCall: 1, membersWithDigestOptOut: 2 });
    expect(await t.mutation(internal.migrations.households, {})).toEqual({
      scanned: 2,
      changed: 1,
      isDone: true,
    });
    expect(await t.mutation(internal.migrations.householdMembers, {})).toEqual({
      scanned: 2,
      changed: 2,
      isDone: true,
    });
    expect(await report(t)).toMatchObject({ householdsWithOnCall: 0, membersWithDigestOptOut: 0 });
    expect(await t.mutation(internal.migrations.households, {})).toMatchObject({ changed: 0 });
    expect(await t.mutation(internal.migrations.householdMembers, {})).toMatchObject({
      changed: 0,
    });
  });
});

describe("migrations.taskInstances", () => {
  test("rewrites fired steps onto the code ladder so the tick does not repeat them", async () => {
    const t = makeBackend();
    const householdId = await createHousehold(t);
    const taskId = await insertTask(t, householdId, { type: "medication", highPriority: false });
    const windowStart = Date.parse("2027-03-13T13:00:00Z");
    const instanceId = await t.run(
      async (ctx) =>
        await ctx.db.insert("taskInstances", {
          taskId,
          householdId,
          localDate: "2027-03-13",
          scheduledTime: "09:00",
          windowStart,
          windowEnd: windowStart + 60 * 60_000,
          state: "escalated",
          createdAt: windowStart - 60_000,
          firedSteps: [
            fired("p0", "prompt_senior", true, windowStart),
            fired("p15", "prompt_senior", true, windowStart + 15 * 60_000),
            fired("a30", "alert_on_call", true, windowStart + 30 * 60_000),
          ],
        }),
    );
    expect((await report(t)).instancesWithLegacySteps).toBe(1);
    expect(await t.mutation(internal.migrations.taskInstances, {})).toEqual({
      scanned: 1,
      changed: 1,
      isDone: true,
    });
    const after = (await t.run(async (ctx) => await ctx.db.get(instanceId)))!;
    expect(after.firedSteps.map((s) => [s.stepId, s.action])).toEqual([
      ["prompt", "prompt_senior"],
      ["prompt_again", "prompt_senior"],
      ["alert", "alert_all_caregivers"],
    ]);
    const tick = await t.mutation(internal.scheduler.tickHousehold, {
      householdId,
      now: windowStart + 40 * 60_000,
    });
    expect(tick.stepsFired).toBe(0);
    expect(await t.mutation(internal.migrations.taskInstances, {})).toMatchObject({ changed: 0 });
  });
});

describe("migrations.agentRequests", () => {
  test("gives a request without a config one that never matches, so it is not continued", async () => {
    const t = makeBackend();
    const householdId = await createHousehold(t);
    const legacy = await insertRequest(t, householdId, { status: "succeeded", sessionId: "s1" });
    await t.run(async (ctx) => await ctx.db.patch(legacy, { agentConfig: undefined }));
    await insertRequest(t, householdId, { status: "succeeded", sessionId: "s2" });
    expect((await report(t)).agentRequestsWithoutConfig).toBe(1);
    expect(await t.mutation(internal.migrations.agentRequests, {})).toEqual({
      scanned: 2,
      changed: 1,
      isDone: true,
    });
    const row = await t.run(async (ctx) => await ctx.db.get(legacy));
    expect(row!.agentConfig).toBe(UNKNOWN_AGENT_CONFIG);
    expect(await t.mutation(internal.migrations.agentRequests, {})).toMatchObject({ changed: 0 });
  });
});

describe("migrations.doseLog", () => {
  test("fills loggedAt from the row's creation time", async () => {
    const t = makeBackend();
    const householdId = await createHousehold(t);
    const taskId = await insertTask(t, householdId, { type: "medication", times: [] });
    const doseId = await t.run(
      async (ctx) =>
        await ctx.db.insert("doseLog", {
          householdId,
          taskId,
          takenAt: 5,
          reportedVia: "voice",
        }),
    );
    expect((await report(t)).doseLogWithoutLoggedAt).toBe(1);
    expect(await t.mutation(internal.migrations.doseLog, {})).toEqual({
      scanned: 1,
      changed: 1,
      isDone: true,
    });
    const row = (await t.run(async (ctx) => await ctx.db.get(doseId)))!;
    expect(row.loggedAt).toBe(row._creationTime);
    expect(await t.mutation(internal.migrations.doseLog, {})).toMatchObject({ changed: 0 });
  });
});

describe("legacyReport", () => {
  test("a household created now has nothing to migrate", async () => {
    const t = makeBackend();
    await createHousehold(t);
    expect(await report(t)).toEqual(CLEAN);
  });

  test("every migration in order leaves the report clean", async () => {
    const t = makeBackend();
    const householdId = await createHousehold(t);
    const medication = await insertPolicy(t, householdId, "medication", OLD_MEDICATION);
    await insertTask(t, householdId, { escalationPolicyId: medication });
    await t.run(async (ctx) => await ctx.db.patch(householdId, { onCallUserId: "user_a" }));
    expect(await report(t)).toMatchObject({
      householdsWithOnCall: 1,
      escalationPolicies: 1,
      tasksWithPolicy: 1,
      tasksWithoutHighPriority: 1,
    });
    for (const migration of [
      internal.migrations.tasks,
      internal.migrations.escalationPolicies,
      internal.migrations.households,
      internal.migrations.householdMembers,
      internal.migrations.taskInstances,
      internal.migrations.agentRequests,
      internal.migrations.doseLog,
    ]) {
      await t.mutation(migration, {});
    }
    expect(await report(t)).toEqual(CLEAN);
  });
});
