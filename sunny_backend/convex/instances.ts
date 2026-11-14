// instances.ts
// Purpose: Task instance operations, ported from the Supabase tasks migration: confirm,
// snooze and claim one instance; today's schedule; "Done" (confirmDueTask: which task the
// senior means, with the already-done double dose guard); senior-created reminders; and
// as-needed dose logging; setTaskNote (an editor's note on a task instance, open or done); and
// undoResolve (a caregiver takes back their own "Mark done" within 30 seconds); undoPressedTask
// (a senior device takes back its own Done press within 60 seconds; a late tap returns
// too_late, never an error); and reopenTaskInstance (an editor caregiver reopens a task
// confirmed or resolved earlier today, for example a mistaken tap on the home display).
// The core of each operation is an exported helper taking
// (ctx, actor, args, now) so the voice agent wrappers (phase 2) and the scheduler reuse it;
// the public functions resolve the actor from auth and use the server clock. Every instance
// state, claim, snooze and note change is audited (lib/schedule.changeInstance). A bare "Done"
// (no label) never picks an anytime instance (lib/anytime.ts); it needs the task's label.
// Which task "Done" means is lib/dueTask.pickDueEntry, shared with the voice agent's "not yet".
//
// Last modified: 2026-11-13

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
  notTooEarly,
  reopenedState,
  seniorCanUndo,
} from "./lib/confirmRule";
import { pickDueEntry } from "./lib/dueTask";
import { appError, isAppError } from "./lib/errors";
import { changeInstance, insertTask, patchTask } from "./lib/schedule";
import { cleanOptional, normalizeWeekdays, requireMaxLength } from "./lib/text";
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
/** How long (ms) after resolving an instance its caregiver may undo it. */
export const UNDO_WINDOW_MS = 30_000;

/** Result of confirmDueTask: a status plus the matched entry's fields where there is one. */
export type ConfirmDueResult = Partial<TodayEntry> & {
  status: "confirmed" | "already_done" | "nothing_due" | "not_found" | "ambiguous" | "not_due_yet";
  options?: TodayEntry[];
};

/** Result of cancelSeniorReminder. */
export interface CancelReminderResult {
  status: "cancelled" | "not_found" | "ambiguous";
  titles: string[];
}

/**
 * purpose: Load an instance.
 * @param ctx: (QueryCtx) Context.
 * @param instanceId: (Id<"taskInstances">) Instance.
 * @return: (Promise<Doc<"taskInstances">>) The instance.
 * @raises not_found when it does not exist.
 */
async function loadInstance(
  ctx: QueryCtx,
  instanceId: Id<"taskInstances">,
): Promise<Doc<"taskInstances">> {
  const instance = await ctx.db.get(instanceId);
  if (!instance) throw appError("not_found", "Task instance not found");
  return instance;
}

/**
 * purpose: Resolve the caller to the senior device they are signed in as, whatever household it
 *          belongs to (the core checks the instance's household).
 * @param ctx: (QueryCtx) Context.
 * @return: (Promise<DeviceActor>) The device actor.
 * @raises unauthenticated when signed out; forbidden when the caller is not a paired device.
 */
async function requireDeviceActor(ctx: QueryCtx): Promise<DeviceActor> {
  const userId = await requireUserId(ctx);
  const device = await findDevice(ctx, userId);
  if (!device) throw appError("forbidden", "Only the senior's devices can do this");
  return { kind: "senior_device", userId, householdId: device.householdId, device };
}

/**
 * purpose: Whether an actor acts for the senior of a household: a backend caller or a device
 *          paired to that household.
 * @param actor: (Actor) The actor.
 * @param householdId: (Id<"households">) Household.
 * @return: (boolean) True for agent, system, or a matching senior device.
 */
function actsForSenior(actor: Actor, householdId: Id<"households">): boolean {
  if (actor.kind === "agent" || actor.kind === "system") return true;
  return actor.kind === "senior_device" && actor.householdId === householdId;
}

