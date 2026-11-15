import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { mutation, query } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import {
  actorUserId,
  findDevice,
  loadHousehold,
  requireEditor,
  requireReader,
  requireSenior,
  requireUserId,
} from "./lib/access";
import type { Actor, CaregiverActor, DeviceActor } from "./lib/access";
import { audit } from "./lib/audit";
import {
  EARLY_CONFIRM_MS,
  LATE_SYNC_MS,
  REPLAY_GRACE_MS,
  caregiverCanReopen,
  isDoneState,
  notTooEarly,
  isPressId,
  PRESS_ID_NOT_VALID,
  queuedPressTakenBack,
  reopenedState,
  seniorCanUndo,
  taskStillRuns,
  withConfirmPressId,
  withTakenBackPressIds,
} from "./lib/confirmRule";
import type { QueuedPress } from "./lib/confirmRule";
import { pickDueEntry } from "./lib/dueTask";
import { appError, isAppError } from "./lib/errors";
import { isOpenState } from "./lib/escalation";
import { changeInstance, insertTask, patchTask } from "./lib/schedule";
import { cleanOptional, normalizeWeekdays, requireMaxLength } from "./lib/text";
import {
  advancedStep,
  hasStepAfter,
  latestStepPress,
  seniorCanUndoStep,
  stepPressed,
  steppedBack,
  taskStep,
} from "./lib/taskSteps";
import { isLocalDate, isLocalTime, localDate, minutes } from "./lib/time";
import { todayInstances } from "./lib/today";
import type { TodayEntry } from "./lib/today";
import { confirmVia } from "./lib/validators";
import type { ConfirmVia } from "./lib/validators";

const DOSE_CLOCK_SKEW_MS = minutes(5);
const DEFAULT_SNOOZE_MINUTES = 15;
const MAX_SNOOZE_MINUTES = 120;
const REMINDER_WINDOW_MINUTES = 30;
const MAX_REMINDER_TITLE_LENGTH = 200;
const MAX_RESOLUTION_NOTE_LENGTH = 500;
export const UNDO_WINDOW_MS = 30_000;

const CLEAR_CONFIRMATION = {
  confirmedAt: undefined,
  confirmedBy: undefined,
  confirmedVia: undefined,
  confirmReceivedAt: undefined,
  resolvedFromState: undefined,
  resolvedFromSnoozedUntil: undefined,
  confirmPressIds: undefined,
} satisfies Partial<Doc<"taskInstances">>;

export const NO_SUCH_TASK = "The task no longer exists";

export type ConfirmTransport = "app" | "device_api";

export type ConfirmDueResult = Partial<TodayEntry> & {
  status:
    | "confirmed"
    | "advanced"
    | "already_done"
    | "nothing_due"
    | "not_found"
    | "ambiguous"
    | "not_due_yet";
  options?: TodayEntry[];
};

export interface CancelReminderResult {
  status: "cancelled" | "not_found" | "ambiguous";
  titles: string[];
}

async function loadInstance(
  ctx: QueryCtx,
  instanceId: Id<"taskInstances">,
): Promise<Doc<"taskInstances">> {
  const instance = await ctx.db.get(instanceId);
  if (!instance) throw appError("not_found", "Task instance not found");
  return instance;
}

async function requireDeviceActor(ctx: QueryCtx): Promise<DeviceActor> {
  const userId = await requireUserId(ctx);
  const device = await findDevice(ctx, userId);
  if (!device) throw appError("forbidden", "Only the senior's devices can do this");
  return { kind: "senior_device", userId, householdId: device.householdId, device };
}

function actsForSenior(actor: Actor, householdId: Id<"households">): boolean {
  if (actor.kind === "agent" || actor.kind === "system") return true;
  return actor.kind === "senior_device" && actor.householdId === householdId;
}

function isHouseholdEditor(actor: Actor, householdId: Id<"households">): actor is CaregiverActor {
  return (
    actor.kind === "caregiver" &&
    actor.householdId === householdId &&
    (actor.role === "primary" || actor.role === "member")
  );
}

