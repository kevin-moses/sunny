// lib/schedule.ts
// Purpose: Task schedule mechanics shared by tasks.ts, instances.ts, scheduler.ts and
// households.ts, ported from the SQL scheduler migration: expanding tasks into daily
// instances in the household's local time (expand_task_instances), resyncing a task or a
// household after a schedule or timezone change, inserting, patching and deleting tasks with
// their audit rows, and changing an instance with its audit row (the Postgres triggers).
// Cascades the SQL foreign keys performed (instance deletes remove their notifications, task
// deletes remove instances and dose log rows) are done here explicitly. Deleting a task
// removes the task row at once and the rest in bounded batches (purgeTaskBatch), because a
// long-lived task has more rows than one mutation may touch. An anytime task (no times, not a
// medication; lib/anytime.ts) gets one instance per day it occurs, with the sentinel
// scheduledTime and a window from local midnight to the next local midnight, or two days
// later when the task does not occur the next day (then it carries over as Leftover). When a
// task turns anytime or timed, its open instances of the other kind for today and later are
// removed on resync. occursOn (the schedule rule) is exported for lib/upcomingTasks.ts, which
// projects it onto future days. A household timezone change keeps the still-open anytime
// instances (rows, notes and all) and moves their windows to the new zone's midnights, instead
// of deleting them (resyncHouseholdTimezone).
//
// Last modified: 2026-11-04

import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import type { Actor } from "./access";
import { anytimeWindow, ANYTIME, isAnytimeTask } from "./anytime";
import { audit } from "./audit";
import { addDays, isoWeekday, localDate, minutes, zonedInstant } from "./time";

/** A task row as written, without Convex system fields. */
export type TaskFields = Omit<Doc<"tasks">, "_id" | "_creationTime">;

/** Rows removed per purge batch (instances, or dose log rows). */
export const PURGE_BATCH_SIZE = 200;

/** Which tasks an expansion covers: one task, or every active task of one household. */
export type ExpandScope = { taskId: Id<"tasks"> } | { householdId: Id<"households"> };

/**
 * purpose: Whether a task's rule puts an occurrence on a local date.
 * @param task: (object) The task's startsOn, endsOn, onceOn and daysOfWeek.
 * @param date: (string) Local "YYYY-MM-DD".
 * @return: (boolean) True when the date is inside starts/ends and matches once-on or weekdays.
 */
export function occursOn(
  task: Pick<TaskFields, "startsOn" | "endsOn" | "onceOn" | "daysOfWeek">,
  date: string,
): boolean {
  if (task.startsOn !== undefined && date < task.startsOn) return false;
  if (task.endsOn !== undefined && date > task.endsOn) return false;
  if (task.onceOn !== undefined) return date === task.onceOn;
  return task.daysOfWeek === undefined || task.daysOfWeek.includes(isoWeekday(date));
}

/**
 * purpose: Create today's and tomorrow's (household-local) instances for one task. A window
 *          that already closed is only created if the schedule existed when it opened, so
 *          new or edited tasks never back-fill past windows as missed. Idempotent.
 * @param ctx: (MutationCtx) Mutation context.
 * @param task: (Doc<"tasks">) The task; inactive tasks create nothing.
 * @param timezone: (string) The household's IANA zone.
 * @param now: (number) Epoch ms.
 * @return: (Promise<number>) Instances created.
 */
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
      ? [{ time: ANYTIME, ...anytimeWindow(date, timezone, occursOn(task, addDays(date, 1))) }]
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

/**
 * purpose: Create instances for today and tomorrow for every active task in scope, in each
 *          household's local time so a daily 8:00 stays 8:00 across DST. Idempotent.
 * @param ctx: (MutationCtx) Mutation context.
 * @param now: (number) Epoch ms.
 * @param scope: (ExpandScope) One task, or one household's active tasks.
 * @return: (Promise<number>) Instances created.
 */
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

/**
 * purpose: Delete instances together with their notifications (the SQL cascade).
 * @param ctx: (MutationCtx) Mutation context.
 * @param instances: (Doc<"taskInstances">[]) Instances to delete.
 * @return: (Promise<void>)
 */
export async function deleteInstances(
  ctx: MutationCtx,
  instances: Doc<"taskInstances">[],
): Promise<void> {
  for (const instance of instances) {
    const notifications = await ctx.db
      .query("notificationOutbox")
      .withIndex("by_task_instance", (q) => q.eq("taskInstanceId", instance._id))
      .collect();
    for (const notification of notifications) await ctx.db.delete(notification._id);
    await ctx.db.delete(instance._id);
  }
}

