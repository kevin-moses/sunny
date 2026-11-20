import type { FunctionReturnType } from 'convex/server';

import type { api } from '../backend/convexApi';
import {
  compareTaskTime,
  displayTime,
  eventDetails,
  eventKey,
  isAnytime,
  isDone,
  isOpen,
  stepCounter,
} from '../day/format';
import {
  addDays,
  dayOfMonth,
  formatLocalDate,
  monthName,
  parseLocalDate,
  weekdayName,
  yearOf,
} from '../day/localDate';
import type { DayTask, DayViewData, EventOccurrence, PlannedTask } from '../day/types';

export type ChatItem = FunctionReturnType<typeof api.agentRequests.transcript>[number];

export type AgentRequest = Extract<ChatItem, { type: 'request' }>;

export type ChatPost = Extract<ChatItem, { type: 'post' }>;

export type MailHeader = NonNullable<ChatPost['mailHeader']>;

export const DIGEST_LABEL = 'Daily summary';

export const MAIL_LABEL = 'Mail';

export const HIGH_PRIORITY_DETAIL = 'High priority';

export const WEEK_LENGTH = 7;

export const WORKING_TEXT = 'Sunny is working on it...';

export const FAILED_TEXT = 'Sunny could not finish that. Please try again.';

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

function shortMonthDay(time: number): string {
  return `${monthName(time).slice(0, 3)} ${dayOfMonth(time)}`;
}

export function weekRangeLabel(todayLocalDate: string): string {
  const start = parseLocalDate(todayLocalDate);
  if (start === null) return '';
  return `${shortMonthDay(start)} – ${shortMonthDay(addDays(start, WEEK_LENGTH - 1))}`;
}

export interface WeekStripDay {
  localDate: string;
  weekdayShort: string;
  dayOfMonth: string;
  isToday: boolean;
  hasMarker: boolean;
  accessibilityLabel: string;
}

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

export function isAlert(task: DayTask): boolean {
  return !isAnytime(task) && (task.state === 'escalated' || task.state === 'missed');
}

export function stepProgress(task: Pick<DayTask, 'state' | 'step'>): string | null {
  if (task.step === null || task.step.index === 0 || !isOpen(task)) return null;
  return stepCounter(task.step);
}

function openDetail(task: Pick<DayTask, 'state' | 'step' | 'highPriority'>): string | null {
  if (!isOpen(task)) return null;
  const parts = [
    task.highPriority ? HIGH_PRIORITY_DETAIL : null,
    task.step === null ? null : stepCounter(task.step),
  ].filter((part) => part !== null);
  return parts.length === 0 ? null : parts.join(' · ');
}

export function alertMessage(task: DayTask): string {
  const parts: string[] = [];
  if (task.carriedOver) parts.push('Left over from yesterday.');
  parts.push(`Due at ${displayTime(task.scheduledTime)}.`);
  const progress = stepProgress(task);
  if (progress !== null) parts.push(`On ${progress.toLowerCase()}.`);
  if (task.state === 'escalated') parts.push('Sunny has alerted the family.');
  return parts.join(' ');
}

export function noteFromInput(text: string | undefined): string | undefined {
  const note = text?.trim();
  return note === undefined || note === '' ? undefined : note;
}

export const ALREADY_DONE_MESSAGE = 'Already marked done.';

export function alreadyDoneMessage(
  confirmedBy: string | undefined,
  userId: string | null,
): string | null {
  return confirmedBy !== undefined && confirmedBy === userId ? null : ALREADY_DONE_MESSAGE;
}

type DeviceSurface = Exclude<NonNullable<DayTask['confirmedVia']>, 'caregiver'>;

const SURFACE_PHRASE: Record<DeviceSurface, string> = {
  button: 'on the display',
  widget: 'from the widget',
  live_activity: 'from the Live Activity',
  phone_app: 'on the phone',
  voice: 'by voice',
};

function sentPhrase(localTime: string, daysLater: number): string {
  const time = displayTime(localTime);
  if (daysLater <= 0) return `sent at ${time}`;
  if (daysLater === 1) return `sent the next day at ${time}`;
  return `sent ${daysLater} days later at ${time}`;
}

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
    const sent =
      task.confirmReceivedLocalTime === null
        ? ''
        : ` (${sentPhrase(task.confirmReceivedLocalTime, task.confirmReceivedDaysLater ?? 0)})`;
    first = `Done${at}${surface === undefined ? '' : ` ${surface}`}${sent}`;
  }
  return first;
}

export function claimText(task: DayTask, userId: string | null): string | null {
  if (task.claimedBy === null) return null;
  if (task.claimedBy === userId) return "You're on it";
  return `${task.claimedByName ?? 'Someone'} is on it`;
}

export type TaskVariant = 'done' | 'alert' | 'open';