function requirePressAge(ageMs: number): void {
  if (!Number.isFinite(ageMs) || ageMs < 0) {
    throw appError("invalid", "The press age must be zero or more");
  }
}

function requirePressId(pressId: string | undefined): void {
  if (pressId !== undefined && !isPressId(pressId)) {
    throw appError("invalid", PRESS_ID_NOT_VALID);
  }
}

function requirePressInWindow(instance: Doc<"taskInstances">, pressedAt: number): void {
  if (pressedAt < instance.windowStart - EARLY_CONFIRM_MS) {
    throw appError("invalid", "This task was not due yet when it was pressed");
  }
  if (pressedAt > instance.windowEnd + REPLAY_GRACE_MS) {
    throw appError("invalid", "This press was too long after the task's window");
  }
}

export async function confirmInstance(
  ctx: MutationCtx,
  actor: Actor,
  args: {
    instanceId: Id<"taskInstances">;
    via: ConfirmVia;
    note?: string;
    pressedAgoMs?: number;
    pressId?: string;
    transport?: ConfirmTransport;
  },
  now: number,
): Promise<Doc<"taskInstances">> {
  const instance = await loadInstance(ctx, args.instanceId);
  const asCaregiver = isHouseholdEditor(actor, instance.householdId);
  if (!asCaregiver && !actsForSenior(actor, instance.householdId)) {
    throw appError("forbidden", "Not allowed to confirm this task");
  }
  if (!asCaregiver && args.via === "caregiver") {
    throw appError("invalid", "Only a caregiver can confirm as a caregiver");
  }
  let queuedPress: QueuedPress | null = null;
  if (args.pressedAgoMs !== undefined) {
    if (actor.kind !== "senior_device") {
      throw appError("invalid", "Only the senior's device can send a press age");
    }
    requirePressAge(args.pressedAgoMs);
    queuedPress = {
      pressedAt: now - args.pressedAgoMs,
      pressId: args.pressId,
      userId: actor.userId,
    };
  }
  if (args.pressId !== undefined) {
    if (actor.kind !== "senior_device") {
      throw appError("invalid", "Only the senior's device can send a press id");
    }
    requirePressId(args.pressId);
  }
  const note = cleanOptional(args.note, MAX_RESOLUTION_NOTE_LENGTH, "The note");
  const replayed = args.pressedAgoMs !== undefined && args.pressedAgoMs > LATE_SYNC_MS;
  if (args.pressId !== undefined && stepPressed(instance, args.pressId)) return instance;
  if (isDoneState(instance.state)) return await recordNoOpPress(ctx, actor, instance, args.pressId);
  const takenBack = queuedPress === null ? null : queuedPressTakenBack(queuedPress, instance);
  if (takenBack !== null) throw appError("invalid", takenBack);
  if (asCaregiver) {
    const household = await loadHousehold(ctx, instance.householdId);
    if (instance.localDate > localDate(now, household.timezone)) {
      throw appError("invalid", "This task is not due yet");
    }
  } else if (!notTooEarly(instance, now)) {
    throw appError("invalid", "This task is not due yet");
  }
  if (replayed) requirePressInWindow(instance, now - (args.pressedAgoMs ?? 0));
  const confirmedAt =
    args.pressedAgoMs === undefined
      ? now
      : Math.min(now, Math.max(now - args.pressedAgoMs, instance.windowStart - EARLY_CONFIRM_MS));
  const lateSynced = now - confirmedAt > LATE_SYNC_MS;
  const pressDetail = {
    ...(args.pressedAgoMs === undefined
      ? {}
      : { pressedAgoMs: args.pressedAgoMs, confirmedAt, receivedAt: now, replayed }),
    ...(args.pressId === undefined ? {} : { pressId: args.pressId }),
    ...(args.transport === undefined ? {} : { transport: args.transport }),
  };
  const step = asCaregiver ? null : await instanceStep(ctx, instance);
  if (hasStepAfter(step)) {
    const press = { at: now, by: actorUserId(actor), pressId: args.pressId };
    return await changeInstance(
      ctx,
      actor,
      instance,
      advancedStep(instance, step, press),
      pressDetail,
    );
  }
  return await changeInstance(
    ctx,
    actor,
    instance,
    {
      state: asCaregiver ? "resolved" : "confirmed",
      confirmedAt,
      confirmReceivedAt: lateSynced ? now : undefined,
      confirmedBy: actorUserId(actor),
      confirmedVia: asCaregiver ? "caregiver" : args.via,
      resolvedFromState: instance.state,
      resolvedFromSnoozedUntil: instance.snoozedUntil,
      resolutionNote: note ?? instance.resolutionNote,
      snoozedUntil: undefined,
      confirmPressIds: args.pressId === undefined ? undefined : [args.pressId],
    },
    pressDetail,
  );
}

