import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import { dueOrEscalatedInstances } from "./lib/escalation";
import type { EscalationStep } from "./lib/validators";

const DEFAULT_BATCH = 50;

export interface RemoveOnCallResult {
  households: number;
  clearedOnCall: number;
  policiesRewritten: number;
  deferred: number;
  isDone: boolean;
}

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

async function hasOpenLegacyAlert(
  ctx: MutationCtx,
  householdId: Id<"households">,
): Promise<boolean> {
  const open = await dueOrEscalatedInstances(ctx, householdId);
  return open.some((i) => i.firedSteps.some((f) => f.action === "alert_on_call"));
}

async function migrateHousehold(
  ctx: MutationCtx,
  household: Doc<"households">,
): Promise<{ clearedOnCall: boolean; policiesRewritten: number; deferred: boolean }> {
  const clearedOnCall = household.onCallUserId !== undefined;
  if (clearedOnCall) await ctx.db.patch(household._id, { onCallUserId: undefined });
  const policies = await ctx.db
    .query("escalationPolicies")
    .withIndex("by_household", (q) => q.eq("householdId", household._id))
    .collect();
  const rewrites = policies.flatMap((policy) => {
    const steps = withoutOnCallSteps(policy.steps);
    return steps === null ? [] : [{ policy, steps }];
  });
  if (rewrites.length > 0 && (await hasOpenLegacyAlert(ctx, household._id))) {
    return { clearedOnCall, policiesRewritten: 0, deferred: true };
  }
  for (const { policy, steps } of rewrites) await ctx.db.patch(policy._id, { steps });
  return { clearedOnCall, policiesRewritten: rewrites.length, deferred: false };
}

export const removeOnCall = internalMutation({
  args: {
    cursor: v.optional(v.union(v.string(), v.null())),
    batchSize: v.optional(v.number()),
  },
  handler: async (ctx, { cursor, batchSize }): Promise<RemoveOnCallResult> => {
    const wanted =
      batchSize !== undefined && Number.isFinite(batchSize) ? batchSize : DEFAULT_BATCH;
    const numItems = Math.min(Math.max(Math.floor(wanted), 1), 200);
    const page = await ctx.db.query("households").paginate({ cursor: cursor ?? null, numItems });
    const result: RemoveOnCallResult = {
      households: page.page.length,
      clearedOnCall: 0,
      policiesRewritten: 0,
      deferred: 0,
      isDone: page.isDone,
    };
    for (const household of page.page) {
      const changed = await migrateHousehold(ctx, household);
      if (changed.clearedOnCall) result.clearedOnCall += 1;
      result.policiesRewritten += changed.policiesRewritten;
      if (changed.deferred) result.deferred += 1;
    }
    console.log(`migrations:removeOnCall ${JSON.stringify(result)}`);
    if (!page.isDone) {
      await ctx.scheduler.runAfter(0, internal.migrations.removeOnCall, {
        cursor: page.continueCursor,
        batchSize: numItems,
      });
    }
    return result;
  },
});
