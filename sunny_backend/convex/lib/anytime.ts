// lib/anytime.ts
// Purpose: The "anytime" task representation, in one place. An anytime task is one that has no
// time of day: it is done "anytime that day". It is stored as a task of any type except
// medication whose `times` list is empty (a medication with no times keeps its older meaning,
// an as-needed medication that is only logged; see tasks.ts isAsNeededTask). Each day it
// occurs the scheduler (lib/schedule.ts) creates one instance whose scheduledTime is the
// sentinel ANYTIME, so the unique-by-time index by_task_date_time keeps deduplicating. The
// instance's window starts at local midnight of its date. It ends at the next local midnight
// when the task also occurs the next day (the next day's instance replaces it: it is marked
// missed and never shown as Leftover), and at local midnight two days later when it does not
// (a one-off, a weekday task before an off day, a task whose end date is reached): then it stays
// open and is shown as Leftover through the next day, and is marked missed only after that. Anytime instances never prompt the senior, never escalate and never notify:
// anytime tasks get no escalation policy and the scheduler skips them even if one is set. The
// sunny_app mirrors the ANYTIME constant (sunny_app/src/day/format.ts); keep the two in sync.
//
// Last modified: 2026-11-01

import { addDays, zonedInstant } from "./time";
import type { TaskType } from "./validators";

/** scheduledTime of an anytime task's instances. Not a valid "HH:MM", so it never collides. */
export const ANYTIME = "anytime";

/**
 * purpose: Whether a task is an anytime task: no times and not a medication.
 * @param task: (object) The task's type and times.
 * @return: (boolean) True for an anytime task.
 */
export function isAnytimeTask(task: { type: TaskType; times: readonly string[] }): boolean {
  return task.times.length === 0 && task.type !== "medication";
}

/**
 * purpose: Whether an instance belongs to an anytime task (its scheduledTime is the sentinel).
 * @param instance: (object) The instance's scheduledTime.
 * @return: (boolean) True for an anytime instance.
 */
export function isAnytimeInstance(instance: { scheduledTime: string }): boolean {
  return instance.scheduledTime === ANYTIME;
}

/**
 * purpose: The window of an anytime instance: local midnight of its date until the next local
 *          midnight when the task occurs again the next day (that day's instance replaces
 *          it), else until local midnight two days later so it is still open, as a
 *          Leftover, all of the next day. DST-safe.
 * @param date: (string) The instance's local "YYYY-MM-DD".
 * @param timezone: (string) The household's IANA zone.
 * @param repeatsNextDay: (boolean) Whether the task occurs on the following local date.
 * @return: ({ windowStart: number; windowEnd: number }) Epoch ms bounds.
 */
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

/**
 * purpose: Sort comparator for instances of one day: timed ones by window start, anytime ones
 *          after all timed ones (then by window start).
 * @param a: (object) First instance's scheduledTime and windowStart.
 * @param b: (object) Second instance's scheduledTime and windowStart.
 * @return: (number) Negative when a is listed first.
 */
export function compareDayOrder(
  a: { scheduledTime: string; windowStart: number },
  b: { scheduledTime: string; windowStart: number },
): number {
  const byAnytime = Number(isAnytimeInstance(a)) - Number(isAnytimeInstance(b));
  return byAnytime !== 0 ? byAnytime : a.windowStart - b.windowStart;
}
