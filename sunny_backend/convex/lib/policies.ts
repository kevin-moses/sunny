// lib/policies.ts
// Purpose: Seeds the default escalation policies every new household starts with (the
// SPEC defaults, ported from private.seed_default_policies). They carry a systemKey so
// code finds them without depending on the editable name; they may be renamed and tuned
// but not deleted (enforced by the policy mutations). Also assigns the stable step ids
// (assignStepIds) that firedSteps on instances refer to.
//
// Last modified: 2026-10-28

import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { appError } from "./errors";
import type { EscalationStep, EscalationStepInput } from "./validators";

/**
 * purpose: Give a list of steps their stable ids. A step keeps the id it was sent with only
 *          when that id belongs to the policy being edited (knownIds); every other step gets
 *          a new random id. Ids are generated here, never trusted from a client.
 * @param steps: (EscalationStepInput[]) Steps in order, each with an optional id.
 * @param knownIds: (ReadonlySet<string>) Ids of the policy's current steps; empty for a new policy.
 * @return: (EscalationStep[]) The steps with ids.
 * @raises invalid when the same known id is used by two steps.
 */
export function assignStepIds(
  steps: EscalationStepInput[],
  knownIds: ReadonlySet<string> = new Set(),
): EscalationStep[] {
  const used = new Set<string>();
  return steps.map(({ id, ...rest }) => {
    let stepId: string;
    if (id !== undefined && knownIds.has(id)) {
      if (used.has(id)) throw appError("invalid", "Step ids must be unique");
      stepId = id;
    } else {
      stepId = crypto.randomUUID();
    }
    used.add(stepId);
    return { id: stepId, ...rest };
  });
}

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
      { id: crypto.randomUUID(), offsetMinutes: 0, action: "prompt_senior", skipIfClaimed: false },
      { id: crypto.randomUUID(), offsetMinutes: 15, action: "prompt_senior", skipIfClaimed: false },
      { id: crypto.randomUUID(), offsetMinutes: 30, action: "alert_on_call", skipIfClaimed: false },
      {
        id: crypto.randomUUID(),
        offsetMinutes: 45,
        action: "alert_all_caregivers",
        skipIfClaimed: true,
      },
    ],
  });
  await ctx.db.insert("escalationPolicies", {
    householdId,
    name: "Prompt only",
    systemKey: "prompt_only",
    steps: [
      { id: crypto.randomUUID(), offsetMinutes: 0, action: "prompt_senior", skipIfClaimed: false },
    ],
  });
}
