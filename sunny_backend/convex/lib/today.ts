// lib/today.ts
// Purpose: The senior's schedule for today, ported from private.today_json. Today is the
// household-local date of the given instant, plus any instance from the previous local date
// whose window crosses midnight and is still due or escalated (a 23:30 task with a 120 minute
// window is still being prompted at 00:10, so it must still be listed and confirmable; an
// anytime instance stays open through the whole next day, so yesterday's undone one is
// listed as carried over and the day after it is not).
// Entries are ordered by window start with anytime instances (lib/anytime.ts) after the timed
// ones of the same day, yesterday's first, and carry the task fields every
// surface (display, widget, agent context) renders. Absent optional
// values are null, not missing keys, as in the other view-shaped results (lib/occurrences).
//
// Each entry also says who claimed it ("I'm on it"): claimedBy is the claimer's user id and
// claimedByName their household display name (null when unclaimed or no longer a member).
// confirmedBy is the confirming user id; confirmedByName is the household display name of the
// caregiver who marked it done (state "resolved"), null for a device confirmation or when the
// member is gone. confirmedLocalTime is the household-local "HH:MM" of confirmedAt. localDate
// is the instance's own local date and carriedOver is true for yesterday's still-open
// instances, and resolutionNote is the note the caregiver left. confirmReceivedAt is set when a
// confirm pressed offline reached the server late (confirmReceivedLocalTime and
// confirmReceivedDaysLater say when, in household time). confirmable says whether a senior
// device may confirm the instance now (lib/confirmRule.ts, the confirm mutation's own rule), so
// a surface can offer Done early without copying the 60 minute constant. reopenable says
// whether an editor caregiver may reopen it (confirmed or resolved, and either marked done
// today or one of today's tasks; the role is the mutation's check), so the app can show the
// control without copying the rule. seniorPrompts counts the senior prompts the escalation
// policy has sent for the instance (fired prompt_senior steps that were notified), so the
// home display can repeat its due cue on each reprompt; snoozed is true while a snooze
// ("not yet") holds the senior prompts back at `now`, the scheduler's own test, so the
// display holds its cue until the snooze ends; snoozedUntil is when the latest snooze ends
// (kept after it passed), so the display owes one cue per snooze end.
//
// Last modified: 2026-11-13