/**
 * purpose: After a task is created or its schedule changes, bring its instances in line.
 *          Deactivating removes its upcoming, due and escalated instances so nothing keeps
 *          prompting; otherwise future upcoming instances are dropped and expanded again.
 * @param ctx: (MutationCtx) Mutation context.
 * @param task: (Doc<"tasks">) The task as it is now.
 * @param now: (number) Epoch ms.
 * @return: (Promise<void>)
 */
export async function resyncTask(ctx: MutationCtx, task: Doc<"tasks">, now: number): Promise<void> {
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
  await expandTasks(ctx, now, { taskId: task._id });
}

/**
 * purpose: When a task turned anytime or timed, remove its still-open (upcoming or due)
 *          instances of the other kind for today and later, so an old 08:00 row does not sit
 *          next to an Anytime row (or the reverse). Confirmed, resolved, missed and escalated
 *          instances are history and stay.
 * @param ctx: (MutationCtx) Mutation context.
 * @param task: (Doc<"tasks">) The task as it is now.
 * @param now: (number) Epoch ms.
 * @return: (Promise<void>)
 */
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
      open.filter((i) => i.localDate >= today && (i.scheduledTime === ANYTIME) !== anytime),
    );
  }
}

/** The actor recorded for state changes the household resync makes on its own. */
const SYSTEM_ACTOR: Actor = { kind: "system" };

/**
 * purpose: After a household timezone change, move the household's still-open anytime
 *          instances (upcoming or due) to the new zone. Their rows are kept so a caregiver note
 *          survives; only windowStart and windowEnd are recomputed (the same window rule as
 *          expansion, including whether the task repeats the next day). A due instance whose
 *          recomputed window has not opened yet goes back to upcoming (audited as a state
 *          change); one whose window has already ended keeps its state and the scheduler's
 *          closeWindows marks it missed on its next tick. A window-only patch writes no audit
 *          row, like expansion creating a row. Instances whose task is gone, inactive or no
 *          longer anytime are left alone. An open instance dated after the new tomorrow is
 *          deleted, as the upcoming-instance cleanup did before.
 * @param ctx: (MutationCtx) Mutation context.
 * @param householdId: (Id<"households">) Household whose timezone was already updated.
 * @param timezone: (string) The household's new IANA zone.
 * @param now: (number) Epoch ms.
 * @return: (Promise<void>)
 */
async function moveOpenAnytimeInstances(
  ctx: MutationCtx,
  householdId: Id<"households">,
  timezone: string,
  now: number,
): Promise<void> {
  const lastDate = addDays(localDate(now, timezone), 1);
  const tasks = new Map<Id<"tasks">, Doc<"tasks"> | null>();
  for (const state of ["upcoming", "due"] as const) {
    const open = await ctx.db
      .query("taskInstances")
      .withIndex("by_household_state", (q) => q.eq("householdId", householdId).eq("state", state))
      .collect();
    for (const instance of open) {
      if (instance.scheduledTime !== ANYTIME) continue;
      if (!tasks.has(instance.taskId)) {
        tasks.set(instance.taskId, await ctx.db.get(instance.taskId));
      }
      const task = tasks.get(instance.taskId);
      if (!task || !task.active || !isAnytimeTask(task)) continue;
      if (instance.localDate > lastDate) {
        await deleteInstances(ctx, [instance]);
        continue;
      }
      const window = anytimeWindow(
        instance.localDate,
        timezone,
        occursOn(task, addDays(instance.localDate, 1)),
      );
      const reopened = state === "due" && window.windowStart > now;
      await changeInstance(ctx, SYSTEM_ACTOR, instance, {
        ...window,
        ...(reopened ? { state: "upcoming" as const } : {}),
      });
    }
  }
}

/**
 * purpose: After a household timezone change every window moves. Open anytime instances are
 *          moved in place (moveOpenAnytimeInstances), then the household's other upcoming
 *          instances that have not opened (timed ones; anytime rows were already moved) are
 *          dropped and the tasks are expanded in the new zone. Expansion looks each
 *          (task, date, time) up in by_task_date_time, so it never duplicates a moved row.
 *          Timed instances that already opened keep their windows.
 * @param ctx: (MutationCtx) Mutation context.
 * @param householdId: (Id<"households">) Household whose timezone was already updated.
 * @param now: (number) Epoch ms.
 * @return: (Promise<void>)
 */
export async function resyncHouseholdTimezone(
  ctx: MutationCtx,
  householdId: Id<"households">,
  now: number,
): Promise<void> {
  const timezone = (await ctx.db.get(householdId))?.timezone;
  if (!timezone) return;
  await moveOpenAnytimeInstances(ctx, householdId, timezone, now);
  const future = await ctx.db
    .query("taskInstances")
    .withIndex("by_household_state", (q) =>
      q.eq("householdId", householdId).eq("state", "upcoming").gt("windowStart", now),
    )
    .collect();
  await deleteInstances(
    ctx,
    future.filter((i) => i.scheduledTime !== ANYTIME),
  );
  await expandTasks(ctx, now, { householdId });
}

