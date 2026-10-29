// lib/today.ts
// Purpose: The senior's schedule for today, ported from private.today_json. Today is the
// household-local date of the given instant; entries are ordered by window start and carry
// the task fields every surface (display, widget, agent context) renders.
//
// Last modified: 2026-10-28

import type { Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { localDate } from "./time";
import type { ConfirmVia, InstanceState, TaskType } from "./validators";

/** One of today's instances joined with its task. */
export interface TodayEntry {
  instanceId: Id<"taskInstances">;
  taskId: Id<"tasks">;
  type: TaskType;
  displayLabel: string;
  spokenPrompt: string;
  pillDescription: string | undefined;
  checklistItems: string[];
  scheduledTime: string;
  state: InstanceState;
  confirmedAt: number | undefined;
  confirmedVia: ConfirmVia | undefined;
}

/**
 * purpose: Today's instances for a household in schedule order.
 * @param ctx: (QueryCtx) Context.
 * @param householdId: (Id<"households">) Household.
 * @param now: (number) Epoch ms; its household-local date defines "today".
 * @return: (TodayEntry[]) Entries ordered by window start; empty if the household is gone.
 */
export async function todayInstances(
  ctx: QueryCtx,
  householdId: Id<"households">,
  now: number,
): Promise<TodayEntry[]> {
  const household = await ctx.db.get(householdId);
  if (!household) return [];
  const date = localDate(now, household.timezone);
  const instances = await ctx.db
    .query("taskInstances")
    .withIndex("by_household_date", (q) => q.eq("householdId", householdId).eq("localDate", date))
    .collect();
  instances.sort((a, b) => a.windowStart - b.windowStart);
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
      pillDescription: task.pillDescription,
      checklistItems: task.checklistItems,
      scheduledTime: instance.scheduledTime,
      state: instance.state,
      confirmedAt: instance.confirmedAt,
      confirmedVia: instance.confirmedVia,
    });
  }
  return entries;
}
