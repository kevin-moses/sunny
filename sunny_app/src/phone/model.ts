import {
  displayTime,
  isAnytime,
  isDone,
  isDue,
  isMissed,
  relativeDayName,
  SPOKEN,
  stepCounter,
} from '../day/format';
import { localClockTime } from '../day/localDate';
import type { AgendaItem, DayTask, DayViewData, EventOccurrence } from '../day/types';
import type { UndoLineData } from '../day/useDoneAction';

export const NOTHING_DUE = 'Nothing to do right now.';

export const COMING_UP = 'Coming up';

export const EARLIER_TODAY = 'Earlier today';

const EVENT_WITHOUT_END_MS = 60 * 60_000;

export type ScreenMode =
  | {
      kind: 'task';
      task: DayTask;
      early: boolean;
      undo: UndoLineData | null;
      message: string | null;
    }
  | { kind: 'noted'; undo: UndoLineData; noted: string; message: string | null }
  | { kind: 'notice'; message: string }
  | { kind: 'clear'; next: string | null };

export interface ModeInput {
  task: DayTask | null;
  message: string | null;
  undo: UndoLineData | null;
  next: string | null;
  timezone: string;
}

export function screenMode({ task, message, undo, next, timezone }: ModeInput): ScreenMode {
  if (task !== null) return { kind: 'task', task, early: task.state === 'upcoming', undo, message };
  if (undo !== null)
    return { kind: 'noted', undo, noted: notedAt(undo.pressedAt, timezone), message };
  if (message !== null) return { kind: 'notice', message };
  return { kind: 'clear', next };
}

export interface Headline {
  sentence: string;
  detail: string | null;
}

export function taskHeadline(task: DayTask): Headline {
  if (task.step !== null) return { sentence: task.step.text, detail: task.displayLabel };
  return { sentence: task.screenSentence ?? task.displayLabel, detail: task.pillDescription };
}

export function comingUpAt(task: Pick<DayTask, 'scheduledTime'>): string {
  return `${COMING_UP} at ${displayTime(task.scheduledTime)}`;
}

export function stepTag(task: Pick<DayTask, 'step'>): string | null {
  return task.step === null ? null : stepCounter(task.step);
}

export function doneKeyLabel(task: DayTask, early: boolean): string {
  const step = task.step;
  const stepSpoken = step === null ? '' : `, ${stepCounter(step).toLowerCase()}, ${step.text}`;
  return early
    ? `Done early: ${task.displayLabel}${stepSpoken}, ${comingUpAt(task).toLowerCase()}`
    : `Done: ${task.displayLabel}${stepSpoken}`;
}

function twoDigits(value: number): string {
  return String(value).padStart(2, '0');
}

function phoneClock(epochMs: number): string {
  const date = new Date(epochMs);
  return `${twoDigits(date.getHours())}:${twoDigits(date.getMinutes())}`;
}

export function notedAt(pressedAt: number, timezone: string): string {
  return `Noted at ${displayTime(localClockTime(timezone, pressedAt) ?? phoneClock(pressedAt))}`;
}

export function eventIsOver(
  event: Pick<EventOccurrence, 'startsAt' | 'endsAt'>,
  now: number,
): boolean {
  return (event.endsAt ?? event.startsAt + EVENT_WITHOUT_END_MS) <= now;
}

function laterDayWord(event: EventOccurrence, today: string): string | null {
  const day = relativeDayName(event.localDate, today);
  return day === 'Tomorrow' ? 'tomorrow' : day;
}

function laterEventText(event: EventOccurrence, today: string): string {
  const time = displayTime(event.startTime);
  const day = laterDayWord(event, today);
  return day === null ? `${event.label} at ${time}` : `${event.label} ${day} at ${time}`;
}

function todayNext(item: AgendaItem, now: number): string | null {
  if (item.kind === 'event') {
    return item.event.startsAt > now
      ? `${item.event.label} at ${displayTime(item.event.startTime)}`
      : null;
  }
  const { task } = item;
  return task.state === 'upcoming' && !isAnytime(task)
    ? `${task.displayLabel} at ${displayTime(task.scheduledTime)}`
    : null;
}

export function nextLine(
  day: Pick<DayViewData, 'localDate' | 'upcoming'>,
  agenda: readonly AgendaItem[],
  now: number,
): string | null {
  for (const item of agenda) {
    const text = todayNext(item, now);
    if (text !== null) return `Next: ${text}`;
  }
  const later = day.upcoming.find((event) => event.localDate > day.localDate);
  return later === undefined ? null : `Next: ${laterEventText(later, day.localDate)}`;
}

export type RowTone = 'plain' | 'now' | 'early' | 'grey';

export interface DayRow {
  key: string;
  time: string;
  label: string;
  mark: 'none' | 'done' | 'event';
  tone: RowTone;
  spoken: string;
}

function eventRow(item: Extract<AgendaItem, { kind: 'event' }>, now: number): DayRow {
  const over = eventIsOver(item.event, now);
  return {
    key: item.id,
    time: displayTime(item.event.startTime),
    label: item.event.label,
    mark: 'event',
    tone: over ? 'grey' : 'plain',
    spoken: over ? EARLIER_TODAY : '',
  };
}

function taskTone(task: DayTask, shown: DayTask | null): { tone: RowTone; spoken: string } {
  if (isDone(task)) return { tone: 'grey', spoken: SPOKEN.done };
  if (isMissed(task)) return { tone: 'grey', spoken: SPOKEN.missed };
  if (shown === null || shown.instanceId !== task.instanceId) return { tone: 'plain', spoken: '' };
  return isDue(task)
    ? { tone: 'now', spoken: SPOKEN.dueNow }
    : { tone: 'early', spoken: COMING_UP };
}

export function dayRows(
  agenda: readonly AgendaItem[],
  shown: DayTask | null,
  now: number,
): DayRow[] {
  return agenda.map((item) => {
    if (item.kind === 'event') return eventRow(item, now);
    const { task } = item;
    return {
      key: item.id,
      time: displayTime(task.scheduledTime),
      label: task.displayLabel,
      mark: isDone(task) ? 'done' : 'none',
      ...taskTone(task, shown),
    };
  });
}
