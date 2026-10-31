// sunny_app/src/caregiver/__tests__/format.test.ts
//
// Purpose: Unit tests for the caregiver helpers: week strip days and markers, date labels,
// alert selection and messages, schedule grouping and row variants, transcript ordering and
// status lines, and the continue-request choice. Fixtures fill only the fields the helpers
// read; the day is Thursday 2026-10-29 unless a test says otherwise.
//
// Last modified: 2026-10-30

import { describe, expect, it } from '@jest/globals';

import type { DayTask, DayViewData, EventOccurrence } from '../../day/types';
import {
  addLocalDays,
  alertMessage,
  buildSchedule,
  buildTranscript,
  buildWeekStrip,
  chooseContinueRequestId,
  eventLabel,
  FAILED_TEXT,
  monthYearLabel,
  selectAlerts,
  WORKING_TEXT,
  weekRangeLabel,
  type AgentRequest,
} from '../format';

/**
 * purpose: Build an event occurrence.
 * @param overrides: (Partial<Record<keyof EventOccurrence, unknown>>) Fields to set.
 * @return: (EventOccurrence) An event on 2026-10-29 at 14:00 unless overridden.
 */
function makeEvent(
  overrides: Partial<Record<keyof EventOccurrence, unknown>> = {},
): EventOccurrence {
  return {
    eventId: 'e1',
    title: 'Cardiology - Dr. Patel',
    label: 'Cardiology',
    startsOn: '2026-10-29',
    startTime: '14:00',
    place: null,
    visitorName: null,
    localDate: '2026-10-29',
    ...overrides,
  } as EventOccurrence;
}

/**
 * purpose: Build a task.
 * @param overrides: (Partial<Record<keyof DayTask, unknown>>) Fields to set.
 * @return: (DayTask) A due 08:00 task unless overridden.
 */
function makeTask(overrides: Partial<Record<keyof DayTask, unknown>> = {}): DayTask {
  return {
    instanceId: 't1',
    displayLabel: 'Take medication',
    scheduledTime: '08:00',
    state: 'due',
    ...overrides,
  } as DayTask;
}

/**
 * purpose: Build a day view dated Thursday 2026-10-29.
 * @param overrides: (Partial<DayViewData>) Fields to set.
 * @return: (DayViewData) An empty day unless overridden.
 */
function makeDay(overrides: Partial<DayViewData> = {}): DayViewData {
  return {
    seniorPreferredName: 'Margaret',
    timezone: 'America/New_York',
    localNow: '2026-10-29T18:00',
    localDate: '2026-10-29',
    weekday: 'Thursday',
    dateLabel: 'October 29',
    header: 'Thursday evening',
    tasks: [],
    eventsToday: [],
    nextUp: null,
    upcoming: [],
    ...overrides,
  };
}

/**
 * purpose: Build an agent request as agentRequests.list returns it.
 * @param overrides: (Partial<Record<keyof AgentRequest, unknown>>) Fields to set.
 * @return: (AgentRequest) A succeeded request with a reply unless overridden.
 */
function makeRequest(overrides: Partial<Record<keyof AgentRequest, unknown>> = {}): AgentRequest {
  return {
    id: 'r1',
    message: 'How is the day?',
    status: 'succeeded',
    reply: 'Going well.',
    error: null,
    ...overrides,
  } as AgentRequest;
}

describe('addLocalDays', () => {
  it('crosses month and year boundaries', () => {
    expect(addLocalDays('2026-10-30', 6)).toBe('2026-11-05');
    expect(addLocalDays('2026-12-30', 3)).toBe('2027-01-02');
  });

  it('goes backwards with a negative count', () => {
    expect(addLocalDays('2026-03-01', -1)).toBe('2026-02-28');
  });

  it('returns an invalid date unchanged', () => {
    expect(addLocalDays('nope', 2)).toBe('nope');
  });
});

describe('labels', () => {
  it('formats the month and year', () => {
    expect(monthYearLabel('2026-10-30')).toBe('October 2026');
    expect(monthYearLabel('bad')).toBe('');
  });

  it('formats the range from today through today+6 with an en dash', () => {
    expect(weekRangeLabel('2026-10-30')).toBe('Oct 30 – Nov 5');
    expect(weekRangeLabel('2026-12-29')).toBe('Dec 29 – Jan 4');
    expect(weekRangeLabel('bad')).toBe('');
  });
});

