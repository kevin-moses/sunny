// sunny_app/src/day/format.ts
//
// Purpose: Pure helpers for the day clock: task state checks (done, open, due), the time-ordered agenda
// merge, and plain-language time text. Dates and times from calendar.dayView are already in
// the household's local time, so nothing here converts timezones (date arithmetic lives in
// localDate.ts). Also the shared wording of an event line (eventDetails). Anytime tasks (no time
// of day, done anytime that day) arrive with the scheduledTime sentinel ANYTIME; they read
// "Anytime", are never "due", and are listed after the day's timed items.
//
// Last modified: 2026-11-01

import { daysBetween, parseLocalDate, weekdayName } from './localDate';
import type { AgendaItem, DayTask, DayViewData, EventOccurrence } from './types';

/**
 * The scheduledTime of an anytime task's instance (a task with no time of day). Mirrors
 * ANYTIME in sunny_backend/convex/lib/anytime.ts; keep the two in sync.
 */
export const ANYTIME = 'anytime';

/**
 * purpose: Whether a task is an anytime task (done anytime that day, no time of day).
 * @param task: (Pick<DayTask, 'scheduledTime'>) The task.
 * @return: (boolean) True when its scheduledTime is the anytime sentinel.
 */
export function isAnytime(task: Pick<DayTask, 'scheduledTime'>): boolean {
  return task.scheduledTime === ANYTIME;
}

/**
 * purpose: Sort comparator for tasks of a list: timed tasks by scheduled time, anytime tasks
 *          after all timed ones.
 * @param a: (Pick<DayTask, 'scheduledTime'>) First task.
 * @param b: (Pick<DayTask, 'scheduledTime'>) Second task.
 * @return: (number) Negative when a is listed first (0 for equal times, so a stable sort keeps
 *          the day view's order).
 */
export function compareTaskTime(
  a: Pick<DayTask, 'scheduledTime'>,
  b: Pick<DayTask, 'scheduledTime'>,
): number {
  const byAnytime = Number(isAnytime(a)) - Number(isAnytime(b));
  if (byAnytime !== 0) return byAnytime;
  return a.scheduledTime < b.scheduledTime ? -1 : a.scheduledTime > b.scheduledTime ? 1 : 0;
}

/**
 * purpose: Whether a task was confirmed by the senior or a caregiver.
 * @param task: (DayTask) The task.
 * @return: (boolean) True once its state is confirmed or resolved.
 */
export function isDone(task: DayTask): boolean {
  return task.state === 'confirmed' || task.state === 'resolved';
}

/**
 * purpose: Whether a task is still open: any task in today's list that is not done (upcoming,
 *          due, escalated or missed).
 * @param task: (DayTask) The task.
 * @return: (boolean) True until its state is confirmed or resolved.
 */
export function isOpen(task: DayTask): boolean {
  return !isDone(task);
}

/**
 * purpose: Whether a task's confirmation window is open and it is time to act on it. An anytime
 *          task is never "due": it is open all day and nothing is highlighted for it.
 * @param task: (DayTask) The task.
 * @return: (boolean) True while its state is due or escalated, for a timed task.
 */
export function isDue(task: DayTask): boolean {
  return !isAnytime(task) && (task.state === 'due' || task.state === 'escalated');
}

/**
 * purpose: Stable id of an event occurrence (an event repeats on different dates).
 * @param event: (EventOccurrence) The occurrence.
 * @return: (string) "<eventId>-<localDate>".
 */
export function eventKey(event: EventOccurrence): string {
  return `${event.eventId}-${event.localDate}`;
}

/**
 * purpose: Merge today's tasks and events into one list ordered by local time; anytime tasks
 *          come last, after every timed task and event.
 * @param day: (DayViewData | null) The day view, or null before the first load.
 * @return: (AgendaItem[]) Agenda lines; ties keep tasks before events.
 */
export function buildAgenda(day: DayViewData | null): AgendaItem[] {
  if (day === null) return [];
  const tasks = day.tasks.map((task): AgendaItem => ({
    kind: 'task',
    id: `task-${task.instanceId}`,
    time: task.scheduledTime,
    task,
  }));
  const events = day.eventsToday.map((event): AgendaItem => ({
    kind: 'event',
    id: `event-${eventKey(event)}`,
    time: event.startTime,
    event,
  }));
  return [...tasks, ...events].sort((a, b) =>
    compareTaskTime({ scheduledTime: a.time }, { scheduledTime: b.time }),
  );
}

/**
 * purpose: Display form of a local "HH:MM" time, for example "2:00 PM"; "Anytime" for the
 *          anytime sentinel.
 * @param localTime: (string) Time from the backend.
 * @return: (string) Display time, or the input unchanged when it is not a valid time.
 */
export function displayTime(localTime: string): string {
  if (localTime === ANYTIME) return 'Anytime';
  const match = /^(\d{2}):(\d{2})$/.exec(localTime);
  if (match === null) return localTime;
  const [hour, minute] = [Number(match[1]), Number(match[2])];
  if (hour > 23 || minute > 59) return localTime;
  const hour12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${hour12}:${match[2]} ${hour < 12 ? 'AM' : 'PM'}`;
}

/**
 * purpose: When an event happens relative to today: "Today at 2:00 PM",
 *          "Tomorrow at 9:00 AM" or "Thursday at 2:00 PM".
 * @param event: (EventOccurrence) The occurrence.
 * @param todayLocalDate: (string | null) The day view's localDate; null before the first load.
 * @return: (string) Calm, plain description; just the time when dates cannot be compared.
 */
export function whenText(event: EventOccurrence, todayLocalDate: string | null): string {
  const time = displayTime(event.startTime);
  const today = todayLocalDate === null ? null : parseLocalDate(todayLocalDate);
  const date = parseLocalDate(event.localDate);
  if (today === null || date === null) return time;
  const days = daysBetween(today, date);
  if (days === 0) return `Today at ${time}`;
  if (days === 1) return `Tomorrow at ${time}`;
  return `${weekdayName(date)} at ${time}`;
}

/**
 * purpose: Describe an event as "<head> with <visitor> at <place>".
 * @param event: (EventOccurrence) The event.
 * @param head: (string) The leading text (the label, or an already-formatted when text).
 * @return: (string) The head with whichever of visitor and place are present.
 */
export function eventDetails(event: EventOccurrence, head: string): string {
  const parts = [head];
  if (event.visitorName) parts.push(`with ${event.visitorName}`);
  if (event.place) parts.push(`at ${event.place}`);
  return parts.join(' ');
}