/**
 * purpose: Whether an actor may edit a household: a primary or member caregiver of it.
 * @param actor: (Actor) The actor.
 * @param householdId: (Id<"households">) Household.
 * @return: (boolean) True for an editor caregiver of that household.
 */
function isHouseholdEditor(actor: Actor, householdId: Id<"households">): actor is CaregiverActor {
  return (
    actor.kind === "caregiver" &&
    actor.householdId === householdId &&
    (actor.role === "primary" || actor.role === "member")
  );
}

/**
 * purpose: Check a press age sent by a senior device.
 * @param ageMs: (number) The age in ms.
 * @return: (void)
 * @raises invalid unless it is a finite number of at least 0.
 */
function requirePressAge(ageMs: number): void {
  if (!Number.isFinite(ageMs) || ageMs < 0) {
    throw appError("invalid", "The press age must be zero or more");
  }
}

/**
 * purpose: Judge a replayed press as of the moment it was pressed.
 * @param instance: (Doc<"taskInstances">) The instance.
 * @param pressedAt: (number) Epoch ms the senior pressed (server now minus the press age).
 * @return: (void)
 * @raises invalid when the press was more than EARLY_CONFIRM_MS before the window started, or
 *         more than REPLAY_GRACE_MS after it ended.
 */
function requirePressInWindow(instance: Doc<"taskInstances">, pressedAt: number): void {
  if (pressedAt < instance.windowStart - EARLY_CONFIRM_MS) {
    throw appError("invalid", "This task was not due yet when it was pressed");
  }
  if (pressedAt > instance.windowEnd + REPLAY_GRACE_MS) {
    throw appError("invalid", "This press was too long after the task's window");
  }
}

/**
 * purpose: Confirm a task instance from any surface. The senior's device or the backend
 *          produces "confirmed"; an editor caregiver produces "resolved" under their name with
 *          confirmedVia "caregiver". A senior device can confirm an upcoming instance
 *          up to 60 minutes early; an editor caregiver can resolve any open task in today's
 *          list or earlier (for example pills given early, or a leftover from yesterday), judged
 *          by the household's timezone, but not one of a later day. Missed ones can still be
 *          confirmed late. Confirming an already confirmed or resolved instance changes nothing
 *          and returns it.
 * @param ctx: (MutationCtx) Mutation context.
 * @param actor: (Actor) Who confirms.
 * @param args: ({instanceId, via, note, pressedAgoMs}) The instance, the surface, an optional
 *        note and an optional press age. pressedAgoMs is how long before this call the senior
 *        pressed Done on a device that held the press (offline) and sent it later. An age, not
 *        a time, so the device's clock skew cannot move the record. Only a senior device may
 *        send it, and it must be a finite number of at least 0. confirmedAt is `now` minus the
 *        age, clamped to between the instance's early-confirm point (windowStart minus
 *        EARLY_CONFIRM_MS) and `now` (never the future); when that is more than
 *        LATE_SYNC_MS before `now`, confirmReceivedAt records `now` so readers can tell a
 *        late-synced confirm from a live one. The audit detail records pressedAgoMs,
 *        confirmedAt and receivedAt. A live press (age of at most LATE_SYNC_MS) is subject to
 *        the early check at `now`. A replayed press (an older age) is judged as of the time it
 *        was pressed, not the time it arrived: it is refused (invalid) if it was pressed more
 *        than EARLY_CONFIRM_MS before the instance's windowStart (the task was not due yet when
 *        she pressed, for example because a caregiver moved it while the phone was offline) or
 *        more than REPLAY_GRACE_MS after its windowEnd (a stale card pressed the morning after
 *        is not an on-time record of last night's task). Without an age confirmedAt is `now`.
 * @param now: (number) Epoch ms.
 * @return: (Promise<Doc<"taskInstances">>) The instance after the call.
 * @raises forbidden when the actor may not confirm; invalid when not due yet (devices and the
 *          agent: more than 60 minutes early; editors: the instance's local date is after today), when via is
 *          "caregiver" for a non-editor, or when the trimmed note is over 500 characters.
 *          A blank note is stored as absent, but never erases a note already on the
 *          instance (set earlier with setTaskNote): without a note the existing one is kept.
 *          Every confirm (device, agent or caregiver) records the state and snooze it replaced
 *          in resolvedFromState and resolvedFromSnoozedUntil, so the senior's undo
 *          (undoPressedInstance), the caregiver's undo and a reopen can use them.
 */
