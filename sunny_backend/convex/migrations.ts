// migrations.ts
// Purpose: One-off data migrations, run by the product owner with `npx convex run` (internal
// functions only; no client can call them).
//
// removeOnCall (2026-11-14): the on-call caregiver is gone; every caregiver is alerted at once
// when a task escalates. Stored data from before that still holds households.onCallUserId and
// escalation steps with the legacy action "alert_on_call" (both kept valid in schema.ts so a
// deploy does not break). Per household this mutation:
// 1. clears onCallUserId;
// 2. in each of the household's escalation policies that has an "alert_on_call" step, rewrites
//    it to "alert_all_caregivers" (same id, offset and skipIfClaimed, so instances that already
//    fired it still see it as fired), then drops every later "alert_all_caregivers" step with
//    skipIfClaimed (it only repeated the alert for the unclaimed case, and now everyone has
//    already been alerted), so the old default medication ladder (prompt 0, prompt 15, on call
//    30, all caregivers 45 unless claimed) ends exactly as the new default (prompt 0, prompt 15,
//    all caregivers 30). A ladder without a legacy step is left as it is.
// It is idempotent (a second run finds nothing to change) and works in batches: it reads one
// page of households and schedules itself for the next page until all are done. Once it has
// run on every deployment, the deprecated onCallUserId field and the "alert_on_call" literal can
// be deleted from schema.ts and lib/validators.ts.
//
// Run: npx convex run migrations:removeOnCall
//
// Last modified: 2026-11-14

import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import { internalMutation } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import type { EscalationStep } from "./lib/validators";

/** Households migrated per transaction. */
const DEFAULT_BATCH = 50;

/** What one run of removeOnCall did. */
export interface RemoveOnCallResult {
  /** Households read in this batch. */
  households: number;
  /** Households cleared of onCallUserId in this batch. */
  clearedOnCall: number;
  /** Policies whose steps were rewritten in this batch. */
  policiesRewritten: number;
  /** True when this was the last page (otherwise the next page is scheduled). */
  isDone: boolean;
}

/**
 * purpose: A ladder without the legacy on-call step: each "alert_on_call" step becomes
 *          "alert_all_caregivers" (same id, offset and skipIfClaimed), and every later
 *          "alert_all_caregivers" step with skipIfClaimed, which only repeated the alert for the
 *          unclaimed case, is dropped.
 * @param steps: (EscalationStep[]) The stored steps, in ladder order.
 * @return: (EscalationStep[] | null) The new steps, or null when the ladder has no legacy step
 *          (nothing to change, so a second run changes nothing).
 */
export function withoutOnCallSteps(steps: EscalationStep[]): EscalationStep[] | null {
  const legacy = steps.filter((s) => s.action === "alert_on_call");
  if (legacy.length === 0) return null;
  const firstLegacy = Math.min(...legacy.map((s) => s.offsetMinutes));
  return steps.flatMap((step): EscalationStep[] => {
    if (step.action === "alert_on_call") return [{ ...step, action: "alert_all_caregivers" }];
    const repeat =
      step.action === "alert_all_caregivers" &&
      step.skipIfClaimed &&
      step.offsetMinutes > firstLegacy;
    return repeat ? [] : [step];
  });
}

/**
 * purpose: Migrate one household: clear onCallUserId and rewrite its policies' legacy steps.
 * @param ctx: (MutationCtx) Context.
 * @param household: (Doc<"households">) The household.
 * @return: (Promise<{ clearedOnCall: boolean; policiesRewritten: number }>) What changed.
 */
async function migrateHousehold(
  ctx: MutationCtx,
  household: Doc<"households">,
): Promise<{ clearedOnCall: boolean; policiesRewritten: number }> {
  const clearedOnCall = household.onCallUserId !== undefined;
  if (clearedOnCall) await ctx.db.patch(household._id, { onCallUserId: undefined });
  const policies = await ctx.db
    .query("escalationPolicies")
    .withIndex("by_household", (q) => q.eq("householdId", household._id))
    .collect();
  let policiesRewritten = 0;
  for (const policy of policies) {
    const steps = withoutOnCallSteps(policy.steps);
    if (steps === null) continue;
    await ctx.db.patch(policy._id, { steps });
    policiesRewritten += 1;
  }
  return { clearedOnCall, policiesRewritten };
}

/**
 * purpose: Remove the on-call caregiver from stored data (see the file header), one page of
 *          households per run; schedules itself for the next page until every household is
 *          done. Internal: run with `npx convex run migrations:removeOnCall`.
 * @param cursor: (string | null, optional) The page to start from; omit for the first.
 * @param batchSize: (number, optional) Households per run, 1 to 200; default 50.
 * @return: (RemoveOnCallResult) What this run did.
 */
export const removeOnCall = internalMutation({
  args: {
    cursor: v.optional(v.union(v.string(), v.null())),
    batchSize: v.optional(v.number()),
  },
  handler: async (ctx, { cursor, batchSize }): Promise<RemoveOnCallResult> => {
    const numItems = Math.min(Math.max(Math.floor(batchSize ?? DEFAULT_BATCH), 1), 200);
    const page = await ctx.db.query("households").paginate({ cursor: cursor ?? null, numItems });
    const result: RemoveOnCallResult = {
      households: page.page.length,
      clearedOnCall: 0,
      policiesRewritten: 0,
      isDone: page.isDone,
    };
    for (const household of page.page) {
      const changed = await migrateHousehold(ctx, household);
      if (changed.clearedOnCall) result.clearedOnCall += 1;
      result.policiesRewritten += changed.policiesRewritten;
    }
    if (!page.isDone) {
      await ctx.scheduler.runAfter(0, internal.migrations.removeOnCall, {
        cursor: page.continueCursor,
        batchSize: numItems,
      });
    }
    return result;
  },
});
