// instances.ts
// Purpose: Task instance operations, ported from the Supabase tasks migration: confirm,
// snooze and claim one instance; today's schedule; "Done" (confirmDueTask: which task the
// senior means, with the already-done double dose guard); senior-created reminders; and
// as-needed dose logging. The core of each operation is an exported helper taking
// (ctx, actor, args, now) so the voice agent wrappers (phase 2) and the scheduler reuse it;
// the public functions resolve the actor from auth and use the server clock. Every instance
// state, claim and snooze change is audited (lib/schedule.changeInstance).
//
// Last modified: 2026-10-28

import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { mutation, query } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { requireEditor, requireReader, requireSenior } from "./lib/access";
import type { Actor } from "./lib/access";
import { appError, isAppError } from "./lib/errors";
import { changeInstance, insertTask, patchTask } from "./lib/schedule";
import { isLocalDate, isLocalTime, localDate, minutes } from "./lib/time";
import { todayInstances } from "./lib/today";
import type { TodayEntry } from "./lib/today";
import { confirmVia } from "./lib/validators";
import type { ConfirmVia } from "./lib/validators";

const EARLY_CONFIRM_MS = minutes(60);
const DOSE_CLOCK_SKEW_MS = minutes(5);
const DEFAULT_SNOOZE_MINUTES = 15;
const MAX_SNOOZE_MINUTES = 120;
const REMINDER_WINDOW_MINUTES = 30;

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
function isHouseholdEditor(actor: Actor, householdId: Id<"households">): boolean {
  return (
    actor.kind === "caregiver" &&
    actor.householdId === householdId &&
    (actor.role === "primary" || actor.role === "member")
  );
}

/**
 * purpose: Confirm a task instance from any surface. The senior's device or the backend
 *          produces "confirmed"; an editor caregiver produces "resolved" under their name with
 *          confirmedVia "caregiver". Upcoming instances can be confirmed up to 60 minutes
 *          early; missed ones can still be confirmed late. Confirming an already confirmed or
 *          resolved instance changes nothing and returns it.
 * @param ctx: (MutationCtx) Mutation context.
 * @param actor: (Actor) Who confirms.
 * @param args: ({instanceId, via, note}) The instance, the surface and an optional note.
 * @param now: (number) Epoch ms.
 * @return: (Promise<Doc<"taskInstances">>) The instance after the call.
 * @raises forbidden when the actor may not confirm; invalid when not due yet.
 */
export async function confirmInstance(
  ctx: MutationCtx,
  actor: Actor,
  args: { instanceId: Id<"taskInstances">; via: ConfirmVia; note?: string },
  now: number,
): Promise<Doc<"taskInstances">> {
  const instance = await loadInstance(ctx, args.instanceId);
  const asCaregiver = isHouseholdEditor(actor, instance.householdId);
  if (!asCaregiver && !actsForSenior(actor, instance.householdId)) {
    throw appError("forbidden", "Not allowed to confirm this task");
  }
  if (instance.state === "confirmed" || instance.state === "resolved") return instance;
  if (instance.state === "upcoming" && instance.windowStart - now > EARLY_CONFIRM_MS) {
    throw appError("invalid", "This task is not due yet");
  }
  return await changeInstance(ctx, actor, instance, {
    state: asCaregiver ? "resolved" : "confirmed",
    confirmedAt: now,
    confirmedBy: "userId" in actor ? actor.userId : undefined,
    confirmedVia: asCaregiver ? "caregiver" : args.via,
    resolutionNote: args.note,
    snoozedUntil: undefined,
  });
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
  if (actor.kind !== "caregiver" || !isHouseholdEditor(actor, instance.householdId)) {
    throw appError("forbidden", "Not allowed to claim this task");
  }
  const claimable =
    instance.state === "due" || instance.state === "escalated" || instance.state === "missed";
  if (instance.claimedBy !== undefined || !claimable) return instance;
  return await changeInstance(ctx, actor, instance, { claimedBy: actor.userId, claimedAt: now });
}

/**
 * purpose: Pick the entry "Done" means. No label: the earliest due or escalated entry. With a
 *          label: entries whose display label contains it (case-insensitive), preferring those
 *          due now, then any still open, else already done.
 * @param today: (TodayEntry[]) Today's entries in schedule order.
 * @param label: (string | null) Lower-cased, trimmed label, or null for none.
 * @return: (ConfirmDueResult | {entry: TodayEntry}) A final result, or the entry to confirm.
 */
function pickDueEntry(
  today: TodayEntry[],
  label: string | null,
): ConfirmDueResult | { entry: TodayEntry } {
  const isDue = (e: TodayEntry) => e.state === "due" || e.state === "escalated";
  if (label === null) {
    const entry = today.find(isDue);
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
  // Another surface may have confirmed it first; then this press did nothing and says so,
  // with the original time.
  return {
    ...entry,
    status: row.confirmedAt === now ? "confirmed" : "already_done",
    state: row.state,
    confirmedAt: row.confirmedAt,
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
 * @raises forbidden for other actors; invalid for a blank title, bad time or past date.
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
  if (args.onDate !== undefined && !isLocalDate(args.onDate)) {
    throw appError("invalid", "The date must be YYYY-MM-DD");
  }
  const household = await ctx.db.get(args.householdId);
  if (!household) throw appError("not_found", "Household not found");
  if (args.onDate !== undefined && args.onDate < localDate(now, household.timezone)) {
    throw appError("invalid", "That date has already passed");
  }
  const days = [...new Set(args.days ?? [])];
  if (!days.every((d) => Number.isInteger(d) && d >= 1 && d <= 7)) {
    throw appError("invalid", "Days must be 1 (Monday) to 7 (Sunday)");
  }
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
        args.onDate === undefined && days.length >= 1 && days.length <= 6
          ? days.sort((a, b) => a - b)
          : undefined,
      windowMinutes: REMINDER_WINDOW_MINUTES,
      escalationPolicyId: policy?._id,
      createdByKind: "senior",
      createdBy: "userId" in actor ? actor.userId : undefined,
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
 * @raises forbidden for other actors; invalid when takenAt is more than 5 minutes ahead;
 *         not_found when the task is not in the household.
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
    reportedBy: "userId" in actor ? actor.userId : undefined,
    note: args.note,
  });
}

/**
 * purpose: Confirm a task instance. A paired senior device confirms it; an editor caregiver
 *          resolves it under their name; viewers and outsiders are forbidden.
 * @param instanceId: (Id<"taskInstances">) Instance.
 * @param via: (ConfirmVia) Surface that confirmed.
 * @param note: (string, optional) Resolution note.
 * @return: (Doc<"taskInstances">) The instance after the call.
 */
export const confirmTaskInstance = mutation({
  args: { instanceId: v.id("taskInstances"), via: confirmVia, note: v.optional(v.string()) },
  handler: async (ctx, args): Promise<Doc<"taskInstances">> => {
    const instance = await loadInstance(ctx, args.instanceId);
    const actor = await requireReader(ctx, instance.householdId);
    return await confirmInstance(ctx, actor, args, Date.now());
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