export async function confirmInstance(
  ctx: MutationCtx,
  actor: Actor,
  args: {
    instanceId: Id<"taskInstances">;
    via: ConfirmVia;
    note?: string;
    pressedAgoMs?: number;
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
  if (args.pressedAgoMs !== undefined) {
    if (actor.kind !== "senior_device") {
      throw appError("invalid", "Only the senior's device can send a press age");
    }
    requirePressAge(args.pressedAgoMs);
  }
  const note = cleanOptional(args.note, MAX_RESOLUTION_NOTE_LENGTH, "The note");
  const replayed = args.pressedAgoMs !== undefined && args.pressedAgoMs > LATE_SYNC_MS;
  if (instance.state === "confirmed" || instance.state === "resolved") return instance;
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
  const pressDetail =
    args.pressedAgoMs === undefined
      ? undefined
      : {
          pressedAgoMs: args.pressedAgoMs,
          confirmedAt,
          receivedAt: now,
          replayed,
        };
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
    },
    pressDetail,
  );
}

/**
 * purpose: Snooze senior prompts for an open instance ("not yet"). Caregiver alerts are not
 *          delayed. Instances that are not due or escalated are returned unchanged.
 * @param ctx: (MutationCtx) Mutation context.
 * @param actor: (Actor) Must be the household's senior device or the backend.
 * @param args: ({instanceId, minutes}) The instance and 1..120 minutes (default 15).
 * @param now: (number) Epoch ms.
 * @return: (Promise<Doc<"taskInstances">>) The instance after the call.
 * @raises forbidden for other actors; invalid for minutes outside 1..120.
 */
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

/**
 * purpose: Claim an open instance ("I'm on it"). First claim wins; an already claimed instance
 *          or one that is not due, escalated or missed is returned unchanged.
 * @param ctx: (MutationCtx) Mutation context.
 * @param actor: (Actor) Must be an editor caregiver of the instance's household.
 * @param args: ({instanceId}) The instance.
 * @param now: (number) Epoch ms.
 * @return: (Promise<Doc<"taskInstances">>) The instance after the call.
 * @raises forbidden for any other actor.
 */
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

/**
 * purpose: Set or clear the note on a task instance, open or done. The note is trimmed; a
 *          blank note clears it. The change is audited as action "note" on the instance.
 * @param ctx: (MutationCtx) Mutation context.
 * @param actor: (Actor) Must be an editor caregiver of the instance's household.
 * @param args: ({instanceId, note}) The instance and the new note (absent or blank clears).
 * @return: (Promise<Doc<"taskInstances">>) The instance after the call.
 * @raises forbidden for any other actor; invalid when the trimmed note is over 500 characters.
 */
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

/**
 * purpose: Take back a caregiver's own "Mark done": the instance returns to the state it had
 *          before (due when that was not recorded) with the confirmation fields cleared. The
 *          note and any claim are kept. The restored instance is an ordinary open one, so the
 *          scheduler handles it as usual (upcoming opens when its window starts, due and
 *          escalated close as missed when the window ends; steps already fired are not
 *          repeated). The snooze the resolve cleared is restored too. The change is audited as a
 *          state change with detail undo: true. A caregiver alert that the scheduler skipped as
 *          instance_closed while the instance was resolved is not re-sent after the undo.
 * @param ctx: (MutationCtx) Mutation context.
 * @param actor: (Actor) Must be an editor caregiver of the instance's household.
 * @param args: ({instanceId}) The instance.
 * @param now: (number) Epoch ms.
 * @return: (Promise<Doc<"taskInstances">>) The instance after the call.
 * @raises forbidden for any other actor; invalid when the instance is not resolved, was
 *          resolved by someone else, or was resolved more than 30 seconds ago.
 */
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
      state: instance.resolvedFromState ?? "due",
      confirmedAt: undefined,
      confirmedBy: undefined,
      confirmedVia: undefined,
      confirmReceivedAt: undefined,
      snoozedUntil: instance.resolvedFromSnoozedUntil,
      resolvedFromState: undefined,
      resolvedFromSnoozedUntil: undefined,
    },
    { undo: true },
  );
}

