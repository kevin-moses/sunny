import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import type { Actor } from "./access";
import { ACTIVITY_LIFETIME_MS } from "./apnsPayload";
import { isDoneState } from "./confirmRule";
import { deliveryPool, insertNotification } from "./delivery";
import { seniorPromptWords } from "./deviceWording";
import { isDueEntry } from "./dueTask";
import {
  ACTIVITY_CAP_MS,
  endActivity,
  findPhonePush,
  loadActivityView,
  nextCommand,
} from "./liveActivity";
import { DAY_MS } from "./time";
import { requestWidgetRefresh } from "./widgetRefresh";

export const ENDED_KEPT_MS = 7 * DAY_MS;

const PURGE_BATCH = 50;

export async function queueActivityPush(
  ctx: MutationCtx,
  activityId: Id<"liveActivities">,
): Promise<void> {
  await deliveryPool.enqueueAction(ctx, internal.liveActivity.push, { activityId });
}

async function activitiesOfInstance(
  ctx: QueryCtx,
  instanceId: Id<"taskInstances">,
): Promise<Doc<"liveActivities">[]> {
  return await ctx.db
    .query("liveActivities")
    .withIndex("by_instance", (q) => q.eq("taskInstanceId", instanceId))
    .collect();
}

async function pushLiveActivities(
  ctx: MutationCtx,
  instanceId: Id<"taskInstances">,
): Promise<void> {
  for (const row of await activitiesOfInstance(ctx, instanceId)) {
    if (row.phase.kind === "live") await queueActivityPush(ctx, row._id);
  }
}

function wasPrompted(instance: Pick<Doc<"taskInstances">, "firedSteps">): boolean {
  return instance.firedSteps.some((step) => step.action === "prompt_senior");
}

async function queueReshow(
  ctx: MutationCtx,
  instance: Doc<"taskInstances">,
  deviceId: Id<"devices">,
): Promise<void> {
  const task = await ctx.db.get(instance.taskId);
  if (task === null) return;
  await insertNotification(ctx, {
    householdId: instance.householdId,
    kind: "senior_reshow",
    taskInstanceId: instance._id,
    recipientDeviceId: deviceId,
    ...seniorPromptWords(task, instance),
    payload: { taskId: task._id, localDate: instance.localDate },
  });
}

export async function reshowIfDue(
  ctx: MutationCtx,
  instanceId: Id<"taskInstances">,
  deviceId: Id<"devices">,
): Promise<void> {
  const instance = await ctx.db.get(instanceId);
  if (instance === null || !isDueEntry(instance) || !wasPrompted(instance)) return;
  await queueReshow(ctx, instance, deviceId);
}

async function seniorPhones(
  ctx: QueryCtx,
  householdId: Id<"households">,
): Promise<Doc<"devices">[]> {
  const devices = await ctx.db
    .query("devices")
    .withIndex("by_household", (q) => q.eq("householdId", householdId))
    .collect();
  return devices.filter((device) => device.kind === "senior_phone");
}

function stepOf(instance: Pick<Doc<"taskInstances">, "currentStep">): number {
  return instance.currentStep ?? 0;
}

export async function instanceChanged(
  ctx: MutationCtx,
  actor: Actor,
  before: Doc<"taskInstances">,
  after: Doc<"taskInstances">,
): Promise<void> {
  if (actor.kind === "system") return;
  if (before.state === after.state && stepOf(before) === stepOf(after)) return;
  await requestWidgetRefresh(ctx, actor, after.householdId);
  await pushLiveActivities(ctx, after._id);
  if (isDoneState(before.state) && isDueEntry(after) && wasPrompted(after)) {
    for (const phone of await seniorPhones(ctx, after.householdId)) {
      await queueReshow(ctx, after, phone._id);
    }
  }
}

export async function instanceGone(
  ctx: MutationCtx,
  instance: Doc<"taskInstances">,
): Promise<void> {
  const now = Date.now();
  for (const row of await activitiesOfInstance(ctx, instance._id)) {
    if (row.phase.kind === "live") await queueActivityPush(ctx, row._id);
    if (row.phase.kind === "starting") await endActivity(ctx, row, "instance_gone", now);
  }
}

