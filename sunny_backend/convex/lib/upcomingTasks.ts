import type { Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { ANYTIME, isAnytimeTask } from "./anytime";
import { occursOn } from "./schedule";
import type { TaskFields } from "./schedule";
import { addDays } from "./time";
import type { TaskType } from "./validators";

export interface UpcomingTask {
  localDate: string;
  scheduledTime: string;
  taskId: Id<"tasks">;
  type: TaskType;
  displayLabel: string;
  title: string;
}

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

export const MAX_PLANNED_TASKS = 200;

function compareEntries(a: UpcomingTask, b: UpcomingTask): number {
  const byAnytime = Number(a.scheduledTime === ANYTIME) - Number(b.scheduledTime === ANYTIME);
  if (byAnytime !== 0) return byAnytime;
  return (
    a.scheduledTime.localeCompare(b.scheduledTime) || a.displayLabel.localeCompare(b.displayLabel)
  );
}

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
    day.sort(compareEntries);
    result.push(...day);
  }
  return result;
}

export async function upcomingTasks(
  ctx: QueryCtx,
  householdId: Id<"households">,
  today: string,
  days: number,
): Promise<UpcomingTask[]> {
  const tasks = await ctx.db
    .query("tasks")
    .withIndex("by_household_active", (q) => q.eq("householdId", householdId).eq("active", true))
    .take(MAX_PLANNED_TASKS);
  return projectTasks(tasks, today, days);
}
