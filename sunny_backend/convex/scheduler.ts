// scheduler.ts
// Purpose: The scheduler, ported from scheduler_tick and expand_task_instances in the SQL
// scheduler migration. tick runs once a minute (crons.ts) and: expands today's and tomorrow's
// instances, opens windows (upcoming to due), fires each due escalation step exactly once
// (recorded on the instance's firedSteps) and queues the notifications in the outbox, marks
// instances with a fired caregiver alert as escalated, and closes windows to missed. Offsets
// count from the later of window start and creation; senior prompts wait while snoozed;
// skipIfClaimed steps are skipped once claimed; inactive tasks never fire; and when several
// steps of one kind (prompt, or caregiver alert) come due together only the latest is sent.
// Convex runs a mutation as one transaction, so overlapping ticks cannot interleave (the
// advisory lock in SQL). Both functions take `now` so tests can drive the clock.
//
// Last modified: 2026-10-28

import { v } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import { internalMutation } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import { changeInstance, expandTasks } from "./lib/schedule";
import { formatTime12, minutes } from "./lib/time";
import type { EscalationStep } from "./lib/validators";

const SYSTEM = { kind: "system" } as const;

/** Counts returned by a tick, for logging. */
export interface TickResult {
  created: number;
  opened: number;
  stepsFired: number;
  escalated: number;
  missed: number;
}

/** An escalation step that is due on an instance, and whether it is the one to send. */
interface DueStep {
  position: number;
  step: EscalationStep;
  notify: boolean;
}

/**
 * purpose: Open windows: every upcoming instance whose window has started becomes due.
 * @param ctx: (MutationCtx) Mutation context.
 * @param now: (number) Epoch ms.
 * @return: (Promise<number>) Instances opened.
 */
async function openWindows(ctx: MutationCtx, now: number): Promise<number> {
  const starting = await ctx.db
    .query("taskInstances")
    .withIndex("by_state_window_start", (q) => q.eq("state", "upcoming").lte("windowStart", now))
    .collect();
  for (const instance of starting) await changeInstance(ctx, SYSTEM, instance, { state: "due" });
  return starting.length;
}

/**
 * purpose: The escalation steps that are due on an instance now and not yet fired. A step is
 *          due once now reaches max(windowStart, createdAt) plus its offset; prompts wait
 *          while snoozed; skipIfClaimed steps are skipped once claimed. Within each kind
 *          (prompt, caregiver alert) only the latest due step is marked to notify.
 * @param instance: (Doc<"taskInstances">) An open instance.
 * @param steps: (EscalationStep[]) The task's policy steps; position is the index.
 * @param now: (number) Epoch ms.
 * @return: (DueStep[]) Due steps in position order.
 */
function dueSteps(instance: Doc<"taskInstances">, steps: EscalationStep[], now: number): DueStep[] {
  const base = Math.max(instance.windowStart, instance.createdAt);
  const fired = new Set(instance.firedSteps.map((f) => f.position));
  const snoozed = instance.snoozedUntil !== undefined && now < instance.snoozedUntil;
  const due: DueStep[] = [];
  steps.forEach((step, position) => {
    if (fired.has(position) || now < base + minutes(step.offsetMinutes)) return;
    if (step.action === "prompt_senior" && snoozed) return;
    if (step.skipIfClaimed && instance.claimedBy !== undefined) return;
    due.push({ position, step, notify: false });
  });
  for (const isPrompt of [true, false]) {
    const latest = due.filter((d) => (d.step.action === "prompt_senior") === isPrompt).at(-1);
    if (latest) latest.notify = true;
  }
  return due;
}

/**
 * purpose: Queue the outbox rows for one fired step: senior prompts go to every device of the
 *          household, an on-call alert to the on-call member (or every primary when none is
 *          set), an all-caregivers alert to every member.
 * @param ctx: (MutationCtx) Mutation context.
 * @param instance: (Doc<"taskInstances">) The instance.
 * @param position: (number) Step position.
 * @param step: (EscalationStep) The step.
 * @return: (Promise<void>)
 */
async function queueNotifications(
  ctx: MutationCtx,
  instance: Doc<"taskInstances">,
  position: number,
  step: EscalationStep,
): Promise<void> {
  const task = await ctx.db.get(instance.taskId);
  const household = await ctx.db.get(instance.householdId);
  if (!task || !household) return;
  const isPrompt = step.action === "prompt_senior";
  const dueAt = `Due at ${formatTime12(instance.scheduledTime)}.`;
  const row = {
    householdId: instance.householdId,
    kind: isPrompt ? ("senior_prompt" as const) : ("caregiver_alert" as const),
    taskInstanceId: instance._id,
    title: isPrompt
      ? task.displayLabel
      : `${household.seniorPreferredName} hasn't confirmed ${task.displayLabel}`,
    body: isPrompt
      ? task.spokenPrompt
      : step.action === "alert_on_call"
        ? `${dueAt} Tap to claim it.`
        : `${dueAt} No one has claimed it yet.`,
    payload: {
      taskId: task._id,
      localDate: instance.localDate,
      step: position,
      action: step.action,
    },
  };
  if (isPrompt) {
    const devices = await ctx.db
      .query("devices")
      .withIndex("by_household", (q) => q.eq("householdId", instance.householdId))
      .collect();
    for (const device of devices) {
      await ctx.db.insert("notificationOutbox", { ...row, recipientDeviceId: device._id });
    }
    return;
  }
  const members = await ctx.db
    .query("householdMembers")
    .withIndex("by_household_user", (q) => q.eq("householdId", instance.householdId))
    .collect();
  const onCall = household.onCallUserId;
  for (const member of members) {
    const wanted =
      step.action === "alert_all_caregivers" ||
      member.userId === onCall ||
      (onCall === undefined && member.role === "primary");
    if (wanted)
      await ctx.db.insert("notificationOutbox", { ...row, recipientUserId: member.userId });
  }
}