/** Result of undoPressedTask: the restored instance, or too_late (nothing was changed). */
export type UndoPressResult =
  { status: "undone"; instance: Doc<"taskInstances"> } | { status: "too_late" };

/**
 * purpose: Take back a senior device's own Done press ("Morning pills done. Undo"). The instance
 *          returns to the state it had before the confirm (by the clock when that was not
 *          recorded, as a reopen does), with the confirmation fields cleared and the snooze the
 *          confirm cleared restored. Allowed only when the instance is confirmed, this device's
 *          user id is its confirmedBy (not another device's, the voice agent's or a caregiver's
 *          confirm), and the server recorded the confirm at most SENIOR_UNDO_MS ago, measured from
 *          confirmReceivedAt when set (an offline press) else confirmedAt. Any failed condition
 *          returns too_late and changes nothing: a late tap is never an error for the senior,
 *          and an instance that no longer exists also reads as too_late. The change is audited
 *          as a state change with detail undo: true.
 * @param ctx: (MutationCtx) Mutation context.
 * @param actor: (Actor) Must be a senior device of the instance's household.
 * @param args: ({instanceId}) The instance.
 * @param now: (number) Epoch ms.
 * @return: (Promise<UndoPressResult>) undone with the instance, or too_late.
 * @raises forbidden when the actor is not a senior device or the instance belongs to another
 *          household.
 */
export async function undoPressedInstance(
  ctx: MutationCtx,
  actor: Actor,
  args: { instanceId: Id<"taskInstances"> },
  now: number,
): Promise<UndoPressResult> {
  if (actor.kind !== "senior_device") {
    throw appError("forbidden", "Only the senior's devices can do this");
  }
  const instance = await ctx.db.get(args.instanceId);
  if (instance === null) return { status: "too_late" };
  if (instance.householdId !== actor.householdId) {
    throw appError("forbidden", "Not allowed to undo this task");
  }
  if (!seniorCanUndo(instance, actor.userId, now)) return { status: "too_late" };
  const restored = await changeInstance(
    ctx,
    actor,
    instance,
    {
      state: instance.resolvedFromState ?? reopenedState(instance, now),
      confirmedAt: undefined,
      confirmedBy: undefined,
      confirmedVia: undefined,
      confirmReceivedAt: undefined,
      snoozedUntil: instance.resolvedFromSnoozedUntil,
      resolvedFromState: undefined,
      resolvedFromSnoozedUntil: undefined,
    },
    { undo: true },
  );
  return { status: "undone", instance: restored };
}