async function instanceStep(
  ctx: QueryCtx,
  instance: Doc<"taskInstances">,
): Promise<ReturnType<typeof taskStep>> {
  const task = await ctx.db.get(instance.taskId);
  return task === null ? null : taskStep(task.checklistItems, instance.currentStep);
}

async function recordNoOpPress(
  ctx: MutationCtx,
  actor: Actor,
  instance: Doc<"taskInstances">,
  pressId: string | undefined,
): Promise<Doc<"taskInstances">> {
  if (
    pressId === undefined ||
    actor.kind !== "senior_device" ||
    instance.state !== "confirmed" ||
    instance.confirmedBy !== actor.userId ||
    instance.takenBackPressIds?.includes(pressId) ||
    instance.confirmPressIds?.includes(pressId)
  ) {
    return instance;
  }
  await ctx.db.patch(instance._id, {
    confirmPressIds: withConfirmPressId(instance.confirmPressIds, pressId),
  });
  return (await ctx.db.get(instance._id))!;
}

export async function snoozeInstance(
  ctx: MutationCtx,
  actor: Actor,
  args: { instanceId: Id<"taskInstances">; minutes?: number },
  now: number,
): Promise<Doc<"taskInstances">> {
  const instance = await loadInstance(ctx, args.instanceId);
  if (!actsForSenior(actor, instance.householdId)) {
    throw appError("forbidden", "Only the senior's devices can do this");
  }
  const snooze = args.minutes ?? DEFAULT_SNOOZE_MINUTES;
  if (!Number.isInteger(snooze) || snooze < 1 || snooze > MAX_SNOOZE_MINUTES) {
    throw appError("invalid", "Snooze must be between 1 and 120 minutes");
  }
  if (instance.state !== "due" && instance.state !== "escalated") return instance;
  return await changeInstance(ctx, actor, instance, { snoozedUntil: now + minutes(snooze) });
}

export async function claimInstance(
  ctx: MutationCtx,
  actor: Actor,
  args: { instanceId: Id<"taskInstances"> },
  now: number,
): Promise<Doc<"taskInstances">> {
  const instance = await loadInstance(ctx, args.instanceId);
  if (!isHouseholdEditor(actor, instance.householdId)) {
    throw appError("forbidden", "Not allowed to claim this task");
  }
  const claimable =
    instance.state === "due" || instance.state === "escalated" || instance.state === "missed";
  if (instance.claimedBy !== undefined || !claimable) return instance;
  return await changeInstance(ctx, actor, instance, { claimedBy: actor.userId, claimedAt: now });
}

export async function setTaskNoteCore(
  ctx: MutationCtx,
  actor: Actor,
  args: { instanceId: Id<"taskInstances">; note?: string },
): Promise<Doc<"taskInstances">> {
  const instance = await loadInstance(ctx, args.instanceId);
  if (!isHouseholdEditor(actor, instance.householdId)) {
    throw appError("forbidden", "Not allowed to change this task's note");
  }
  const note = cleanOptional(args.note, MAX_RESOLUTION_NOTE_LENGTH, "The note");
  return await changeInstance(ctx, actor, instance, { resolutionNote: note });
}

