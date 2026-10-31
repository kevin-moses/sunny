// sunny_app/src/caregiver/format.ts
//
// Purpose: Pure helpers for the caregiver app: the seven-day week strip (today through today+6),
// the date range and month labels, which tasks are alerts and who is on them, the "This week"
// schedule grouped by day, and the chat transcript built from the household's agent requests
// (oldest first). Dates are household-local "YYYY-MM-DD" strings from calendar.dayView; date
// arithmetic comes from day/localDate (parsed once, then counted as days), so no timezone
// conversion happens here.
//
// Last modified: 2026-10-31

import type { FunctionReturnType } from 'convex/server';

import type { api } from '../backend/convexApi';
import { displayTime, eventDetails, eventKey, isDone } from '../day/format';
import {
  addDays,
  dayOfMonth,
  formatLocalDate,
  monthName,
  parseLocalDate,
  weekdayName,
  yearOf,
} from '../day/localDate';
import type { AgendaItem, DayTask, DayViewData, EventOccurrence } from '../day/types';

/** An agent request as the chat tab sees it (agentRequests.list, newest first). */
export type AgentRequest = FunctionReturnType<typeof api.agentRequests.list>[number];

/** Number of days the week strip and schedule cover, starting today. */
export const WEEK_LENGTH = 7;

/** Shown while a request is queued or running. */
export const WORKING_TEXT = 'Sunny is working on it...';

/** Shown when a failed request carries no error text. */
export const FAILED_TEXT = 'Sunny could not finish that. Please try again.';

/**
 * purpose: Month and year of a local date, for the calendar card, for example "October 2026".
 * @param localDate: (string) "YYYY-MM-DD".
 * @return: (string) The label, or an empty string when the date is invalid.
 */
export function monthYearLabel(localDate: string): string {
  const time = parseLocalDate(localDate);
  return time === null ? '' : `${monthName(time)} ${yearOf(time)}`;
}

/**
 * purpose: Short month and day of a day counter, for example "Oct 30".
 * @param time: (number) UTC-midnight timestamp.
 * @return: (string) The label.
 */
function shortMonthDay(time: number): string {
  return `${monthName(time).slice(0, 3)} ${dayOfMonth(time)}`;
}

/**
 * purpose: The range the week covers, for example "Oct 30 – Nov 5" (today through today+6).
 * @param todayLocalDate: (string) The day view's localDate.
 * @return: (string) The range label, or an empty string when the date is invalid.
 */
