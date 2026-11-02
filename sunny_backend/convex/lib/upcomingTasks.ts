// lib/upcomingTasks.ts
// Purpose: Projects the household's active tasks onto future local dates, for the caregiver
// calendar (calendar.dayView). Task instances exist only for today and tomorrow
// (lib/schedule.ts), so a later day's tasks are derived from the task schedules with the same
// rule the expander uses (occursOn: starts/ends, once-on, weekdays). A timed task contributes one
// entry per time; an anytime task (lib/anytime.ts) one entry with the ANYTIME sentinel; an
// as-needed medication (a medication with no times) has no schedule and contributes nothing.
// Entries per day are ordered by time with anytime ones last, ties by label. These are plans, not
// instances: they carry no state, so they cannot be ticked. Dates only, so DST does not matter.
//
// Last modified: 2026-11-01

import type { Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { ANYTIME, compareDayOrder, isAnytimeTask } from "./anytime";
import { occursOn } from "./schedule";
import type { TaskFields } from "./schedule";
import { addDays } from "./time";
import type { TaskType } from "./validators";

/** A task planned on a future day. */
export interface UpcomingTask {
  /** The household-local date, "YYYY-MM-DD". */
  localDate: string;
  /** Household-local "HH:MM", or the ANYTIME sentinel ("anytime"). */
  scheduledTime: string;
  taskId: Id<"tasks">;
  type: TaskType;
  displayLabel: string;
  title: string;
}

/** The task fields the projection reads, plus its id. */
export type ProjectableTask = Pick<
  TaskFields,
  | "active"
  | "type"
  | "times"
  | "title"
  | "displayLabel"
  | "startsOn"
  | "endsOn"
  | "onceOn"
  | "daysOfWeek"
> & { _id: Id<"tasks"> };

/**
 * purpose: Project tasks onto the local dates from + 1 .. from + days.
 * @param tasks: (ProjectableTask[]) The household's tasks; inactive ones are ignored.
 * @param from: (string) Today's local date; the first projected day is the next one.
 * @param days: (number) How many days after from to project.
 * @return: (UpcomingTask[]) Entries by date, then timed by time, anytime last, then by label.
 */
export function projectTasks(
  tasks: readonly ProjectableTask[],
  from: string,
  days: number,
): UpcomingTask[] {
  const result: UpcomingTask[] = [];
  for (let offset = 1; offset <= days; offset += 1) {
    const date = addDays(from, offset);
    const day: UpcomingTask[] = [];
    for (const task of tasks) {
      if (!task.active || !occursOn(task, date)) continue;
      let times: readonly string[];
      if (isAnytimeTask(task)) times = [ANYTIME];
      else if (task.times.length === 0) continue;
      else times = task.times;
      for (const scheduledTime of times) {
        day.push({
          localDate: date,
          scheduledTime,
          taskId: task._id,
          type: task.type,
          displayLabel: task.displayLabel,
          title: task.title,
        });
      }
    }
    day.sort(
      (a, b) =>
        compareDayOrder(
          { scheduledTime: a.scheduledTime, windowStart: 0 },
          { scheduledTime: b.scheduledTime, windowStart: 0 },
        ) ||
        a.scheduledTime.localeCompare(b.scheduledTime) ||
        a.displayLabel.localeCompare(b.displayLabel),
    );
    result.push(...day);
  }
  return result;
}

/**
 * purpose: The household's active tasks projected onto the days after today.
 * @param ctx: (QueryCtx) Context.
 * @param householdId: (Id<"households">) Household.
 * @param today: (string) Household-local today.
 * @param days: (number) How many days after today to project.
 * @return: (Promise<UpcomingTask[]>) See projectTasks.
 */
export async function upcomingTasks(
  ctx: QueryCtx,
  householdId: Id<"households">,
  today: string,
  days: number,
): Promise<UpcomingTask[]> {
  const tasks = await ctx.db
    .query("tasks")
    .withIndex("by_household_active", (q) => q.eq("householdId", householdId).eq("active", true))
    .collect();
  return projectTasks(tasks, today, days);
}
