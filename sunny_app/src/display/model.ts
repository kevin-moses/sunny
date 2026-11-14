// sunny_app/src/display/model.ts
//
// Purpose: Pure rules that turn the household's day view (calendar.dayView) into what the home
// display shows: the Now card (the task to act on, overdue or not, and its steps; or a calm
// "nothing to do" state), the Next up item, the rows of the Today screen, and the date line
// ("November 8, 2026"), and the household-local time now (nowTime). Times use clockTime from
// day/format ("8:00"). A task whose window closed unconfirmed (missed) gets its own row mark
// so the screen can grey it without a check and without a "Now" tag. A missed task never
// becomes the Now task, but it stops the Now card from claiming the day is all done.
//
// The Now task is the first due or escalated timed task in the day view's order; the Done key
// confirms it by its instance id, so it always confirms the task the screen shows. A task is
// overdue once the family has been alerted (escalated) or when it is still open from
// yesterday. Multi-step instructions have no backend fields yet:
// until they do, a task's checklist items (two or more) stand in for its steps.
//
// Last modified: 2026-11-14

import type { SFSymbol } from 'expo-symbols';

import { ANYTIME, clockTime, isDone, isDue, isMissed, relativeDayName } from '../day/format';
import type { AgendaItem, DayTask, DayViewData, EventOccurrence } from '../day/types';

/** How many rows fit on the Today screen. */
const MAX_TODAY_ROWS = 7;

/** The Now card for a task waiting to be done. */
export interface TaskCard {
  kind: 'task';
  task: DayTask;
  /** The family has been alerted, or the task is still open from yesterday. */
  overdue: boolean;
  /** The task's steps, or null for a one-step task. */
  steps: string[] | null;
}

/** What the Now card shows. */
export type NowCard =
  | TaskCard
  | {
      kind: 'clear';
      /**
       * Nothing is left today: no open task, no later event and no missed task (a missed
       * task keeps the card at the calm "nothing to do right now" until it is confirmed).
       */
      allDone: boolean;
    };

/** What the Next up card shows. */
export interface NextItem {
  title: string;
  /** "10:00", or "Tomorrow, 9:00" for a later day. */
  when: string;
  icon: SFSymbol;
  /** The visitor's initial, drawn instead of the icon; null when nobody visits. */
  initial: string | null;
}

/** One row of the Today screen. */
export interface TodayRow {
  key: string;
  time: string;
  label: string;
  /**
   * done: checked and grey; now: the Now task, boxed and tagged; missed: grey with no check
   * and no tag (its window closed unconfirmed); none: plain.
   */
  mark: 'done' | 'now' | 'missed' | 'none';
}

/**
 * purpose: The date line under the header, with the year: "November 8, 2026".
 * @param day: (Pick<DayViewData, 'dateLabel' | 'localDate'>) The day view.
 * @return: (string) The date line.
 */
export function fullDate(day: Pick<DayViewData, 'dateLabel' | 'localDate'>): string {
  return `${day.dateLabel}, ${day.localDate.slice(0, 4)}`;
}

/**
 * purpose: The household-local time of the day view, "HH:MM".
 * @param day: (Pick<DayViewData, 'localNow'>) The day view.
 * @return: (string) The time part of localNow.
 */
export function nowTime(day: Pick<DayViewData, 'localNow'>): string {
  return day.localNow.slice(11, 16);
}

/**
 * purpose: The icon of a task type.
 * @param type: (DayTask['type']) The task type.
 * @return: (SFSymbol) The SF Symbol drawn for it.
 */
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

/**
 * purpose: The question above the Done key: "Taken them?" for medication, "Finished?" for
 *          anything else.
 * @param task: (Pick<DayTask, 'type'>) The task.
 * @return: (string) The question.
 */
export function doneQuestion(task: Pick<DayTask, 'type'>): string {
  return task.type === 'medication' ? 'Taken them?' : 'Finished?';
}

/**
 * purpose: A task's steps, shown one at a time. Temporary: until tasks carry instruction
 *          steps, the checklist items stand in for them.
 * @param task: (Pick<DayTask, 'checklistItems'>) The task.
 * @return: (string[] | null) Two or more steps, or null for a one-step task.
 */
export function instructionSteps(task: Pick<DayTask, 'checklistItems'>): string[] | null {
  return task.checklistItems.length >= 2 ? task.checklistItems : null;
}

/**
 * purpose: Decide what the Now card shows: the first due or escalated timed task (the task
 *          a bare Done confirms), otherwise a calm clear state. The clear state says the day is
 *          all done only when nothing is waiting or coming and no task today is missed.
 * @param day: (DayViewData) The day view.
 * @return: (NowCard) The card.
 */
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
  // A missed task (its window closed) is not waiting, but the day is not all done either.
  const openTask = day.tasks.some(
    (t) => t.state === 'upcoming' || t.state === 'due' || t.state === 'escalated',
  );
  const laterEvent = day.eventsToday.some((e) => e.startTime > now);
  const anyMissed = day.tasks.some(isMissed);
  return { kind: 'clear', allDone: !openTask && !laterEvent && !anyMissed };
}

/**
 * purpose: The words for an event on another day: "Tomorrow, 9:00" or "Monday, 9:00".
 * @param event: (EventOccurrence) The occurrence.
 * @param today: (string) The day view's localDate.
 * @return: (string) The when text; just the time when the dates cannot be read.
 */
function laterWhen(event: EventOccurrence, today: string): string {
  const time = clockTime(event.startTime);
  const day = relativeDayName(event.localDate, today);
  return day === null ? time : `${day}, ${time}`;
}

/**
 * purpose: The Next up card for an event.
 * @param event: (EventOccurrence) The occurrence.
 * @param when: (string) Its when text.
 * @return: (NextItem) The card.
 */
function eventNext(event: EventOccurrence, when: string): NextItem {
  const visitor = event.visitorName?.trim() ?? '';
  return {
    title: event.label,
    when,
    icon: 'calendar',
    initial: visitor === '' ? null : Array.from(visitor)[0]!.toUpperCase(),
  };
}

/**
 * purpose: The next thing after the Now task: the first later task or event today in agenda
 *          order, otherwise the next event on a later day.
 * @param day: (DayViewData) The day view.
 * @param agenda: (AgendaItem[]) Today's merged, time-ordered agenda.
 * @param nowTaskId: (string | null) The Now task's instanceId, skipped here.
 * @return: (NextItem | null) The card, or null when nothing is coming.
 */
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

/**
 * purpose: The mark of a task's Today row: now for the Now task, done once confirmed, missed
 *          when its window closed unconfirmed, otherwise none.
 * @param task: (DayTask) The task.
 * @param nowTaskId: (string | null) The Now task's instanceId.
 * @return: (TodayRow['mark']) The mark.
 */
function taskMark(task: DayTask, nowTaskId: string | null): TodayRow['mark'] {
  if (task.instanceId === nowTaskId) return 'now';
  if (isDone(task)) return 'done';
  return isMissed(task) ? 'missed' : 'none';
}

/**
 * purpose: The rows of the Today screen. When there are more than fit, the earliest finished
 *          rows are dropped first, then the latest rows, which `hidden` counts.
 * @param agenda: (AgendaItem[]) Today's merged, time-ordered agenda.
 * @param nowTaskId: (string | null) The Now task's instanceId, marked "now".
 * @param maxRows: (number) How many rows fit, counting the "more" line when one is needed.
 * @return: ({ rows: TodayRow[]; hidden: number }) The rows and how many later ones were left out.
 */
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
