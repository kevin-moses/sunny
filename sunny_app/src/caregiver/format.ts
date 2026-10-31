// sunny_app/src/caregiver/format.ts
//
// Purpose: Pure helpers for the caregiver app: the seven-day week strip (today through today+6),
// the date range and month labels, which of today's tasks are alerts, the "This week" schedule
// grouped by day, and the chat transcript built from the household's agent requests (oldest
// first) plus the request a new message should continue. Dates are household-local
// "YYYY-MM-DD" strings from calendar.dayView; calendar arithmetic uses UTC dates purely as a
// day counter, so no timezone conversion happens here.
//
// Last modified: 2026-10-30

import type { FunctionReturnType } from 'convex/server';

import type { api } from '../backend/convexApi';
import { displayTime, isDone, buildAgenda, parseLocalDate, WEEKDAYS } from '../day/format';
import type { DayTask, DayViewData, EventOccurrence } from '../day/types';

/** An agent request as the chat tab sees it (agentRequests.list, newest first). */
export type AgentRequest = FunctionReturnType<typeof api.agentRequests.list>[number];

/** Number of days the week strip and schedule cover, starting today. */
export const WEEK_LENGTH = 7;

/** Shown while a request is queued or running. */
export const WORKING_TEXT = 'Sunny is working on it...';

/** Shown when a failed request carries no error text. */
export const FAILED_TEXT = 'Sunny could not finish that. Please try again.';

const MS_PER_DAY = 86_400_000;
const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

/**
 * purpose: Shift a local date by a number of days.
 * @param localDate: (string) "YYYY-MM-DD".
 * @param days: (number) Days to add; may be negative.
 * @return: (string) The shifted date, or the input unchanged when it is not a valid date.
 */
export function addLocalDays(localDate: string, days: number): string {
  const time = parseLocalDate(localDate);
  if (time === null) return localDate;
  return new Date(time + days * MS_PER_DAY).toISOString().slice(0, 10);
}

/**
 * purpose: Split a local date into a Date (UTC midnight) for name lookups.
 * @param localDate: (string) "YYYY-MM-DD".
 * @return: (Date | null) The date, or null when invalid.
 */
function toDate(localDate: string): Date | null {
  const time = parseLocalDate(localDate);
  return time === null ? null : new Date(time);
}

/**
 * purpose: Month and year of a local date, for the calendar card, for example "October 2026".
 * @param localDate: (string) "YYYY-MM-DD".
 * @return: (string) The label, or an empty string when the date is invalid.
 */
