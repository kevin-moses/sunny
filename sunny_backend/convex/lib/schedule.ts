import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import type { Actor } from "./access";
import { anytimeWindow, ANYTIME, isAnytimeInstance, isAnytimeTask } from "./anytime";
import { audit } from "./audit";
import { isDoneState, withTakenBackPressIds } from "./confirmRule";
import { instanceChanged, instanceGone, taskTextChanged } from "./liveActivitySync";
import { hasStepProgress, stepPressIds } from "./taskSteps";
import { requestWidgetRefresh } from "./widgetRefresh";
import { shownOn } from "./today";
import { addDays, isoWeekday, localDate, minutes, zonedInstant } from "./time";

export type TaskFields = Omit<Doc<"tasks">, "_id" | "_creationTime">;

export const PURGE_BATCH_SIZE = 200;

export type ExpandScope = { taskId: Id<"tasks"> } | { householdId: Id<"households"> };

export function occursOn(
  task: Pick<TaskFields, "startsOn" | "endsOn" | "onceOn" | "daysOfWeek">,
  date: string,
): boolean {
  if (task.startsOn !== undefined && date < task.startsOn) return false;
  if (task.endsOn !== undefined && date > task.endsOn) return false;
  if (task.onceOn !== undefined) return date === task.onceOn;
  return task.daysOfWeek === undefined || task.daysOfWeek.includes(isoWeekday(date));
}

function anytimeWindowFor(
  task: Pick<TaskFields, "startsOn" | "endsOn" | "onceOn" | "daysOfWeek">,
  date: string,
  timezone: string,
): { windowStart: number; windowEnd: number } {
  return anytimeWindow(date, timezone, occursOn(task, addDays(date, 1)));
}

async function expandOneTask(
  ctx: MutationCtx,
  task: Doc<"tasks">,
  timezone: string,
  now: number,
): Promise<number> {
  if (!task.active) return 0;
  const today = localDate(now, timezone);
  let created = 0;
  for (const date of [today, addDays(today, 1)]) {
    if (!occursOn(task, date)) continue;
    const slots = isAnytimeTask(task)
      ? [{ time: ANYTIME, ...anytimeWindowFor(task, date, timezone) }]
      : task.times.map((time) => {
          const windowStart = zonedInstant(date, time, timezone);
          return { time, windowStart, windowEnd: windowStart + minutes(task.windowMinutes) };
        });
    for (const { time, windowStart, windowEnd } of slots) {
      if (windowEnd <= now && windowStart < task.scheduleChangedAt) continue;
      const existing = await ctx.db
        .query("taskInstances")
        .withIndex("by_task_date_time", (q) =>
          q.eq("taskId", task._id).eq("localDate", date).eq("scheduledTime", time),
        )
        .first();
      if (existing) continue;
      await ctx.db.insert("taskInstances", {
        taskId: task._id,
        householdId: task.householdId,
        localDate: date,
        scheduledTime: time,
        windowStart,
        windowEnd,
        state: "upcoming",
        createdAt: now,
        firedSteps: [],
      });
      created += 1;
    }
  }
  return created;
}

export async function expandTasks(
  ctx: MutationCtx,
  now: number,
  scope: ExpandScope,
): Promise<number> {
  let tasks: Doc<"tasks">[];
  if ("taskId" in scope) {
    const task = await ctx.db.get(scope.taskId);
    tasks = task ? [task] : [];
  } else {
    const householdId = scope.householdId;
    tasks = await ctx.db
      .query("tasks")
      .withIndex("by_household_active", (q) => q.eq("householdId", householdId).eq("active", true))
      .collect();
  }
  const zones = new Map<Id<"households">, string | null>();
  let created = 0;
  for (const task of tasks) {
    if (!zones.has(task.householdId)) {
      zones.set(task.householdId, (await ctx.db.get(task.householdId))?.timezone ?? null);
    }
    const timezone = zones.get(task.householdId);
    if (timezone) created += await expandOneTask(ctx, task, timezone, now);
  }
  return created;
}

