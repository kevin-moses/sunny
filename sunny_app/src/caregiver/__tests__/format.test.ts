// sunny_app/src/caregiver/__tests__/format.test.ts
//
// Purpose: Unit tests for the caregiver helpers: week strip days and markers, date labels,
// alert detection, messages and claim text, the per-day schedule rows (ids and variants), the
// selected-day title and fallback rule, transcript ordering, status lines and speaker
// attribution, and the in-progress check. Fixtures fill only the
// fields the helpers read; the day is Thursday 2026-10-29 unless a test says otherwise.
//
// Last modified: 2026-10-31

import { describe, expect, it } from '@jest/globals';

import { buildAgenda } from '../../day/format';
import type { DayTask, DayViewData, EventOccurrence } from '../../day/types';
import {
  alertMessage,
  ANOTHER_CAREGIVER,
  buildTranscript,
  buildWeekStrip,
  claimText,
  FAILED_TEXT,
  hasInProgress,
  isAlert,
  messageSpeaker,
  resolveSelectedDate,
  scheduleForDate,
  selectedDayTitle,
  VARIANT_STYLE,
  WORKING_TEXT,
  weekMonthLabel,
  weekRangeLabel,
  type AgentRequest,
  type ScheduleRowData,
} from '../format';

/**
 * purpose: Build the schedule rows for a date the way the Home screen does.
 * @param day: (DayViewData) The day view.
 * @param date: (string) The selected local date.
 * @return: (ScheduleRowData[]) The rows.
 */
function scheduleOf(day: DayViewData, date: string): ScheduleRowData[] {
  return scheduleForDate(day, buildAgenda(day), date);
}

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
    requestedBy: 'user_a',
    requestedByName: 'Pat',
    message: 'How is the day?',
    status: 'succeeded',
    reply: 'Going well.',
    error: null,
    ...overrides,
  } as AgentRequest;
}