export async function undoResolveInstance(
  ctx: MutationCtx,
  actor: Actor,
  args: { instanceId: Id<"taskInstances"> },
  now: number,
): Promise<Doc<"taskInstances">> {
  const instance = await loadInstance(ctx, args.instanceId);
  if (!isHouseholdEditor(actor, instance.householdId)) {
    throw appError("forbidden", "Not allowed to undo this task");
  }
  const undoable =
    instance.state === "resolved" &&
    instance.confirmedBy === actor.userId &&
    instance.confirmedAt !== undefined &&
    now - instance.confirmedAt <= UNDO_WINDOW_MS;
  if (!undoable) throw appError("invalid", "This can no longer be undone.");
  return await changeInstance(
    ctx,
    actor,
    instance,
    {
      ...CLEAR_CONFIRMATION,
      state: instance.resolvedFromState ?? "due",
      snoozedUntil: instance.resolvedFromSnoozedUntil,
    },
    { undo: true },
  );
}

export type UndoPressResult =
  { status: "undone"; instance: Doc<"taskInstances"> } | { status: "too_late" };

async function runsOnSchedule(ctx: QueryCtx, instance: Doc<"taskInstances">): Promise<boolean> {
  return taskStillRuns(await ctx.db.get(instance.taskId), instance);
}

async function undoRefusal(
  ctx: QueryCtx,
  instance: Doc<"taskInstances">,
  userId: string,
  pressId: string | undefined,
  tappedAt: number,
): Promise<string | null> {
  if (isOpenState(instance.state)) {
    if (!seniorCanUndoStep(instance, userId, pressId, tappedAt)) {
      return "The task has no step done by this device within the undo window";
    }
  } else if (pressId !== undefined && !(instance.confirmPressIds ?? []).includes(pressId)) {
    return "This press is not part of the task's confirmation";
  } else if (!seniorCanUndo(instance, userId, tappedAt)) {
    return "The task is not confirmed by this device within the undo window";
  }
  if (!(await runsOnSchedule(ctx, instance))) return "This task is no longer on the schedule";
  return null;
}

export async function undoPressedInstance(
  ctx: MutationCtx,
  actor: Actor,
  args: { instanceId: Id<"taskInstances">; undoneAgoMs?: number; pressId?: string },
  now: number,
): Promise<UndoPressResult> {
  if (actor.kind !== "senior_device") {
    throw appError("forbidden", "Only the senior's devices can do this");
  }
  if (args.undoneAgoMs !== undefined) requirePressAge(args.undoneAgoMs);
  requirePressId(args.pressId);
  const instance = await ctx.db.get(args.instanceId);
  if (instance !== null && instance.householdId !== actor.householdId) {
    throw appError("forbidden", "Not allowed to undo this task");
  }
  const tappedAt = now - (args.undoneAgoMs ?? 0);
  const refusal =
    instance === null
      ? NO_SUCH_TASK
      : await undoRefusal(ctx, instance, actor.userId, args.pressId, tappedAt);
  if (refusal !== null || instance === null) {
    await audit(ctx, {
      householdId: actor.householdId,
      actor,
      action: "undo_not_applied",
      entity: "task_instance",
      entityId: instance?._id,
      detail: {
        reason: refusal ?? NO_SUCH_TASK,
        instanceId: args.instanceId,
        undoneAgoMs: args.undoneAgoMs ?? 0,
        tappedAt,
        receivedAt: now,
        ...(args.pressId === undefined ? {} : { pressId: args.pressId }),
      },
    });
    return { status: "too_late" };
  }
  const lastStep = latestStepPress(instance);
  if (isOpenState(instance.state) && lastStep !== null) {
    const takenBack = lastStep.pressId === undefined ? [] : [lastStep.pressId];
    const steppedBackRow = await changeInstance(
      ctx,
      actor,
      instance,
      {
        ...steppedBack(instance),
        confirmTakenBackAt: Math.min(now, Math.max(tappedAt, lastStep.at)),
        confirmTakenBackBy: actor.userId,
        takenBackPressIds: withTakenBackPressIds(instance.takenBackPressIds, takenBack),
      },
      {
        undo: true,
        ...(args.pressId === undefined ? {} : { pressId: args.pressId }),
        takenBackPressIds: takenBack,
      },
    );
    return { status: "undone", instance: steppedBackRow };
  }
  const restored = await changeInstance(
    ctx,
    actor,
    instance,
    {
      ...CLEAR_CONFIRMATION,
      state: instance.resolvedFromState ?? reopenedState(instance, now),
      snoozedUntil: instance.resolvedFromSnoozedUntil,
      confirmTakenBackAt: Math.min(now, Math.max(tappedAt, instance.confirmedAt ?? tappedAt)),
      confirmTakenBackBy: actor.userId,
      takenBackPressIds: withTakenBackPressIds(
        instance.takenBackPressIds,
        instance.confirmPressIds,
      ),
    },
    {
      undo: true,
      ...(args.pressId === undefined ? {} : { pressId: args.pressId }),
      takenBackPressIds: instance.confirmPressIds ?? [],
    },
  );
  return { status: "undone", instance: restored };
}

