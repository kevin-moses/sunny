// instances.ts
// Purpose: Task instance operations, ported from the Supabase tasks migration: confirm,
// snooze and claim one instance; today's schedule; "Done" (confirmDueTask: which task the
// senior means, with the already-done double dose guard); senior-created reminders; and
// as-needed dose logging; setTaskNote (an editor's note on a task instance, open or done); and
// undoResolve (a caregiver takes back their own "Mark done" within 30 seconds).
// The core of each operation is an exported helper taking
// (ctx, actor, args, now) so the voice agent wrappers (phase 2) and the scheduler reuse it;
// the public functions resolve the actor from auth and use the server clock. Every instance
// state, claim, snooze and note change is audited (lib/schedule.changeInstance). A bare "Done"
// (no label) never picks an anytime instance (lib/anytime.ts); it needs the task's label.
//
// Last modified: 2026-11-09

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
import { isAnytimeInstance } from "./lib/anytime";
import { EARLY_CONFIRM_MS, LATE_SYNC_MS, notTooEarly } from "./lib/confirmRule";
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
 *        the early check at `now`. A replayed press (an older age) skips it: the age is evidence
 *        of an earlier real press, and the limit exists to stop accidental live presses (the
 *        client and the live path still enforce it); the audit detail then records
 *        earlyCheckBypassed and confirmReceivedAt is set. Without an age confirmedAt is `now`.
 * @param now: (number) Epoch ms.
 * @return: (Promise<Doc<"taskInstances">>) The instance after the call.
 * @raises forbidden when the actor may not confirm; invalid when not due yet (devices and the
 *          agent: more than 60 minutes early; editors: the instance's local date is after today), when via is
 *          "caregiver" for a non-editor, or when the trimmed note is over 500 characters.
 *          A blank note is stored as absent, but never erases a note already on the
 *          instance (set earlier with setTaskNote): without a note the existing one is kept.
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
    if (!Number.isFinite(args.pressedAgoMs) || args.pressedAgoMs < 0) {
      throw appError("invalid", "The press age must be zero or more");
    }
  }
  const note = cleanOptional(args.note, MAX_RESOLUTION_NOTE_LENGTH, "The note");
  const replayed = args.pressedAgoMs !== undefined && args.pressedAgoMs > LATE_SYNC_MS;
  if (instance.state === "confirmed" || instance.state === "resolved") return instance;
  if (asCaregiver) {
    const household = await loadHousehold(ctx, instance.householdId);
    if (instance.localDate > localDate(now, household.timezone)) {
      throw appError("invalid", "This task is not due yet");
    }
  } else if (!replayed && !notTooEarly(instance, now)) {
    throw appError("invalid", "This task is not due yet");
  }
  const bypassed = replayed && !asCaregiver && !notTooEarly(instance, now);
  const confirmedAt =
    args.pressedAgoMs === undefined
      ? now
      : Math.min(now, Math.max(now - args.pressedAgoMs, instance.windowStart - EARLY_CONFIRM_MS));
  const lateSynced = bypassed || now - confirmedAt > LATE_SYNC_MS;
  const pressDetail =
    args.pressedAgoMs === undefined
      ? undefined
      : {
          pressedAgoMs: args.pressedAgoMs,
          confirmedAt,
          receivedAt: now,
          replayed,
          earlyCheckBypassed: bypassed,
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
      resolvedFromState: asCaregiver ? instance.state : undefined,
      resolvedFromSnoozedUntil: asCaregiver ? instance.snoozedUntil : undefined,
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

/**
 * purpose: Pick the entry "Done" means. No label: the earliest due or escalated timed entry
 *          (anytime entries are only matched by label). With a label: entries whose display
 *          label contains it (case-insensitive), preferring those due now, then any still open,
 *          else already done.
 * @param today: (TodayEntry[]) Today's entries in schedule order.
 * @param label: (string | null) Lower-cased, trimmed label, or null for none.
 * @return: (ConfirmDueResult | {entry: TodayEntry}) A final result, or the entry to confirm.
 */
function pickDueEntry(
  today: TodayEntry[],
  label: string | null,
): ConfirmDueResult | { entry: TodayEntry } {
  /**
   * purpose: Whether an entry is open for confirmation right now.
   * @param e: (TodayEntry) The entry.
   * @return: (boolean) True when due or escalated.
   */
  const isDue = (e: TodayEntry): boolean => e.state === "due" || e.state === "escalated";
  if (label === null) {
    // An anytime entry is open all day, so a bare "Done" never means it; it needs its label.
    const entry = today.find((e) => isDue(e) && !isAnytimeInstance(e));
    return entry ? { entry } : { status: "nothing_due" };
  }
  const matches = today.filter((e) => e.displayLabel.toLowerCase().includes(label));
  if (matches.length === 0) return { status: "not_found" };
  let open = matches.filter(isDue);
  if (open.length === 0) {
    open = matches.filter((e) => e.state !== "confirmed" && e.state !== "resolved");
  }
  if (open.length === 0) {
    const latest = matches.reduce((a, b) => ((b.confirmedAt ?? 0) > (a.confirmedAt ?? 0) ? b : a));
    return { ...latest, status: "already_done" };
  }
  if (open.length > 1) return { status: "ambiguous", options: open };
  return { entry: open[0]! };
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
  const label = (args.label ?? "").trim().toLowerCase() || null;
  const picked = pickDueEntry(await todayInstances(ctx, args.householdId, now), label);
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
 * @param args: ({householdId, taskId, takenAt, via, note}) The dose.
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
  if (!Number.isFinite(args.pressedAgoMs) || args.pressedAgoMs < 0) {
    throw appError("invalid", "The press age must be zero or more");
  }
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
    const userId = await requireUserId(ctx);
    const device = await findDevice(ctx, userId);
    if (!device) throw appError("forbidden", "Only the senior's devices can do this");
    const actor: DeviceActor = {
      kind: "senior_device",
      userId,
      householdId: device.householdId,
      device,
    };
    return await confirmPressedInstance(ctx, actor, args, Date.now());
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