export function weekRangeLabel(todayLocalDate: string): string {
  const start = parseLocalDate(todayLocalDate);
  if (start === null) return '';
  return `${shortMonthDay(start)} – ${shortMonthDay(addDays(start, WEEK_LENGTH - 1))}`;
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
 * @return: (WeekStripDay[]) Seven days, today through today+6; empty when the date is invalid.
 */
export function buildWeekStrip(day: DayViewData): WeekStripDay[] {
  const start = parseLocalDate(day.localDate);
  if (start === null) return [];
  const eventDates = new Set([...day.eventsToday, ...day.upcoming].map((e) => e.localDate));
  const days: WeekStripDay[] = [];
  for (let offset = 0; offset < WEEK_LENGTH; offset += 1) {
    const time = addDays(start, offset);
    const localDate = formatLocalDate(time);
    const isToday = offset === 0;
    const hasMarker = eventDates.has(localDate) || (isToday && day.tasks.length > 0);
    const name = weekdayName(time);
    const date = String(dayOfMonth(time));
    days.push({
      localDate,
      weekdayShort: name.slice(0, 3),
      dayOfMonth: date,
      isToday,
      hasMarker,
      accessibilityLabel: `${isToday ? 'Today, ' : ''}${name} ${date}${
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
 * purpose: The message under an alert's title.
 * @param task: (DayTask) An alert task.
 * @return: (string) "Due at 8:00 AM." plus "Sunny has alerted the family." when escalated.
 */
export function alertMessage(task: DayTask): string {
  const due = `Due at ${displayTime(task.scheduledTime)}.`;
  return task.state === 'escalated' ? `${due} Sunny has alerted the family.` : due;
}

/**
 * purpose: Who is on an alert, from the claim the day view carries.
 * @param task: (DayTask) An alert task.
 * @param userId: (string | null) The signed-in caregiver's Clerk user id.
 * @return: (string | null) "You're on it" for the caregiver's own claim, "<name> is on it" for
 *          someone else's ("Someone" if they are no longer a member), null when unclaimed.
 */
export function claimText(task: DayTask, userId: string | null): string | null {
  if (task.claimedBy === null) return null;
  if (task.claimedBy === userId) return "You're on it";
  return `${task.claimedByName ?? 'Someone'} is on it`;
}

/** How a schedule row looks. */
export type ScheduleVariant = 'done' | 'alert' | 'task' | 'event';

/** What each schedule variant shows: its icon and the status word read to screen readers. */
export const VARIANT_STYLE: Record<
  ScheduleVariant,
  {
    icon: 'checkmark.circle.fill' | 'exclamationmark.circle.fill' | 'circle' | 'calendar';
    status: string;
  }
> = {
  done: { icon: 'checkmark.circle.fill', status: 'Done' },
  alert: { icon: 'exclamationmark.circle.fill', status: 'Not confirmed' },
  task: { icon: 'circle', status: '' },
  event: { icon: 'calendar', status: '' },
};

/** One line of the "This week" card. */
export interface ScheduleRowData {
  id: string;
  variant: ScheduleVariant;
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
 * purpose: Build a schedule row.
 * @param id: (string) Stable row id.
 * @param variant: (ScheduleVariant) How the row looks.
 * @param time: (string) Display time.
 * @param label: (string) What happens.
 * @return: (ScheduleRowData) The row, with its screen reader label.
 */
function scheduleRow(
  id: string,
  variant: ScheduleVariant,
  time: string,
  label: string,
): ScheduleRowData {
  const { status } = VARIANT_STYLE[variant];
  return {
    id,
    variant,
    time,
    label,
    accessibilityLabel: `${time}, ${label}${status === '' ? '' : `, ${status}`}`,
  };
}

/**
 * purpose: Reduce a task to its schedule row.
 * @param task: (DayTask) The task.
 * @param id: (string) Row id.
 * @return: (ScheduleRowData) The row.
 */
function taskRow(task: DayTask, id: string): ScheduleRowData {
  const variant: ScheduleVariant = isDone(task) ? 'done' : isAlert(task) ? 'alert' : 'task';
  return scheduleRow(id, variant, displayTime(task.scheduledTime), task.displayLabel);
}

/**
 * purpose: Reduce an event to its schedule row.
 * @param event: (EventOccurrence) The event occurrence.
 * @param id: (string) Row id.
 * @return: (ScheduleRowData) The row, worded "<label> with <visitor> at <place>".
 */
function eventRow(event: EventOccurrence, id: string): ScheduleRowData {
  return scheduleRow(id, 'event', displayTime(event.startTime), eventDetails(event, event.label));
}

/**
 * purpose: The "This week" card's groups: today (tasks and events merged in time order, from
 *          the day view's agenda) then each later day within the week that has events. Days
 *          with nothing are omitted.
 * @param day: (DayViewData) The day view.
 * @param agenda: (AgendaItem[]) Today's merged agenda (useDayView's agenda for this day).
 * @return: (ScheduleGroup[]) Groups in date order; empty when nothing is scheduled.
 */
export function buildSchedule(day: DayViewData, agenda: AgendaItem[]): ScheduleGroup[] {
  const groups: ScheduleGroup[] = [];
  const todayRows = agenda.map((item) =>
    item.kind === 'task' ? taskRow(item.task, item.id) : eventRow(item.event, item.id),
  );
  if (todayRows.length > 0) {
    groups.push({ key: day.localDate, title: `Today, ${day.weekday}`, rows: todayRows });
  }
  const start = parseLocalDate(day.localDate);
  const lastDate =
    start === null ? day.localDate : formatLocalDate(addDays(start, WEEK_LENGTH - 1));
  const later = day.upcoming
    .filter((e) => e.localDate > day.localDate && e.localDate <= lastDate)
    .sort((a, b) =>
      a.localDate !== b.localDate
        ? a.localDate.localeCompare(b.localDate)
        : a.startTime.localeCompare(b.startTime),
    );
  for (const event of later) {
    const row = eventRow(event, eventKey(event));
    const last = groups[groups.length - 1];
    if (last !== undefined && last.key === event.localDate) {
      last.rows.push(row);
    } else {
      const time = parseLocalDate(event.localDate);
      groups.push({
        key: event.localDate,
        title: time === null ? '' : weekdayName(time),
        rows: [row],
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
 * purpose: Whether any request is still queued or running; the server allows only one request
 *          at a time in a conversation, so sending waits until none is.
 * @param requests: (AgentRequest[]) Requests as agentRequests.list returns them.
 * @return: (boolean) True while one is queued or running.
 */
export function hasInProgress(requests: AgentRequest[]): boolean {
  return requests.some((r) => r.status === 'queued' || r.status === 'running');
}