export const VARIANT_STYLE: Record<TaskVariant, { status: string }> = {
  done: { status: 'Done' },
  alert: { status: 'Not confirmed' },
  open: { status: '' },
};

interface RowBase {
  id: string;
  time: string;
  label: string;
  detail: string | null;
  accessibilityLabel: string;
}

export interface TaskRowData extends RowBase {
  kind: 'task';
  variant: TaskVariant;
  instanceId: DayTask['instanceId'];
  note: string | null;
  reopenable: boolean;
}

export interface EventRowData extends RowBase {
  kind: 'event';
}

export type ScheduleRowData = TaskRowData | EventRowData;

function spokenLabel(row: {
  time: string;
  label: string;
  status: string;
  detail: string | null;
  note: string | null;
}): string {
  const spoken = `${row.time}, ${row.label}${row.status === '' ? '' : `, ${row.status}`}`;
  return [spoken, row.detail, row.note === null ? null : `Note: ${row.note}`]
    .filter((part) => part !== null)
    .join('. ');
}

function taskRow(task: DayTask, options: { id: string; userId: string | null }): TaskRowData {
  const variant: TaskVariant = !isOpen(task) ? 'done' : isAlert(task) ? 'alert' : 'open';
  const time = displayTime(task.scheduledTime);
  const detail = doneDetail(task, options.userId) ?? openDetail(task);
  return {
    kind: 'task',
    id: options.id,
    variant,
    time,
    label: task.displayLabel,
    detail,
    instanceId: task.instanceId,
    note: task.resolutionNote,
    reopenable: variant === 'done' && task.reopenable === true,
    accessibilityLabel: spokenLabel({
      time,
      label: task.displayLabel,
      status: VARIANT_STYLE[variant].status,
      detail,
      note: task.resolutionNote,
    }),
  };
}

function eventRow(event: EventOccurrence, id: string): EventRowData {
  const time = displayTime(event.startTime);
  const label = eventDetails(event, event.label);
  return {
    kind: 'event',
    id,
    time,
    label,
    detail: null,
    accessibilityLabel: spokenLabel({ time, label, status: '', detail: null, note: null }),
  };
}

export type CheckboxKind = 'open' | 'alert' | 'done' | 'disabled';

export interface CheckboxState {
  kind: CheckboxKind;
  interactive: boolean;
}

export function checkboxState(
  row: TaskRowData,
  flags: { canEdit: boolean; busy: boolean },
): CheckboxState {
  if (flags.busy) return { kind: 'done', interactive: false };
  if (row.variant === 'done') {
    return { kind: 'done', interactive: flags.canEdit && row.reopenable };
  }
  if (!flags.canEdit) return { kind: 'disabled', interactive: false };
  return { kind: row.variant, interactive: true };
}

export function noteLine(note: string | null): string | null {
  const text = noteFromInput(note ?? undefined);
  return text === undefined ? null : `Note: ${text}`;
}

export function shouldSaveNote(draft: string, current: string | null): boolean {
  return noteFromInput(draft) !== noteFromInput(current ?? undefined);
}

export function eventsForDate(day: DayViewData, date: string): EventRowData[] {
  const events = date === day.localDate ? day.eventsToday : day.upcoming;
  return events
    .filter((e) => e.localDate === date)
    .sort((a, b) => a.startTime.localeCompare(b.startTime))
    .map((event) => eventRow(event, eventKey(event)));
}

export interface PlannedTaskRowData {
  id: string;
  time: string;
  label: string;
  accessibilityLabel: string;
}

export function plannedTasksForDate(day: DayViewData, date: string): PlannedTaskRowData[] | null {
  if (date <= day.localDate) return null;
  return day.upcomingTasks
    .filter((task) => task.localDate === date)
    .map((task: PlannedTask) => {
      const time = displayTime(task.scheduledTime);
      return {
        id: `planned-${task.taskId}-${task.scheduledTime}`,
        time,
        label: task.displayLabel,
        accessibilityLabel: `${time}, ${task.displayLabel}, planned, not available to mark done yet`,
      };
    });
}

export interface TodaysTasks {
  leftover: TaskRowData[];
  today: TaskRowData[];
}

export function todaysTasks(day: DayViewData, userId: string | null): TodaysTasks {
  const result: TodaysTasks = { leftover: [], today: [] };
  const ordered = [...day.tasks].sort(compareTaskTime);
  for (const task of ordered) {
    const row = taskRow(task, { id: `task-${task.instanceId}`, userId });
    (task.carriedOver ? result.leftover : result.today).push(row);
  }
  return result;
}

export function selectedDayTitle(todayDate: string, date: string): string {
  if (date === todayDate) return 'Today';
  const time = parseLocalDate(date);
  if (time === null) return '';
  return `${weekdayName(time)}, ${shortMonthDay(time)}`;
}

