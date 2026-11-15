import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import type { EscalationStep } from "./lib/validators";
import { withoutOnCallSteps } from "./migrations";
import { addInstance, createHousehold, makeBackend, type TestConvex } from "./testing.helpers";

const OLD_DEFAULT: EscalationStep[] = [
  { id: "p0", offsetMinutes: 0, action: "prompt_senior", skipIfClaimed: false },
  { id: "p15", offsetMinutes: 15, action: "prompt_senior", skipIfClaimed: false },
  { id: "a30", offsetMinutes: 30, action: "alert_on_call", skipIfClaimed: false },
  { id: "a45", offsetMinutes: 45, action: "alert_all_caregivers", skipIfClaimed: true },
];

const NEW_DEFAULT: EscalationStep[] = [
  { id: "p0", offsetMinutes: 0, action: "prompt_senior", skipIfClaimed: false },
  { id: "p15", offsetMinutes: 15, action: "prompt_senior", skipIfClaimed: false },
  { id: "a30", offsetMinutes: 30, action: "alert_all_caregivers", skipIfClaimed: false },
];

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

async function legacyHousehold(t: TestConvex, subject: string): Promise<Id<"households">> {
  const householdId = await createHousehold(t, { subject });
  await t.run(async (ctx) => {
    await ctx.db.patch(householdId, { onCallUserId: subject });
    const medication = (await policies(ctx.db, householdId)).find(
      (p) => p.systemKey === "medication",
    )!;
    await ctx.db.patch(medication._id, { steps: OLD_DEFAULT });
  });
  return householdId;
}

async function policies(
  db: Parameters<Parameters<TestConvex["run"]>[0]>[0]["db"],
  householdId: Id<"households">,
): Promise<Doc<"escalationPolicies">[]> {
  return await db
    .query("escalationPolicies")
    .withIndex("by_household", (q) => q.eq("householdId", householdId))
    .collect();
}

async function state(t: TestConvex, householdId: Id<"households">) {
  return await t.run(async (ctx) => ({
    household: (await ctx.db.get(householdId))!,
    medication: (await policies(ctx.db, householdId)).find((p) => p.systemKey === "medication")!
      .steps,
  }));
}

describe("removeOnCall", () => {
  test("the old default ladder becomes the new default and onCallUserId is cleared", async () => {
    const t = makeBackend();
    const householdId = await legacyHousehold(t, "user_a");
    const result = await t.mutation(internal.migrations.removeOnCall, {});
    expect(result).toEqual({
      households: 1,
      clearedOnCall: 1,
      policiesRewritten: 1,
      deferred: 0,
      isDone: true,
    });
    const after = await state(t, householdId);
    expect(after.household.onCallUserId).toBeUndefined();
    expect(after.medication).toEqual(NEW_DEFAULT);
  });

  test("a second run changes nothing", async () => {
    const t = makeBackend();
    const householdId = await legacyHousehold(t, "user_a");
    await t.mutation(internal.migrations.removeOnCall, {});
    const once = await state(t, householdId);
    const again = await t.mutation(internal.migrations.removeOnCall, {});
    expect(again).toEqual({
      households: 1,
      clearedOnCall: 0,
      policiesRewritten: 0,
      deferred: 0,
      isDone: true,
    });
    expect(await state(t, householdId)).toEqual(once);
  });

  test("a household already on the new default is left as it is", async () => {
    const t = makeBackend();
    const householdId = await createHousehold(t);
    const before = await state(t, householdId);
    await t.mutation(internal.migrations.removeOnCall, {});
    expect(await state(t, householdId)).toEqual(before);
  });

  test("an open instance that fired a legacy step defers the ladder until it has closed", async () => {
    const t = makeBackend();
    const householdId = await legacyHousehold(t, "user_a");
    const instanceId = await addInstance(t, householdId, "Morning pills", {
      state: "escalated",
      firedSteps: [{ stepId: "a30", action: "alert_on_call", firedAt: 1, notified: true }],
    });
    const first = await t.mutation(internal.migrations.removeOnCall, {});
    expect(first).toMatchObject({ clearedOnCall: 1, policiesRewritten: 0, deferred: 1 });
    const deferred = await state(t, householdId);
    expect(deferred.household.onCallUserId).toBeUndefined();
    expect(deferred.medication).toEqual(OLD_DEFAULT);

    await t.run(async (ctx) => await ctx.db.patch(instanceId, { state: "missed" }));
    const later = await t.mutation(internal.migrations.removeOnCall, {});
    expect(later).toMatchObject({ clearedOnCall: 0, policiesRewritten: 1, deferred: 0 });
    expect((await state(t, householdId)).medication).toEqual(NEW_DEFAULT);
  });

  test("an open instance that fired no legacy step does not defer", async () => {
    const t = makeBackend();
    const householdId = await legacyHousehold(t, "user_a");
    await addInstance(t, householdId, "Morning pills", {
      state: "due",
      firedSteps: [{ stepId: "p0", action: "prompt_senior", firedAt: 1, notified: true }],
    });
    expect(await t.mutation(internal.migrations.removeOnCall, {})).toMatchObject({ deferred: 0 });
    expect((await state(t, householdId)).medication).toEqual(NEW_DEFAULT);
  });

  test("a batch size that is not a finite number falls back to the default", async () => {
    const t = makeBackend();
    for (const subject of ["u1", "u2"]) await legacyHousehold(t, subject);
    const result = await t.mutation(internal.migrations.removeOnCall, { batchSize: Number.NaN });
    expect(result).toMatchObject({ households: 2, isDone: true });
  });

  test("works through every household in batches", async () => {
    const t = makeBackend();
    const ids = [];
    for (const subject of ["u1", "u2", "u3"]) ids.push(await legacyHousehold(t, subject));
    const first = await t.mutation(internal.migrations.removeOnCall, { batchSize: 1 });
    expect(first).toMatchObject({ households: 1, isDone: false });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    for (const id of ids) {
      const after = await state(t, id);
      expect(after.household.onCallUserId).toBeUndefined();
      expect(after.medication).toEqual(NEW_DEFAULT);
    }
  });
});

