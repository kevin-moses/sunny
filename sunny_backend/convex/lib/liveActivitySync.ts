import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { seniorPhones } from "./access";
import type { Actor } from "./access";
import { ACTIVITY_LIFETIME_MS } from "./apnsPayload";
import { isDoneState } from "./confirmRule";
import { deliveryPool, insertNotification } from "./delivery";
import { seniorPromptWords } from "./deviceWording";
import { isDueEntry } from "./dueTask";
import {
  activitiesOfInstance,
  canShowAgain,
  endActivity,
  findPhonePush,
  loadActivityView,
  loadSubject,
  nextCommand,
  openActivitiesOf,
} from "./liveActivity";
import { taskCards, timelineTask } from "./phoneTimeline";
import { DAY_MS } from "./time";
import type { ActivitySubject, ActivityView } from "./liveActivity";
import type { ActivityEndReason, ConfirmVia } from "./validators";
import { phonePressedOn, requestWidgetRefresh, wakePhoneToReport } from "./widgetRefresh";

export const ENDED_KEPT_MS = 7 * DAY_MS;

const PURGE_BATCH = 50;

async function queueActivityPush(
  ctx: MutationCtx,
  activityId: Id<"liveActivities">,
): Promise<void> {
  await deliveryPool.enqueueAction(ctx, internal.liveActivity.push, { activityId });
}

const ENDS_THE_PHONE_CANNOT_PREDICT: ReadonlySet<ActivityEndReason> = new Set([
  "confirmed",
  "instance_gone",
]);

const VIAS_THAT_CHANGE_THE_ACTIVITY_ON_THE_PHONE: ReadonlySet<ConfirmVia> = new Set([
  "live_activity",
  "phone_app",
]);

function changedOnPhone(actor: Actor, after: Doc<"taskInstances">): Id<"devices"> | null {
  const via = after.confirmedVia;
  if (via === undefined || !VIAS_THAT_CHANGE_THE_ACTIVITY_ON_THE_PHONE.has(via)) return null;
  return phonePressedOn(actor);
}

type SyncRule =
  | { kind: "by_view"; changedOn: Id<"devices"> | null; startingEndsAs: ActivityEndReason | null }
  | { kind: "end_as"; reason: ActivityEndReason };

const BY_VIEW: SyncRule = { kind: "by_view", changedOn: null, startingEndsAs: null };

export async function syncActivity(
  ctx: MutationCtx,
  row: Doc<"liveActivities">,
  now: number,
  rule: SyncRule = BY_VIEW,
  known: ActivityView | null = null,
): Promise<void> {
  const { phase } = row;
  if (phase.kind === "ended") return;
  if (phase.kind === "live") {
    await queueActivityPush(ctx, row._id);
    return;
  }
  if (rule.kind === "end_as") {
    await endActivity(ctx, row, rule.reason, now);
    return;
  }
  if (phase.kind === "starting") {
    if (rule.startingEndsAs !== null) await endActivity(ctx, row, rule.startingEndsAs, now);
    return;
  }
  if (phase.proof === "awaited") return;
  const view = known ?? (await loadActivityView(ctx, row, now));
  if (view.kind !== "end") return;
  await endActivity(ctx, row, view.reason, now, view.content);
  if (ENDS_THE_PHONE_CANNOT_PREDICT.has(view.reason) && row.deviceId !== rule.changedOn) {
    await wakePhoneToReport(ctx, row.deviceId, now);
  }
}

async function syncInstanceActivities(
  ctx: MutationCtx,
  instanceId: Id<"taskInstances">,
  now: number,
  rule: SyncRule,
): Promise<void> {
  for (const row of await activitiesOfInstance(ctx, instanceId)) {
    await syncActivity(ctx, row, now, rule);
  }
}

function wasPrompted(instance: Pick<Doc<"taskInstances">, "firedSteps">): boolean {
  return instance.firedSteps.some((step) => step.action === "prompt_senior");
}

async function queueSeniorCue(
  ctx: MutationCtx,
  kind: "senior_prompt" | "senior_reshow",
  { instance, task }: ActivitySubject,
  deviceId: Id<"devices">,
  payload: Record<string, unknown> = {},
): Promise<void> {
  await insertNotification(ctx, {
    householdId: instance.householdId,
    kind,
    taskInstanceId: instance._id,
    recipientDeviceId: deviceId,
    ...seniorPromptWords(task, instance),
    payload: { taskId: task._id, localDate: instance.localDate, ...payload },
  });
}

async function queueReshow(
  ctx: MutationCtx,
  instance: Doc<"taskInstances">,
  device: Doc<"devices">,
): Promise<void> {
  const task = await ctx.db.get(instance.taskId);
  if (task === null || !(await canShowAgain(ctx, instance._id, device, Date.now()))) return;
  await queueSeniorCue(ctx, "senior_reshow", { instance, task }, device._id);
}

export async function reshowIfDue(
  ctx: MutationCtx,
  instanceId: Id<"taskInstances">,
  deviceId: Id<"devices">,
): Promise<void> {
  const instance = await ctx.db.get(instanceId);
  const device = await ctx.db.get(deviceId);
  if (instance === null || device === null) return;
  if (!isDueEntry(instance) || !wasPrompted(instance)) return;
  await queueReshow(ctx, instance, device);
}