export function monthYearLabel(localDate: string): string {
  const date = toDate(localDate);
  return date === null ? '' : `${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
}

/**
 * purpose: Short month and day of a local date, for example "Oct 30".
 * @param localDate: (string) "YYYY-MM-DD".
 * @return: (string) The label, or an empty string when the date is invalid.
 */
function shortMonthDay(localDate: string): string {
  const date = toDate(localDate);
  return date === null ? '' : `${MONTHS[date.getUTCMonth()].slice(0, 3)} ${date.getUTCDate()}`;
}

/**
 * purpose: The range the week covers, for example "Oct 30 – Nov 5" (today through today+6).
 * @param todayLocalDate: (string) The day view's localDate.
 * @return: (string) The range label, or an empty string when the date is invalid.
 */
export function weekRangeLabel(todayLocalDate: string): string {
  const start = shortMonthDay(todayLocalDate);
  const end = shortMonthDay(addLocalDays(todayLocalDate, WEEK_LENGTH - 1));
  return start === '' || end === '' ? '' : `${start} – ${end}`;
}

/**
 * purpose: Full weekday name of a local date.
 * @param localDate: (string) "YYYY-MM-DD".
 * @return: (string) For example "Friday"; an empty string when the date is invalid.
 */
export function weekdayName(localDate: string): string {
  const date = toDate(localDate);
  return date === null ? '' : WEEKDAYS[date.getUTCDay()];
}

/** One cell of the calendar card's week strip. */
export interface WeekStripDay {
  localDate: string;
  /** Three-letter weekday, for example "Thu". */
  weekdayShort: string;
  /** Day of the month, for example "30". */
  dayOfMonth: string;
  isToday: boolean;
  /** True when the dot shows: the day has events, or it is today and has tasks. */
  hasMarker: boolean;
  accessibilityLabel: string;
}

/**
 * purpose: The seven cells of the week strip, today first.
 * @param day: (DayViewData) The day view.
 * @return: (WeekStripDay[]) Seven days, today through today+6.
 */
export function buildWeekStrip(day: DayViewData): WeekStripDay[] {
  const eventDates = new Set([...day.eventsToday, ...day.upcoming].map((e) => e.localDate));
  const days: WeekStripDay[] = [];
  for (let offset = 0; offset < WEEK_LENGTH; offset += 1) {
    const localDate = addLocalDays(day.localDate, offset);
    const isToday = offset === 0;
    const hasMarker = eventDates.has(localDate) || (isToday && day.tasks.length > 0);
    const name = weekdayName(localDate);
    const dayOfMonth = String(toDate(localDate)?.getUTCDate() ?? '');
    days.push({
      localDate,
      weekdayShort: name.slice(0, 3),
      dayOfMonth,
      isToday,
      hasMarker,
      accessibilityLabel: `${isToday ? 'Today, ' : ''}${name} ${dayOfMonth}${
        hasMarker ? ', has plans' : ''
      }`,
    });
  }
  return days;
}

/**
 * purpose: Whether a task needs a caregiver's attention.
 * @param task: (DayTask) The task.
 * @return: (boolean) True when its state is escalated or missed.
 */
export function isAlert(task: DayTask): boolean {
  return task.state === 'escalated' || task.state === 'missed';
}

/**
 * purpose: The tasks that need attention, in the day view's order.
 * @param tasks: (DayTask[]) Today's tasks (may start with yesterday's still-open ones).
 * @return: (DayTask[]) Escalated and missed tasks.
 */
export function selectAlerts(tasks: DayTask[]): DayTask[] {
  return tasks.filter(isAlert);
}

/**
 * purpose: The message under an alert's title.
 * @param task: (DayTask) An alert task.
 * @return: (string) "Due at 8:00 AM." plus "Sunny has alerted the family." when escalated.
 */
export function alertMessage(task: DayTask): string {
  const due = `Due at ${displayTime(task.scheduledTime)}.`;
  return task.state === 'escalated' ? `${due} Sunny has alerted the family.` : due;
}

/** How a schedule row looks. */
export type ScheduleVariant = 'done' | 'alert' | 'task' | 'event';

/** One line of the "This week" card. */
export interface ScheduleRowData {
  id: string;
  variant: ScheduleVariant;
  icon: 'checkmark.circle.fill' | 'exclamationmark.circle.fill' | 'circle' | 'calendar';
  time: string;
  label: string;
  accessibilityLabel: string;
}

/** One day of the "This week" card. */
export interface ScheduleGroup {
  /** The local date of the group. */
  key: string;
  /** "Today, Thursday" or a full weekday name. */
  title: string;
  rows: ScheduleRowData[];
}

/**
 * purpose: Describe an event as "<label> with <visitor> at <place>".
 * @param event: (EventOccurrence) The event.
 * @return: (string) The label with whichever of visitor and place are present.
 */
export function eventLabel(event: EventOccurrence): string {
  const parts = [event.label];
  if (event.visitorName) parts.push(`with ${event.visitorName}`);
  if (event.place) parts.push(`at ${event.place}`);
  return parts.join(' ');
}

/**
 * purpose: Reduce a task to its schedule row.
 * @param task: (DayTask) The task.
 * @return: (ScheduleRowData) The row.
 */
function taskRow(task: DayTask): ScheduleRowData {
  const variant: ScheduleVariant = isDone(task) ? 'done' : isAlert(task) ? 'alert' : 'task';
  const icon =
    variant === 'done'
      ? 'checkmark.circle.fill'
      : variant === 'alert'
        ? 'exclamationmark.circle.fill'
        : 'circle';
  const time = displayTime(task.scheduledTime);
  const status = variant === 'done' ? 'Done' : variant === 'alert' ? 'Not confirmed' : '';
  return {
    id: `task-${task.instanceId}`,
    variant,
    icon,
    time,
    label: task.displayLabel,
    accessibilityLabel: `${time}, ${task.displayLabel}${status === '' ? '' : `, ${status}`}`,
  };
}

/**
 * purpose: Reduce an event to its schedule row.
 * @param event: (EventOccurrence) The event occurrence.
 * @return: (ScheduleRowData) The row.
 */
function eventRow(event: EventOccurrence): ScheduleRowData {
  const time = displayTime(event.startTime);
  const label = eventLabel(event);
  return {
    id: `event-${event.eventId}-${event.localDate}`,
    variant: 'event',
    icon: 'calendar',
    time,
    label,
    accessibilityLabel: `${time}, ${label}`,
  };
}

/**
 * purpose: The "This week" card's groups: today (tasks and events merged in time order) then
 *          each later day within the week that has events. Days with nothing are omitted.
 * @param day: (DayViewData) The day view.
 * @return: (ScheduleGroup[]) Groups in date order; empty when nothing is scheduled.
 */
export function buildSchedule(day: DayViewData): ScheduleGroup[] {
  const groups: ScheduleGroup[] = [];
  const todayRows = buildAgenda(day).map((item) =>
    item.kind === 'task' ? taskRow(item.task) : eventRow(item.event),
  );
  if (todayRows.length > 0) {
    groups.push({ key: day.localDate, title: `Today, ${day.weekday}`, rows: todayRows });
  }
  const lastDate = addLocalDays(day.localDate, WEEK_LENGTH - 1);
  const later = day.upcoming
    .filter((e) => e.localDate > day.localDate && e.localDate <= lastDate)
    .sort((a, b) =>
      a.localDate !== b.localDate
        ? a.localDate.localeCompare(b.localDate)
        : a.startTime.localeCompare(b.startTime),
    );
  for (const event of later) {
    const last = groups[groups.length - 1];
    if (last !== undefined && last.key === event.localDate) {
      last.rows.push(eventRow(event));
    } else {
      groups.push({
        key: event.localDate,
        title: weekdayName(event.localDate),
        rows: [eventRow(event)],
      });
    }
  }
  return groups;
}

/** One line of the chat transcript. */
export interface TranscriptEntry {
  id: string;
  /** caregiver: right bubble; sunny: left text; working and error: status lines. */
  kind: 'caregiver' | 'sunny' | 'working' | 'error';
  text: string;
}

/**
 * purpose: Turn the household's agent requests into chat lines, oldest first: each request is
 *          the caregiver's message, then Sunny's reply, a "working" line while it is queued or
 *          running, or the error when it failed. Cancelled requests show only the message.
 * @param requests: (AgentRequest[]) Requests as agentRequests.list returns them (newest first).
 * @return: (TranscriptEntry[]) The lines in reading order.
 */
export function buildTranscript(requests: AgentRequest[]): TranscriptEntry[] {
  const entries: TranscriptEntry[] = [];
  for (const request of [...requests].reverse()) {
    entries.push({ id: `${request.id}-message`, kind: 'caregiver', text: request.message });
    if (request.status === 'queued' || request.status === 'running') {
      entries.push({ id: `${request.id}-status`, kind: 'working', text: WORKING_TEXT });
    } else if (request.status === 'failed') {
      entries.push({
        id: `${request.id}-status`,
        kind: 'error',
        text: request.error?.trim() ? request.error : FAILED_TEXT,
      });
    } else if (request.status === 'succeeded' && request.reply?.trim()) {
      entries.push({ id: `${request.id}-reply`, kind: 'sunny', text: request.reply });
    }
  }
  return entries;
}

/**
 * purpose: Pick the request a new message should continue so the agent keeps context.
 * @param requests: (AgentRequest[]) Requests as agentRequests.list returns them (newest first).
 * @return: (AgentRequest['id'] | undefined) The newest succeeded request's id; undefined when
 *          there is none.
 */
export function chooseContinueRequestId(requests: AgentRequest[]): AgentRequest['id'] | undefined {
  return requests.find((r) => r.status === 'succeeded')?.id;
}