describe("withoutOnCallSteps", () => {
  test("a custom ladder keeps its other steps; only the repeat after the legacy step goes", () => {
    const custom: EscalationStep[] = [
      { id: "p0", offsetMinutes: 0, action: "prompt_senior", skipIfClaimed: false },
      { id: "e20", offsetMinutes: 20, action: "alert_all_caregivers", skipIfClaimed: false },
      { id: "c40", offsetMinutes: 40, action: "alert_on_call", skipIfClaimed: true },
      { id: "r60", offsetMinutes: 60, action: "alert_all_caregivers", skipIfClaimed: true },
      { id: "p70", offsetMinutes: 70, action: "prompt_senior", skipIfClaimed: false },
    ];
    expect(withoutOnCallSteps(custom)).toEqual([
      custom[0],
      custom[1],
      { id: "c40", offsetMinutes: 40, action: "alert_all_caregivers", skipIfClaimed: true },
      custom[4],
    ]);
  });

  test("with several legacy steps, everything after the earliest one is compared", () => {
    const steps: EscalationStep[] = [
      { id: "c20", offsetMinutes: 20, action: "alert_on_call", skipIfClaimed: false },
      { id: "r25", offsetMinutes: 25, action: "alert_all_caregivers", skipIfClaimed: true },
      { id: "c40", offsetMinutes: 40, action: "alert_on_call", skipIfClaimed: true },
      { id: "r50", offsetMinutes: 50, action: "alert_all_caregivers", skipIfClaimed: true },
    ];
    expect(withoutOnCallSteps(steps)).toEqual([
      { ...steps[0], action: "alert_all_caregivers" },
      { ...steps[2], action: "alert_all_caregivers" },
    ]);
  });

  test("an all-caregivers step at exactly the legacy step's offset is kept", () => {
    const steps: EscalationStep[] = [
      { id: "c30", offsetMinutes: 30, action: "alert_on_call", skipIfClaimed: false },
      { id: "s30", offsetMinutes: 30, action: "alert_all_caregivers", skipIfClaimed: true },
    ];
    expect(withoutOnCallSteps(steps)).toEqual([
      { ...steps[0], action: "alert_all_caregivers" },
      steps[1],
    ]);
  });

  test("a ladder with no legacy step is not changed, even with two all-caregivers steps", () => {
    expect(withoutOnCallSteps(NEW_DEFAULT)).toBeNull();
    expect(
      withoutOnCallSteps([
        { id: "a", offsetMinutes: 30, action: "alert_all_caregivers", skipIfClaimed: false },
        { id: "b", offsetMinutes: 45, action: "alert_all_caregivers", skipIfClaimed: true },
      ]),
    ).toBeNull();
  });

  test("an all-caregivers step before the legacy one, or one that ignores claims, stays", () => {
    const steps: EscalationStep[] = [
      { id: "x", offsetMinutes: 10, action: "alert_all_caregivers", skipIfClaimed: true },
      { id: "c", offsetMinutes: 30, action: "alert_on_call", skipIfClaimed: false },
      { id: "y", offsetMinutes: 45, action: "alert_all_caregivers", skipIfClaimed: false },
    ];
    expect(withoutOnCallSteps(steps)).toEqual([
      steps[0],
      { ...steps[1], action: "alert_all_caregivers" },
      steps[2],
    ]);
  });
});