export async function instanceChanged(
  ctx: MutationCtx,
  actor: Actor,
  before: Doc<"taskInstances">,
  after: Doc<"taskInstances">,
): Promise<void> {
  if (actor.kind === "system") return;
  if (before.state === after.state && (before.currentStep ?? 0) === (after.currentStep ?? 0)) {
    return;
  }
  await requestWidgetRefresh(ctx, actor, after.householdId);
  await syncInstanceActivities(ctx, after._id, Date.now(), {
    kind: "by_view",
    changedOn: changedOnPhone(actor, after),
    startingEndsAs: null,
  });
  if (isDoneState(before.state) && isDueEntry(after) && wasPrompted(after)) {
    for (const phone of await seniorPhones(ctx, after.householdId)) {
      await queueReshow(ctx, after, phone);
    }
  }
}

export async function instanceGone(
  ctx: MutationCtx,
  instance: Doc<"taskInstances">,
): Promise<void> {
  await syncInstanceActivities(ctx, instance._id, Date.now(), {
    kind: "by_view",
    changedOn: null,
    startingEndsAs: "instance_gone",
  });
}

function shownCards(instance: Doc<"taskInstances">, task: Doc<"tasks">, now: number): string {
  return JSON.stringify(taskCards(timelineTask(instance, task, now)));
}

export async function taskTextChanged(
  ctx: MutationCtx,
  before: Doc<"tasks">,
  after: Doc<"tasks">,
): Promise<void> {
  const now = Date.now();
  for (const state of ["due", "escalated"] as const) {
    const instances = await ctx.db
      .query("taskInstances")
      .withIndex("by_task_state", (q) => q.eq("taskId", after._id).eq("state", state))
      .collect();
    for (const instance of instances) {
      if (shownCards(instance, before, now) === shownCards(instance, after, now)) continue;
      await syncInstanceActivities(ctx, instance._id, now, BY_VIEW);
    }
  }
}

export async function phoneRevoked(ctx: MutationCtx, deviceId: Id<"devices">): Promise<void> {
  const push = await findPhonePush(ctx, deviceId);
  if (push !== null) await ctx.db.delete(push._id);
  const now = Date.now();
  for (const row of await openActivitiesOf(ctx, deviceId)) {
    await syncActivity(ctx, row, now, { kind: "end_as", reason: "device_revoked" });
  }
}

export async function proofMissed(
  ctx: MutationCtx,
  activityId: Id<"liveActivities">,
  now: number,
): Promise<void> {
  const row = await ctx.db.get(activityId);
  if (row === null || row.phase.kind !== "started" || row.phase.proof !== "awaited") return;
  const missed = { ...row, phase: { ...row.phase, proof: "missed" as const } };
  await ctx.db.patch(row._id, { phase: missed.phase });
  const push = await findPhonePush(ctx, row.deviceId);
  if (push !== null) await ctx.db.patch(push._id, { blindSince: now });
  await syncActivity(ctx, missed, now);
  if (row.quiet) return;
  const subject = await loadSubject(ctx, row.taskInstanceId);
  if (subject === null || !isDueEntry(subject.instance)) return;
  await queueSeniorCue(ctx, "senior_prompt", subject, row.deviceId, {
    unprovenActivity: row._id,
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
): Promise<void> {
  for (const row of await activitiesInPhase(ctx, householdId, "starting")) {
    if (row.phase.kind !== "starting") continue;
    const cue = await ctx.db.get(row.phase.outboxId);
    if (cue !== null && cue.state === "pending") continue;
    await endActivity(ctx, row, "start_failed", now);
  }
}

async function sweepStarted(
  ctx: MutationCtx,
  householdId: Id<"households">,
  now: number,
): Promise<void> {
  for (const row of await activitiesInPhase(ctx, householdId, "started")) {
    await syncActivity(ctx, row, now);
  }
}

async function sweepLive(
  ctx: MutationCtx,
  householdId: Id<"households">,
  now: number,
): Promise<void> {
  for (const row of await activitiesInPhase(ctx, householdId, "live")) {
    if (row.phase.kind !== "live") continue;
    const view = await loadActivityView(ctx, row, now);
    if (now >= row.phase.acceptedAt + ACTIVITY_LIFETIME_MS) {
      await endActivity(ctx, row, view.kind === "end" ? view.reason : "expired", now);
    } else if (nextCommand(row, view).kind !== "none") {
      await queueActivityPush(ctx, row._id);
    }
  }
}

async function purgeEnded(
  ctx: MutationCtx,
  householdId: Id<"households">,
  now: number,
): Promise<void> {
  const oldest = await ctx.db
    .query("liveActivities")
    .withIndex("by_household_phase", (q) =>
      q.eq("householdId", householdId).eq("phase.kind", "ended"),
    )
    .take(PURGE_BATCH);
  for (const row of oldest) {
    if (row.phase.kind !== "ended" || now - row.phase.at < ENDED_KEPT_MS) continue;
    await ctx.db.delete(row._id);
  }
}

export async function sweepLiveActivities(
  ctx: MutationCtx,
  householdId: Id<"households">,
  now: number,
): Promise<void> {
  await sweepStarting(ctx, householdId, now);
  await sweepStarted(ctx, householdId, now);
  await sweepLive(ctx, householdId, now);
  await purgeEnded(ctx, householdId, now);
}