describe('labels', () => {
  it('formats the month and year of a week inside one month', () => {
    expect(weekMonthLabel('2026-10-20')).toBe('October 2026');
    expect(weekMonthLabel('bad')).toBe('');
  });

  it('shows both months when the week crosses a month boundary', () => {
    expect(weekMonthLabel('2026-10-30')).toBe('October – November 2026');
  });

  it('shows both months and years when the week crosses a year boundary', () => {
    expect(weekMonthLabel('2026-12-29')).toBe('December 2026 – January 2027');
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

  it('crosses a month and year boundary', () => {
    const days = buildWeekStrip(makeDay({ localDate: '2026-12-30' }));
    expect(days.map((d) => d.localDate)).toEqual([
      '2026-12-30',
      '2026-12-31',
      '2027-01-01',
      '2027-01-02',
      '2027-01-03',
      '2027-01-04',
      '2027-01-05',
    ]);
  });

  it('is empty for an invalid date', () => {
    expect(buildWeekStrip(makeDay({ localDate: 'bad' }))).toEqual([]);
  });

  it('describes the day for screen readers', () => {
    const days = buildWeekStrip(makeDay({ tasks: [makeTask()] }));
    expect(days[0].accessibilityLabel).toBe('Today, Thursday, October 29, has events');
    expect(days[1].accessibilityLabel).toBe('Friday, October 30');
    expect(days[3].accessibilityLabel).toBe('Sunday, November 1');
  });
});

describe('alerts', () => {
  it('flags only escalated and missed tasks', () => {
    const states = ['escalated', 'due', 'missed', 'confirmed', 'upcoming', 'resolved'] as const;
    expect(states.filter((state) => isAlert(makeTask({ state })))).toEqual(['escalated', 'missed']);
  });

  it('says who is on a claimed alert, and nothing when unclaimed', () => {
    const unclaimed = makeTask({ claimedBy: null, claimedByName: null });
    const mine = makeTask({ claimedBy: 'user_me', claimedByName: 'Me' });
    const theirs = makeTask({ claimedBy: 'user_pat', claimedByName: 'Pat' });
    const gone = makeTask({ claimedBy: 'user_gone', claimedByName: null });
    expect(claimText(unclaimed, 'user_me')).toBeNull();
    expect(claimText(mine, 'user_me')).toBe("You're on it");
    expect(claimText(theirs, 'user_me')).toBe('Pat is on it');
    expect(claimText(gone, 'user_me')).toBe('Someone is on it');
    expect(claimText(theirs, null)).toBe('Pat is on it');
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

describe('scheduleForDate', () => {
  it('is empty when nothing is scheduled', () => {
    expect(scheduleOf(makeDay(), '2026-10-29')).toEqual([]);
    expect(scheduleOf(makeDay(), '2026-10-31')).toEqual([]);
  });

  it('merges today tasks and events in time order', () => {
    const day = makeDay({
      tasks: [makeTask({ instanceId: 't1', scheduledTime: '08:00' })],
      eventsToday: [makeEvent({ startTime: '07:00', label: 'Walk' })],
    });
    expect(scheduleOf(day, '2026-10-29').map((r) => r.label)).toEqual(['Walk', 'Take medication']);
  });

  it('reuses the agenda ids for today and the event key for later days', () => {
    const day = makeDay({
      tasks: [makeTask({ instanceId: 't1' })],
      eventsToday: [makeEvent({ eventId: 'e1', startTime: '07:00' })],
      upcoming: [makeEvent({ eventId: 'e2', localDate: '2026-10-31' })],
    });
    expect(scheduleOf(day, '2026-10-29').map((r) => r.id)).toEqual([
      'event-e1-2026-10-29',
      'task-t1',
    ]);
    expect(scheduleOf(day, '2026-10-31').map((r) => r.id)).toEqual(['e2-2026-10-31']);
  });

  it('uses the agenda it is given instead of rebuilding it', () => {
    const day = makeDay({ tasks: [makeTask({ instanceId: 't1' })] });
    expect(scheduleForDate(day, [], '2026-10-29')).toEqual([]);
  });

  it('assigns a variant to each kind of row, with its icon from VARIANT_STYLE', () => {
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
    const rows = scheduleOf(day, '2026-10-29');
    expect(rows.map((r) => [r.variant, VARIANT_STYLE[r.variant].icon])).toEqual([
      ['done', 'checkmark.circle.fill'],
      ['alert', 'exclamationmark.circle.fill'],
      ['alert', 'exclamationmark.circle.fill'],
      ['task', 'circle'],
      ['done', 'checkmark.circle.fill'],
      ['event', 'calendar'],
    ]);
  });

  it('lists only the chosen later day events, sorted by time', () => {
    const day = makeDay({
      upcoming: [
        makeEvent({ eventId: 'z', localDate: '2026-10-31', startTime: '15:00', label: 'Late' }),
        makeEvent({ eventId: 'y', localDate: '2026-10-30', startTime: '09:00', label: 'Early' }),
        makeEvent({ eventId: 'x', localDate: '2026-10-31', startTime: '08:00', label: 'First' }),
      ],
    });
    expect(scheduleOf(day, '2026-10-31').map((r) => r.label)).toEqual(['First', 'Late']);
    expect(scheduleOf(day, '2026-10-30').map((r) => r.label)).toEqual(['Early']);
  });

  it('finds events past a month and year boundary', () => {
    const day = makeDay({
      localDate: '2026-12-30',
      upcoming: [makeEvent({ eventId: 'n', localDate: '2027-01-02', label: 'New year' })],
    });
    expect(scheduleOf(day, '2027-01-02').map((r) => r.label)).toEqual(['New year']);
    expect(scheduleOf(day, '2027-01-01')).toEqual([]);
  });

  it('does not show tasks on a later day', () => {
    const day = makeDay({ tasks: [makeTask()] });
    expect(scheduleOf(day, '2026-10-30')).toEqual([]);
  });

  it('puts the visitor in an event row and labels it for screen readers', () => {
    const day = makeDay({
      eventsToday: [makeEvent({ visitorName: 'Sam', startTime: '14:00' })],
    });
    const row = scheduleOf(day, '2026-10-29')[0];
    expect(row.label).toBe('Cardiology with Sam');
    expect(row.accessibilityLabel).toBe('2:00 PM, Cardiology with Sam');
  });

  it('adds the status word to task rows for screen readers', () => {
    const day = makeDay({
      tasks: [
        makeTask({ instanceId: 'a', scheduledTime: '06:00', state: 'confirmed' }),
        makeTask({ instanceId: 'b', scheduledTime: '07:00', state: 'missed' }),
        makeTask({ instanceId: 'c', scheduledTime: '08:00', state: 'upcoming' }),
      ],
    });
    expect(scheduleOf(day, '2026-10-29').map((r) => r.accessibilityLabel)).toEqual([
      '6:00 AM, Take medication, Done',
      '7:00 AM, Take medication, Not confirmed',
      '8:00 AM, Take medication',
    ]);
  });
});

describe('selectedDayTitle', () => {
  it('is "Today" for today', () => {
    expect(selectedDayTitle('2026-10-29', '2026-10-29')).toBe('Today');
  });

  it('is the weekday and short date for another day, across a month boundary', () => {
    expect(selectedDayTitle('2026-10-29', '2026-11-01')).toBe('Sunday, Nov 1');
  });

  it('crosses a year boundary', () => {
    expect(selectedDayTitle('2026-12-30', '2027-01-02')).toBe('Saturday, Jan 2');
  });

  it('is empty for an invalid date', () => {
    expect(selectedDayTitle('2026-10-29', 'bad')).toBe('');
  });
});

describe('resolveSelectedDate', () => {
  const strip = buildWeekStrip(makeDay());

  it('is today when nothing was chosen', () => {
    expect(resolveSelectedDate(strip, '2026-10-29', null)).toBe('2026-10-29');
  });

  it('keeps a chosen day in the strip', () => {
    const selection = { date: '2026-11-01', todayWhenChosen: '2026-10-29' };
    expect(resolveSelectedDate(strip, '2026-10-29', selection)).toBe('2026-11-01');
  });

  it('falls back to today when today changed since the choice', () => {
    const next = buildWeekStrip(makeDay({ localDate: '2026-10-30' }));
    const selection = { date: '2026-11-01', todayWhenChosen: '2026-10-29' };
    expect(resolveSelectedDate(next, '2026-10-30', selection)).toBe('2026-10-30');
  });

  it('falls back to today when the chosen date is not in the strip', () => {
    const selection = { date: '2026-11-20', todayWhenChosen: '2026-10-29' };
    expect(resolveSelectedDate(strip, '2026-10-29', selection)).toBe('2026-10-29');
  });

  it('works across a year boundary', () => {
    const yearStrip = buildWeekStrip(makeDay({ localDate: '2026-12-30' }));
    const selection = { date: '2027-01-03', todayWhenChosen: '2026-12-30' };
    expect(resolveSelectedDate(yearStrip, '2026-12-30', selection)).toBe('2027-01-03');
  });
});

describe('messageSpeaker', () => {
  it('is null for the signed-in caregiver, whatever their stored name', () => {
    expect(messageSpeaker('user_a', 'Pat', 'user_a')).toBeNull();
    expect(messageSpeaker('user_a', null, 'user_a')).toBeNull();
  });

  it('is the sender name for another caregiver', () => {
    expect(messageSpeaker('user_b', 'Max', 'user_a')).toBe('Max');
  });

  it('falls back to "Another caregiver" without a usable name', () => {
    expect(messageSpeaker('user_b', null, 'user_a')).toBe(ANOTHER_CAREGIVER);
    expect(messageSpeaker('user_b', '  ', 'user_a')).toBe(ANOTHER_CAREGIVER);
  });

  it('is null while the signed-in user is unknown', () => {
    expect(messageSpeaker('user_b', 'Max', null)).toBeNull();
  });
});

describe('buildTranscript', () => {
  it('lists the requests oldest first, each message followed by its reply', () => {
    const requests = [
      makeRequest({ id: 'r2', message: 'And now?', reply: 'Still fine.' }),
      makeRequest({ id: 'r1' }),
    ];
    expect(buildTranscript(requests, 'user_a').map((e) => [e.kind, e.text])).toEqual([
      ['caregiver', 'How is the day?'],
      ['sunny', 'Going well.'],
      ['caregiver', 'And now?'],
      ['sunny', 'Still fine.'],
    ]);
  });

  it('shows a working line while a request is queued or running', () => {
    const queued = buildTranscript([makeRequest({ status: 'queued', reply: null })], 'user_a');
    const running = buildTranscript([makeRequest({ status: 'running', reply: null })], 'user_a');
    expect(queued[1]).toMatchObject({ kind: 'working', text: WORKING_TEXT });
    expect(running[1]).toMatchObject({ kind: 'working', text: WORKING_TEXT });
  });

  it('shows the error of a failed request, or a generic line without one', () => {
    const withError = buildTranscript(
      [makeRequest({ status: 'failed', reply: null, error: 'Agent unavailable' })],
      'user_a',
    );
    const without = buildTranscript(
      [makeRequest({ status: 'failed', reply: null, error: null })],
      'user_a',
    );
    expect(withError[1]).toMatchObject({ kind: 'error', text: 'Agent unavailable' });
    expect(without[1]).toMatchObject({ kind: 'error', text: FAILED_TEXT });
  });

  it('shows only the message for a cancelled request or a blank reply', () => {
    expect(
      buildTranscript([makeRequest({ status: 'cancelled', reply: null })], 'user_a'),
    ).toHaveLength(1);
    expect(buildTranscript([makeRequest({ reply: '  ' })], 'user_a')).toHaveLength(1);
  });

  it('gives every entry a unique id and handles no requests', () => {
    const entries = buildTranscript(
      [makeRequest({ id: 'r2' }), makeRequest({ id: 'r1' })],
      'user_a',
    );
    expect(new Set(entries.map((e) => e.id)).size).toBe(entries.length);
    expect(buildTranscript([], 'user_a')).toEqual([]);
  });

  it('credits other caregivers by name and leaves the signed-in caregiver unlabelled', () => {
    const entries = buildTranscript(
      [
        makeRequest({ id: 'r2', requestedBy: 'user_b', requestedByName: 'Max' }),
        makeRequest({ id: 'r1' }),
      ],
      'user_a',
    );
    const speakers = entries.filter((e) => e.kind === 'caregiver').map((e) => e.speaker);
    expect(speakers).toEqual([null, 'Max']);
    expect(entries.filter((e) => e.kind === 'sunny').every((e) => e.speaker === null)).toBe(true);
  });
});

describe('hasInProgress', () => {
  it('is true while any request is queued or running', () => {
    expect(hasInProgress([makeRequest(), makeRequest({ status: 'queued' })])).toBe(true);
    expect(hasInProgress([makeRequest({ status: 'running' }), makeRequest()])).toBe(true);
  });

  it('is false when every request has finished or there are none', () => {
    const finished = (['succeeded', 'failed', 'cancelled'] as const).map((status) =>
      makeRequest({ status }),
    );
    expect(hasInProgress(finished)).toBe(false);
    expect(hasInProgress([])).toBe(false);
  });
});