describe('buildWeekStrip', () => {
  it('returns seven days starting today with weekday and date', () => {
    const days = buildWeekStrip(makeDay());
    expect(days).toHaveLength(7);
    expect(days[0]).toMatchObject({
      localDate: '2026-10-29',
      weekdayShort: 'Thu',
      dayOfMonth: '29',
      isToday: true,
    });
    expect(days[3]).toMatchObject({
      localDate: '2026-11-01',
      weekdayShort: 'Sun',
      dayOfMonth: '1',
    });
    expect(days.filter((d) => d.isToday)).toHaveLength(1);
  });

  it('marks days with events and today when it has tasks', () => {
    const day = makeDay({
      tasks: [makeTask()],
      upcoming: [makeEvent({ localDate: '2026-10-31' })],
    });
    const markers = buildWeekStrip(day).map((d) => d.hasMarker);
    expect(markers).toEqual([true, false, true, false, false, false, false]);
  });

  it('leaves an empty day unmarked', () => {
    expect(buildWeekStrip(makeDay()).some((d) => d.hasMarker)).toBe(false);
  });

  it('marks today for an event today even with no tasks', () => {
    const day = makeDay({ eventsToday: [makeEvent()] });
    expect(buildWeekStrip(day)[0].hasMarker).toBe(true);
  });

  it('describes the day for screen readers', () => {
    const days = buildWeekStrip(makeDay({ tasks: [makeTask()] }));
    expect(days[0].accessibilityLabel).toBe('Today, Thursday 29, has plans');
    expect(days[1].accessibilityLabel).toBe('Friday 30');
  });
});

describe('alerts', () => {
  it('selects escalated and missed tasks in order', () => {
    const tasks = [
      makeTask({ instanceId: 'a', state: 'escalated' }),
      makeTask({ instanceId: 'b', state: 'due' }),
      makeTask({ instanceId: 'c', state: 'missed' }),
      makeTask({ instanceId: 'd', state: 'confirmed' }),
      makeTask({ instanceId: 'e', state: 'upcoming' }),
      makeTask({ instanceId: 'f', state: 'resolved' }),
    ];
    expect(selectAlerts(tasks).map((t) => t.instanceId)).toEqual(['a', 'c']);
  });

  it('returns nothing when no task needs attention', () => {
    expect(selectAlerts([makeTask()])).toEqual([]);
  });

  it('adds the family line only when escalated', () => {
    expect(alertMessage(makeTask({ state: 'escalated', scheduledTime: '14:05' }))).toBe(
      'Due at 2:05 PM. Sunny has alerted the family.',
    );
    expect(alertMessage(makeTask({ state: 'missed', scheduledTime: '08:00' }))).toBe(
      'Due at 8:00 AM.',
    );
  });
});

describe('eventLabel', () => {
  it('appends the visitor and place when present', () => {
    expect(eventLabel(makeEvent({ visitorName: 'Dr. Patel', place: 'the clinic' }))).toBe(
      'Cardiology with Dr. Patel at the clinic',
    );
    expect(eventLabel(makeEvent())).toBe('Cardiology');
  });
});