/**
 * purpose: Reopen a task that was confirmed or resolved by mistake (the home display has no
 *          undo). The instance gets the state the clock says (reopenedState): before its window
 *          upcoming; inside it the recorded prior state when that was due or escalated, else due
 *          (an anytime instance: due); at or after its window end missed. The confirmation
 *          fields and the recorded prior state are cleared; the caregiver's note and any claim
 *          are kept, and no snooze is restored. The escalation ladder simply continues: steps
 *          already fired (firedSteps) are not repeated and steps not yet fired fire as usual
 *          when due. Audited as a state change with detail reopen: true and the previous state,
 *          confirmedAt, confirmedBy and confirmedVia.
 * @param ctx: (MutationCtx) Mutation context.
 * @param actor: (Actor) Must be an editor caregiver of the instance's household.
 * @param args: ({instanceId}) The instance.
 * @param now: (number) Epoch ms.
 * @return: (Promise<Doc<"taskInstances">>) The instance after the call.
 * @raises forbidden for any other actor (viewers, devices, another household); invalid, with a
 *          message a caregiver can read, when the task is not marked done or was marked done on
 *          an earlier day (household time).
 */
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
    const done = instance.state === "confirmed" || instance.state === "resolved";
    throw appError(
      "invalid",
      done
        ? "Only a task marked done today can be reopened."
        : "This task is not marked done, so there is nothing to reopen.",
    );
  }
  const previous: Record<string, unknown> = { reopen: true, state: instance.state };
  if (instance.confirmedAt !== undefined) previous["confirmedAt"] = instance.confirmedAt;
  if (instance.confirmedBy !== undefined) previous["confirmedBy"] = instance.confirmedBy;
  if (instance.confirmedVia !== undefined) previous["confirmedVia"] = instance.confirmedVia;
  return await changeInstance(
    ctx,
    actor,
    instance,
    {
      state: reopenedState(instance, now),
      confirmedAt: undefined,
      confirmedBy: undefined,
      confirmedVia: undefined,
      confirmReceivedAt: undefined,
      resolvedFromState: undefined,
      resolvedFromSnoozedUntil: undefined,
    },
    previous,
  );
}

/**
 * purpose: Confirm "the task" the senior means: the one rule for the Done button, the widget
 *          and voice. already_done carries the original confirmedAt, guarding against double
 *          doses; not_due_yet means the matched task is more than an hour away.
 * @param ctx: (MutationCtx) Mutation context.
 * @param actor: (Actor) Must be the household's senior device or the backend.
 * @param args: ({householdId, via, label}) Household, surface and optional label to match.
 * @param now: (number) Epoch ms; its household-local date defines today.
 * @return: (Promise<ConfirmDueResult>) Status plus the matched entry's fields.
 * @raises forbidden for other actors.
 */
export async function confirmDueTaskCore(
  ctx: MutationCtx,
  actor: Actor,
  args: { householdId: Id<"households">; via: ConfirmVia; label?: string },
  now: number,
): Promise<ConfirmDueResult> {
  if (!actsForSenior(actor, args.householdId)) {
    throw appError("forbidden", "Only the senior's devices can do this");
  }
  const picked = pickDueEntry(await todayInstances(ctx, args.householdId, now), args.label);
  if (!("entry" in picked)) return picked;
  const { entry } = picked;
  let row: Doc<"taskInstances">;
  try {
    row = await confirmInstance(ctx, actor, { instanceId: entry.instanceId, via: args.via }, now);
  } catch (e) {
    if (isAppError(e, "invalid")) return { ...entry, status: "not_due_yet" };
    throw e;
  }
  return {
    ...entry,
    status: "confirmed",
    state: row.state,
    confirmedAt: row.confirmedAt ?? null,
  };
}

/**
 * purpose: Create a reminder the senior asked for ("remind me to call the plumber tomorrow at
 *          10"): a senior-created task on the household's prompt-only policy with a 30 minute
 *          window. One-off when onDate is given (today or later), otherwise recurring on days
 *          (ISO weekdays; absent or all seven = every day).
 * @param ctx: (MutationCtx) Mutation context.
 * @param actor: (Actor) Must be the household's senior device or the backend.
 * @param args: ({householdId, title, time, onDate, days}) The reminder.
 * @param now: (number) Epoch ms.
 * @return: (Promise<Doc<"tasks">>) The new task.
 * @raises forbidden for other actors; invalid for a blank or over-long (200) title, bad
 *         time or past date.
 */
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

