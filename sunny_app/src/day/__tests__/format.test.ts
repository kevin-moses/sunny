// sunny_app/src/day/__tests__/format.test.ts
//
// Purpose: Unit tests for the day clock helpers:
// the get_day_view payload shape (extra server keys ignored), relative day wording,
// local time formatting, agenda order, and the task state checks.
//
// Last modified: 2026-10-28

import { describe, expect, it } from '@jest/globals';

import { buildAgenda, displayTime, isDone, isDue, whenText } from '../format';
import type { DayTask, DayViewData } from '../types';

/**
 * purpose: Parse a get_day_view JSON payload the way the app receives it.
 * @param json: (string) The JSON text.
 * @return: (DayViewData) The parsed payload.
 */
function decode(json: string): DayViewData {
  return JSON.parse(json) as DayViewData;
}

/**
 * purpose: Build a task with a given state.
 * @param state: (string) Task state.
 * @return: (DayTask) A task.
 */
function taskWithState(state: string): DayTask {
  return { instance_id: 't', display_label: 'x', scheduled_time: '08:00:00', state };
}

const EMPTY_DAY = `{
  "local_date": "2026-10-26",
  "date_label": "October 26",
  "header": "Monday evening",
  "tasks": [],
  "events_today": [],
  "next_up": null,
  "upcoming": []
}`;

/**
 * purpose: A day view dated 2026-10-26 (a Monday) with one upcoming event.
 * @param localDate: (string) The upcoming event's local date.
 * @param startTime: (string) The upcoming event's start time.
 * @return: (DayViewData) The day view.
 */
function dayWithUpcoming(localDate: string, startTime: string): DayViewData {
  const day = decode(EMPTY_DAY);
  day.upcoming = [
    {
      event_id: 'e1',
      label: 'Visit',
      local_date: localDate,
      start_time: startTime,
      place: null,
      visitor_name: null,
    },
  ];
  return day;
}

describe('decoding a realistic get_day_view payload', () => {
  const data = decode(`{
    "local_date": "2026-10-26",
    "date_label": "October 26",
    "header": "Monday evening",
    "timezone": "America/New_York",
    "weekday": "Monday",
    "senior_preferred_name": "Margaret",
    "tasks": [
      {"instance_id": "t-001", "display_label": "Take blood pressure medication",
       "scheduled_time": "08:00:00", "state": "due"},
      {"instance_id": "t-002", "display_label": "Evening walk",
       "scheduled_time": "18:00:00", "state": "upcoming"}
    ],
    "events_today": [
      {"event_id": "e-100", "label": "Cardiology appointment", "local_date": "2026-10-26",
       "start_time": "14:00:00", "place": "Downtown Medical Center, Suite 410",
       "visitor_name": null, "starts_at": "2026-10-26T14:00:00Z", "title": "Cardiology - Dr. Patel"},
      {"event_id": "e-101", "label": "Lunch with Susan", "local_date": "2026-10-26",
       "start_time": "12:00:00", "place": null, "visitor_name": "Susan Chen"}
    ],
    "next_up": {"event_id": "e-100", "label": "Cardiology appointment",
      "local_date": "2026-10-26", "start_time": "14:00:00",
      "place": "Downtown Medical Center, Suite 410", "visitor_name": null},
    "upcoming": [{"event_id": "e-200", "label": "Dentist", "local_date": "2026-10-29",
      "start_time": "09:30:00", "place": "Smile Clinic", "visitor_name": null}]
  }`);

  it('keeps the top-level fields with their snake_case names', () => {
    expect(data.local_date).toBe('2026-10-26');
    expect(data.date_label).toBe('October 26');
    expect(data.header).toBe('Monday evening');
  });

  it('exposes tasks and their due / done state', () => {
    expect(data.tasks).toHaveLength(2);
    expect(data.tasks[0].instance_id).toBe('t-001');
    expect(data.tasks[0].display_label).toBe('Take blood pressure medication');
    expect(data.tasks[0].scheduled_time).toBe('08:00:00');
    expect(data.tasks[0].state).toBe('due');
    expect(isDue(data.tasks[0])).toBe(true);
    expect(isDone(data.tasks[0])).toBe(false);
    expect(data.tasks[1].state).toBe('upcoming');
    expect(isDue(data.tasks[1])).toBe(false);
    expect(isDone(data.tasks[1])).toBe(false);
  });

  it('exposes events with nullable place and visitor_name', () => {
    expect(data.events_today).toHaveLength(2);
    expect(data.events_today[0].event_id).toBe('e-100');
    expect(data.events_today[0].start_time).toBe('14:00:00');
    expect(data.events_today[0].place).toBe('Downtown Medical Center, Suite 410');
    expect(data.events_today[0].visitor_name).toBeNull();
    expect(data.events_today[1].place).toBeNull();
    expect(data.events_today[1].visitor_name).toBe('Susan Chen');
  });

  it('exposes next_up and upcoming', () => {
    expect(data.next_up?.event_id).toBe('e-100');
    expect(data.next_up?.start_time).toBe('14:00:00');
    expect(data.upcoming).toHaveLength(1);
    expect(data.upcoming[0].local_date).toBe('2026-10-29');
  });

  it('ignores extra server keys when merging the agenda', () => {
    expect(buildAgenda(data).map((item) => item.id)).toEqual([
      'task-t-001',
      'event-e-101-2026-10-26',
      'event-e-100-2026-10-26',
      'task-t-002',
    ]);
  });
});

