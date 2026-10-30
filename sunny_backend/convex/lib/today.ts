// lib/today.ts
// Purpose: The senior's schedule for today, ported from private.today_json. Today is the
// household-local date of the given instant, plus any instance from the previous local date
// whose window crosses midnight and is still due or escalated (a 23:30 task with a 120 minute
// window is still being prompted at 00:10, so it must still be listed and confirmable).
// Entries are ordered by window start, yesterday's first, and carry the task fields every
// surface (display, widget, agent context) renders. Absent optional
// values are null, not missing keys, as in the other view-shaped results (lib/occurrences).
//
// Last modified: 2026-10-28

import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { addDays, localDate } from "./time";
import type { ConfirmVia, InstanceState, TaskType } from "./validators";

/** One of today's instances joined with its task. */
export interface TodayEntry {
  instanceId: Id<"taskInstances">;
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
  for (const instance of instances) {
    const task = await ctx.db.get(instance.taskId);
    if (!task) continue;
    entries.push({
      instanceId: instance._id,
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
    });
  }
  return entries;
}
