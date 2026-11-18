import { addDays, zonedInstant } from "./time";
import type { TaskType } from "./validators";

export const ANYTIME = "anytime";

export function isAnytimeTask(task: { type: TaskType; times: readonly string[] }): boolean {
  return task.times.length === 0 && task.type !== "medication";
}

export function isAnytimeInstance(instance: { scheduledTime: string }): boolean {
  return instance.scheduledTime === ANYTIME;
}

export function anytimeWindow(
  date: string,
  timezone: string,
  repeatsNextDay: boolean,
): { windowStart: number; windowEnd: number } {
  return {
    windowStart: zonedInstant(date, "00:00", timezone),
    windowEnd: zonedInstant(addDays(date, repeatsNextDay ? 1 : 2), "00:00", timezone),
  };
}

export function compareDayOrder(
  a: { scheduledTime: string; windowStart: number },
  b: { scheduledTime: string; windowStart: number },
): number {
  const byAnytime = Number(isAnytimeInstance(a)) - Number(isAnytimeInstance(b));
  return byAnytime !== 0 ? byAnytime : a.windowStart - b.windowStart;
}