export async function deleteInstances(
  ctx: MutationCtx,
  instances: Doc<"taskInstances">[],
): Promise<void> {
  const now = Date.now();
  for (const instance of instances) {
    const notifications = await ctx.db
      .query("notificationOutbox")
      .withIndex("by_task_instance", (q) => q.eq("taskInstanceId", instance._id))
      .collect();
    for (const notification of notifications) await ctx.db.delete(notification._id);
    await ctx.db.delete(instance._id);
    if (instance.windowStart <= now) await instanceGone(ctx, instance);
  }
}

export async function resyncTask(
  ctx: MutationCtx,
  actor: Actor,
  task: Doc<"tasks">,
  now: number,
): Promise<void> {
  if (!task.active) {
    for (const state of ["upcoming", "due", "escalated"] as const) {
      const open = await ctx.db
        .query("taskInstances")
        .withIndex("by_task_state", (q) => q.eq("taskId", task._id).eq("state", state))
        .collect();
      await deleteInstances(ctx, open);
    }
    return;
  }
  await deleteMismatchedOpenInstances(ctx, task, now);
  const future = await ctx.db
    .query("taskInstances")
    .withIndex("by_task_state", (q) =>
      q.eq("taskId", task._id).eq("state", "upcoming").gt("windowStart", now),
    )
    .collect();
  await deleteInstances(ctx, future);
  await refreshOpenAnytimeWindows(ctx, actor, task, now);
  await expandTasks(ctx, now, { taskId: task._id });
}

async function refreshOpenAnytimeWindows(
  ctx: MutationCtx,
  actor: Actor,
  task: Doc<"tasks">,
  now: number,
): Promise<void> {
  if (!isAnytimeTask(task)) return;
  const timezone = (await ctx.db.get(task.householdId))?.timezone;
  if (!timezone) return;
  const today = localDate(now, timezone);
  for (const state of ["upcoming", "due"] as const) {
    const open = await ctx.db
      .query("taskInstances")
      .withIndex("by_task_state", (q) => q.eq("taskId", task._id).eq("state", state))
      .collect();
    for (const instance of open) {
      if (isAnytimeInstance(instance) && instance.localDate >= today) {
        await refreshAnytimeWindow(ctx, actor, task, instance, timezone, now);
      }
    }
  }
}

async function deleteMismatchedOpenInstances(
  ctx: MutationCtx,
  task: Doc<"tasks">,
  now: number,
): Promise<void> {
  const timezone = (await ctx.db.get(task.householdId))?.timezone;
  if (!timezone) return;
  const today = localDate(now, timezone);
  const anytime = isAnytimeTask(task);
  for (const state of ["upcoming", "due"] as const) {
    const open = await ctx.db
      .query("taskInstances")
      .withIndex("by_task_state", (q) => q.eq("taskId", task._id).eq("state", state))
      .collect();
    await deleteInstances(
      ctx,
      open.filter((i) => i.localDate >= today && isAnytimeInstance(i) !== anytime),
    );
  }
}

async function refreshAnytimeWindow(
  ctx: MutationCtx,
  actor: Actor,
  task: Doc<"tasks">,
  instance: Doc<"taskInstances">,
  timezone: string,
  now: number,
): Promise<void> {
  const window = anytimeWindowFor(task, instance.localDate, timezone);
  const reopened = instance.state === "due" && window.windowStart > now;
  await changeInstance(ctx, actor, instance, {
    ...window,
    ...(reopened ? { state: "upcoming" as const } : {}),
  });
}

function sameItems(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((item, i) => item === b[i]);
}

