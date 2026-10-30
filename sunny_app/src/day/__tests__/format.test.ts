// sunny_app/src/day/__tests__/format.test.ts
//
// Purpose: Unit tests for the day clock helpers on the camelCase calendar.dayView shape:
// the agenda merge and its order, relative day wording, local "HH:MM" time formatting, and
// the task state checks. Fixtures are built with small helpers that fill the fields the
// helpers do not read, so each test states only what it cares about.
//
// Last modified: 2026-10-29

import { describe, expect, it } from '@jest/globals';

import { buildAgenda, displayTime, eventKey, isDone, isDue, whenText } from '../format';
import type { DayTask, DayViewData, EventOccurrence } from '../types';

/**
 * purpose: Build an event occurrence.
 * @param overrides: (Partial<Record<keyof EventOccurrence, unknown>>) Fields to set; ids may
 *        be plain strings.
 * @return: (EventOccurrence) An occurrence on 2026-10-26 at 14:00 unless overridden.
 */
function makeEvent(
  overrides: Partial<Record<keyof EventOccurrence, unknown>> = {},
): EventOccurrence {
  return {
    eventId: 'e1',
    title: 'Cardiology - Dr. Patel',
    label: 'Cardiology appointment',
    startsOn: '2026-10-26',
    startTime: '14:00',
    durationMinutes: null,
    place: null,
    visitorName: null,
    notes: null,
    repeatDays: null,
    repeatUntil: null,
    createdVia: 'caregiver',
    cancelled: false,
    localDate: '2026-10-26',
    startsAt: 0,
    endsAt: null,
    ...overrides,
  } as EventOccurrence;
}

/**
 * purpose: Build a task.
 * @param overrides: (Partial<Record<keyof DayTask, unknown>>) Fields to set; ids may be
 *        plain strings.
 * @return: (DayTask) A due 08:00 task unless overridden.
 */
function makeTask(overrides: Partial<Record<keyof DayTask, unknown>> = {}): DayTask {
  return {
    instanceId: 't1',
    taskId: 'task1',
    type: 'medication',
    displayLabel: 'Take medication',
    spokenPrompt: 'Time for your medication',
    pillDescription: null,
    checklistItems: [],
    scheduledTime: '08:00',
    state: 'due',
    confirmedAt: null,
    confirmedVia: null,
    ...overrides,
  } as DayTask;
}

/**
 * purpose: Build a day view dated 2026-10-26 (a Monday).
 * @param overrides: (Partial<DayViewData>) Fields to set.
 * @return: (DayViewData) An empty day unless overridden.
 */
function makeDay(overrides: Partial<DayViewData> = {}): DayViewData {
  return {
    seniorPreferredName: 'Margaret',
    timezone: 'America/New_York',
    localNow: '2026-10-26T18:00',
    localDate: '2026-10-26',
    weekday: 'Monday',
    dateLabel: 'October 26',
    header: 'Monday evening',
    tasks: [],
    eventsToday: [],
    nextUp: null,
    upcoming: [],
    ...overrides,
  };
}

/**
 * purpose: A day with one upcoming event.
 * @param localDate: (string) The event's local date.
 * @param startTime: (string) The event's start time.
 * @return: (DayViewData) The day.
 */
function dayWithUpcoming(localDate: string, startTime: string): DayViewData {
  return makeDay({ upcoming: [makeEvent({ localDate, startTime })] });
}

