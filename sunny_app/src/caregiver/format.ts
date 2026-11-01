// sunny_app/src/caregiver/format.ts
//
// Purpose: Pure helpers for the caregiver app: the seven-day week strip (today through today+6),
// the date range and month labels, which tasks are alerts and who is on them, which tasks are
// open (upcoming, due, escalated or missed: an editor can mark any of them done; the checkbox
// looks open, alert, done or disabled), today's task rows (leftover and today, with the "who confirmed"
// detail line of done tasks and, for open tasks, what "Mark done" needs), the event rows of any
// day (tasks and events are kept apart; the week strip dots count events only), the title for the
// day selected in the week strip, the later days of the week grouped by day, and the chat transcript built from the
// household's agent requests (oldest first). Dates are household-local "YYYY-MM-DD" strings from
// calendar.dayView; date arithmetic comes from day/localDate (parsed once, then counted as
// days). No timezone conversion happens here: the server sends each confirmation as a
// household-local "HH:MM" (confirmedLocalTime) and marks yesterday's still-open tasks
// (carriedOver), and the message for a Mark done that another person beat (alreadyDoneMessage).
// Note helpers say who may open the note editor (canEditNote), how a saved note reads on a row
// (noteLine) and whether closing the editor must save (shouldSaveNote).
//
// Last modified: 2026-11-01

import type { FunctionReturnType } from 'convex/server';

import type { api } from '../backend/convexApi';
import { displayTime, eventDetails, eventKey, isDone, isDue } from '../day/format';
import {
  addDays,
  dayOfMonth,
  formatLocalDate,
  monthName,
  parseLocalDate,
  weekdayName,
  yearOf,
} from '../day/localDate';
import type { DayTask, DayViewData, EventOccurrence } from '../day/types';

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
  /** True when the dot shows: the day has events (tasks do not count). */
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
    const hasMarker = eventDates.has(localDate);
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
 * purpose: Whether a task is still open: an editor caregiver may mark it done at any time today,
 *          including before it is due (alerts are the escalated and missed subset, see isAlert).
 * @param task: (DayTask) The task.
 * @return: (boolean) True when its state is upcoming, due, escalated or missed.
 */
export function isOpen(task: DayTask): boolean {
  return task.state === 'upcoming' || isDue(task) || isAlert(task);
}

/**
 * purpose: The message under an alert's title.
 * @param task: (DayTask) An alert task.
 * @return: (string) "Due at 8:00 AM.", preceded by "Left over from yesterday." for a carried-over
 *          task and followed by "Sunny has alerted the family." when escalated.
 */
export function alertMessage(task: DayTask): string {
  const parts: string[] = [];
  if (task.carriedOver) parts.push('Left over from yesterday.');
  parts.push(`Due at ${displayTime(task.scheduledTime)}.`);
  if (task.state === 'escalated') parts.push('Sunny has alerted the family.');
  return parts.join(' ');
}

/**
 * purpose: Turn the text typed in the note editor into the note to save.
 * @param text: (string | undefined) What the caregiver typed, if anything.
 * @return: (string | undefined) The trimmed note, or undefined when empty (which clears it).
 */
export function noteFromInput(text: string | undefined): string | undefined {
  const note = text?.trim();
  return note === undefined || note === '' ? undefined : note;
}

/** Shown on a task another person finished before the caregiver's Mark done went through. */
export const ALREADY_DONE_MESSAGE = 'Already marked done.';

/**
 * purpose: Decide whether a Mark done call did nothing because someone else finished the task
 *          first. The server returns an already confirmed or resolved instance unchanged, so
 *          the instance's confirmedBy is the first confirmer, not necessarily this caregiver.
 * @param confirmedBy: (string | undefined) Clerk user id (or device id) on the returned instance.
 * @param userId: (string | null) The signed-in caregiver's Clerk user id.
 * @return: (string | null) ALREADY_DONE_MESSAGE when the confirmation is not this caregiver's;
 *          otherwise null.
 */
export function alreadyDoneMessage(
  confirmedBy: string | undefined,
  userId: string | null,
): string | null {
  return confirmedBy !== undefined && confirmedBy === userId ? null : ALREADY_DONE_MESSAGE;
}

/** A device surface a task can be confirmed from (everything but a caregiver's resolution). */
type DeviceSurface = Exclude<NonNullable<DayTask['confirmedVia']>, 'caregiver'>;

/** Where a device confirmation happened, as worded after "Done at <time>". */
const SURFACE_PHRASE: Record<DeviceSurface, string> = {
  button: 'on the display',
  widget: 'from the widget',
  live_activity: 'from the Live Activity',
  phone_app: 'on the phone',
  voice: 'by voice',
};

/**
 * purpose: The detail text under a done task: who confirmed it and when.
 *          Caregiver-resolved (state "resolved"): "Marked done by <name> at <time>" ("by you"
 *          for the signed-in caregiver, "by a caregiver" when their name is unknown).
 *          Device-confirmed: "Done at <time>" plus where it happened ("on the display", "by
 *          voice", ...). The note is not part of it (see the row's note), because a task
 *          can have a note before it is done.
 * @param task: (DayTask) The task.
 * @param userId: (string | null) The signed-in caregiver's Clerk user id.
 * @return: (string | null) The text; null when the task is not done, or a device confirmation
 *          has no time or surface to add to "Done".
 */
