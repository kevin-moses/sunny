// sunny_app/src/day/format.ts
//
// Purpose: Pure helpers for the day clock: task state checks, the time-ordered agenda
// merge, and plain-language time text. Dates and times from calendar.dayView are already in
// the household's local time, so nothing here converts timezones; calendar arithmetic
// uses UTC dates purely as a day counter.
//
// Last modified: 2026-10-29

import type { AgendaItem, DayTask, DayViewData, EventOccurrence } from './types';

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MS_PER_DAY = 86_400_000;

/**
 * purpose: Whether a task was confirmed by the senior or a caregiver.
 * @param task: (DayTask) The task.
 * @return: (boolean) True once its state is confirmed or resolved.
 */
export function isDone(task: DayTask): boolean {
  return task.state === 'confirmed' || task.state === 'resolved';
}

/**
 * purpose: Whether a task's confirmation window is open.
 * @param task: (DayTask) The task.
 * @return: (boolean) True while its state is due or escalated.
 */
export function isDue(task: DayTask): boolean {
  return task.state === 'due' || task.state === 'escalated';
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
 * purpose: Merge today's tasks and events into one list ordered by local time.
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
  return [...tasks, ...events].sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0));
}

/**
 * purpose: Display form of a local "HH:MM" time, for example "2:00 PM".
 * @param localTime: (string) Time from the backend.
 * @return: (string) Display time, or the input unchanged when it is not a valid time.
 */
export function displayTime(localTime: string): string {
  const match = /^(\d{2}):(\d{2})$/.exec(localTime);
  if (match === null) return localTime;
  const [hour, minute] = [Number(match[1]), Number(match[2])];
  if (hour > 23 || minute > 59) return localTime;
  const hour12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${hour12}:${match[2]} ${hour < 12 ? 'AM' : 'PM'}`;
}

/**
 * purpose: Parse a "YYYY-MM-DD" local date into a UTC timestamp used as a day counter.
 * @param localDate: (string) Date from the backend.
 * @return: (number | null) Milliseconds at UTC midnight, or null when invalid.
 */
function parseLocalDate(localDate: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(localDate);
  if (match === null) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const time = Date.UTC(year, month - 1, day);
  const parsed = new Date(time);
  const valid =
    parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month - 1 &&
    parsed.getUTCDate() === day;
  return valid ? time : null;
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
  const days = Math.trunc((date - today) / MS_PER_DAY);
  if (days === 0) return `Today at ${time}`;
  if (days === 1) return `Tomorrow at ${time}`;
  return `${WEEKDAYS[new Date(date).getUTCDay()]} at ${time}`;
}
