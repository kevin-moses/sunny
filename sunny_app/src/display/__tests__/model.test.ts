// sunny_app/src/display/__tests__/model.test.ts
//
// Purpose: Unit tests for the home display's rules: the date wording, which task the Now card
// shows and when it reads as overdue or multi-step, the Next up pick, and the Today rows
// (marks and overflow). Fixtures fill only what the rules read.
//
// Last modified: 2026-11-13

import { describe, expect, it } from '@jest/globals';

import { buildAgenda } from '../../day/format';
import type { DayTask, DayViewData, EventOccurrence } from '../../day/types';
import { fullDate, nextItem, nowCard, todayRows } from '../model';

/**
 * purpose: Build a task.
 * @param overrides: (Partial<Record<keyof DayTask, unknown>>) Fields to set.
 * @return: (DayTask) An upcoming 08:00 medication unless overridden.
 */
function makeTask(overrides: Partial<Record<keyof DayTask, unknown>> = {}): DayTask {
  return {
    instanceId: 't1',
    taskId: 'task1',
    type: 'medication',
    displayLabel: 'Morning pills',
    pillDescription: null,
    checklistItems: [],
    scheduledTime: '08:00',
    state: 'upcoming',
    carriedOver: false,
    ...overrides,
  } as DayTask;
}

/**
 * purpose: Build an event occurrence on the fixture day.
 * @param overrides: (Partial<Record<keyof EventOccurrence, unknown>>) Fields to set.
 * @return: (EventOccurrence) A 14:00 visit by Sarah unless overridden.
 */
function makeEvent(
  overrides: Partial<Record<keyof EventOccurrence, unknown>> = {},
): EventOccurrence {
  return {
    eventId: 'e1',
    label: 'Sarah visits',
    startTime: '14:00',
    visitorName: 'Sarah',
    localDate: '2026-11-07',
    ...overrides,
  } as EventOccurrence;
}

/**
 * purpose: Build a day view for Saturday 2026-11-07 at 09:30.
 * @param overrides: (Partial<DayViewData>) Fields to set.
 * @return: (DayViewData) An empty day unless overridden.
 */
function makeDay(overrides: Partial<DayViewData> = {}): DayViewData {
  return {
    localNow: '2026-11-07T09:30:00',
    localDate: '2026-11-07',
    dateLabel: 'November 7',
    header: 'Saturday morning',
    tasks: [],
    eventsToday: [],
    nextUp: null,
    upcoming: [],
    ...overrides,
  } as DayViewData;
}

describe('fullDate', () => {
  it('adds the year to the date label', () => {
    expect(fullDate(makeDay())).toBe('November 7, 2026');
  });
});

describe('nowCard', () => {
  it('shows the first due timed task, skipping anytime tasks', () => {
    const day = makeDay({
      tasks: [
        makeTask({ instanceId: 'plants', scheduledTime: 'anytime', state: 'due' }),
        makeTask({ instanceId: 'pills', state: 'due' }),
        makeTask({ instanceId: 'walk', scheduledTime: '10:00', state: 'due' }),
      ],
    });
    const card = nowCard(day);
    expect(card.kind === 'task' && card.task.instanceId).toBe('pills');
  });

  it('marks escalated and carried-over tasks as overdue', () => {
    const escalated = nowCard(makeDay({ tasks: [makeTask({ state: 'escalated' })] }));
    const carried = nowCard(makeDay({ tasks: [makeTask({ state: 'due', carriedOver: true })] }));
    const due = nowCard(makeDay({ tasks: [makeTask({ state: 'due' })] }));
    expect(escalated.kind === 'task' && escalated.overdue).toBe(true);
    expect(carried.kind === 'task' && carried.overdue).toBe(true);
    expect(due.kind === 'task' && due.overdue).toBe(false);
  });

  it('uses two or more checklist items as steps', () => {
    const steps = ['Wash your hands', 'Tilt your head back'];
    const multi = nowCard(makeDay({ tasks: [makeTask({ state: 'due', checklistItems: steps })] }));
    const single = nowCard(
      makeDay({ tasks: [makeTask({ state: 'due', checklistItems: ['Only one'] })] }),
    );
    expect(multi.kind === 'task' && multi.steps).toEqual(steps);
    expect(single.kind === 'task' && single.steps).toBeNull();
  });

  it('is clear but not all done while a task or event is still ahead', () => {
    expect(nowCard(makeDay({ tasks: [makeTask()] }))).toEqual({ kind: 'clear', allDone: false });
    expect(nowCard(makeDay({ eventsToday: [makeEvent()] }))).toEqual({
      kind: 'clear',
      allDone: false,
    });
  });

  it('is all done when every task is finished and no event is ahead', () => {
    const day = makeDay({
      tasks: [makeTask({ state: 'confirmed' }), makeTask({ instanceId: 't2', state: 'missed' })],
      eventsToday: [makeEvent({ startTime: '09:00' })],
    });
    expect(nowCard(day)).toEqual({ kind: 'clear', allDone: true });
  });
});

