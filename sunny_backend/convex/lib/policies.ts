// lib/policies.ts
// Purpose: Seeds the default escalation policies every new household starts with (the
// SPEC defaults, ported from private.seed_default_policies). They carry a systemKey so
// code finds them without depending on the editable name; they may be renamed and tuned
// but not deleted (enforced by the policy mutations).
//
// Last modified: 2026-10-28

import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";

/**
 * purpose: Insert the "Medication" and "Prompt only" policies for a household.
 * @param ctx: (MutationCtx) Mutation context.
 * @param householdId: (Id<"households">) The new household.
 * @return: (Promise<void>) Resolves when both policies are written.
 */
export async function seedDefaultPolicies(
  ctx: MutationCtx,
  householdId: Id<"households">,
): Promise<void> {
  await ctx.db.insert("escalationPolicies", {
    householdId,
    name: "Medication",
    systemKey: "medication",
    steps: [
      { offsetMinutes: 0, action: "prompt_senior", skipIfClaimed: false },
      { offsetMinutes: 15, action: "prompt_senior", skipIfClaimed: false },
      { offsetMinutes: 30, action: "alert_on_call", skipIfClaimed: false },
      { offsetMinutes: 45, action: "alert_all_caregivers", skipIfClaimed: true },
    ],
  });
  await ctx.db.insert("escalationPolicies", {
    householdId,
    name: "Prompt only",
    systemKey: "prompt_only",
    steps: [{ offsetMinutes: 0, action: "prompt_senior", skipIfClaimed: false }],
  });
}