/**
 * purpose: Cancel a reminder the senior created, by case-insensitive title match. Caregiver
 *          tasks are never matched and a blank query matches nothing. Cancelling deactivates
 *          the task and removes its open instances so nothing keeps prompting.
 * @param ctx: (MutationCtx) Mutation context.
 * @param actor: (Actor) Must be the household's senior device or the backend.
 * @param args: ({householdId, query}) Household and the words to match in the title.
 * @param now: (number) Epoch ms.
 * @return: (Promise<CancelReminderResult>) cancelled | not_found | ambiguous, with titles.
 * @raises forbidden for other actors.
 */
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

/**
 * purpose: Record an as-needed dose taken outside a scheduled instance.
 * @param ctx: (MutationCtx) Mutation context.
 * @param actor: (Actor) An editor caregiver, the household's device, or the backend.
 * @param args: ({householdId, taskId, takenAt, via, note, conversationId}) The dose, and the
 *        voice conversation it was reported in (the voice agent only).
 * @param now: (number) Epoch ms.
 * @return: (Promise<Id<"doseLog">>) The new log row.
 * @raises forbidden for other actors; invalid when takenAt is not a finite number or is more
 *         than 5 minutes ahead; not_found when the task is not in the household.
 */
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

/**
 * purpose: Confirm a task instance. A paired senior device confirms it; an editor caregiver
 *          resolves it under their name; viewers and outsiders are forbidden.
 * @param instanceId: (Id<"taskInstances">) Instance.
 * @param via: (ConfirmVia) Surface that confirmed.
 * @param note: (string, optional) Resolution note.
 * @return: (Doc<"taskInstances">) The instance after the call. (A press held offline and sent
 *          later goes through confirmPressedTask instead.)
 */
export const confirmTaskInstance = mutation({
  args: { instanceId: v.id("taskInstances"), via: confirmVia, note: v.optional(v.string()) },
  handler: async (ctx, args): Promise<Doc<"taskInstances">> => {
    const instance = await loadInstance(ctx, args.instanceId);
    const actor = await requireReader(ctx, instance.householdId);
    return await confirmInstance(ctx, actor, args, Date.now());
  },
});

/** Result of confirmPressedTask. */
export type PressResult =
  { status: "confirmed"; instance: Doc<"taskInstances"> } | { status: "rejected"; reason: string };

/**
 * purpose: Confirm a task from a press the senior's device held and sent later (or sent at
 *          once): confirmInstance with a press age, for senior devices only, where a refusal
 *          does not throw. Refusing would make the device drop a press the senior really made
 *          (and was told was checked off), so a refused press (instance gone, not due yet for
 *          a live press, ...) returns { status: "rejected", reason } and writes an audit row
 *          (action "press_not_applied", the instance id if known, the reason, the press age and
 *          time) so the household has a server-side record. Authorization failures still throw:
 *          a caller that is not a device, or an instance of another household.
 * @param ctx: (MutationCtx) Mutation context.
 * @param actor: (Actor) Must be a senior device.
 * @param args: ({instanceId, via, pressedAgoMs}) The instance, the surface and the press age.
 * @param now: (number) Epoch ms.
 * @return: (Promise<PressResult>) confirmed with the instance, or rejected with the reason.
 * @raises forbidden when the actor is not a senior device or the instance belongs to another
 *          household; invalid for an age that is not a finite number of at least 0.
 */
export async function confirmPressedInstance(
  ctx: MutationCtx,
  actor: Actor,
  args: { instanceId: Id<"taskInstances">; via: ConfirmVia; pressedAgoMs: number },
  now: number,
): Promise<PressResult> {
  if (actor.kind !== "senior_device") {
    throw appError("forbidden", "Only the senior's devices can do this");
  }
  requirePressAge(args.pressedAgoMs);
  const instance = await ctx.db.get(args.instanceId);
  if (instance !== null && instance.householdId !== actor.householdId) {
    throw appError("forbidden", "Not allowed to confirm this task");
  }
  /**
   * purpose: Record a press that could not be applied and build the rejected result.
   * @param reason: (string) Why.
   * @return: (Promise<PressResult>) The rejected result.
   */
  const rejected = async (reason: string): Promise<PressResult> => {
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
      },
    });
    return { status: "rejected", reason };
  };
  if (instance === null) return await rejected("The task no longer exists");
  try {
    return { status: "confirmed", instance: await confirmInstance(ctx, actor, args, now) };
  } catch (error) {
    if (error instanceof ConvexError && !isAppError(error, "forbidden")) {
      return await rejected((error.data as { message?: string }).message ?? "Not applied");
    }
    throw error;
  }
}

