// lib/today.ts
// Purpose: The senior's schedule for today, ported from private.today_json. Today is the
// household-local date of the given instant, plus any instance from the previous local date
// whose window crosses midnight and is still due or escalated (a 23:30 task with a 120 minute
// window is still being prompted at 00:10, so it must still be listed and confirmable).
// Entries are ordered by window start, yesterday's first, and carry the task fields every
// surface (display, widget, agent context) renders. Absent optional
// values are null, not missing keys, as in the other view-shaped results (lib/occurrences).
//
// Each entry also says who claimed it ("I'm on it"): claimedBy is the claimer's user id and
// claimedByName their household display name (null when unclaimed or no longer a member).
// Likewise confirmedBy / confirmedByName name the caregiver who marked it done (null when a
// device or the senior confirmed it, or the member is gone). localDate is the instance's own
// local date, so a caller can tell yesterday's carry-over from today's entries, and
// resolutionNote is the note the caregiver left.
//
// Last modified: 2026-11-01

import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { findMember } from "./access";
import { addDays, localDate } from "./time";
import type { ConfirmVia, InstanceState, TaskType } from "./validators";

/** One of today's instances joined with its task. */
export interface TodayEntry {
  instanceId: Id<"taskInstances">;
  /** The instance's household-local date, "YYYY-MM-DD" (yesterday's for a carry-over). */
  localDate: string;
  taskId: Id<"tasks">;
  type: TaskType;
  displayLabel: string;
  spokenPrompt: string;
  pillDescription: string | null;
  checklistItems: string[];
  scheduledTime: string;
  state: InstanceState;
  confirmedAt: number | null;
  confirmedVia: ConfirmVia | null;
  claimedBy: string | null;
  claimedByName: string | null;
  /** Clerk user id of the caregiver who marked it done; null when a device confirmed it. */
  confirmedBy: string | null;
  /** That caregiver's household display name; null when confirmedBy is null or they left. */
  confirmedByName: string | null;
  resolutionNote: string | null;
}

/**
 * purpose: Today's instances for a household in schedule order, preceded by yesterday's
 *          instances that are still due or escalated.
 * @param ctx: (QueryCtx) Context.
 * @param householdId: (Id<"households">) Household.
 * @param now: (number) Epoch ms; its household-local date defines "today".
 * @return: (TodayEntry[]) Entries ordered by window start (yesterday's carry-over first);
 *          empty if the household is gone.
 */
export async function todayInstances(
  ctx: QueryCtx,
  householdId: Id<"households">,
  now: number,
): Promise<TodayEntry[]> {
  const household = await ctx.db.get(householdId);
  if (!household) return [];
  const date = localDate(now, household.timezone);
  /**
   * purpose: Sort comparator ordering task instances by window start.
   * @param a: (Doc<"taskInstances">) First instance.
   * @param b: (Doc<"taskInstances">) Second instance.
   * @return: (number) Negative when a starts first.
   */
  const byWindowStart = (a: Doc<"taskInstances">, b: Doc<"taskInstances">): number =>
    a.windowStart - b.windowStart;
  const carryOver = (
    await ctx.db
      .query("taskInstances")
      .withIndex("by_household_date", (q) =>
        q.eq("householdId", householdId).eq("localDate", addDays(date, -1)),
      )
      .collect()
  )
    .filter((i) => i.state === "due" || i.state === "escalated")
    .sort(byWindowStart);
  const todays = (
    await ctx.db
      .query("taskInstances")
      .withIndex("by_household_date", (q) => q.eq("householdId", householdId).eq("localDate", date))
      .collect()
  ).sort(byWindowStart);
  const instances = [...carryOver, ...todays];
  const entries: TodayEntry[] = [];
  const memberNames = new Map<string, string | null>();
  /**
   * purpose: A member's display name, looked up once per user for this call.
   * @param userId: (string | null) Clerk user id, or null.
   * @return: (Promise<string | null>) The name; null for null, or when no longer a member.
   */
  const nameOf = async (userId: string | null): Promise<string | null> => {
    if (userId === null) return null;
    if (!memberNames.has(userId)) {
      const member = await findMember(ctx, householdId, userId);
      memberNames.set(userId, member?.displayName ?? null);
    }
    return memberNames.get(userId) ?? null;
  };
  for (const instance of instances) {
    const task = await ctx.db.get(instance.taskId);
    if (!task) continue;
    const claimedBy = instance.claimedBy ?? null;
    const confirmedBy = instance.confirmedBy ?? null;
    entries.push({
      instanceId: instance._id,
      localDate: instance.localDate,
      taskId: task._id,
      type: task.type,
      displayLabel: task.displayLabel,
      spokenPrompt: task.spokenPrompt,
      pillDescription: task.pillDescription ?? null,
      checklistItems: task.checklistItems,
      scheduledTime: instance.scheduledTime,
      state: instance.state,
      confirmedAt: instance.confirmedAt ?? null,
      confirmedVia: instance.confirmedVia ?? null,
      claimedBy,
      claimedByName: await nameOf(claimedBy),
      confirmedBy,
      confirmedByName: await nameOf(confirmedBy),
      resolutionNote: instance.resolutionNote ?? null,
    });
  }
  return entries;
}