export async function reopenInstance(
  ctx: MutationCtx,
  actor: Actor,
  args: { instanceId: Id<"taskInstances"> },
  now: number,
): Promise<Doc<"taskInstances">> {
  const instance = await loadInstance(ctx, args.instanceId);
  if (!isHouseholdEditor(actor, instance.householdId)) {
    throw appError("forbidden", "Not allowed to reopen this task");
  }
  const household = await loadHousehold(ctx, instance.householdId);
  if (!caregiverCanReopen(instance, now, household.timezone)) {
    throw appError(
      "invalid",
      isDoneState(instance.state)
        ? "This task was marked done on an earlier day, so it can no longer be reopened."
        : "This task is not marked done, so there is nothing to reopen.",
    );
  }
  if (!(await runsOnSchedule(ctx, instance))) {
    throw appError("invalid", "This task is no longer on the schedule.");
  }
  return await changeInstance(
    ctx,
    actor,
    instance,
    {
      ...CLEAR_CONFIRMATION,
      state: reopenedState(instance, now),
      ...(instance.state === "confirmed"
        ? {
            confirmTakenBackAt: now,
            confirmTakenBackBy: actor.userId,
            takenBackPressIds: withTakenBackPressIds(
              instance.takenBackPressIds,
              instance.confirmPressIds,
            ),
          }
        : {}),
    },
    {
      reopen: true,
      confirmedAt: instance.confirmedAt,
      confirmedBy: instance.confirmedBy,
      confirmedVia: instance.confirmedVia,
      takenBackPressIds: instance.confirmPressIds ?? [],
    },
  );
}

export async function confirmDueTaskCore(
  ctx: MutationCtx,
  actor: Actor,
  args: {
    householdId: Id<"households">;
    via: ConfirmVia;
    label?: string;
    transport?: ConfirmTransport;
  },
  now: number,
): Promise<ConfirmDueResult> {
  if (!actsForSenior(actor, args.householdId)) {
    throw appError("forbidden", "Only the senior's devices can do this");
  }
  const picked = pickDueEntry(await todayInstances(ctx, args.householdId, now, actor), args.label);
  if (!("entry" in picked)) return picked;
  const { entry } = picked;
  let row: Doc<"taskInstances">;
  try {
    row = await confirmInstance(
      ctx,
      actor,
      { instanceId: entry.instanceId, via: args.via, transport: args.transport },
      now,
    );
  } catch (e) {
    if (isAppError(e, "invalid")) return { ...entry, status: "not_due_yet" };
    throw e;
  }
  return {
    ...entry,
    status: pressStatus(row),
    state: row.state,
    confirmedAt: row.confirmedAt ?? null,
    step: taskStep(entry.checklistItems, row.currentStep),
  };
}