async function restartStepsShownToday(
  ctx: MutationCtx,
  actor: Actor,
  task: Doc<"tasks">,
  now: number,
): Promise<void> {
  const timezone = (await ctx.db.get(task.householdId))?.timezone;
  if (!timezone) return;
  const today = localDate(now, timezone);
  const recent = await ctx.db
    .query("taskInstances")
    .withIndex("by_task_date_time", (q) =>
      q.eq("taskId", task._id).gte("localDate", addDays(today, -1)).lte("localDate", today),
    )
    .collect();
  for (const instance of recent) {
    if (isDoneState(instance.state) || !shownOn(instance, today) || !hasStepProgress(instance)) {
      continue;
    }
    const pressIds = stepPressIds(instance);
    await changeInstance(
      ctx,
      actor,
      instance,
      {
        currentStep: 0,
        stepPresses: undefined,
        takenBackPressIds: withTakenBackPressIds(instance.takenBackPressIds, pressIds),
      },
      { restart: true, reason: "steps_changed", takenBackPressIds: pressIds },
    );
  }
}

export async function resyncHouseholdTimezone(
  ctx: MutationCtx,
  actor: Actor,
  householdId: Id<"households">,
  timezone: string,
  now: number,
): Promise<void> {
  await ctx.db.patch(householdId, { timezone });
  const lastDate = addDays(localDate(now, timezone), 1);
  const open = (
    await Promise.all(
      (["upcoming", "due"] as const).map((state) =>
        ctx.db
          .query("taskInstances")
          .withIndex("by_household_state", (q) =>
            q.eq("householdId", householdId).eq("state", state),
          )
          .collect(),
      ),
    )
  ).flat();
  const doomed = open.filter(
    (i) =>
      i.state === "upcoming" &&
      i.windowStart > now &&
      (!isAnytimeInstance(i) || i.localDate > lastDate),
  );
  const doomedIds = new Set(doomed.map((i) => i._id));
  const refreshable = open.filter((i) => isAnytimeInstance(i) && !doomedIds.has(i._id));
  const tasks = new Map<Id<"tasks">, Doc<"tasks"> | null>();
  for (const instance of refreshable) {
    if (!tasks.has(instance.taskId)) tasks.set(instance.taskId, await ctx.db.get(instance.taskId));
    const task = tasks.get(instance.taskId);
    if (task && task.active && isAnytimeTask(task)) {
      await refreshAnytimeWindow(ctx, actor, task, instance, timezone, now);
    }
  }
  await deleteInstances(ctx, doomed);
  await expandTasks(ctx, now, { householdId });
  await requestWidgetRefresh(ctx, actor, householdId);
}

export function scheduleChanged(before: TaskFields, after: TaskFields): boolean {
  const key = (t: TaskFields): string =>
    JSON.stringify([
      t.times,
      isAnytimeTask(t),
      t.daysOfWeek ?? null,
      t.onceOn ?? null,
      t.startsOn ?? null,
      t.endsOn ?? null,
      t.windowMinutes,
      t.active,
    ]);
  return key(before) !== key(after);
}

async function auditTask(
  ctx: MutationCtx,
  actor: Actor,
  action: string,
  taskId: Id<"tasks">,
  task: TaskFields,
): Promise<void> {
  await audit(ctx, {
    householdId: task.householdId,
    actor,
    action,
    entity: "task",
    entityId: taskId,
    detail: { displayLabel: task.displayLabel, createdByKind: task.createdByKind },
  });
}

export async function insertTask(
  ctx: MutationCtx,
  actor: Actor,
  fields: Omit<TaskFields, "scheduleChangedAt">,
  now: number,
): Promise<Id<"tasks">> {
  const row: TaskFields = { ...fields, scheduleChangedAt: now };
  const taskId = await ctx.db.insert("tasks", row);
  await auditTask(ctx, actor, "insert", taskId, row);
  await expandTasks(ctx, now, { taskId });
  await requestWidgetRefresh(ctx, actor, row.householdId);
  return taskId;
}