describe('buildAgenda', () => {
  it('orders tasks and events by local time', () => {
    const day = makeDay({
      tasks: [
        makeTask({ instanceId: 't-evening', scheduledTime: '18:00' }),
        makeTask({ instanceId: 't-morning', scheduledTime: '07:30', state: 'confirmed' }),
      ],
      eventsToday: [
        makeEvent({ eventId: 'e-lunch', startTime: '12:00' }),
        makeEvent({ eventId: 'e-cardio', startTime: '14:00' }),
      ],
    });
    const agenda = buildAgenda(day);
    expect(agenda.map((item) => item.id)).toEqual([
      'task-t-morning',
      'event-e-lunch-2026-10-26',
      'event-e-cardio-2026-10-26',
      'task-t-evening',
    ]);
    const [first, second] = agenda;
    expect(first.kind).toBe('task');
    expect(first.kind === 'task' && first.task.instanceId).toBe('t-morning');
    expect(second.kind).toBe('event');
    expect(second.kind === 'event' && second.event.eventId).toBe('e-lunch');
  });

  it('keeps tasks before events at the same time', () => {
    const day = makeDay({
      tasks: [makeTask({ instanceId: 't1', scheduledTime: '09:00' })],
      eventsToday: [makeEvent({ eventId: 'e1', startTime: '09:00' })],
    });
    expect(buildAgenda(day).map((item) => item.kind)).toEqual(['task', 'event']);
  });

  it('is empty before the day view has loaded', () => {
    expect(buildAgenda(null)).toEqual([]);
  });
});

describe('eventKey', () => {
  it('combines the event id and the local date', () => {
    expect(eventKey(makeEvent({ eventId: 'e-9', localDate: '2026-10-27' }))).toBe('e-9-2026-10-27');
  });
});

describe('whenText', () => {
  it('says Today for an event on the day view date', () => {
    const day = makeDay({ eventsToday: [makeEvent()] });
    expect(whenText(day.eventsToday[0], day.localDate)).toBe('Today at 2:00 PM');
  });

  it('says Tomorrow for the next day', () => {
    const day = dayWithUpcoming('2026-10-27', '09:00');
    expect(whenText(day.upcoming[0], day.localDate)).toBe('Tomorrow at 9:00 AM');
  });

  it('names the weekday for later in the week', () => {
    const day = dayWithUpcoming('2026-10-29', '15:00');
    expect(whenText(day.upcoming[0], day.localDate)).toBe('Thursday at 3:00 PM');
  });

  it('counts Tomorrow across a month boundary', () => {
    const day = dayWithUpcoming('2026-11-01', '09:00');
    expect(whenText(day.upcoming[0], '2026-10-31')).toBe('Tomorrow at 9:00 AM');
  });

  it('returns only the time before the day view has loaded', () => {
    const day = dayWithUpcoming('2026-10-29', '15:00');
    expect(whenText(day.upcoming[0], null)).toBe('3:00 PM');
  });

  it('returns only the time when a date is invalid', () => {
    const day = dayWithUpcoming('2026-13-45', '15:00');
    expect(whenText(day.upcoming[0], day.localDate)).toBe('3:00 PM');
  });
});

describe('displayTime', () => {
  it('formats morning, midnight and afternoon times', () => {
    expect(displayTime('08:00')).toBe('8:00 AM');
    expect(displayTime('00:30')).toBe('12:30 AM');
    expect(displayTime('12:00')).toBe('12:00 PM');
    expect(displayTime('14:00')).toBe('2:00 PM');
    expect(displayTime('23:59')).toBe('11:59 PM');
  });

  it('returns invalid input unchanged', () => {
    expect(displayTime('not-a-valid-time')).toBe('not-a-valid-time');
    expect(displayTime('25:00')).toBe('25:00');
    expect(displayTime('08:00:00')).toBe('08:00:00');
    expect(displayTime('')).toBe('');
  });
});

describe('task state checks', () => {
  it('treats confirmed and resolved as done', () => {
    expect(isDone(makeTask({ state: 'confirmed' }))).toBe(true);
    expect(isDone(makeTask({ state: 'resolved' }))).toBe(true);
    expect(isDone(makeTask({ state: 'due' }))).toBe(false);
  });

  it('treats due and escalated as due', () => {
    expect(isDue(makeTask({ state: 'due' }))).toBe(true);
    expect(isDue(makeTask({ state: 'escalated' }))).toBe(true);
    expect(isDue(makeTask({ state: 'confirmed' }))).toBe(false);
    expect(isDue(makeTask({ state: 'upcoming' }))).toBe(false);
  });
});