function shownText(task: Doc<"tasks">): string {
  return JSON.stringify([
    task.displayLabel,
    task.screenSentence ?? null,
    task.pillDescription ?? null,
    task.checklistItems,
  ]);
}

export async function taskTextChanged(
  ctx: MutationCtx,
  before: Doc<"tasks">,
  after: Doc<"tasks">,
): Promise<void> {
  if (shownText(before) === shownText(after)) return;
  for (const state of ["due", "escalated"] as const) {
    const instances = await ctx.db
      .query("taskInstances")
      .withIndex("by_task_state", (q) => q.eq("taskId", after._id).eq("state", state))
      .collect();
    for (const instance of instances) await pushLiveActivities(ctx, instance._id);
  }
}

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

async function activitiesInPhase(
  ctx: QueryCtx,
  householdId: Id<"households">,
  kind: Doc<"liveActivities">["phase"]["kind"],
): Promise<Doc<"liveActivities">[]> {
  return await ctx.db
    .query("liveActivities")
    .withIndex("by_household_phase", (q) => q.eq("householdId", householdId).eq("phase.kind", kind))
    .collect();
}

async function sweepStarting(
  ctx: MutationCtx,
  householdId: Id<"households">,
  now: number,
): Promise<number> {
  let swept = 0;
  for (const row of await activitiesInPhase(ctx, householdId, "starting")) {
    if (row.phase.kind !== "starting") continue;
    const cue = await ctx.db.get(row.phase.outboxId);
    if (cue !== null && cue.state === "pending") continue;
    await endActivity(ctx, row, "start_failed", now);
    swept += 1;
  }
  return swept;
}

async function sweepStarted(
  ctx: MutationCtx,
  householdId: Id<"households">,
  now: number,
): Promise<number> {
  let swept = 0;
  for (const row of await activitiesInPhase(ctx, householdId, "started")) {
    if (row.phase.kind !== "started") continue;
    if (now < Math.min(row.windowEnd, row.phase.acceptedAt + ACTIVITY_CAP_MS)) continue;
    await endActivity(ctx, row, "unreachable", now);
    swept += 1;
  }
  return swept;
}

async function sweepLive(
  ctx: MutationCtx,
  householdId: Id<"households">,
  now: number,
): Promise<number> {
  let swept = 0;
  for (const row of await activitiesInPhase(ctx, householdId, "live")) {
    if (row.phase.kind !== "live") continue;
    const view = await loadActivityView(ctx, row, now);
    if (now >= row.phase.acceptedAt + ACTIVITY_LIFETIME_MS) {
      await endActivity(ctx, row, view.kind === "end" ? view.reason : "expired", now);
      swept += 1;
      continue;
    }
    if (nextCommand(row, view).kind === "none") continue;
    await queueActivityPush(ctx, row._id);
    swept += 1;
  }
  return swept;
}

async function purgeEnded(
  ctx: MutationCtx,
  householdId: Id<"households">,
  now: number,
): Promise<number> {
  const oldest = await ctx.db
    .query("liveActivities")
    .withIndex("by_household_phase", (q) =>
      q.eq("householdId", householdId).eq("phase.kind", "ended"),
    )
    .take(PURGE_BATCH);
  let purged = 0;
  for (const row of oldest) {
    if (row.phase.kind !== "ended" || now - row.phase.at < ENDED_KEPT_MS) continue;
    await ctx.db.delete(row._id);
    purged += 1;
  }
  return purged;
}

export async function sweepLiveActivities(
  ctx: MutationCtx,
  householdId: Id<"households">,
  now: number,
): Promise<number> {
  return (
    (await sweepStarting(ctx, householdId, now)) +
    (await sweepStarted(ctx, householdId, now)) +
    (await sweepLive(ctx, householdId, now)) +
    (await purgeEnded(ctx, householdId, now))
  );
}
