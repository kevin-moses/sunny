// migrations.test.ts
// Purpose: Tests for migrations.removeOnCall with convex-test: a household on the old default
// medication ladder (prompt 0, prompt 15, on call 30, all caregivers 45 unless claimed) ends on
// exactly the new default (prompt 0, prompt 15, all caregivers 30), keeping the step ids, and its
// onCallUserId is cleared; a second run changes nothing; a custom ladder keeps its other steps
// and a ladder with no legacy step is left alone; and the mutation works through every household
// in batches by scheduling itself. Also withoutOnCallSteps as a pure function.
//
// Last modified: 2026-11-14

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import type { EscalationStep } from "./lib/validators";
import { withoutOnCallSteps } from "./migrations";
import { createHousehold, makeBackend, type TestConvex } from "./testing.helpers";

/** The medication ladder every household was seeded with before 2026-11-14. */
const OLD_DEFAULT: EscalationStep[] = [
  { id: "p0", offsetMinutes: 0, action: "prompt_senior", skipIfClaimed: false },
  { id: "p15", offsetMinutes: 15, action: "prompt_senior", skipIfClaimed: false },
  { id: "a30", offsetMinutes: 30, action: "alert_on_call", skipIfClaimed: false },
  { id: "a45", offsetMinutes: 45, action: "alert_all_caregivers", skipIfClaimed: true },
];

/** The new default medication ladder, with the old ladder's ids. */
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

/**
 * purpose: Create a household as it was stored before the change: an on-call caregiver and the
 *          old default medication ladder.
 * @param t: (TestConvex) Harness.
 * @param subject: (string) The creating caregiver.
 * @return: (Promise<Id<"households">>) The household.
 */
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

/**
 * purpose: A household's escalation policies.
 * @param db: (object) A database reader.
 * @param householdId: (Id<"households">) Household.
 * @return: (Promise<Doc<"escalationPolicies">[]>) The policies.
 */
async function policies(
  db: Parameters<Parameters<TestConvex["run"]>[0]>[0]["db"],
  householdId: Id<"households">,
): Promise<Doc<"escalationPolicies">[]> {
  return await db
    .query("escalationPolicies")
    .withIndex("by_household", (q) => q.eq("householdId", householdId))
    .collect();
}

/**
 * purpose: Read a household and its medication policy's steps.
 * @param t: (TestConvex) Harness.
 * @param householdId: (Id<"households">) Household.
 * @return: (Promise<{ household, medication }>) The row and the steps.
 */
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
    expect(result).toEqual({ households: 1, clearedOnCall: 1, policiesRewritten: 1, isDone: true });
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
    expect(again).toEqual({ households: 1, clearedOnCall: 0, policiesRewritten: 0, isDone: true });
    expect(await state(t, householdId)).toEqual(once);
  });

  test("a household already on the new default is left as it is", async () => {
    const t = makeBackend();
    const householdId = await createHousehold(t);
    const before = await state(t, householdId);
    await t.mutation(internal.migrations.removeOnCall, {});
    expect(await state(t, householdId)).toEqual(before);
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
