import type { SFSymbol } from 'expo-symbols';

import { ANYTIME, clockTime, isDone, isDue, isMissed, relativeDayName } from '../day/format';
import type { AgendaItem, DayTask, DayViewData, EventOccurrence } from '../day/types';

const MAX_TODAY_ROWS = 7;

export interface TaskCard {
  kind: 'task';
  task: DayTask;
  overdue: boolean;
  steps: string[] | null;
}

export type NowCard =
  | TaskCard
  | {
      kind: 'clear';
      allDone: boolean;
    };

export interface NextItem {
  title: string;
  when: string;
  icon: SFSymbol;
  initial: string | null;
}

export interface TodayRow {
  key: string;
  time: string;
  label: string;
  mark: 'done' | 'now' | 'missed' | 'none';
}

export function fullDate(day: Pick<DayViewData, 'dateLabel' | 'localDate'>): string {
  return `${day.dateLabel}, ${day.localDate.slice(0, 4)}`;
}

export function nowTime(day: Pick<DayViewData, 'localNow'>): string {
  return day.localNow.slice(11, 16);
}

export function taskIcon(type: DayTask['type']): SFSymbol {
  switch (type) {
    case 'medication':
      return 'pills';
    case 'appointment':
      return 'calendar';
    case 'checklist':
      return 'checklist';
    case 'reminder':
      return 'bell';
    case 'routine':
      return 'clock';
  }
}

export function doneQuestion(task: Pick<DayTask, 'type'>): string {
  return task.type === 'medication' ? 'Taken them?' : 'Finished?';
}

export function instructionSteps(task: Pick<DayTask, 'checklistItems' | 'step'>): string[] | null {
  return task.step === null ? null : task.checklistItems;
}

export function nowCard(day: DayViewData): NowCard {
  const task = day.tasks.find(isDue);
  if (task !== undefined) {
    return {
      kind: 'task',
      task,
      overdue: task.state === 'escalated' || task.carriedOver,
      steps: instructionSteps(task),
    };
  }
  const now = nowTime(day);
  const openTask = day.tasks.some(
    (t) => t.state === 'upcoming' || t.state === 'due' || t.state === 'escalated',
  );
  const laterEvent = day.eventsToday.some((e) => e.startTime > now);
  const anyMissed = day.tasks.some(isMissed);
  return { kind: 'clear', allDone: !openTask && !laterEvent && !anyMissed };
}

function laterWhen(event: EventOccurrence, today: string): string {
  const time = clockTime(event.startTime);
  const day = relativeDayName(event.localDate, today);
  return day === null ? time : `${day}, ${time}`;
}

function eventNext(event: EventOccurrence, when: string): NextItem {
  const visitor = event.visitorName?.trim() ?? '';
  return {
    title: event.label,
    when,
    icon: 'calendar',
    initial: visitor === '' ? null : Array.from(visitor)[0]!.toUpperCase(),
  };
}

export function nextItem(
  day: DayViewData,
  agenda: AgendaItem[],
  nowTaskId: string | null,
): NextItem | null {
  const now = nowTime(day);
  for (const item of agenda) {
    if (item.kind === 'event') {
      if (item.event.startTime > now) {
        return eventNext(item.event, clockTime(item.event.startTime));
      }
      continue;
    }
    const { task } = item;
    const waiting = task.state === 'upcoming' || isDue(task);
    if (waiting && task.scheduledTime !== ANYTIME && task.instanceId !== nowTaskId) {
      return {
        title: task.displayLabel,
        when: clockTime(task.scheduledTime),
        icon: taskIcon(task.type),
        initial: null,
      };
    }
  }
  const later = day.upcoming.find((e) => e.localDate > day.localDate);
  return later === undefined ? null : eventNext(later, laterWhen(later, day.localDate));
}

function taskMark(task: DayTask, nowTaskId: string | null): TodayRow['mark'] {
  if (task.instanceId === nowTaskId) return 'now';
  if (isDone(task)) return 'done';
  return isMissed(task) ? 'missed' : 'none';
}

export function todayRows(
  agenda: AgendaItem[],
  nowTaskId: string | null,
  maxRows: number = MAX_TODAY_ROWS,
): { rows: TodayRow[]; hidden: number } {
  const all = agenda.map((item): TodayRow => {
    if (item.kind === 'event') {
      return {
        key: item.id,
        time: clockTime(item.event.startTime),
        label: item.event.label,
        mark: 'none',
      };
    }
    const { task } = item;
    return {
      key: item.id,
      time: clockTime(task.scheduledTime),
      label: task.displayLabel,
      mark: taskMark(task, nowTaskId),
    };
  });
  let excess = all.length - maxRows;
  const rows = all.filter((row) => {
    if (excess <= 0 || row.mark !== 'done') return true;
    excess -= 1;
    return false;
  });
  if (rows.length <= maxRows) return { rows, hidden: 0 };
  const shown = Math.max(maxRows - 1, 0);
  return { rows: rows.slice(0, shown), hidden: rows.length - shown };
}