export async function patchTask(
  ctx: MutationCtx,
  actor: Actor,
  task: Doc<"tasks">,
  patch: Partial<TaskFields>,
  now: number,
): Promise<Doc<"tasks">> {
  const changed = scheduleChanged(task, { ...task, ...patch });
  await ctx.db.patch(task._id, changed ? { ...patch, scheduleChangedAt: now } : patch);
  const updated = (await ctx.db.get(task._id))!;
  await auditTask(ctx, actor, "update", updated._id, updated);
  await taskTextChanged(ctx, task, updated);
  if (changed) await resyncTask(ctx, actor, updated, now);
  if (!sameItems(task.checklistItems, updated.checklistItems)) {
    await restartStepsShownToday(ctx, actor, updated, now);
  }
  await requestWidgetRefresh(ctx, actor, updated.householdId);
  return updated;
}

export async function deleteTask(
  ctx: MutationCtx,
  actor: Actor,
  task: Doc<"tasks">,
): Promise<void> {
  await ctx.db.delete(task._id);
  await auditTask(ctx, actor, "delete", task._id, task);
  await requestWidgetRefresh(ctx, actor, task.householdId);
  await ctx.scheduler.runAfter(0, internal.tasks.purgeTaskData, {
    householdId: task.householdId,
    taskId: task._id,
  });
}

export async function purgeTaskBatch(
  ctx: MutationCtx,
  householdId: Id<"households">,
  taskId: Id<"tasks">,
): Promise<boolean> {
  const instances = await ctx.db
    .query("taskInstances")
    .withIndex("by_task_date_time", (q) => q.eq("taskId", taskId))
    .take(PURGE_BATCH_SIZE);
  await deleteInstances(ctx, instances);
  if (instances.length === PURGE_BATCH_SIZE) return true;
  const doses = await ctx.db
    .query("doseLog")
    .withIndex("by_household_task_taken", (q) =>
      q.eq("householdId", householdId).eq("taskId", taskId),
    )
    .take(PURGE_BATCH_SIZE);
  for (const dose of doses) await ctx.db.delete(dose._id);
  return doses.length === PURGE_BATCH_SIZE;
}

export async function changeInstance(
  ctx: MutationCtx,
  actor: Actor,
  instance: Doc<"taskInstances">,
  patch: Partial<Omit<Doc<"taskInstances">, "_id" | "_creationTime">>,
  extraDetail?: Record<string, unknown>,
): Promise<Doc<"taskInstances">> {
  const changed = Object.entries(patch).filter(
    ([key, value]) => instance[key as keyof typeof instance] !== value,
  );
  if (changed.length === 0) return instance;
  await ctx.db.patch(instance._id, Object.fromEntries(changed));
  const after = (await ctx.db.get(instance._id))!;
  await instanceChanged(ctx, actor, instance, after);
  let action: "state_change" | "claim" | "snooze" | "note" | "step";
  let detail: Record<string, unknown>;
  if (after.state !== instance.state) action = "state_change";
  else if (after.claimedBy !== instance.claimedBy) action = "claim";
  else if (after.currentStep !== instance.currentStep) action = "step";
  else if (after.snoozedUntil !== instance.snoozedUntil) action = "snooze";
  else if (after.resolutionNote !== instance.resolutionNote) action = "note";
  else return after;
  if (action === "note") {
    detail = { hasNote: after.resolutionNote !== undefined };
  } else {
    detail = { from: instance.state, to: after.state };
    if (after.confirmedVia !== undefined) detail["via"] = after.confirmedVia;
    if (after.claimedBy !== undefined) detail["claimedBy"] = after.claimedBy;
    if (after.snoozedUntil !== undefined) detail["snoozedUntil"] = after.snoozedUntil;
    if (after.currentStep !== instance.currentStep) {
      detail["fromStep"] = instance.currentStep ?? 0;
      detail["toStep"] = after.currentStep ?? 0;
    }
    if (extraDetail !== undefined) Object.assign(detail, extraDetail);
  }
  await audit(ctx, {
    householdId: after.householdId,
    actor,
    action,
    entity: "task_instance",
    entityId: after._id,
    detail,
  });
  return after;
}
