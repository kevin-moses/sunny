import { daysBetween, parseLocalDate, weekdayName } from './localDate';
import type { AgendaItem, DayTask, DayViewData, EventOccurrence } from './types';
import type { ANYTIME as BACKEND_ANYTIME } from '../../../sunny_backend/convex/lib/anytime';

export const ANYTIME: typeof BACKEND_ANYTIME = 'anytime';

export function isAnytime(task: Pick<DayTask, 'scheduledTime'>): boolean {
  return task.scheduledTime === ANYTIME;
}

export function compareTaskTime(
  a: Pick<DayTask, 'scheduledTime'>,
  b: Pick<DayTask, 'scheduledTime'>,
): number {
  const byAnytime = Number(isAnytime(a)) - Number(isAnytime(b));
  if (byAnytime !== 0) return byAnytime;
  return a.scheduledTime < b.scheduledTime ? -1 : a.scheduledTime > b.scheduledTime ? 1 : 0;
}

export function isDone(task: Pick<DayTask, 'state'>): boolean {
  return task.state === 'confirmed' || task.state === 'resolved';
}

export const SPOKEN = {
  done: 'Done',
  now: 'Now',
  dueNow: 'Due now',
  missed: 'Earlier today, not marked done',
} as const;

export function stepCounter(step: NonNullable<DayTask['step']>): string {
  return `Step ${step.index + 1} of ${step.count}`;
}

export function isMissed(task: DayTask): boolean {
  return task.state === 'missed';
}

export function isOpen(task: Pick<DayTask, 'state'>): boolean {
  return !isDone(task);
}

export function isDue(task: DayTask): boolean {
  return !isAnytime(task) && (task.state === 'due' || task.state === 'escalated');
}

export function eventKey(event: EventOccurrence): string {
  return `${event.eventId}-${event.localDate}`;
}

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

function timeParts(localTime: string): { hour: number; minute: string } | null {
  const match = /^(\d{2}):(\d{2})$/.exec(localTime);
  if (match === null) return null;
  const hour = Number(match[1]);
  if (hour > 23 || Number(match[2]) > 59) return null;
  return { hour, minute: match[2]! };
}

export function clockTime(localTime: string): string {
  if (localTime === ANYTIME) return 'Anytime';
  const parts = timeParts(localTime);
  if (parts === null) return localTime;
  return `${parts.hour % 12 === 0 ? 12 : parts.hour % 12}:${parts.minute}`;
}

export function displayTime(localTime: string): string {
  const parts = timeParts(localTime);
  if (parts === null) return clockTime(localTime);
  return `${clockTime(localTime)} ${parts.hour < 12 ? 'AM' : 'PM'}`;
}

export function relativeDayName(localDate: string, todayLocalDate: string | null): string | null {
  const today = todayLocalDate === null ? null : parseLocalDate(todayLocalDate);
  const date = parseLocalDate(localDate);
  if (today === null || date === null) return null;
  const days = daysBetween(today, date);
  if (days === 0) return 'Today';
  if (days === 1) return 'Tomorrow';
  return weekdayName(date);
}

export function whenText(event: EventOccurrence, todayLocalDate: string | null): string {
  const time = displayTime(event.startTime);
  const day = relativeDayName(event.localDate, todayLocalDate);
  return day === null ? time : `${day} at ${time}`;
}

export function eventDetails(event: EventOccurrence, head: string): string {
  const parts = [head];
  if (event.visitorName) parts.push(`with ${event.visitorName}`);
  if (event.place) parts.push(`at ${event.place}`);
  return parts.join(' ');
}