/**
 * purpose: Confirm a task from the senior device's queued press (see confirmPressedInstance).
 *          Senior devices only.
 * @param instanceId: (Id<"taskInstances">) Instance.
 * @param via: (ConfirmVia) Surface that confirmed.
 * @param pressedAgoMs: (number) How long ago (ms) the senior pressed Done.
 * @return: (PressResult) confirmed with the instance, or rejected with the reason (also audited).
 */
export const confirmPressedTask = mutation({
  args: { instanceId: v.id("taskInstances"), via: confirmVia, pressedAgoMs: v.number() },
  handler: async (ctx, args): Promise<PressResult> => {
    const actor = await requireDeviceActor(ctx);
    return await confirmPressedInstance(ctx, actor, args, Date.now());
  },
});

/**
 * purpose: Take back the senior device's own Done press (the phone shows Undo for 30 seconds;
 *          the server allows 60). Senior devices only. A press that can no longer be undone
 *          returns { status: "too_late" } and changes nothing, never an error.
 * @param instanceId: (Id<"taskInstances">) Instance.
 * @return: (UndoPressResult) undone with the instance, or too_late.
 */
export const undoPressedTask = mutation({
  args: { instanceId: v.id("taskInstances") },
  handler: async (ctx, args): Promise<UndoPressResult> => {
    const actor = await requireDeviceActor(ctx);
    return await undoPressedInstance(ctx, actor, args, Date.now());
  },
});

/**
 * purpose: Reopen a task confirmed or resolved earlier today, by anyone. Editor caregivers only.
 * @param instanceId: (Id<"taskInstances">) Instance.
 * @return: (Doc<"taskInstances">) The instance after the call.
 */
export const reopenTaskInstance = mutation({
  args: { instanceId: v.id("taskInstances") },
  handler: async (ctx, args): Promise<Doc<"taskInstances">> => {
    const instance = await loadInstance(ctx, args.instanceId);
    const actor = await requireEditor(ctx, instance.householdId);
    return await reopenInstance(ctx, actor, args, Date.now());
  },
});

/**
 * purpose: "Not yet": snooze senior prompts for an open instance. The senior's devices only.
 * @param instanceId: (Id<"taskInstances">) Instance.
 * @param minutes: (number, optional) 1..120, default 15.
 * @return: (Doc<"taskInstances">) The instance after the call.
 */
export const snoozeTaskInstance = mutation({
  args: { instanceId: v.id("taskInstances"), minutes: v.optional(v.number()) },
  handler: async (ctx, args): Promise<Doc<"taskInstances">> => {
    const instance = await loadInstance(ctx, args.instanceId);
    const actor = await requireSenior(ctx, instance.householdId);
    return await snoozeInstance(ctx, actor, args, Date.now());
  },
});

/**
 * purpose: "I'm on it": claim an open instance. Editor caregivers only; first claim wins.
 * @param instanceId: (Id<"taskInstances">) Instance.
 * @return: (Doc<"taskInstances">) The instance after the call.
 */
export const claimTaskInstance = mutation({
  args: { instanceId: v.id("taskInstances") },
  handler: async (ctx, args): Promise<Doc<"taskInstances">> => {
    const instance = await loadInstance(ctx, args.instanceId);
    const actor = await requireEditor(ctx, instance.householdId);
    return await claimInstance(ctx, actor, args, Date.now());
  },
});