/**
 * purpose: Fire every due escalation step once on every open instance whose window has not
 *          closed, record it on the instance and queue the notifications for steps to send.
 * @param ctx: (MutationCtx) Mutation context.
 * @param now: (number) Epoch ms.
 * @return: (Promise<number>) Steps fired and notified (superseded steps are not counted).
 */
async function fireSteps(ctx: MutationCtx, now: number): Promise<number> {
  let notified = 0;
  for (const state of ["due", "escalated"] as const) {
    const open = await ctx.db
      .query("taskInstances")
      .withIndex("by_state_window_start", (q) => q.eq("state", state))
      .collect();
    for (const instance of open) {
      if (instance.windowEnd <= now) continue;
      const task = await ctx.db.get(instance.taskId);
      if (!task || !task.active || task.escalationPolicyId === undefined) continue;
      const policy = await ctx.db.get(task.escalationPolicyId);
      if (!policy) continue;
      const due = dueSteps(instance, policy.steps, now);
      if (due.length === 0) continue;
      await ctx.db.patch(instance._id, {
        firedSteps: [
          ...instance.firedSteps,
          ...due.map((d) => ({
            position: d.position,
            action: d.step.action,
            firedAt: now,
            notified: d.notify,
          })),
        ],
      });
      for (const d of due) {
        if (!d.notify) continue;
        notified += 1;
        await queueNotifications(ctx, instance, d.position, d.step);
      }
    }
  }
  return notified;
}

/**
 * purpose: Mark due instances escalated once a caregiver alert step has fired for them.
 * @param ctx: (MutationCtx) Mutation context.
 * @return: (Promise<number>) Instances escalated.
 */
async function markEscalated(ctx: MutationCtx): Promise<number> {
  const due = await ctx.db
    .query("taskInstances")
    .withIndex("by_state_window_start", (q) => q.eq("state", "due"))
    .collect();
  const alerted = due.filter((i) => i.firedSteps.some((f) => f.action !== "prompt_senior"));
  for (const instance of alerted) {
    await changeInstance(ctx, SYSTEM, instance, { state: "escalated" });
  }
  return alerted.length;
}

/**
 * purpose: Close windows: due or escalated instances whose window has ended become missed.
 * @param ctx: (MutationCtx) Mutation context.
 * @param now: (number) Epoch ms.
 * @return: (Promise<number>) Instances marked missed.
 */
async function closeWindows(ctx: MutationCtx, now: number): Promise<number> {
  let missed = 0;
  for (const state of ["due", "escalated"] as const) {
    const ended = await ctx.db
      .query("taskInstances")
      .withIndex("by_state_window_end", (q) => q.eq("state", state).lte("windowEnd", now))
      .collect();
    for (const instance of ended) await changeInstance(ctx, SYSTEM, instance, { state: "missed" });
    missed += ended.length;
  }
  return missed;
}

/**
 * purpose: Create instances for today and tomorrow (household-local) for every active task,
 *          or for one task. Idempotent. Internal.
 * @param now: (number, optional) Epoch ms; defaults to the server clock.
 * @param taskId: (Id<"tasks">, optional) Limit the expansion to one task.
 * @return: (number) Instances created.
 */
export const expand = internalMutation({
  args: { now: v.optional(v.number()), taskId: v.optional(v.id("tasks")) },
  handler: async (ctx, args): Promise<number> => {
    return await expandTasks(ctx, args.now ?? Date.now(), { taskId: args.taskId });
  },
});

/**
 * purpose: One scheduler pass: expand, open windows, fire escalation steps, mark escalated,
 *          close windows. Run every minute by crons.ts. Internal.
 * @param now: (number, optional) Epoch ms; defaults to the server clock.
 * @return: (TickResult) Counts of created, opened, fired (notified), escalated and missed.
 */
export const tick = internalMutation({
  args: { now: v.optional(v.number()) },
  handler: async (ctx, args): Promise<TickResult> => {
    const now = args.now ?? Date.now();
    const created = await expandTasks(ctx, now);
    const opened = await openWindows(ctx, now);
    const stepsFired = await fireSteps(ctx, now);
    const escalated = await markEscalated(ctx);
    const missed = await closeWindows(ctx, now);
    return { created, opened, stepsFired, escalated, missed };
  },
});