export interface LaterDayGroup {
  date: string;
  title: string;
  rows: EventRowData[];
}

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

export interface DaySelection {
  date: string;
  todayWhenChosen: string;
}

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

export type TaskWording = AgentRequest['wording'][number];

export const ON_DISPLAY = 'On the display';

export const SUNNY_SAYS = 'Sunny says';

export const NOT_SPOKEN = 'Nothing. Tasks without a time are not announced.';

export interface TranscriptEntry {
  id: string;
  kind: 'caregiver' | 'sunny' | 'notice' | 'working' | 'error' | 'wording';
  text: string;
  speaker: string | null;
  label: string | null;
  wording: TaskWording | null;
}

export function otherTimesCaption(wording: TaskWording): string | null {
  const others = wording.times.slice(1);
  return others.length === 0 ? null : `Also at ${others.map(displayTime).join(', ')}`;
}

export function wordingSpeech(wording: TaskWording): string {
  const display = `${ON_DISPLAY}: ${wording.time} ${wording.label}.`;
  const says = `${SUNNY_SAYS}: ${wording.sentence ?? NOT_SPOKEN}`;
  const others = otherTimesCaption(wording);
  return others === null ? `${display} ${says}` : `${display} ${says} ${others}.`;
}

function longDate(localDate: string): string | null {
  const time = parseLocalDate(localDate);
  return time === null ? null : `${weekdayName(time)}, ${monthName(time)} ${dayOfMonth(time)}`;
}

export function postLabel(localDate: string): string {
  const date = longDate(localDate);
  return date === null ? DIGEST_LABEL : `${DIGEST_LABEL}, ${date}`;
}

function mailHeaderLabel(header: MailHeader): string {
  const from =
    header.senderName === null
      ? header.senderAddress
      : `${header.senderName} <${header.senderAddress}>`;
  const verified = header.senderVerified ? 'verified sender' : 'sender not verified';
  const date = longDate(header.receivedDate) ?? header.receivedDate;
  return [
    `From: ${from} (${verified})`,
    `Subject: ${header.subject}`,
    `Received: ${date} at ${displayTime(header.receivedTime)}`,
  ].join('\n');
}

export const ANOTHER_CAREGIVER = 'Another caregiver';

export function messageSpeaker(
  requestedBy: string,
  requestedByName: string | null,
  userId: string | null,
): string | null {
  if (userId === null || requestedBy === userId) return null;
  return requestedByName?.trim() ? requestedByName : ANOTHER_CAREGIVER;
}

function requestEntries(request: AgentRequest, userId: string | null): TranscriptEntry[] {
  const entries: TranscriptEntry[] = [
    {
      id: `${request.id}-message`,
      kind: 'caregiver',
      text: request.message,
      speaker: messageSpeaker(request.requestedBy, request.requestedByName, userId),
      label: null,
      wording: null,
    },
  ];
  const line = { id: `${request.id}-status`, speaker: null, label: null, wording: null };
  if (request.status === 'queued' || request.status === 'running') {
    entries.push({ ...line, kind: 'working', text: WORKING_TEXT });
  } else if (request.status === 'failed') {
    entries.push({
      ...line,
      kind: 'error',
      text: request.error?.trim() ? request.error : FAILED_TEXT,
    });
  } else if (request.status === 'succeeded' && request.reply?.trim()) {
    entries.push({ ...line, id: `${request.id}-reply`, kind: 'sunny', text: request.reply });
  }
  if (request.status !== 'queued' && request.status !== 'running') {
    for (const wording of request.wording) {
      entries.push({
        ...line,
        id: `${request.id}-wording-${wording.taskId}`,
        kind: 'wording',
        text: wordingSpeech(wording),
        wording,
      });
    }
  }
  return entries;
}

function postEntry(post: ChatPost): TranscriptEntry {
  const entry = {
    id: `${post.id}-post`,
    kind: 'sunny',
    text: post.body,
    speaker: null,
    label: null,
    wording: null,
  } as const;
  switch (post.kind) {
    case 'digest':
      return { ...entry, label: postLabel(post.localDate) };
    case 'mail':
      return {
        ...entry,
        label: post.mailHeader === null ? MAIL_LABEL : mailHeaderLabel(post.mailHeader),
      };
    case 'mailbox':
      return { ...entry, kind: 'notice' };
  }
}

export function buildTranscript(items: ChatItem[], userId: string | null): TranscriptEntry[] {
  return [...items]
    .reverse()
    .flatMap((item): TranscriptEntry[] =>
      item.type === 'request' ? requestEntries(item, userId) : [postEntry(item)],
    );
}

export function hasInProgress(items: ChatItem[]): boolean {
  return items.some(
    (item) => item.type === 'request' && (item.status === 'queued' || item.status === 'running'),
  );
}
