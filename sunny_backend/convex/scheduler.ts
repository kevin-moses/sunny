// scheduler.ts
// Purpose: The scheduler, ported from scheduler_tick and expand_task_instances in the SQL
// scheduler migration. tick runs once a minute (crons.ts) but only fans out: it pages through
// the households and schedules one tickHousehold per household with the same `now`, so no
// transaction grows with the number of households (a single global pass would hit Convex's
// per-mutation read and write limits and then fail every minute for everyone). tickHousehold
// does the work for one household: expands today's and tomorrow's instances, opens windows
// (upcoming to due), fires each due escalation step exactly once (recorded by step id on the
// instance's firedSteps) and queues the notifications in the outbox, marks instances with a
// fired caregiver alert as escalated, and closes windows to missed. Offsets count from the
// later of window start and creation; senior prompts wait while snoozed; skipIfClaimed steps
// are skipped once claimed; inactive tasks never fire; and when several steps of one kind
// (prompt, or caregiver alert) come due together only the latest, by its current position in
// the policy, is sent. Each household runs in its own serializable transaction, so a slow or
// overlapping tick conflicts only with writes to that household. The functions take `now` so
// tests can drive the clock; tickHouseholdCore is the pure pass tests call directly.
//
// Last modified: 2026-10-28

import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import { appError } from "./lib/errors";
import { changeInstance, expandTasks } from "./lib/schedule";
import { formatTime12, minutes } from "./lib/time";
import type { EscalationStep } from "./lib/validators";

const SYSTEM = { kind: "system" } as const;

/** Households a tick page schedules; the next page is scheduled as a follow-up. */
const TICK_PAGE_SIZE = 500;

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
  step: EscalationStep;
  notify: boolean;
}

/**
 * purpose: Open windows: every upcoming instance of the household whose window has started
 *          becomes due.
 * @param ctx: (MutationCtx) Mutation context.
 * @param householdId: (Id<"households">) Household.
 * @param now: (number) Epoch ms.
 * @return: (Promise<number>) Instances opened.
 */
async function openWindows(
  ctx: MutationCtx,
  householdId: Id<"households">,
  now: number,
): Promise<number> {
  const starting = await ctx.db
    .query("taskInstances")
    .withIndex("by_household_state", (q) =>
      q.eq("householdId", householdId).eq("state", "upcoming").lte("windowStart", now),
    )
    .collect();
  for (const instance of starting) await changeInstance(ctx, SYSTEM, instance, { state: "due" });
  return starting.length;
}

/**
 * purpose: The escalation steps that are due on an instance now and not yet fired. A step is
 *          due once now reaches max(windowStart, createdAt) plus its offset; prompts wait
 *          while snoozed; skipIfClaimed steps are skipped once claimed. Within each kind
 *          (prompt, caregiver alert) only the latest due step, by current position in the
 *          policy, is marked to notify. Fired steps are matched by step id, so editing the
 *          policy does not change which steps count as fired.
 * @param instance: (Doc<"taskInstances">) An open instance.
 * @param steps: (EscalationStep[]) The task's policy steps in order.
 * @param now: (number) Epoch ms.
 * @return: (DueStep[]) Due steps in policy order.
 */
function dueSteps(instance: Doc<"taskInstances">, steps: EscalationStep[], now: number): DueStep[] {
  const base = Math.max(instance.windowStart, instance.createdAt);
  const fired = new Set(instance.firedSteps.map((f) => f.stepId));
  const snoozed = instance.snoozedUntil !== undefined && now < instance.snoozedUntil;
  const due: DueStep[] = [];
  for (const step of steps) {
    if (fired.has(step.id) || now < base + minutes(step.offsetMinutes)) continue;
    if (step.action === "prompt_senior" && snoozed) continue;
    if (step.skipIfClaimed && instance.claimedBy !== undefined) continue;
    due.push({ step, notify: false });
  }
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
 * @param step: (EscalationStep) The step; its id is the payload's `step`.
 * @return: (Promise<void>)
 */
async function queueNotifications(
  ctx: MutationCtx,
  instance: Doc<"taskInstances">,
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
      step: step.id,
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
 * purpose: Fire every due escalation step once on every open instance of the household whose
 *          window has not closed, record it on the instance and queue the notifications for
 *          steps to send.
 * @param ctx: (MutationCtx) Mutation context.
 * @param householdId: (Id<"households">) Household.
 * @param now: (number) Epoch ms.
 * @return: (Promise<number>) Steps fired and notified (superseded steps are not counted).
 */
async function fireSteps(
  ctx: MutationCtx,
  householdId: Id<"households">,
  now: number,
): Promise<number> {
  let notified = 0;
  for (const state of ["due", "escalated"] as const) {
    const open = await ctx.db
      .query("taskInstances")
      .withIndex("by_household_state", (q) => q.eq("householdId", householdId).eq("state", state))
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
            stepId: d.step.id,
            action: d.step.action,
            firedAt: now,
            notified: d.notify,
          })),
        ],
      });
      for (const d of due) {
        if (!d.notify) continue;
        notified += 1;
        await queueNotifications(ctx, instance, d.step);
      }
    }
  }
  return notified;
}

/**
 * purpose: Mark the household's due instances escalated once a caregiver alert step has
 *          fired for them.
 * @param ctx: (MutationCtx) Mutation context.
 * @param householdId: (Id<"households">) Household.
 * @return: (Promise<number>) Instances escalated.
 */