describe('whenText', () => {
  it('says Today for an event on the day view date', () => {
    const day = decode(EMPTY_DAY);
    day.events_today = [
      {
        event_id: 'e1',
        label: 'Cardiology appointment',
        local_date: '2026-10-26',
        start_time: '14:00:00',
        place: 'Clinic',
        visitor_name: null,
      },
    ];
    expect(whenText(day.events_today[0], day.local_date)).toBe('Today at 2:00 PM');
  });

  it('says Tomorrow for the next day', () => {
    const day = dayWithUpcoming('2026-10-27', '09:00:00');
    expect(whenText(day.upcoming[0], day.local_date)).toBe('Tomorrow at 9:00 AM');
  });

  it('names the weekday for later in the week', () => {
    const day = dayWithUpcoming('2026-10-29', '15:00:00');
    expect(whenText(day.upcoming[0], day.local_date)).toBe('Thursday at 3:00 PM');
  });

  it('counts Tomorrow across a month boundary', () => {
    const day = dayWithUpcoming('2026-11-01', '09:00:00');
    expect(whenText(day.upcoming[0], '2026-10-31')).toBe('Tomorrow at 9:00 AM');
  });

  it('returns only the time before the day view has loaded', () => {
    const day = dayWithUpcoming('2026-10-29', '15:00:00');
    expect(whenText(day.upcoming[0], null)).toBe('3:00 PM');
  });

  it('returns only the time when a date is invalid', () => {
    const day = dayWithUpcoming('2026-13-45', '15:00:00');
    expect(whenText(day.upcoming[0], day.local_date)).toBe('3:00 PM');
  });
});

describe('displayTime', () => {
  it('formats morning, midnight and afternoon times', () => {
    expect(displayTime('08:00:00')).toBe('8:00 AM');
    expect(displayTime('00:30:00')).toBe('12:30 AM');
    expect(displayTime('12:00:00')).toBe('12:00 PM');
    expect(displayTime('14:00:00')).toBe('2:00 PM');
    expect(displayTime('23:59:00')).toBe('11:59 PM');
  });

  it('returns invalid input unchanged', () => {
    expect(displayTime('not-a-valid-time')).toBe('not-a-valid-time');
    expect(displayTime('25:00:00')).toBe('25:00:00');
    expect(displayTime('')).toBe('');
  });
});

describe('buildAgenda', () => {
  it('orders tasks and events by local time', () => {
    const day = decode(`{
      "local_date": "2026-10-26", "date_label": "October 26", "header": "Monday evening",
      "tasks": [
        {"instance_id": "t-evening", "display_label": "Evening walk",
         "scheduled_time": "18:00:00", "state": "due"},
        {"instance_id": "t-morning", "display_label": "Morning medication",
         "scheduled_time": "07:30:00", "state": "confirmed"}
      ],
      "events_today": [
        {"event_id": "e-lunch", "label": "Lunch with Susan", "local_date": "2026-10-26",
         "start_time": "12:00:00", "place": null, "visitor_name": "Susan Chen"},
        {"event_id": "e-cardio", "label": "Cardiology", "local_date": "2026-10-26",
         "start_time": "14:00:00", "place": "Downtown Medical Center", "visitor_name": null}
      ],
      "next_up": null, "upcoming": []
    }`);
    const agenda = buildAgenda(day);
    expect(agenda.map((item) => item.id)).toEqual([
      'task-t-morning',
      'event-e-lunch-2026-10-26',
      'event-e-cardio-2026-10-26',
      'task-t-evening',
    ]);
    const [first, second] = agenda;
    expect(first.kind).toBe('task');
    expect(first.kind === 'task' && first.task.instance_id).toBe('t-morning');
    expect(second.kind).toBe('event');
    expect(second.kind === 'event' && second.event.event_id).toBe('e-lunch');
  });

  it('is empty before the day view has loaded', () => {
    expect(buildAgenda(null)).toEqual([]);
  });
});

describe('task state checks', () => {
  it('treats confirmed and resolved as done', () => {
    expect(isDone(taskWithState('confirmed'))).toBe(true);
    expect(isDone(taskWithState('resolved'))).toBe(true);
    expect(isDone(taskWithState('due'))).toBe(false);
  });

  it('treats due and escalated as due', () => {
    expect(isDue(taskWithState('due'))).toBe(true);
    expect(isDue(taskWithState('escalated'))).toBe(true);
    expect(isDue(taskWithState('confirmed'))).toBe(false);
  });
});