/**
 * purpose: Set or clear the note on a task instance (open or done). Editor caregivers of the
 *          instance's household only.
 * @param instanceId: (Id<"taskInstances">) Instance.
 * @param note: (string, optional) The note; absent or blank clears it, at most 500 characters.
 * @return: (Doc<"taskInstances">) The instance after the call.
 */
export const setTaskNote = mutation({
  args: { instanceId: v.id("taskInstances"), note: v.optional(v.string()) },
  handler: async (ctx, args): Promise<Doc<"taskInstances">> => {
    const instance = await loadInstance(ctx, args.instanceId);
    const actor = await requireEditor(ctx, instance.householdId);
    return await setTaskNoteCore(ctx, actor, args);
  },
});

/**
 * purpose: Undo the caller's own "Mark done" within 30 seconds. Editor caregivers only.
 * @param instanceId: (Id<"taskInstances">) Instance.
 * @return: (Doc<"taskInstances">) The instance after the call.
 */
export const undoResolve = mutation({
  args: { instanceId: v.id("taskInstances") },
  handler: async (ctx, args): Promise<Doc<"taskInstances">> => {
    const instance = await loadInstance(ctx, args.instanceId);
    const actor = await requireEditor(ctx, instance.householdId);
    return await undoResolveInstance(ctx, actor, args, Date.now());
  },
});

/**
 * purpose: Today's schedule for the household, in order. Readers only.
 * @param householdId: (Id<"households">) Household.
 * @return: (TodayEntry[]) Today's entries.
 */
export const today = query({
  args: { householdId: v.id("households") },
  handler: async (ctx, args): Promise<TodayEntry[]> => {
    await requireReader(ctx, args.householdId);
    return await todayInstances(ctx, args.householdId, Date.now());
  },
});

/**
 * purpose: The Done button, widget and voice: confirm the task the senior means. The
 *          senior's devices only.
 * @param householdId: (Id<"households">) Household.
 * @param via: (ConfirmVia) Surface.
 * @param label: (string, optional) Words from the task's display label.
 * @return: (ConfirmDueResult) Status and the matched task.
 */
export const confirmDueTask = mutation({
  args: { householdId: v.id("households"), via: confirmVia, label: v.optional(v.string()) },
  handler: async (ctx, args): Promise<ConfirmDueResult> => {
    const actor = await requireSenior(ctx, args.householdId);
    return await confirmDueTaskCore(ctx, actor, args, Date.now());
  },
});

/**
 * purpose: Create a reminder for the senior. The senior's devices only (the voice agent gets a
 *          backend wrapper in phase 2).
 * @param householdId: (Id<"households">) Household.
 * @param title: (string) What to be reminded of.
 * @param time: (string) Local "HH:MM".
 * @param onDate: (string, optional) One-off local date, today or later.
 * @param days: (number[], optional) ISO weekdays for a recurring reminder.
 * @return: (Doc<"tasks">) The new task.
 */
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

/**
 * purpose: Cancel a reminder the senior created, matched by title words. The senior's devices
 *          only.
 * @param householdId: (Id<"households">) Household.
 * @param query: (string) Words in the reminder's title.
 * @return: (CancelReminderResult) cancelled | not_found | ambiguous, with titles.
 */
export const cancelSeniorReminder = mutation({
  args: { householdId: v.id("households"), query: v.string() },
  handler: async (ctx, args): Promise<CancelReminderResult> => {
    const actor = await requireSenior(ctx, args.householdId);
    return await cancelSeniorReminderCore(ctx, actor, args, Date.now());
  },
});

/**
 * purpose: Log an as-needed dose taken outside a scheduled instance, reported by the caller.
 *          Editor caregivers and the household's devices.
 * @param householdId: (Id<"households">) Household.
 * @param taskId: (Id<"tasks">) The as-needed task.
 * @param takenAt: (number) Epoch ms the dose was taken (at most 5 minutes ahead).
 * @param via: (ConfirmVia) Surface that reported it.
 * @param note: (string, optional) Free text.
 * @return: (Id<"doseLog">) The new log row.
 */
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