export async function createSeniorReminderCore(
  ctx: MutationCtx,
  actor: Actor,
  args: {
    householdId: Id<"households">;
    title: string;
    time: string;
    onDate?: string;
    days?: number[];
  },
  now: number,
): Promise<Doc<"tasks">> {
  if (!actsForSenior(actor, args.householdId)) {
    throw appError("forbidden", "Only the senior's devices can do this");
  }
  const title = args.title.trim();
  if (title === "" || !isLocalTime(args.time)) {
    throw appError("invalid", "A reminder needs a title and a time (HH:MM)");
  }
  requireMaxLength(title, MAX_REMINDER_TITLE_LENGTH, "The title");
  if (args.onDate !== undefined && !isLocalDate(args.onDate)) {
    throw appError("invalid", "The date must be YYYY-MM-DD");
  }
  const household = await loadHousehold(ctx, args.householdId);
  if (args.onDate !== undefined && args.onDate < localDate(now, household.timezone)) {
    throw appError("invalid", "That date has already passed");
  }
  const days = normalizeWeekdays(args.days ?? [], "Days must be 1 (Monday) to 7 (Sunday)");
  const policy = await ctx.db
    .query("escalationPolicies")
    .withIndex("by_household_system_key", (q) =>
      q.eq("householdId", args.householdId).eq("systemKey", "prompt_only"),
    )
    .unique();
  const taskId = await insertTask(
    ctx,
    actor,
    {
      householdId: args.householdId,
      type: "reminder",
      title,
      displayLabel: title.charAt(0).toUpperCase() + title.slice(1),
      spokenPrompt: `Reminder: ${title}.`,
      checklistItems: [],
      times: [args.time],
      onceOn: args.onDate,
      daysOfWeek:
        args.onDate === undefined && days.length >= 1 && days.length <= 6 ? days : undefined,
      windowMinutes: REMINDER_WINDOW_MINUTES,
      escalationPolicyId: policy?._id,
      createdByKind: "senior",
      createdBy: actorUserId(actor),
      active: true,
    },
    now,
  );
  return (await ctx.db.get(taskId))!;
}

export async function cancelSeniorReminderCore(
  ctx: MutationCtx,
  actor: Actor,
  args: { householdId: Id<"households">; query: string },
  now: number,
): Promise<CancelReminderResult> {
  if (!actsForSenior(actor, args.householdId)) {
    throw appError("forbidden", "Only the senior's devices can do this");
  }
  const needle = args.query.trim().toLowerCase();
  const tasks = await ctx.db
    .query("tasks")
    .withIndex("by_household", (q) => q.eq("householdId", args.householdId))
    .collect();
  const matches =
    needle === ""
      ? []
      : tasks.filter(
          (t) => t.createdByKind === "senior" && t.active && t.title.toLowerCase().includes(needle),
        );
  const titles = matches.map((t) => t.title);
  if (matches.length === 0) return { status: "not_found", titles: [] };
  if (matches.length > 1) return { status: "ambiguous", titles };
  await patchTask(ctx, actor, matches[0]!, { active: false }, now);
  return { status: "cancelled", titles };
}

