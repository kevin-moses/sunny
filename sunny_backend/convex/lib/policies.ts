import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { appError } from "./errors";
import type { EscalationStep, EscalationStepInput } from "./validators";

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
      {
        id: crypto.randomUUID(),
        offsetMinutes: 30,
        action: "alert_all_caregivers",
        skipIfClaimed: false,
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