import type { Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { memberNames } from "./access";
import { compareDayOrder } from "./anytime";
import { caregiverCanReopen, seniorCanConfirm } from "./confirmRule";
import { addDays, daysBetween, localDate, localTime } from "./time";
import type { ConfirmVia, InstanceState, TaskType } from "./validators";

/** One of today's instances joined with its task. */
export interface TodayEntry {
  instanceId: Id<"taskInstances">;
  /** The instance's household-local date, "YYYY-MM-DD" (yesterday's for a carry-over). */
  localDate: string;
  /** True for yesterday's instance that is still due or escalated. */
  carriedOver: boolean;
  taskId: Id<"tasks">;
  type: TaskType;
  displayLabel: string;
  spokenPrompt: string;
  pillDescription: string | null;
  checklistItems: string[];
  /** Household-local "HH:MM", or the ANYTIME sentinel ("anytime") for a task without a time. */
  scheduledTime: string;
  state: InstanceState;
  confirmedAt: number | null;
  /** Household-local "HH:MM" of confirmedAt; null when not confirmed. */
  confirmedLocalTime: string | null;
  confirmedVia: ConfirmVia | null;
  /** When the server received a late-synced confirm (pressed offline); null for a live one. */
  confirmReceivedAt: number | null;
  /** Household-local "HH:MM" of confirmReceivedAt; null when it is null. */
  confirmReceivedLocalTime: string | null;
  /** Local days from confirmedAt to confirmReceivedAt (0 same day); null when absent. */
  confirmReceivedDaysLater: number | null;
  claimedBy: string | null;
  claimedByName: string | null;
  /**
   * The confirming user id: the caregiver's for a resolution, the device's account id for a
   * device confirmation; null when unconfirmed.
   */
  confirmedBy: string | null;
  /** The caregiver's display name; null unless state is "resolved", or when they left. */
  confirmedByName: string | null;
  resolutionNote: string | null;
  /** A senior device may confirm it now (open and not more than 60 minutes early). */
  confirmable: boolean;
  /** An editor caregiver may reopen it now: confirmed or resolved, marked done today or due today. */
  reopenable: boolean;
  /** How many senior prompts (notified prompt_senior steps) have been sent; 0 before any. */
  seniorPrompts: number;
  /** True while the instance is snoozed (now is before its snoozedUntil). */
  snoozed: boolean;
  /** When the latest snooze ends or ended (epoch ms); null when never snoozed. */
  snoozedUntil: number | null;
}

/**
 * purpose: How many local days after the confirmation a late-synced confirm reached the server.
 * @param instance: (object) The instance's confirmedAt and confirmReceivedAt.
 * @param timezone: (string) The household's IANA zone.
 * @return: (number | null) 0 for the same local day, 1 for the next, and so on; null when the
 *          instance has no confirmReceivedAt (or no confirmedAt).
 */
export function receivedDaysLater(
  instance: { confirmedAt?: number; confirmReceivedAt?: number },
  timezone: string,
): number | null {
  if (instance.confirmedAt === undefined || instance.confirmReceivedAt === undefined) return null;
  return daysBetween(
    localDate(instance.confirmedAt, timezone),
    localDate(instance.confirmReceivedAt, timezone),
  );
}

/**
 * purpose: Today's instances for a household in schedule order, preceded by yesterday's
 *          instances that are still due or escalated.
 * @param ctx: (QueryCtx) Context.
 * @param householdId: (Id<"households">) Household.
 * @param now: (number) Epoch ms; its household-local date defines "today".
 * @return: (TodayEntry[]) Entries ordered by window start, anytime ones last within a day
 *          (yesterday's carry-over first); empty if the household is gone.
 */
export async function todayInstances(
  ctx: QueryCtx,
  householdId: Id<"households">,
  now: number,
): Promise<TodayEntry[]> {
  const household = await ctx.db.get(householdId);
  if (!household) return [];
  const date = localDate(now, household.timezone);
  const carryOver = (
    await ctx.db
      .query("taskInstances")
      .withIndex("by_household_date", (q) =>
        q.eq("householdId", householdId).eq("localDate", addDays(date, -1)),
      )
      .collect()
  )
    .filter((i) => i.state === "due" || i.state === "escalated")
    .sort(compareDayOrder);
  const todays = (
    await ctx.db
      .query("taskInstances")
      .withIndex("by_household_date", (q) => q.eq("householdId", householdId).eq("localDate", date))
      .collect()
  ).sort(compareDayOrder);
  const carriedIds = new Set(carryOver.map((i) => i._id));
  const names = await memberNames(ctx, householdId);
  /**
   * purpose: A member's display name.
   * @param userId: (string | null) Clerk user id, or null.
   * @return: (string | null) The name; null for null, or when no longer a member.
   */
  const nameOf = (userId: string | null): string | null =>
    userId === null ? null : (names.get(userId) ?? null);
  const entries: TodayEntry[] = [];
  for (const instance of [...carryOver, ...todays]) {
    const task = await ctx.db.get(instance.taskId);
    if (!task) continue;
    const claimedBy = instance.claimedBy ?? null;
    const confirmedBy = instance.confirmedBy ?? null;
    const confirmedAt = instance.confirmedAt ?? null;
    entries.push({
      instanceId: instance._id,
      localDate: instance.localDate,
      carriedOver: carriedIds.has(instance._id),
      taskId: task._id,
      type: task.type,
      displayLabel: task.displayLabel,
      spokenPrompt: task.spokenPrompt,
      pillDescription: task.pillDescription ?? null,
      checklistItems: task.checklistItems,
      scheduledTime: instance.scheduledTime,
      state: instance.state,
      confirmedAt,
      confirmedLocalTime: confirmedAt === null ? null : localTime(confirmedAt, household.timezone),
      confirmedVia: instance.confirmedVia ?? null,
      confirmReceivedAt: instance.confirmReceivedAt ?? null,
      confirmReceivedLocalTime:
        instance.confirmReceivedAt === undefined
          ? null
          : localTime(instance.confirmReceivedAt, household.timezone),
      confirmReceivedDaysLater: receivedDaysLater(instance, household.timezone),
      claimedBy,
      claimedByName: nameOf(claimedBy),
      confirmedBy,
      confirmedByName: instance.state === "resolved" ? nameOf(confirmedBy) : null,
      resolutionNote: instance.resolutionNote ?? null,
      confirmable: seniorCanConfirm(instance, now),
      reopenable: caregiverCanReopen(instance, now, household.timezone),
      seniorPrompts: instance.firedSteps.filter((s) => s.action === "prompt_senior" && s.notified)
        .length,
      snoozed: instance.snoozedUntil !== undefined && now < instance.snoozedUntil,
      snoozedUntil: instance.snoozedUntil ?? null,
    });
  }
  return entries;
}