export async function logDoseCore(
  ctx: MutationCtx,
  actor: Actor,
  args: {
    householdId: Id<"households">;
    taskId: Id<"tasks">;
    takenAt: number;
    via: ConfirmVia;
    note?: string;
    conversationId?: Id<"conversations">;
  },
  now: number,
): Promise<Id<"doseLog">> {
  if (!isHouseholdEditor(actor, args.householdId) && !actsForSenior(actor, args.householdId)) {
    throw appError("forbidden", "Not allowed to log a dose");
  }
  if (!Number.isFinite(args.takenAt)) {
    throw appError("invalid", "takenAt must be a valid time");
  }
  if (args.takenAt > now + DOSE_CLOCK_SKEW_MS) {
    throw appError("invalid", "A dose cannot be logged in the future");
  }
  const task = await ctx.db.get(args.taskId);
  if (!task || task.householdId !== args.householdId) throw appError("not_found", "Task not found");
  return await ctx.db.insert("doseLog", {
    householdId: args.householdId,
    taskId: args.taskId,
    takenAt: args.takenAt,
    reportedVia: args.via,
    reportedBy: actorUserId(actor),
    note: args.note,
    loggedAt: now,
    conversationId: args.conversationId,
  });
}

export const confirmTaskInstance = mutation({
  args: { instanceId: v.id("taskInstances"), via: confirmVia, note: v.optional(v.string()) },
  handler: async (ctx, args): Promise<Doc<"taskInstances">> => {
    const instance = await loadInstance(ctx, args.instanceId);
    const actor = await requireReader(ctx, instance.householdId);
    return await confirmInstance(ctx, actor, { ...args, transport: "app" }, Date.now());
  },
});

export type PressResult =
  | { status: "confirmed" | "advanced"; instance: Doc<"taskInstances"> }
  | { status: "rejected"; reason: string };

function pressStatus(row: Doc<"taskInstances">): "confirmed" | "advanced" {
  return isDoneState(row.state) ? "confirmed" : "advanced";
}

export async function confirmPressedInstance(
  ctx: MutationCtx,
  actor: Actor,
  args: {
    instanceId: Id<"taskInstances">;
    via: ConfirmVia;
    pressedAgoMs: number;
    pressId?: string;
    transport: ConfirmTransport;
  },
  now: number,
  options: { recordRefusal?: boolean } = {},
): Promise<PressResult> {
  if (actor.kind !== "senior_device") {
    throw appError("forbidden", "Only the senior's devices can do this");
  }
  requirePressAge(args.pressedAgoMs);
  const idValid = args.pressId === undefined || isPressId(args.pressId);
  const instance = await ctx.db.get(args.instanceId);
  const rejected = async (reason: string): Promise<PressResult> => {
    if (options.recordRefusal === false) return { status: "rejected", reason };
    await audit(ctx, {
      householdId: actor.householdId,
      actor,
      action: "press_not_applied",
      entity: "task_instance",
      entityId: instance?._id,
      detail: {
        reason,
        pressedAgoMs: args.pressedAgoMs,
        pressedAt: now - args.pressedAgoMs,
        receivedAt: now,
        via: args.via,
        instanceId: args.instanceId,
        transport: args.transport,
        ...(args.pressId === undefined || !idValid ? {} : { pressId: args.pressId }),
      },
    });
    return { status: "rejected", reason };
  };
  if (!idValid) {
    if (instance !== null && instance.householdId !== actor.householdId) {
      throw appError("forbidden", "Not allowed to confirm this task");
    }
    return await rejected(PRESS_ID_NOT_VALID);
  }
  if (instance === null) return await rejected(NO_SUCH_TASK);
  try {
    const row = await confirmInstance(ctx, actor, args, now);
    return { status: pressStatus(row), instance: row };
  } catch (error) {
    if (error instanceof ConvexError && !isAppError(error, "forbidden")) {
      return await rejected((error.data as { message?: string }).message ?? "Not applied");
    }
    throw error;
  }
}