/**
 * purpose: Whether any field that decides which instances exist differs between two versions
 *          of a task (times, weekdays, once-on, starts/ends, window, active).
 * @param before: (TaskFields) The task before the change.
 * @param after: (TaskFields) The task after the change.
 * @return: (boolean) True when the schedule changed.
 */
export function scheduleChanged(before: TaskFields, after: TaskFields): boolean {
  /**
   * purpose: A comparable string of the schedule-defining fields of a task.
   * @param t: (TaskFields) The task.
   * @return: (string) JSON of those fields.
   */
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

/**
 * purpose: Write the audit row for a task change.
 * @param ctx: (MutationCtx) Context.
 * @param actor: (Actor) Who changed it.
 * @param action: (string) "insert", "update" or "delete".
 * @param taskId: (Id<"tasks">) The task.
 * @param task: (TaskFields) The task after the change (before it, for a delete).
 * @return: (Promise<void>) Resolves when written.
 */
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

/**
 * purpose: Insert a task, audit it and expand its first instances.
 * @param ctx: (MutationCtx) Mutation context.
 * @param actor: (Actor) Who creates it.
 * @param fields: (Omit<TaskFields, "scheduleChangedAt">) The validated task.
 * @param now: (number) Epoch ms.
 * @return: (Promise<Id<"tasks">>) The new task.
 */
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
  return taskId;
}

/**
 * purpose: Patch a task, audit the update and, when the schedule changed, stamp
 *          scheduleChangedAt and resync its instances. A key set to undefined clears the field.
 * @param ctx: (MutationCtx) Mutation context.
 * @param actor: (Actor) Who changes it.
 * @param task: (Doc<"tasks">) The task before the change.
 * @param patch: (Partial<TaskFields>) Fields to change.
 * @param now: (number) Epoch ms.
 * @return: (Promise<Doc<"tasks">>) The task after the change.
 */
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
  if (changed) await resyncTask(ctx, updated, now);
  return updated;
}

/**
 * purpose: Hard delete a task: remove the task row and audit the deletion at once, and
 *          schedule the removal of its instances (with their notifications) and dose log rows
 *          in bounded batches (tasks.purgeTaskData). Until the purge finishes, orphaned
 *          instances exist; every reader skips instances whose task is gone.
 * @param ctx: (MutationCtx) Mutation context.
 * @param actor: (Actor) Who deletes it.
 * @param task: (Doc<"tasks">) The task.
 * @return: (Promise<void>)
 */
export async function deleteTask(
  ctx: MutationCtx,
  actor: Actor,
  task: Doc<"tasks">,
): Promise<void> {
  await ctx.db.delete(task._id);
  await auditTask(ctx, actor, "delete", task._id, task);
  await ctx.scheduler.runAfter(0, internal.tasks.purgeTaskData, {
    householdId: task.householdId,
    taskId: task._id,
  });
}

/**
 * purpose: Remove one bounded batch of a deleted task's leftovers: up to PURGE_BATCH_SIZE
 *          instances (with their notifications), then up to PURGE_BATCH_SIZE dose log rows.
 * @param ctx: (MutationCtx) Mutation context.
 * @param householdId: (Id<"households">) The task's household.
 * @param taskId: (Id<"tasks">) The deleted task.
 * @return: (Promise<boolean>) True when more remains and another batch must run.
 */
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

/**
 * purpose: Patch an instance and audit the change like the SQL trigger: a state change is
 *          "state_change", otherwise a claim change is "claim", otherwise a snooze change is
 *          "snooze", otherwise a resolutionNote change is "note" (detail { hasNote }). Fields
 *          whose value already matches are not written, and when nothing differs there is no
 *          write and no audit. A key set to undefined clears the field.
 * @param ctx: (MutationCtx) Mutation context.
 * @param actor: (Actor) Who made the change (the scheduler passes the system actor).
 * @param instance: (Doc<"taskInstances">) The instance before the change.
 * @param patch: (Partial<Doc<"taskInstances">>) Fields to change.
 * @param extraDetail: (Record<string, unknown>, optional) Keys merged into the audit detail of a
 *        state, claim or snooze change (for example { undo: true }); other callers omit it.
 * @return: (Promise<Doc<"taskInstances">>) The instance after the change.
 */
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
  let action: "state_change" | "claim" | "snooze" | "note";
  let detail: Record<string, unknown>;
  if (after.state !== instance.state) action = "state_change";
  else if (after.claimedBy !== instance.claimedBy) action = "claim";
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
