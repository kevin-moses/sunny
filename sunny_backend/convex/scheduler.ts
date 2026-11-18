import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import { queueDigestIfDue } from "./digest";
import { householdCaregivers, SYSTEM_ACTOR } from "./lib/access";
import { isAnytimeInstance } from "./lib/anytime";
import { withStepSpeech } from "./lib/deviceWording";
import { appError } from "./lib/errors";
import { insertNotification } from "./lib/delivery";
import { announceEvents } from "./lib/eventNotices";
import {
  caregiverAlerted,
  dueOrEscalatedInstances,
  escalationSteps,
  firedStep,
  isCaregiverAlert,
  stepDueAt,
  stepHeld,
} from "./lib/escalation";
import type { EscalationStep } from "./lib/escalation";
import { changeInstance, expandTasks } from "./lib/schedule";
import { taskStep } from "./lib/taskSteps";
import { formatTime12 } from "./lib/time";

const TICK_PAGE_SIZE = 500;

const CLOSE_ALERT_MAX_LATE_MS = 60 * 60_000;

export interface TickResult {
  created: number;
  opened: number;
  stepsFired: number;
  escalated: number;
  missed: number;
  noticed: number;
}

interface DueStep {
  step: EscalationStep;
  notify: boolean;
}

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
  for (const instance of starting)
    await changeInstance(ctx, SYSTEM_ACTOR, instance, { state: "due" });
  return starting.length;
}

function dueSteps(
  instance: Doc<"taskInstances">,
  steps: readonly EscalationStep[],
  now: number,
): DueStep[] {
  const fired = new Set(instance.firedSteps.map((f) => f.stepId));
  const due: DueStep[] = [];
  for (const step of steps) {
    if (fired.has(step.id) || now < stepDueAt(instance, step)) continue;
    if (stepHeld(instance, step, now)) continue;
    due.push({ step, notify: false });
  }
  for (const isAlert of [false, true]) {
    const latest = due.filter((d) => isCaregiverAlert(d.step.action) === isAlert).at(-1);
    if (latest) latest.notify = true;
  }
  return due;
}

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
  const note = instance.state === "missed" ? " Its time has now passed." : "";
  const row = {
    householdId: instance.householdId,
    kind: isPrompt ? ("senior_prompt" as const) : ("caregiver_alert" as const),
    taskInstanceId: instance._id,
    title: isPrompt
      ? task.displayLabel
      : `${household.seniorPreferredName} hasn't confirmed ${task.displayLabel}`,
    body: isPrompt
      ? withStepSpeech(task.spokenPrompt, taskStep(task.checklistItems, instance.currentStep))
      : `${dueAt}${note}`,
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
      await insertNotification(ctx, { ...row, recipientDeviceId: device._id });
    }
    return;
  }
  for (const member of await householdCaregivers(ctx, instance.householdId)) {
    await insertNotification(ctx, { ...row, recipientUserId: member.userId });
  }
}

async function fireSteps(
  ctx: MutationCtx,
  householdId: Id<"households">,
  now: number,
): Promise<number> {
  let notified = 0;
  for (const instance of await dueOrEscalatedInstances(ctx, householdId)) {
    if (instance.windowEnd <= now || isAnytimeInstance(instance)) continue;
    const steps = escalationSteps(await ctx.db.get(instance.taskId));
    const due = dueSteps(instance, steps, now);
    if (due.length === 0) continue;
    await ctx.db.patch(instance._id, {
      firedSteps: [...instance.firedSteps, ...due.map((d) => firedStep(d.step, now, d.notify))],
    });
    for (const d of due) {
      if (!d.notify) continue;
      notified += 1;
      await queueNotifications(ctx, instance, d.step);
    }
  }
  return notified;
}

async function markEscalated(ctx: MutationCtx, householdId: Id<"households">): Promise<number> {
  const due = await ctx.db
    .query("taskInstances")
    .withIndex("by_household_state", (q) => q.eq("householdId", householdId).eq("state", "due"))
    .collect();
  const alerted = due.filter((i) => caregiverAlerted(i.firedSteps));
  for (const instance of alerted) {
    await changeInstance(ctx, SYSTEM_ACTOR, instance, { state: "escalated" });
  }
  return alerted.length;
}

async function alertOwedAtClose(
  ctx: MutationCtx,
  instance: Doc<"taskInstances">,
  now: number,
): Promise<EscalationStep | null> {
  if (isAnytimeInstance(instance) || instance.createdAt >= instance.windowEnd) return null;
  if (now - instance.windowEnd > CLOSE_ALERT_MAX_LATE_MS) return null;
  if (caregiverAlerted(instance.firedSteps)) return null;
  const steps = escalationSteps(await ctx.db.get(instance.taskId));
  const fired = new Set(instance.firedSteps.map((f) => f.stepId));
  return (
    steps.find(
      (s) => isCaregiverAlert(s.action) && !fired.has(s.id) && !stepHeld(instance, s, now),
    ) ?? null
  );
}

async function closeWindows(
  ctx: MutationCtx,
  householdId: Id<"households">,
  now: number,
): Promise<number> {
  const ended = (await dueOrEscalatedInstances(ctx, householdId)).filter((i) => i.windowEnd <= now);
  for (const instance of ended) {
    const step = await alertOwedAtClose(ctx, instance, now);
    const firedSteps = step ? [...instance.firedSteps, firedStep(step, now, true)] : undefined;
    const after = await changeInstance(ctx, SYSTEM_ACTOR, instance, {
      state: "missed",
      ...(firedSteps ? { firedSteps } : {}),
    });
    if (step) await queueNotifications(ctx, after, step);
  }
  return ended.length;
}

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
  const household = await ctx.db.get(householdId);
  if (!household) return { created, opened, stepsFired, escalated, missed, noticed: 0 };
  const noticed = await announceEvents(ctx, household, now);
  await queueDigestIfDue(ctx, household, now);
  return { created, opened, stepsFired, escalated, missed, noticed };
}

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

export const tickHousehold = internalMutation({
  args: { householdId: v.id("households"), now: v.number() },
  handler: async (ctx, args): Promise<TickResult> => {
    return await tickHouseholdCore(ctx, args.householdId, args.now);
  },
});

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