export const confirmPressedTask = mutation({
  args: {
    instanceId: v.id("taskInstances"),
    via: confirmVia,
    pressedAgoMs: v.number(),
    pressId: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<PressResult> => {
    const actor = await requireDeviceActor(ctx);
    return await confirmPressedInstance(ctx, actor, { ...args, transport: "app" }, Date.now());
  },
});

export const undoPressedTask = mutation({
  args: {
    instanceId: v.id("taskInstances"),
    undoneAgoMs: v.optional(v.number()),
    pressId: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<UndoPressResult> => {
    const actor = await requireDeviceActor(ctx);
    return await undoPressedInstance(ctx, actor, args, Date.now());
  },
});

export const reopenTaskInstance = mutation({
  args: { instanceId: v.id("taskInstances") },
  handler: async (ctx, args): Promise<Doc<"taskInstances">> => {
    const instance = await loadInstance(ctx, args.instanceId);
    const actor = await requireEditor(ctx, instance.householdId);
    return await reopenInstance(ctx, actor, args, Date.now());
  },
});

export const snoozeTaskInstance = mutation({
  args: { instanceId: v.id("taskInstances"), minutes: v.optional(v.number()) },
  handler: async (ctx, args): Promise<Doc<"taskInstances">> => {
    const instance = await loadInstance(ctx, args.instanceId);
    const actor = await requireSenior(ctx, instance.householdId);
    return await snoozeInstance(ctx, actor, args, Date.now());
  },
});

export const claimTaskInstance = mutation({
  args: { instanceId: v.id("taskInstances") },
  handler: async (ctx, args): Promise<Doc<"taskInstances">> => {
    const instance = await loadInstance(ctx, args.instanceId);
    const actor = await requireEditor(ctx, instance.householdId);
    return await claimInstance(ctx, actor, args, Date.now());
  },
});

export const setTaskNote = mutation({
  args: { instanceId: v.id("taskInstances"), note: v.optional(v.string()) },
  handler: async (ctx, args): Promise<Doc<"taskInstances">> => {
    const instance = await loadInstance(ctx, args.instanceId);
    const actor = await requireEditor(ctx, instance.householdId);
    return await setTaskNoteCore(ctx, actor, args);
  },
});

export const undoResolve = mutation({
  args: { instanceId: v.id("taskInstances") },
  handler: async (ctx, args): Promise<Doc<"taskInstances">> => {
    const instance = await loadInstance(ctx, args.instanceId);
    const actor = await requireEditor(ctx, instance.householdId);
    return await undoResolveInstance(ctx, actor, args, Date.now());
  },
});

export const today = query({
  args: { householdId: v.id("households") },
  handler: async (ctx, args): Promise<TodayEntry[]> => {
    const actor = await requireReader(ctx, args.householdId);
    return await todayInstances(ctx, args.householdId, Date.now(), actor);
  },
});

export const confirmDueTask = mutation({
  args: { householdId: v.id("households"), via: confirmVia, label: v.optional(v.string()) },
  handler: async (ctx, args): Promise<ConfirmDueResult> => {
    const actor = await requireSenior(ctx, args.householdId);
    return await confirmDueTaskCore(ctx, actor, { ...args, transport: "app" }, Date.now());
  },
});

export const createSeniorReminder = mutation({
  args: {
    householdId: v.id("households"),
    title: v.string(),
    time: v.string(),
    onDate: v.optional(v.string()),
    days: v.optional(v.array(v.number())),
  },
  handler: async (ctx, args): Promise<Doc<"tasks">> => {
    const actor = await requireSenior(ctx, args.householdId);
    return await createSeniorReminderCore(ctx, actor, args, Date.now());
  },
});

export const cancelSeniorReminder = mutation({
  args: { householdId: v.id("households"), query: v.string() },
  handler: async (ctx, args): Promise<CancelReminderResult> => {
    const actor = await requireSenior(ctx, args.householdId);
    return await cancelSeniorReminderCore(ctx, actor, args, Date.now());
  },
});

export const logDose = mutation({
  args: {
    householdId: v.id("households"),
    taskId: v.id("tasks"),
    takenAt: v.number(),
    via: confirmVia,
    note: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<Id<"doseLog">> => {
    const actor = await requireReader(ctx, args.householdId);
    return await logDoseCore(ctx, actor, args, Date.now());
  },
});
