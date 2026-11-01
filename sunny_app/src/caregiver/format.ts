// sunny_app/src/caregiver/format.ts
//
// Purpose: Pure helpers for the caregiver app: the seven-day week strip (today through today+6),
// the date range and month labels, which tasks are alerts and who is on them, the schedule rows
// and title for the day selected in the week strip, and the chat transcript built from the household's agent requests
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
 * purpose: Month and year the week covers (today through today+6), for the calendar card. A
 *          week inside one month reads "October 2026"; across a month boundary both months
 *          show: "October – November 2026", or "December 2026 – January 2027" across a year.
 * @param todayLocalDate: (string) "YYYY-MM-DD", the first day of the week.
 * @return: (string) The label, or an empty string when the date is invalid.
 */
export function weekMonthLabel(todayLocalDate: string): string {
  const start = parseLocalDate(todayLocalDate);
  if (start === null) return '';
  const end = addDays(start, WEEK_LENGTH - 1);
  if (yearOf(start) !== yearOf(end)) {
    return `${monthName(start)} ${yearOf(start)} – ${monthName(end)} ${yearOf(end)}`;
  }
  if (monthName(start) !== monthName(end)) {
    return `${monthName(start)} – ${monthName(end)} ${yearOf(end)}`;
  }
  return `${monthName(start)} ${yearOf(start)}`;
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
  /** For example "Sunday, November 1, has events"; prefixed "Today, " for today. */
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
    const spoken = `${name}, ${monthName(time)} ${date}`;
    days.push({
      localDate,
      weekdayShort: name.slice(0, 3),
      dayOfMonth: date,
      isToday,
      hasMarker,
      accessibilityLabel: `${isToday ? 'Today, ' : ''}${spoken}${hasMarker ? ', has events' : ''}`,
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

/** One line of the schedule card. */
export interface ScheduleRowData {
  id: string;
  variant: ScheduleVariant;
  time: string;
  label: string;
  accessibilityLabel: string;
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
 * purpose: The schedule rows of one day of the week: for today the agenda (tasks and events
 *          merged in time order, from the day view); for any other date that day's events in
 *          time order.
 * @param day: (DayViewData) The day view.
 * @param agenda: (AgendaItem[]) Today's merged agenda (useDayView's agenda for this day).
 * @param date: (string) The selected local date "YYYY-MM-DD".
 * @return: (ScheduleRowData[]) The rows; empty when nothing is scheduled that day.
 */
export function scheduleForDate(
  day: DayViewData,
  agenda: AgendaItem[],
  date: string,
): ScheduleRowData[] {
  if (date === day.localDate) {
    return agenda.map((item) =>
      item.kind === 'task' ? taskRow(item.task, item.id) : eventRow(item.event, item.id),
    );
  }
  return day.upcoming
    .filter((e) => e.localDate === date)
    .sort((a, b) => a.startTime.localeCompare(b.startTime))
    .map((event) => eventRow(event, eventKey(event)));
}

/**
 * purpose: The section title for the selected day.
 * @param todayDate: (string) Today's local date "YYYY-MM-DD".
 * @param date: (string) The selected local date.
 * @return: (string) "Today" for today, otherwise the weekday and date such as "Sunday, Nov 1";
 *          an empty string when the date is invalid.
 */
export function selectedDayTitle(todayDate: string, date: string): string {
  if (date === todayDate) return 'Today';
  const time = parseLocalDate(date);
  if (time === null) return '';
  return `${weekdayName(time)}, ${shortMonthDay(time)}`;
}

/** The day the caregiver tapped, and which "today" it was chosen against. */
export interface DaySelection {
  date: string;
  /** The day view's localDate when the choice was made. */
  todayWhenChosen: string;
}

/**
 * purpose: Decide which day the schedule shows. The choice holds only while today has not
 *          changed (midnight rollover resets it) and the chosen date is still in the strip.
 * @param strip: (WeekStripDay[]) The week strip, today first.
 * @param todayDate: (string) Today's local date.
 * @param selection: (DaySelection | null) The caregiver's choice, null before any tap.
 * @return: (string) The date to show; today when the choice no longer applies.
 */
export function resolveSelectedDate(
  strip: WeekStripDay[],
  todayDate: string,
  selection: DaySelection | null,
): string {
  if (
    selection !== null &&
    selection.todayWhenChosen === todayDate &&
    strip.some((d) => d.localDate === selection.date)
  ) {
    return selection.date;
  }
  return todayDate;
}

/** One line of the chat transcript. */
export interface TranscriptEntry {
  id: string;
  /** caregiver: right bubble; sunny: left text; working and error: status lines. */
  kind: 'caregiver' | 'sunny' | 'working' | 'error';
  text: string;
  /**
   * Caregiver lines only: who said it when it was not the signed-in caregiver (their name, or
   * "Another caregiver"); null for the signed-in caregiver's own messages and other kinds.
   */
  speaker: string | null;
}

/** The speaker label for a message from a caregiver whose name is unknown. */
export const ANOTHER_CAREGIVER = 'Another caregiver';

/**
 * purpose: Decide who to credit for a caregiver's message in the shared chat.
 * @param requestedBy: (string) Clerk user id of the caregiver who sent it.
 * @param requestedByName: (string | null) Their display name, null if no longer a member.
 * @param userId: (string | null) The signed-in caregiver's Clerk user id.
 * @return: (string | null) null when the message is the signed-in caregiver's own (or the
 *          signed-in user is unknown); otherwise the sender's name, or "Another caregiver".
 */
export function messageSpeaker(
  requestedBy: string,
  requestedByName: string | null,
  userId: string | null,
): string | null {
  if (userId === null || requestedBy === userId) return null;
  return requestedByName?.trim() ? requestedByName : ANOTHER_CAREGIVER;
}

/**
 * purpose: Turn the household's agent requests into chat lines, oldest first: each request is
 *          the caregiver's message, then Sunny's reply, a "working" line while it is queued or
 *          running, or the error when it failed. Cancelled requests show only the message.
 * @param requests: (AgentRequest[]) Requests as agentRequests.list returns them (newest first).
 * @param userId: (string | null) The signed-in caregiver's Clerk user id, to tell their own
 *        messages from other caregivers'.
 * @return: (TranscriptEntry[]) The lines in reading order.
 */
export function buildTranscript(
  requests: AgentRequest[],
  userId: string | null,
): TranscriptEntry[] {
  const entries: TranscriptEntry[] = [];
  for (const request of [...requests].reverse()) {
    entries.push({
      id: `${request.id}-message`,
      kind: 'caregiver',
      text: request.message,
      speaker: messageSpeaker(request.requestedBy, request.requestedByName, userId),
    });
    if (request.status === 'queued' || request.status === 'running') {
      entries.push({
        id: `${request.id}-status`,
        kind: 'working',
        text: WORKING_TEXT,
        speaker: null,
      });
    } else if (request.status === 'failed') {
      entries.push({
        id: `${request.id}-status`,
        kind: 'error',
        text: request.error?.trim() ? request.error : FAILED_TEXT,
        speaker: null,
      });
    } else if (request.status === 'succeeded' && request.reply?.trim()) {
      entries.push({
        id: `${request.id}-reply`,
        kind: 'sunny',
        text: request.reply,
        speaker: null,
      });
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