async function markEscalated(ctx: MutationCtx, householdId: Id<"households">): Promise<number> {
  const due = await ctx.db
    .query("taskInstances")
    .withIndex("by_household_state", (q) => q.eq("householdId", householdId).eq("state", "due"))
    .collect();
  const alerted = due.filter((i) => i.firedSteps.some((f) => f.action !== "prompt_senior"));
  for (const instance of alerted) {
    await changeInstance(ctx, SYSTEM, instance, { state: "escalated" });
  }
  return alerted.length;
}

/**
 * purpose: Close windows: the household's due or escalated instances whose window has ended
 *          become missed.
 * @param ctx: (MutationCtx) Mutation context.
 * @param householdId: (Id<"households">) Household.
 * @param now: (number) Epoch ms.
 * @return: (Promise<number>) Instances marked missed.
 */
async function closeWindows(
  ctx: MutationCtx,
  householdId: Id<"households">,
  now: number,
): Promise<number> {
  let missed = 0;
  for (const state of ["due", "escalated"] as const) {
    const open = await ctx.db
      .query("taskInstances")
      .withIndex("by_household_state", (q) => q.eq("householdId", householdId).eq("state", state))
      .collect();
    const ended = open.filter((i) => i.windowEnd <= now);
    for (const instance of ended) await changeInstance(ctx, SYSTEM, instance, { state: "missed" });
    missed += ended.length;
  }
  return missed;
}

/**
 * purpose: One scheduler pass over one household: expand, open windows, fire escalation steps,
 *          mark escalated, close windows. The pure core of tickHousehold, called directly by
 *          tests with an explicit clock.
 * @param ctx: (MutationCtx) Mutation context.
 * @param householdId: (Id<"households">) Household.
 * @param now: (number) Epoch ms.
 * @return: (Promise<TickResult>) Counts of created, opened, fired (notified), escalated, missed.
 */
export async function tickHouseholdCore(
  ctx: MutationCtx,
  householdId: Id<"households">,
  now: number,
): Promise<TickResult> {
  const created = await expandTasks(ctx, now, { householdId });
  const opened = await openWindows(ctx, householdId, now);
  const stepsFired = await fireSteps(ctx, householdId, now);
  const escalated = await markEscalated(ctx, householdId);
  const missed = await closeWindows(ctx, householdId, now);
  return { created, opened, stepsFired, escalated, missed };
}

/**
 * purpose: Create instances for today and tomorrow (household-local) for one task or for the
 *          active tasks of one household. Idempotent. Internal.
 * @param now: (number, optional) Epoch ms; defaults to the server clock.
 * @param taskId: (Id<"tasks">, optional) Expand this task.
 * @param householdId: (Id<"households">, optional) Expand this household's active tasks.
 * @return: (number) Instances created.
 * @raises invalid when neither taskId nor householdId is given.
 */
export const expand = internalMutation({
  args: {
    now: v.optional(v.number()),
    taskId: v.optional(v.id("tasks")),
    householdId: v.optional(v.id("households")),
  },
  handler: async (ctx, args): Promise<number> => {
    const now = args.now ?? Date.now();
    if (args.taskId !== undefined) return await expandTasks(ctx, now, { taskId: args.taskId });
    if (args.householdId !== undefined) {
      return await expandTasks(ctx, now, { householdId: args.householdId });
    }
    throw appError("invalid", "expand needs a taskId or a householdId");
  },
});

/**
 * purpose: One scheduler pass for one household: expand, open windows, fire escalation steps,
 *          mark escalated, close windows, in one transaction. Scheduled by tick. Internal.
 * @param householdId: (Id<"households">) Household.
 * @param now: (number) Epoch ms shared by every household of one tick.
 * @return: (TickResult) Counts of created, opened, fired (notified), escalated and missed.
 */
export const tickHousehold = internalMutation({
  args: { householdId: v.id("households"), now: v.number() },
  handler: async (ctx, args): Promise<TickResult> => {
    return await tickHouseholdCore(ctx, args.householdId, args.now);
  },
});

/**
 * purpose: The cron entry point, run every minute by crons.ts. Lists household ids one page at
 *          a time and schedules tickHousehold for each with the same `now`; when more pages
 *          remain it schedules itself for the next page. It does no per-household work, so its
 *          cost does not grow with tasks or instances. Internal.
 * @param now: (number, optional) Epoch ms; defaults to the server clock on the first page and
 *             is carried to later pages.
 * @param cursor: (string, optional) Continuation cursor of the household listing.
 * @param pageSize: (number, optional) Households per page (tests set it small).
 * @return: (number) Households scheduled on this page.
 */
export const tick = internalMutation({
  args: {
    now: v.optional(v.number()),
    cursor: v.optional(v.string()),
    pageSize: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<number> => {
    const now = args.now ?? Date.now();
    const pageSize = args.pageSize ?? TICK_PAGE_SIZE;
    const page = await ctx.db
      .query("households")
      .paginate({ numItems: pageSize, cursor: args.cursor ?? null });
    for (const household of page.page) {
      await ctx.scheduler.runAfter(0, internal.scheduler.tickHousehold, {
        householdId: household._id,
        now,
      });
    }
    if (!page.isDone) {
      await ctx.scheduler.runAfter(0, internal.scheduler.tick, {
        now,
        cursor: page.continueCursor,
        pageSize,
      });
    }
    return page.page.length;
  },
});
