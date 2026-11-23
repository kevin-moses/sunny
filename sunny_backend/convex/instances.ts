import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { mutation, query } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import {
  actorUserId,
  loadHousehold,
  requireEditor,
  requireDeviceActor,
  requireReader,
  requireSenior,
} from "./lib/access";
import type { Actor, CaregiverActor } from "./lib/access";
import { audit } from "./lib/audit";
import {
  EARLY_CONFIRM_MS,
  LATE_SYNC_MS,
  NOT_DUE_YET,
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
import { appError } from "./lib/errors";
import { changeInstance, insertTask, patchTask } from "./lib/schedule";
import { clippedLabel, validateDraft } from "./lib/taskDraft";
import { cleanOptional, normalizeWeekdays } from "./lib/text";
import {
  OTHER_STEP,
  STEP_NOT_VALID,
  advancedStep,
  hasStepAfter,
  isStepIndex,
  latestStepPress,
  pressedOtherStep,
  seniorCanUndoStep,
  stepIndex,
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
    | "not_due_yet"
    | "other_step";
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

const PRESS_AGE_NOT_VALID = "The press age must be zero or more";

function isPressAge(ageMs: number): boolean {
  return Number.isFinite(ageMs) && ageMs >= 0;
}

function requirePressAge(ageMs: number): void {
  if (!isPressAge(ageMs)) throw appError("invalid", PRESS_AGE_NOT_VALID);
}

function requirePressId(pressId: string | undefined): void {
  if (pressId !== undefined && !isPressId(pressId)) {
    throw appError("invalid", PRESS_ID_NOT_VALID);
  }
}

function malformedPress(
  actor: Actor,
  press: { pressedAgoMs?: number; pressId?: string; step?: number },
): string | null {
  const fromDevice = actor.kind === "senior_device";
  if (press.pressedAgoMs !== undefined) {
    if (!fromDevice) return "Only the senior's device can send a press age";
    if (!isPressAge(press.pressedAgoMs)) return PRESS_AGE_NOT_VALID;
  }
  if (press.pressId !== undefined) {
    if (!fromDevice) return "Only the senior's device can send a press id";
    if (!isPressId(press.pressId)) return PRESS_ID_NOT_VALID;
  }
  if (press.step !== undefined && !isStepIndex(press.step)) return STEP_NOT_VALID;
  return null;
}

function pressOutsideWindow(instance: Doc<"taskInstances">, pressedAt: number): string | null {
  if (pressedAt < instance.windowStart - EARLY_CONFIRM_MS) {
    return "This task was not due yet when it was pressed";
  }
  if (pressedAt > instance.windowEnd + REPLAY_GRACE_MS) {
    return "This press was too long after the task's window";
  }
  return null;
}

interface ConfirmArgs {
  instanceId: Id<"taskInstances">;
  via: ConfirmVia;
  note?: string;
  pressedAgoMs?: number;
  pressId?: string;
  step?: number;
  transport?: ConfirmTransport;
}

type ConfirmOutcome =
  | { kind: "applied" | "other_step"; row: Doc<"taskInstances"> }
  | { kind: "not_due"; reason: string }
  | { kind: "refused"; reason: string };

export async function confirmInstance(
  ctx: MutationCtx,
  actor: Actor,
  args: ConfirmArgs,
  now: number,
): Promise<Doc<"taskInstances">> {
  const outcome = await confirmOutcome(ctx, actor, args, now);
  if (outcome.kind === "not_due" || outcome.kind === "refused") {
    throw appError("invalid", outcome.reason);
  }
  return outcome.row;
}

function applied(row: Doc<"taskInstances">): ConfirmOutcome {
  return { kind: "applied", row };
}

async function confirmOutcome(
  ctx: MutationCtx,
  actor: Actor,
  args: ConfirmArgs,
  now: number,
  options: { recordOtherStep?: boolean } = {},
): Promise<ConfirmOutcome> {
  const instance = await loadInstance(ctx, args.instanceId);
  const asCaregiver = isHouseholdEditor(actor, instance.householdId);
  if (!asCaregiver && !actsForSenior(actor, instance.householdId)) {
    throw appError("forbidden", "Not allowed to confirm this task");
  }
  if (!asCaregiver && args.via === "caregiver") {
    throw appError("invalid", "Only a caregiver can confirm as a caregiver");
  }
  const malformed = malformedPress(actor, args);
  if (malformed !== null) throw appError("invalid", malformed);
  const queuedPress: QueuedPress | null =
    args.pressedAgoMs === undefined || actor.kind !== "senior_device"
      ? null
      : { pressedAt: now - args.pressedAgoMs, pressId: args.pressId, userId: actor.userId };
  const note = cleanOptional(args.note, MAX_RESOLUTION_NOTE_LENGTH, "The note");
  const replayed = args.pressedAgoMs !== undefined && args.pressedAgoMs > LATE_SYNC_MS;
  if (args.pressId !== undefined && stepPressed(instance, args.pressId)) return applied(instance);
  if (isDoneState(instance.state)) {
    return applied(await recordNoOpPress(ctx, actor, instance, args.pressId));
  }
  const takenBack = queuedPress === null ? null : queuedPressTakenBack(queuedPress, instance);
  if (takenBack !== null) return { kind: "refused", reason: takenBack };
  if (!(await isDue(ctx, instance, asCaregiver, now))) {
    return { kind: "not_due", reason: NOT_DUE_YET };
  }
  if (replayed && queuedPress !== null) {
    const outsideWindow = pressOutsideWindow(instance, queuedPress.pressedAt);
    if (outsideWindow !== null) return { kind: "refused", reason: outsideWindow };
  }
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
  if (!asCaregiver && pressedOtherStep(step, args.step)) {
    if (options.recordOtherStep !== false) {
      await recordOtherStepPress(ctx, actor, instance, args, stepIndex(step), now);
    }
    return { kind: "other_step", row: instance };
  }
  if (hasStepAfter(step)) {
    const press = { at: now, by: actorUserId(actor), pressId: args.pressId };
    return applied(
      await changeInstance(ctx, actor, instance, advancedStep(instance, step, press), {
        ...pressDetail,
        ...(instance.snoozedUntil === undefined
          ? {}
          : { clearedSnoozedUntil: instance.snoozedUntil }),
      }),
    );
  }
  const confirmed = await changeInstance(
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
  return applied(confirmed);
}

async function isDue(
  ctx: QueryCtx,
  instance: Doc<"taskInstances">,
  asCaregiver: boolean,
  now: number,
): Promise<boolean> {
  if (!asCaregiver) return notTooEarly(instance, now);
  const household = await loadHousehold(ctx, instance.householdId);
  return instance.localDate <= localDate(now, household.timezone);
}

async function instanceStep(
  ctx: QueryCtx,
  instance: Doc<"taskInstances">,
): Promise<ReturnType<typeof taskStep>> {
  const task = await ctx.db.get(instance.taskId);
  return task === null ? null : taskStep(task.checklistItems, instance.currentStep);
}

async function recordOtherStepPress(
  ctx: MutationCtx,
  actor: Actor,
  instance: Doc<"taskInstances">,
  args: ConfirmArgs,
  currentStep: number,
  now: number,
): Promise<void> {
  await audit(ctx, {
    householdId: instance.householdId,
    actor,
    action: "press_not_applied",
    entity: "task_instance",
    entityId: instance._id,
    detail: {
      reason: OTHER_STEP,
      instanceId: instance._id,
      via: args.via,
      pressedStep: args.step,
      currentStep,
      receivedAt: now,
      ...(args.pressedAgoMs === undefined
        ? {}
        : { pressedAgoMs: args.pressedAgoMs, pressedAt: now - args.pressedAgoMs }),
      ...(args.pressId === undefined ? {} : { pressId: args.pressId }),
      ...(args.transport === undefined ? {} : { transport: args.transport }),
    },
  });
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
  pressId: string,
  tappedAt: number,
): Promise<string | null> {
  if (!isDoneState(instance.state)) {
    if (!seniorCanUndoStep(instance, userId, pressId, tappedAt)) {
      return "The task has no step done by this device within the undo window";
    }
  } else if (!(instance.confirmPressIds ?? []).includes(pressId)) {
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
  args: {
    instanceId: Id<"taskInstances">;
    undoneAgoMs?: number;
    pressId: string;
    transport: ConfirmTransport;
  },
  now: number,
  options: { recordRefusal?: boolean } = {},
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
    if (options.recordRefusal === false) return { status: "too_late" };
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
        pressId: args.pressId,
        transport: args.transport,
      },
    });
    return { status: "too_late" };
  }
  const undoDetail = { undo: true, pressId: args.pressId, transport: args.transport };
  if (!isDoneState(instance.state) && latestStepPress(instance) !== null) {
    const steppedBackRow = await changeInstance(
      ctx,
      actor,
      instance,
      {
        ...steppedBack(instance),
        takenBackPressIds: withTakenBackPressIds(instance.takenBackPressIds, [args.pressId]),
      },
      { ...undoDetail, takenBackPressIds: [args.pressId] },
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
    { ...undoDetail, takenBackPressIds: instance.confirmPressIds ?? [] },
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
    step?: number;
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
  const outcome = await confirmOutcome(
    ctx,
    actor,
    { instanceId: entry.instanceId, via: args.via, step: args.step, transport: args.transport },
    now,
  );
  if (outcome.kind === "not_due") return { ...entry, status: "not_due_yet" };
  if (outcome.kind === "refused") throw appError("invalid", outcome.reason);
  const { row } = outcome;
  return {
    ...entry,
    status: outcome.kind === "other_step" ? "other_step" : pressStatus(row),
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
  if (args.onDate !== undefined && !isLocalDate(args.onDate)) {
    throw appError("invalid", "The date must be YYYY-MM-DD");
  }
  const household = await loadHousehold(ctx, args.householdId);
  if (args.onDate !== undefined && args.onDate < localDate(now, household.timezone)) {
    throw appError("invalid", "That date has already passed");
  }
  const days = normalizeWeekdays(args.days ?? [], "Days must be 1 (Monday) to 7 (Sunday)");
  const draft = validateDraft({
    type: "reminder",
    title,
    displayLabel: clippedLabel(title.charAt(0).toUpperCase() + title.slice(1)),
    spokenPrompt: `Reminder: ${title}.`,
    checklistItems: [],
    times: [args.time],
    onceOn: args.onDate,
    daysOfWeek:
      args.onDate === undefined && days.length >= 1 && days.length <= 6 ? days : undefined,
    windowMinutes: REMINDER_WINDOW_MINUTES,
    highPriority: false,
    active: true,
  });
  const taskId = await insertTask(
    ctx,
    actor,
    {
      ...draft,
      householdId: args.householdId,
      createdByKind: "senior",
      createdBy: actorUserId(actor),
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
  args: {
    instanceId: v.id("taskInstances"),
    via: confirmVia,
    note: v.optional(v.string()),
    step: v.optional(v.number()),
  },
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
    step?: number;
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
  const malformed = malformedPress(actor, args);
  if (malformed !== null) {
    if (instance !== null && instance.householdId !== actor.householdId) {
      throw appError("forbidden", "Not allowed to confirm this task");
    }
    return await rejected(malformed);
  }
  if (instance === null) return await rejected(NO_SUCH_TASK);
  const outcome = await confirmOutcome(ctx, actor, args, now, {
    recordOtherStep: options.recordRefusal,
  });
  if (outcome.kind === "not_due" || outcome.kind === "refused") {
    return await rejected(outcome.reason);
  }
  return { status: pressStatus(outcome.row), instance: outcome.row };
}

export const confirmPressedTask = mutation({
  args: {
    instanceId: v.id("taskInstances"),
    via: confirmVia,
    pressedAgoMs: v.number(),
    pressId: v.string(),
    step: v.optional(v.number()),
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
    pressId: v.string(),
  },
  handler: async (ctx, args): Promise<UndoPressResult> => {
    const actor = await requireDeviceActor(ctx);
    return await undoPressedInstance(ctx, actor, { ...args, transport: "app" }, Date.now());
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
  args: {
    householdId: v.id("households"),
    via: confirmVia,
    label: v.optional(v.string()),
    step: v.optional(v.number()),
  },
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