describe('nextItem', () => {
  it('picks the first later task, skipping the Now task, done and anytime tasks', () => {
    const day = makeDay({
      tasks: [
        makeTask({ instanceId: 'pills', state: 'due' }),
        makeTask({ instanceId: 'breakfast', scheduledTime: '07:30', state: 'confirmed' }),
        makeTask({ instanceId: 'plants', scheduledTime: 'anytime', state: 'due' }),
        makeTask({
          instanceId: 'walk',
          type: 'routine',
          displayLabel: 'Morning walk',
          scheduledTime: '10:00',
        }),
      ],
      eventsToday: [makeEvent()],
    });
    expect(nextItem(day, buildAgenda(day), 'pills')).toEqual({
      title: 'Morning walk',
      when: '10:00',
      icon: 'clock',
      initial: null,
    });
  });

  it("shows a later event with the visitor's initial and skips events already started", () => {
    const day = makeDay({
      eventsToday: [makeEvent({ eventId: 'early', startTime: '09:00' }), makeEvent()],
    });
    expect(nextItem(day, buildAgenda(day), null)).toEqual({
      title: 'Sarah visits',
      when: '2:00',
      icon: 'calendar',
      initial: 'S',
    });
  });

  it('falls back to the next event on a later day', () => {
    const tomorrow = makeEvent({
      label: 'Church',
      visitorName: null,
      localDate: '2026-11-08',
      startTime: '09:00',
    });
    const later = makeEvent({ label: 'Doctor', visitorName: null, localDate: '2026-11-10' });
    expect(nextItem(makeDay({ upcoming: [tomorrow] }), [], null)?.when).toBe('Tomorrow, 9:00');
    expect(nextItem(makeDay({ upcoming: [later] }), [], null)?.when).toBe('Tuesday, 2:00');
    expect(nextItem(makeDay(), [], null)).toBeNull();
  });
});

describe('todayRows', () => {
  it('marks done tasks and the Now task', () => {
    const day = makeDay({
      tasks: [
        makeTask({ instanceId: 'breakfast', scheduledTime: '07:30', state: 'confirmed' }),
        makeTask({ instanceId: 'pills', state: 'due' }),
      ],
      eventsToday: [makeEvent()],
    });
    const { rows, hidden } = todayRows(buildAgenda(day), 'pills');
    expect(rows.map((r) => [r.time, r.mark])).toEqual([
      ['7:30', 'done'],
      ['8:00', 'now'],
      ['2:00', 'none'],
    ]);
    expect(hidden).toBe(0);
  });

  it('marks a missed task missed, and done once it is confirmed or resolved', () => {
    const marks = (state: string): string[] =>
      todayRows(buildAgenda(makeDay({ tasks: [makeTask({ state })] })), null).rows.map(
        (r) => r.mark,
      );
    expect(marks('missed')).toEqual(['missed']);
    expect(marks('confirmed')).toEqual(['done']);
    expect(marks('resolved')).toEqual(['done']);
    expect(marks('upcoming')).toEqual(['none']);
  });

  it('leaves due, escalated and upcoming tasks unmarked and the Now task now', () => {
    const day = makeDay({
      tasks: [
        makeTask({ instanceId: 'a', scheduledTime: '06:00', state: 'missed' }),
        makeTask({
          instanceId: 'b',
          scheduledTime: '07:00',
          state: 'escalated',
          carriedOver: true,
        }),
        makeTask({ instanceId: 'c', scheduledTime: '08:00', state: 'due' }),
        makeTask({ instanceId: 'd', scheduledTime: '09:00', state: 'upcoming' }),
      ],
    });
    const { rows } = todayRows(buildAgenda(day), 'c');
    expect(rows.map((r) => [r.time, r.mark])).toEqual([
      ['6:00', 'missed'],
      ['7:00', 'none'],
      ['8:00', 'now'],
      ['9:00', 'none'],
    ]);
  });

  it('drops the earliest done rows first, then counts the latest rows left out', () => {
    const tasks = ['06:00', '07:00', '08:00', '09:00', '10:00', '11:00'].map((time, i) =>
      makeTask({
        instanceId: `t${i}`,
        scheduledTime: time,
        state: i < 2 ? 'confirmed' : 'upcoming',
      }),
    );
    const agenda = buildAgenda(makeDay({ tasks }));
    expect(todayRows(agenda, null, 4).rows.map((r) => r.time)).toEqual([
      '8:00',
      '9:00',
      '10:00',
      '11:00',
    ]);
    const tight = todayRows(agenda, null, 3);
    expect(tight.rows.map((r) => r.time)).toEqual(['8:00', '9:00']);
    expect(tight.hidden).toBe(2);
  });
});