export function doneDetail(task: DayTask, userId: string | null): string | null {
  if (!isDone(task)) return null;
  const at = task.confirmedLocalTime === null ? '' : ` at ${displayTime(task.confirmedLocalTime)}`;
  let first: string;
  if (task.state === 'resolved') {
    const who =
      task.confirmedBy !== null && task.confirmedBy === userId
        ? 'you'
        : (task.confirmedByName ?? 'a caregiver');
    first = `Marked done by ${who}${at}`;
  } else {
    const surface =
      task.confirmedVia === null || task.confirmedVia === 'caregiver'
        ? undefined
        : SURFACE_PHRASE[task.confirmedVia];
    if (at === '' && surface === undefined) return null;
    first = `Done${at}${surface === undefined ? '' : ` ${surface}`}`;
  }
  return first;
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

/** What "Mark done" needs from a row's task. */
export interface Markable {
  instanceId: DayTask['instanceId'];
  label: string;
}

/** One line of the schedule card. */
export interface ScheduleRowData {
  id: string;
  variant: ScheduleVariant;
  time: string;
  label: string;
  /** Who confirmed a done task (see doneDetail); null for everything else. */
  detail: string | null;
  /** The task instance behind a task row (its actions and note are keyed by it); null for events. */
  instanceId: DayTask['instanceId'] | null;
  /** The note on a task, open or done; null when it has none and for events. */
  note: string | null;
  /** The task to mark done for an open task row; null for events and tasks that are not open. */
  markable: Markable | null;
  accessibilityLabel: string;
}

/**
 * purpose: Build a schedule row.
 * @param row: ({ id, variant, time, label, detail?, instanceId?, note?, markable? }) The row's
 *        fields: stable id, how it looks, display time, what happens, the done detail (default
 *        none), the task instance (default none), the task's note (default none) and the task
 *        to mark done (default none).
 * @return: (ScheduleRowData) The row, with its screen reader label.
 */
function scheduleRow(row: {
  id: string;
  variant: ScheduleVariant;
  time: string;
  label: string;
  detail?: string | null;
  instanceId?: DayTask['instanceId'];
  note?: string | null;
  markable?: Markable | null;
}): ScheduleRowData {
  const {
    id,
    variant,
    time,
    label,
    detail = null,
    note = null,
    markable = null,
    instanceId = null,
  } = row;
  const { status } = VARIANT_STYLE[variant];
  const spoken = `${time}, ${label}${status === '' ? '' : `, ${status}`}`;
  return {
    id,
    variant,
    time,
    label,
    instanceId,
    detail,
    note,
    markable,
    accessibilityLabel: [spoken, detail, note === null ? null : `Note: ${note}`]
      .filter((part) => part !== null)
      .join('. '),
  };
}

/**
 * purpose: Reduce a task to its schedule row.
 * @param task: (DayTask) The task.
 * @param options: ({ id: string, userId: string | null }) The row id and the signed-in
 *        caregiver's Clerk user id.
 * @return: (ScheduleRowData) The row; open tasks carry what "Mark done" needs.
 */
function taskRow(task: DayTask, options: { id: string; userId: string | null }): ScheduleRowData {
  return scheduleRow({
    id: options.id,
    variant: isDone(task) ? 'done' : isAlert(task) ? 'alert' : 'task',
    time: displayTime(task.scheduledTime),
    label: task.displayLabel,
    detail: doneDetail(task, options.userId),
    instanceId: task.instanceId,
    note: task.resolutionNote,
    markable: isOpen(task) ? { instanceId: task.instanceId, label: task.displayLabel } : null,
  });
}

/**
 * purpose: Reduce an event to its schedule row.
 * @param event: (EventOccurrence) The event occurrence.
 * @param id: (string) Row id.
 * @return: (ScheduleRowData) The row, worded "<label> with <visitor> at <place>".
 */
function eventRow(event: EventOccurrence, id: string): ScheduleRowData {
  return scheduleRow({
    id,
    variant: 'event',
    time: displayTime(event.startTime),
    label: eventDetails(event, event.label),
  });
}

/**
 * How a task row's checkbox looks: an open box, an open box in the serious colors, a checked box,
 * or a dulled open box that cannot be ticked (so a tap is never silently ignored).
 */
export type CheckboxKind = 'open' | 'alert' | 'done' | 'disabled';

/**
 * purpose: The checkbox a schedule row shows. Done tasks stay checked whether or not they can be
 *          ticked; an open task that cannot be ticked (a viewer, or a completion in flight)
 *          is dulled, without the alert border.
 * @param variant: (ScheduleVariant) The row's variant.
 * @param interactive: (boolean) Whether tapping the checkbox does something (checkboxInteractive).
 * @return: (CheckboxKind | null) The checkbox look; null for events, which keep their icon.
 */
export function checkboxKind(variant: ScheduleVariant, interactive: boolean): CheckboxKind | null {
  if (variant === 'event') return null;
  if (variant === 'done') return 'done';
  if (!interactive) return 'disabled';
  return variant === 'alert' ? 'alert' : 'open';
}

/**
 * purpose: Whether tapping a row's checkbox marks the task done: an editor on an open task.
 *          Done tasks (there is no undo), events and viewers get a non-interactive box.
 * @param row: (ScheduleRowData) The row.
 * @param canEdit: (boolean) Whether this caregiver may edit (everyone but viewers).
 * @return: (boolean) True when the checkbox is pressable.
 */
export function checkboxInteractive(row: ScheduleRowData, canEdit: boolean): boolean {
  return canEdit && row.markable !== null;
}

/**
 * purpose: Whether tapping a task row's text opens the note editor: editors on task rows (open
 *          or done). Viewers and events never get an editor.
 * @param row: (ScheduleRowData) The row.
 * @param canEdit: (boolean) Whether this caregiver may edit (everyone but viewers).
 * @return: (boolean) True when the editor can open.
 */
export function canEditNote(row: ScheduleRowData, canEdit: boolean): boolean {
  return canEdit && row.variant !== 'event' && row.instanceId !== null;
}

/**
 * purpose: The subtitle that shows a task's saved note on its collapsed row.
 * @param note: (string | null) The task's note.
 * @return: (string | null) "Note: <text>", or null when there is no note (or only blanks).
 */
export function noteLine(note: string | null): string | null {
  const text = noteFromInput(note ?? undefined);
  return text === undefined ? null : `Note: ${text}`;
}

/**
 * purpose: Decide whether closing the note editor must save: only when what was typed, trimmed,
 *          differs from the note the task has (a blank draft against no note is no change).
 * @param draft: (string) The text in the editor.
 * @param current: (string | null) The note the task has now.
 * @return: (boolean) True when the draft should be saved (a blank draft then clears the note).
 */
export function shouldSaveNote(draft: string, current: string | null): boolean {
  return noteFromInput(draft) !== noteFromInput(current ?? undefined);
}

/**
 * purpose: The event rows of one day of the week, never tasks. Today's events come from the day
 *          view's eventsToday, every later day's from its upcoming events.
 * @param day: (DayViewData) The day view.
 * @param date: (string) The local date "YYYY-MM-DD".
 * @return: (ScheduleRowData[]) That day's events in time order; empty when there are none.
 */
export function eventsForDate(day: DayViewData, date: string): ScheduleRowData[] {
  const events = date === day.localDate ? day.eventsToday : day.upcoming;
  return events
    .filter((e) => e.localDate === date)
    .sort((a, b) => a.startTime.localeCompare(b.startTime))
    .map((event) => eventRow(event, eventKey(event)));
}

/** Today's tasks: yesterday's open tasks (leftover) and today's own, each in time order. */
export interface TodaysTasks {
  leftover: ScheduleRowData[];
  today: ScheduleRowData[];
}

/**
 * purpose: Today's task rows, independent of the week strip selection and never events. Tasks
 *          carried over from yesterday go to leftover, the rest to today, each in scheduled-time
 *          order (ties keep the day view's order).
 * @param day: (DayViewData) The day view.
 * @param userId: (string | null) The signed-in caregiver's Clerk user id, to word "by you".
 * @return: (TodaysTasks) The leftover and today's rows; both empty when there are no tasks.
 */
export function todaysTasks(day: DayViewData, userId: string | null): TodaysTasks {
  const result: TodaysTasks = { leftover: [], today: [] };
  const ordered = [...day.tasks].sort((a, b) => a.scheduledTime.localeCompare(b.scheduledTime));
  for (const task of ordered) {
    const row = taskRow(task, { id: `task-${task.instanceId}`, userId });
    (task.carriedOver ? result.leftover : result.today).push(row);
  }
  return result;
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

/** One later day of the week: its date, heading and event rows. */
export interface LaterDayGroup {
  date: string;
  /** For example "Sunday, Nov 1". */
  title: string;
  rows: ScheduleRowData[];
}

/**
 * purpose: The days after the selected one, through the end of the week strip, that have
 *          events, for the "Later this week" section. Today is never included (the selected
 *          day is today or later), so its tasks never appear here.
 * @param day: (DayViewData) The day view.
 * @param strip: (WeekStripDay[]) The week strip, today first.
 * @param selectedDate: (string) The selected local date.
 * @return: (LaterDayGroup[]) One group per day with events, in date order; empty when none.
 */
export function laterThisWeek(
  day: DayViewData,
  strip: WeekStripDay[],
  selectedDate: string,
): LaterDayGroup[] {
  const groups: LaterDayGroup[] = [];
  for (const { localDate } of strip) {
    if (localDate <= selectedDate) continue;
    const rows = eventsForDate(day, localDate);
    if (rows.length > 0) {
      groups.push({ date: localDate, title: selectedDayTitle(day.localDate, localDate), rows });
    }
  }
  return groups;
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