describe('buildSchedule', () => {
  it('is empty when nothing is scheduled', () => {
    expect(buildSchedule(makeDay())).toEqual([]);
  });

  it('merges today tasks and events in time order under "Today, <weekday>"', () => {
    const day = makeDay({
      tasks: [makeTask({ instanceId: 't1', scheduledTime: '08:00' })],
      eventsToday: [makeEvent({ startTime: '07:00', label: 'Walk' })],
    });
    const [today] = buildSchedule(day);
    expect(today.title).toBe('Today, Thursday');
    expect(today.rows.map((r) => r.label)).toEqual(['Walk', 'Take medication']);
  });

  it('assigns a variant and icon to each kind of row', () => {
    const day = makeDay({
      tasks: [
        makeTask({ instanceId: 'a', scheduledTime: '06:00', state: 'confirmed' }),
        makeTask({ instanceId: 'b', scheduledTime: '07:00', state: 'missed' }),
        makeTask({ instanceId: 'c', scheduledTime: '08:00', state: 'escalated' }),
        makeTask({ instanceId: 'd', scheduledTime: '09:00', state: 'upcoming' }),
        makeTask({ instanceId: 'e', scheduledTime: '10:00', state: 'resolved' }),
      ],
      eventsToday: [makeEvent({ startTime: '11:00' })],
    });
    const rows = buildSchedule(day)[0].rows;
    expect(rows.map((r) => [r.variant, r.icon])).toEqual([
      ['done', 'checkmark.circle.fill'],
      ['alert', 'exclamationmark.circle.fill'],
      ['alert', 'exclamationmark.circle.fill'],
      ['task', 'circle'],
      ['done', 'checkmark.circle.fill'],
      ['event', 'calendar'],
    ]);
  });

  it('groups later days by full weekday name, sorted, and drops days past the week', () => {
    const day = makeDay({
      upcoming: [
        makeEvent({ eventId: 'z', localDate: '2026-10-31', startTime: '15:00', label: 'Late' }),
        makeEvent({ eventId: 'y', localDate: '2026-10-30', startTime: '09:00', label: 'Early' }),
        makeEvent({ eventId: 'x', localDate: '2026-10-31', startTime: '08:00', label: 'First' }),
        makeEvent({ eventId: 'w', localDate: '2026-11-05', startTime: '08:00', label: 'Too far' }),
      ],
    });
    const groups = buildSchedule(day);
    expect(groups.map((g) => g.title)).toEqual(['Friday', 'Saturday']);
    expect(groups[1].rows.map((r) => r.label)).toEqual(['First', 'Late']);
  });

  it('puts the visitor and place in an event row and labels it for screen readers', () => {
    const day = makeDay({
      eventsToday: [makeEvent({ visitorName: 'Sam', startTime: '14:00' })],
    });
    const row = buildSchedule(day)[0].rows[0];
    expect(row.label).toBe('Cardiology with Sam');
    expect(row.accessibilityLabel).toBe('2:00 PM, Cardiology with Sam');
  });
});

describe('buildTranscript', () => {
  it('lists the requests oldest first, each message followed by its reply', () => {
    const requests = [
      makeRequest({ id: 'r2', message: 'And now?', reply: 'Still fine.' }),
      makeRequest({ id: 'r1' }),
    ];
    expect(buildTranscript(requests).map((e) => [e.kind, e.text])).toEqual([
      ['caregiver', 'How is the day?'],
      ['sunny', 'Going well.'],
      ['caregiver', 'And now?'],
      ['sunny', 'Still fine.'],
    ]);
  });

  it('shows a working line while a request is queued or running', () => {
    const queued = buildTranscript([makeRequest({ status: 'queued', reply: null })]);
    const running = buildTranscript([makeRequest({ status: 'running', reply: null })]);
    expect(queued[1]).toMatchObject({ kind: 'working', text: WORKING_TEXT });
    expect(running[1]).toMatchObject({ kind: 'working', text: WORKING_TEXT });
  });

  it('shows the error of a failed request, or a generic line without one', () => {
    const withError = buildTranscript([
      makeRequest({ status: 'failed', reply: null, error: 'Agent unavailable' }),
    ]);
    const without = buildTranscript([makeRequest({ status: 'failed', reply: null, error: null })]);
    expect(withError[1]).toMatchObject({ kind: 'error', text: 'Agent unavailable' });
    expect(without[1]).toMatchObject({ kind: 'error', text: FAILED_TEXT });
  });

  it('shows only the message for a cancelled request or a blank reply', () => {
    expect(buildTranscript([makeRequest({ status: 'cancelled', reply: null })])).toHaveLength(1);
    expect(buildTranscript([makeRequest({ reply: '  ' })])).toHaveLength(1);
  });

  it('gives every entry a unique id and handles no requests', () => {
    const entries = buildTranscript([makeRequest({ id: 'r2' }), makeRequest({ id: 'r1' })]);
    expect(new Set(entries.map((e) => e.id)).size).toBe(entries.length);
    expect(buildTranscript([])).toEqual([]);
  });
});

describe('chooseContinueRequestId', () => {
  it('picks the newest succeeded request', () => {
    const requests = [
      makeRequest({ id: 'r3', status: 'running', reply: null }),
      makeRequest({ id: 'r2', status: 'failed', reply: null }),
      makeRequest({ id: 'r1b', status: 'succeeded' }),
      makeRequest({ id: 'r1a', status: 'succeeded' }),
    ];
    expect(chooseContinueRequestId(requests)).toBe('r1b');
  });

  it('is undefined when nothing has succeeded', () => {
    expect(chooseContinueRequestId([makeRequest({ status: 'failed' })])).toBeUndefined();
    expect(chooseContinueRequestId([])).toBeUndefined();
  });
});
