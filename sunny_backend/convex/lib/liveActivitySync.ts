import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { insertNotification } from "./delivery";
import { seniorPromptWords } from "./deviceWording";
import { isDueEntry } from "./dueTask";
import { findPhonePush } from "./liveActivity";

export async function proofMissed(
  ctx: MutationCtx,
  activityId: Id<"liveActivities">,
  now: number,
): Promise<void> {
  const row = await ctx.db.get(activityId);
  if (row === null || row.phase.kind !== "started" || row.phase.proof !== "awaited") return;
  await ctx.db.patch(row._id, { phase: { ...row.phase, proof: "missed" } });
  const push = await findPhonePush(ctx, row.deviceId);
  if (push !== null) await ctx.db.patch(push._id, { blindSince: now });
  const instance = await ctx.db.get(row.taskInstanceId);
  const task = instance === null ? null : await ctx.db.get(instance.taskId);
  if (instance === null || task === null || !isDueEntry(instance)) return;
  await insertNotification(ctx, {
    householdId: row.householdId,
    kind: "senior_prompt",
    taskInstanceId: instance._id,
    recipientDeviceId: row.deviceId,
    ...seniorPromptWords(task, instance),
    payload: { taskId: task._id, localDate: instance.localDate, unprovenActivity: row._id },
  });
}
