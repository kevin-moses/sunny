// sunny_app/src/caregiver/__tests__/format.test.ts
//
// Purpose: Unit tests for the caregiver helpers: week strip days and markers, date labels,
// alert detection (never for anytime tasks), messages and claim text, anytime rows listed last, leftover (carried-over) tasks,
// the note input, the done detail line (who confirmed, surface), today's task rows (leftover
// split, notes, checkboxState for editors, viewers and busy rows, note visibility), the
// events-only rows of any day (a separate row type from task rows), the planned task rows of a
// selected future day (none for today, so today's tasks are not duplicated),
// the selected-day title and fallback rule,
// the later-this-week groups, transcript ordering, status lines and speaker attribution, and the
// in-progress check, and the already-done message for a Mark done another person beat. Fixtures fill only the
// fields the helpers read; the day is Thursday 2026-10-29 unless a test says otherwise.
//
// Last modified: 2026-11-09

import { describe, expect, it } from '@jest/globals';

import type { DayTask, DayViewData, EventOccurrence, PlannedTask } from '../../day/types';
import {
  ALREADY_DONE_MESSAGE,
  alertMessage,
  alreadyDoneMessage,
  ANOTHER_CAREGIVER,
  buildTranscript,
  buildWeekStrip,
  checkboxState,
  claimText,
  doneDetail,
  eventsForDate,
  FAILED_TEXT,
  hasInProgress,
  isAlert,
  laterThisWeek,
  messageSpeaker,
  noteFromInput,
  noteLine,
  plannedTasksForDate,
  resolveSelectedDate,
  shouldSaveNote,
  selectedDayTitle,
  todaysTasks,
  WORKING_TEXT,
  weekMonthLabel,
  weekRangeLabel,
  type AgentRequest,
  type EventRowData,
  type TaskRowData,
} from '../format';

/** The day the fixtures are dated and the signed-in caregiver. */
const TODAY = '2026-10-29';
const USER = 'user_me';
/** The household-local time the server reports for a confirmation (confirmedLocalTime). */
const CONFIRMED_TIME = '14:05';

/**
 * purpose: Build the event rows for a date the way the Home screen does.
 * @param day: (DayViewData) The day view.
 * @param date: (string) The selected local date.
 * @return: (EventRowData[]) The rows.
 */
function eventsOf(day: DayViewData, date: string): EventRowData[] {
  return eventsForDate(day, date);
}

/**
 * purpose: Today's task rows (leftover and today) for a user, flattened in display order.
 * @param day: (DayViewData) The day view.
 * @return: (TaskRowData[]) The leftover rows followed by today's rows.
 */
function taskRows(day: DayViewData): TaskRowData[] {
  const { leftover, today } = todaysTasks(day, USER);
  return [...leftover, ...today];
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
    localDate: '2026-10-29',
    scheduledTime: '08:00',
    state: 'due',
    carriedOver: false,
    confirmedAt: null,
    confirmedLocalTime: null,
    confirmedVia: null,
    confirmReceivedAt: null,
    confirmReceivedLocalTime: null,
    confirmReceivedDaysLater: null,
    claimedBy: null,
    claimedByName: null,
    confirmedBy: null,
    confirmedByName: null,
    resolutionNote: null,
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
    upcomingTasks: [],
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

  it('marks days with events only, ignoring tasks', () => {
    const day = makeDay({
      tasks: [makeTask()],
      upcoming: [makeEvent({ localDate: '2026-10-31' })],
    });
    const markers = buildWeekStrip(day).map((d) => d.hasMarker);
    expect(markers).toEqual([false, false, true, false, false, false, false]);
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
    const day = makeDay({
      eventsToday: [makeEvent()],
      upcoming: [makeEvent({ localDate: '2026-11-01' })],
    });
    const days = buildWeekStrip(day);
    expect(days[0].accessibilityLabel).toBe('Today, Thursday, October 29, has events');
    expect(days[1].accessibilityLabel).toBe('Friday, October 30');
    expect(days[3].accessibilityLabel).toBe('Sunday, November 1, has events');
  });

  it('leaves today unmarked when it has only tasks', () => {
    const day = makeDay({ tasks: [makeTask()], eventsToday: [], upcoming: [] });
    const [today] = buildWeekStrip(day);
    expect(today.hasMarker).toBe(false);
    expect(today.accessibilityLabel).toBe('Today, Thursday, October 29');
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

/**
 * purpose: Build a planned task.
 * @param overrides: (Partial<Record<keyof PlannedTask, unknown>>) Fields to set.
 * @return: (PlannedTask) An anytime task on 2026-11-02 unless overridden.
 */
function makePlanned(overrides: Partial<Record<keyof PlannedTask, unknown>> = {}): PlannedTask {
  return {
    localDate: '2026-11-02',
    scheduledTime: 'anytime',
    taskId: 'k1',
    type: 'reminder',
    displayLabel: 'License renewal',
    title: 'Renew license',
    ...overrides,
  } as PlannedTask;
}

describe('plannedTasksForDate', () => {
  it('is null for today, so the tickable list is not duplicated', () => {
    const day = makeDay({ upcomingTasks: [makePlanned({ localDate: '2026-10-29' })] });
    expect(plannedTasksForDate(day, '2026-10-29')).toBeNull();
  });

  it('lists the rows of the selected future day only, with Anytime and clock times', () => {
    const day = makeDay({
      upcomingTasks: [
        makePlanned({ localDate: '2026-10-30', scheduledTime: '08:00', displayLabel: 'Vitamin' }),
        makePlanned({ localDate: '2026-10-30' }),
        makePlanned({ localDate: '2026-10-31', displayLabel: 'Other day' }),
      ],
    });
    const rows = plannedTasksForDate(day, '2026-10-30');
    expect(rows?.map((r) => [r.time, r.label])).toEqual([
      ['8:00 AM', 'Vitamin'],
      ['Anytime', 'License renewal'],
    ]);
    expect(new Set(rows?.map((r) => r.id)).size).toBe(2);
    expect(rows?.[1].accessibilityLabel).toContain('planned');
  });

  it('is an empty list for a future day with nothing planned', () => {
    expect(plannedTasksForDate(makeDay(), '2026-10-31')).toEqual([]);
  });

  it('keeps events out of the rows, and tasks out of the event rows', () => {
    const day = makeDay({
      upcomingTasks: [makePlanned({ localDate: '2026-10-30' })],
      upcoming: [makeEvent({ localDate: '2026-10-30', label: 'Walk' })],
    });
    expect(plannedTasksForDate(day, '2026-10-30')?.map((r) => r.label)).toEqual([
      'License renewal',
    ]);
    expect(eventsOf(day, '2026-10-30').map((r) => r.label)).toEqual(['Walk']);
  });
});

describe('eventsForDate', () => {
  it('is empty when no events are scheduled', () => {
    expect(eventsOf(makeDay(), '2026-10-29')).toEqual([]);
    expect(eventsOf(makeDay(), '2026-10-31')).toEqual([]);
  });

  it("lists today's events, from eventsToday, sorted by time, with event keys as ids", () => {
    const day = makeDay({
      eventsToday: [
        makeEvent({ eventId: 'e2', startTime: '15:00', label: 'Late' }),
        makeEvent({ eventId: 'e1', startTime: '07:00', label: 'Walk' }),
      ],
    });
    const rows = eventsOf(day, '2026-10-29');
    expect(rows.map((r) => r.label)).toEqual(['Walk', 'Late']);
    expect(rows.map((r) => r.id)).toEqual(['e1-2026-10-29', 'e2-2026-10-29']);
    expect(rows.every((r) => r.kind === 'event')).toBe(true);
  });

  it('never includes tasks, for today or a later day', () => {
    const day = makeDay({
      tasks: [makeTask({ instanceId: 't1' })],
      eventsToday: [makeEvent({ startTime: '07:00', label: 'Walk' })],
    });
    expect(eventsOf(day, '2026-10-29').map((r) => r.label)).toEqual(['Walk']);
    expect(eventsOf(makeDay({ tasks: [makeTask()] }), '2026-10-30')).toEqual([]);
  });

  it('lists only the chosen later day events, sorted by time', () => {
    const day = makeDay({
      upcoming: [
        makeEvent({ eventId: 'z', localDate: '2026-10-31', startTime: '15:00', label: 'Late' }),
        makeEvent({ eventId: 'y', localDate: '2026-10-30', startTime: '09:00', label: 'Early' }),
        makeEvent({ eventId: 'x', localDate: '2026-10-31', startTime: '08:00', label: 'First' }),
      ],
    });
    expect(eventsOf(day, '2026-10-31').map((r) => r.label)).toEqual(['First', 'Late']);
    expect(eventsOf(day, '2026-10-30').map((r) => r.label)).toEqual(['Early']);
  });

  it('finds events past a month and year boundary', () => {
    const day = makeDay({
      localDate: '2026-12-30',
      upcoming: [makeEvent({ eventId: 'n', localDate: '2027-01-02', label: 'New year' })],
    });
    expect(eventsOf(day, '2027-01-02').map((r) => r.label)).toEqual(['New year']);
    expect(eventsOf(day, '2027-01-01')).toEqual([]);
  });

  it('puts the visitor in an event row and labels it for screen readers', () => {
    const day = makeDay({
      eventsToday: [makeEvent({ visitorName: 'Sam', startTime: '14:00' })],
    });
    const row = eventsOf(day, '2026-10-29')[0];
    expect(row.label).toBe('Cardiology with Sam');
    expect(row.accessibilityLabel).toBe('2:00 PM, Cardiology with Sam');
  });
});

describe('todaysTasks', () => {
  it('is empty when there are no tasks, whatever the events', () => {
    expect(todaysTasks(makeDay(), USER)).toEqual({ leftover: [], today: [] });
    const withEvent = makeDay({ eventsToday: [makeEvent()] });
    expect(todaysTasks(withEvent, USER)).toEqual({ leftover: [], today: [] });
  });

  it('orders tasks by scheduled time and never includes events', () => {
    const day = makeDay({
      tasks: [
        makeTask({ instanceId: 'b', scheduledTime: '12:00' }),
        makeTask({ instanceId: 'a', scheduledTime: '08:00' }),
      ],
      eventsToday: [makeEvent({ startTime: '09:00' })],
    });
    expect(todaysTasks(day, USER).today.map((r) => r.id)).toEqual(['task-a', 'task-b']);
  });

  it('lists anytime rows after the timed ones with the time "Anytime"', () => {
    const day = makeDay({
      tasks: [
        makeTask({ instanceId: 'any', scheduledTime: 'anytime', state: 'due' }),
        makeTask({ instanceId: 'late', scheduledTime: '20:00' }),
        makeTask({ instanceId: 'early', scheduledTime: '08:00' }),
      ],
    });
    const { today } = todaysTasks(day, USER);
    expect(today.map((r) => r.id)).toEqual(['task-early', 'task-late', 'task-any']);
    expect(today[2]).toMatchObject({ time: 'Anytime', variant: 'open' });
    expect(today[2]?.accessibilityLabel).toContain('Anytime');
  });

  it('lists a left-over anytime row after left-over timed rows', () => {
    const day = makeDay({
      tasks: [
        makeTask({ instanceId: 'any', scheduledTime: 'anytime', carriedOver: true, state: 'due' }),
        makeTask({ instanceId: 'late', scheduledTime: '23:30', carriedOver: true, state: 'due' }),
      ],
    });
    expect(todaysTasks(day, USER).leftover.map((r) => r.id)).toEqual(['task-late', 'task-any']);
  });

  it('assigns a variant to each kind of task row', () => {
    const day = makeDay({
      tasks: [
        makeTask({ instanceId: 'a', scheduledTime: '06:00', state: 'confirmed' }),
        makeTask({ instanceId: 'b', scheduledTime: '07:00', state: 'missed' }),
        makeTask({ instanceId: 'c', scheduledTime: '08:00', state: 'escalated' }),
        makeTask({ instanceId: 'd', scheduledTime: '09:00', state: 'upcoming' }),
        makeTask({ instanceId: 'e', scheduledTime: '10:00', state: 'resolved' }),
      ],
    });
    expect(taskRows(day).map((r) => [r.kind, r.variant])).toEqual([
      ['task', 'done'],
      ['task', 'alert'],
      ['task', 'alert'],
      ['task', 'open'],
      ['task', 'done'],
    ]);
  });

  it('adds the status word to task rows for screen readers', () => {
    const day = makeDay({
      tasks: [
        makeTask({ instanceId: 'a', scheduledTime: '06:00', state: 'confirmed' }),
        makeTask({ instanceId: 'b', scheduledTime: '07:00', state: 'missed' }),
        makeTask({ instanceId: 'c', scheduledTime: '08:00', state: 'upcoming' }),
      ],
    });
    expect(taskRows(day).map((r) => r.accessibilityLabel)).toEqual([
      '6:00 AM, Take medication, Done',
      '7:00 AM, Take medication, Not confirmed',
      '8:00 AM, Take medication',
    ]);
  });

  it('carries the instance id on every task row', () => {
    const day = makeDay({ tasks: [makeTask({ instanceId: 't9' })] });
    expect(taskRows(day)[0].instanceId).toBe('t9');
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

describe('laterThisWeek', () => {
  const later = (day: DayViewData, selected: string) =>
    laterThisWeek(day, buildWeekStrip(day), selected);

  it('lists every later day with events, in date order, when today is selected', () => {
    const day = makeDay({
      upcoming: [
        makeEvent({ eventId: 'e2', label: 'Lunch', localDate: '2026-11-01', startTime: '12:00' }),
        makeEvent({ eventId: 'e1', label: 'Walk', localDate: '2026-10-31', startTime: '09:00' }),
        makeEvent({ eventId: 'e3', label: 'Call', localDate: '2026-11-01', startTime: '08:00' }),
      ],
    });
    const groups = later(day, '2026-10-29');
    expect(groups.map((g) => g.date)).toEqual(['2026-10-31', '2026-11-01']);
    expect(groups.map((g) => g.title)).toEqual(['Saturday, Oct 31', 'Sunday, Nov 1']);
    expect(groups[1].rows.map((r) => r.label)).toEqual(['Call', 'Lunch']);
  });

  it('starts after the selected day mid-week', () => {
    const day = makeDay({
      upcoming: [
        makeEvent({ eventId: 'e1', localDate: '2026-10-30' }),
        makeEvent({ eventId: 'e2', localDate: '2026-10-31' }),
        makeEvent({ eventId: 'e3', localDate: '2026-11-02' }),
      ],
    });
    expect(later(day, '2026-10-31').map((g) => g.date)).toEqual(['2026-11-02']);
  });

  it('is empty when the last day of the strip is selected', () => {
    const day = makeDay({ upcoming: [makeEvent({ localDate: '2026-11-04' })] });
    expect(later(day, '2026-11-04')).toEqual([]);
  });

  it('skips days without events', () => {
    const day = makeDay({ upcoming: [makeEvent({ localDate: '2026-11-03' })] });
    expect(later(day, '2026-10-29').map((g) => g.date)).toEqual(['2026-11-03']);
  });

  it('ignores events beyond the strip', () => {
    const day = makeDay({ upcoming: [makeEvent({ localDate: '2026-11-05' })] });
    expect(later(day, '2026-10-29')).toEqual([]);
  });

  it('crosses a year boundary', () => {
    const day = makeDay({
      localDate: '2026-12-30',
      upcoming: [makeEvent({ localDate: '2027-01-02' })],
    });
    const groups = later(day, '2026-12-30');
    expect(groups.map((g) => g.date)).toEqual(['2027-01-02']);
    expect(groups[0].title).toBe('Saturday, Jan 2');
  });

  it('never includes today or its tasks', () => {
    const day = makeDay({
      tasks: [makeTask()],
      eventsToday: [makeEvent({ localDate: '2026-10-29' })],
      upcoming: [makeEvent({ eventId: 'e2', localDate: '2026-10-30' })],
    });
    const groups = later(day, '2026-10-29');
    expect(groups.map((g) => g.date)).toEqual(['2026-10-30']);
    expect(groups.flatMap((g) => g.rows).every((r) => r.kind === 'event')).toBe(true);
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

describe('anytime alerts', () => {
  it('never treats an anytime task as an alert', () => {
    expect(isAlert(makeTask({ scheduledTime: 'anytime', state: 'missed' }))).toBe(false);
    expect(isAlert(makeTask({ scheduledTime: 'anytime', state: 'escalated' }))).toBe(false);
  });
});

describe('leftover tasks', () => {
  const yesterday = '2026-10-28';

  it('opens the alert message with where it came from', () => {
    const task = makeTask({
      localDate: yesterday,
      carriedOver: true,
      state: 'escalated',
      scheduledTime: '23:30',
    });
    expect(alertMessage(task)).toBe(
      'Left over from yesterday. Due at 11:30 PM. Sunny has alerted the family.',
    );
    expect(alertMessage(makeTask({ carriedOver: true, state: 'missed' }))).toBe(
      'Left over from yesterday. Due at 8:00 AM.',
    );
  });

  it('moves carried-over tasks out of the day rows into the leftover list, tasks only', () => {
    const day = makeDay({
      tasks: [
        makeTask({
          instanceId: 'old',
          localDate: yesterday,
          carriedOver: true,
          scheduledTime: '23:30',
          state: 'due',
        }),
        makeTask({ instanceId: 'new', scheduledTime: '08:00' }),
      ],
      eventsToday: [makeEvent({ startTime: '09:00' })],
    });
    const { leftover, today } = todaysTasks(day, USER);
    expect(leftover.map((r) => r.id)).toEqual(['task-old']);
    expect(today.map((r) => r.id)).toEqual(['task-new']);
  });

  it('never calls an event leftover: today events stay out of the tasks lists', () => {
    const day = makeDay({ eventsToday: [makeEvent({ startTime: '06:00' })] });
    const { leftover, today } = todaysTasks(day, USER);
    expect([...leftover, ...today]).toEqual([]);
    expect(eventsOf(day, TODAY)).toHaveLength(1);
  });

  it('has no leftover rows when nothing is carried over', () => {
    const day = makeDay({ tasks: [makeTask()] });
    expect(todaysTasks(day, USER).leftover).toEqual([]);
  });
});

describe('note input', () => {
  it('trims the note and turns an empty one into a clear', () => {
    expect(noteFromInput('  Called her  ')).toBe('Called her');
    expect(noteFromInput('   ')).toBeUndefined();
    expect(noteFromInput('')).toBeUndefined();
    expect(noteFromInput(undefined)).toBeUndefined();
  });
});

describe('checkboxState', () => {
  const rowFor = (state: string) => taskRows(makeDay({ tasks: [makeTask({ state })] }))[0];
  const look = (state: string, canEdit: boolean, busy = false) =>
    checkboxState(rowFor(state), { canEdit, busy });

  it('lets an editor tap every open task, with the alert look for escalated and missed', () => {
    expect(look('upcoming', true)).toEqual({ kind: 'open', interactive: true });
    expect(look('due', true)).toEqual({ kind: 'open', interactive: true });
    expect(look('escalated', true)).toEqual({ kind: 'alert', interactive: true });
    expect(look('missed', true)).toEqual({ kind: 'alert', interactive: true });
  });

  it('dulls and disables every open task for a viewer', () => {
    for (const state of ['upcoming', 'due', 'escalated', 'missed']) {
      expect([state, look(state, false)]).toEqual([
        state,
        { kind: 'disabled', interactive: false },
      ]);
    }
  });

  it('keeps done tasks checked and not tappable, for editors and viewers', () => {
    for (const state of ['confirmed', 'resolved']) {
      for (const canEdit of [true, false]) {
        expect(look(state, canEdit)).toEqual({ kind: 'done', interactive: false });
      }
    }
  });

  it('shows a task whose Mark done call is running as checked and not tappable', () => {
    expect(look('due', true, true)).toEqual({ kind: 'done', interactive: false });
    expect(look('missed', true, true)).toEqual({ kind: 'done', interactive: false });
  });
});

describe('task notes', () => {
  const noted = (state: string, resolutionNote: string | null) =>
    taskRows(makeDay({ tasks: [makeTask({ state, resolutionNote })] }))[0];

  it('puts the note on open and done task rows alike, and on the screen reader label', () => {
    expect(noted('due', 'Refill soon').note).toBe('Refill soon');
    expect(noted('confirmed', 'Refill soon').note).toBe('Refill soon');
    expect(noted('due', null).note).toBeNull();
    expect(noted('due', 'Refill soon').accessibilityLabel).toBe(
      '8:00 AM, Take medication. Note: Refill soon',
    );
  });

  it('words the collapsed note subtitle, and has none for no or blank notes', () => {
    expect(noteLine('Refill soon')).toBe('Note: Refill soon');
    expect(noteLine('  Called  ')).toBe('Note: Called');
    expect(noteLine(null)).toBeNull();
    expect(noteLine('   ')).toBeNull();
  });

  it('saves only when the trimmed draft differs from the current note', () => {
    expect(shouldSaveNote('Called her', null)).toBe(true);
    expect(shouldSaveNote('  Called her ', 'Called her')).toBe(false);
    expect(shouldSaveNote('Called again', 'Called her')).toBe(true);
    expect(shouldSaveNote('', null)).toBe(false);
    expect(shouldSaveNote('   ', null)).toBe(false);
  });

  it('treats a blank draft over an existing note as a clear to save', () => {
    expect(shouldSaveNote('', 'Called her')).toBe(true);
  });
});

describe('doneDetail', () => {
  it('is null for a task that is not done', () => {
    expect(doneDetail(makeTask({ state: 'due' }), USER)).toBeNull();
  });

  it('names the caregiver who marked it done', () => {
    const task = makeTask({
      state: 'resolved',
      confirmedVia: 'caregiver',
      confirmedBy: 'user_pat',
      confirmedByName: 'Pat',
      confirmedLocalTime: CONFIRMED_TIME,
    });
    expect(doneDetail(task, USER)).toBe('Marked done by Pat at 2:05 PM');
  });

  it('says "you" when the signed-in caregiver did it', () => {
    const task = makeTask({
      state: 'resolved',
      confirmedVia: 'caregiver',
      confirmedBy: USER,
      confirmedByName: 'Me',
      confirmedLocalTime: CONFIRMED_TIME,
    });
    expect(doneDetail(task, USER)).toBe('Marked done by you at 2:05 PM');
  });

  it('says "a caregiver" when the name is unknown', () => {
    const task = makeTask({
      state: 'resolved',
      confirmedVia: 'caregiver',
      confirmedBy: 'user_gone',
      confirmedByName: null,
      confirmedLocalTime: CONFIRMED_TIME,
    });
    expect(doneDetail(task, USER)).toBe('Marked done by a caregiver at 2:05 PM');
    expect(doneDetail(task, null)).toBe('Marked done by a caregiver at 2:05 PM');
  });

  it('leaves the note out of the detail (it is the row note)', () => {
    const task = makeTask({
      state: 'resolved',
      confirmedVia: 'caregiver',
      confirmedBy: 'user_pat',
      confirmedByName: 'Pat',
      confirmedLocalTime: CONFIRMED_TIME,
      resolutionNote: 'Called her',
    });
    expect(doneDetail(task, USER)).toBe('Marked done by Pat at 2:05 PM');
  });

  it('words each device surface', () => {
    const wording = {
      button: 'Done at 2:05 PM on the display',
      widget: 'Done at 2:05 PM from the widget',
      live_activity: 'Done at 2:05 PM from the Live Activity',
      phone_app: 'Done at 2:05 PM on the phone',
      voice: 'Done at 2:05 PM by voice',
    };
    for (const [confirmedVia, text] of Object.entries(wording)) {
      const task = makeTask({
        state: 'confirmed',
        confirmedVia,
        confirmedLocalTime: CONFIRMED_TIME,
      });
      expect([confirmedVia, doneDetail(task, USER)]).toEqual([confirmedVia, text]);
    }
  });

  it('says when a late-synced confirm reached the server', () => {
    const task = makeTask({
      state: 'confirmed',
      confirmedVia: 'phone_app',
      confirmedLocalTime: '08:05',
      confirmReceivedLocalTime: '11:00',
    });
    expect(doneDetail(task, USER)).toBe('Done at 8:05 AM on the phone (sent at 11:00 AM)');
  });

  it('says "the next day" when the confirm reached the server after midnight', () => {
    const task = makeTask({
      state: 'confirmed',
      confirmedVia: 'phone_app',
      confirmedLocalTime: '23:30',
      confirmReceivedLocalTime: '02:10',
      confirmReceivedDaysLater: 1,
    });
    expect(doneDetail(task, USER)).toBe(
      'Done at 11:30 PM on the phone (sent the next day at 2:10 AM)',
    );
    const later = makeTask({
      state: 'confirmed',
      confirmedVia: 'phone_app',
      confirmedLocalTime: '23:30',
      confirmReceivedLocalTime: '02:10',
      confirmReceivedDaysLater: 3,
    });
    expect(doneDetail(later, USER)).toBe(
      'Done at 11:30 PM on the phone (sent 3 days later at 2:10 AM)',
    );
  });

  it('adds nothing for a live confirm', () => {
    const task = makeTask({
      state: 'confirmed',
      confirmedVia: 'phone_app',
      confirmedLocalTime: '08:05',
    });
    expect(doneDetail(task, USER)).toBe('Done at 8:05 AM on the phone');
  });

  it('omits the time when the server sent none', () => {
    const task = makeTask({ state: 'confirmed', confirmedVia: 'voice' });
    expect(doneDetail(task, USER)).toBe('Done by voice');
  });

  it('is null for a confirmation with nothing known beyond "Done"', () => {
    expect(doneDetail(makeTask({ state: 'confirmed' }), USER)).toBeNull();
  });

  it('is null for a done task with only a note', () => {
    const task = makeTask({ state: 'confirmed', resolutionNote: 'Fine' });
    expect(doneDetail(task, USER)).toBeNull();
  });

  it('shows the detail and the note on done task rows', () => {
    const day = makeDay({
      tasks: [
        makeTask({
          state: 'resolved',
          confirmedVia: 'caregiver',
          confirmedBy: 'user_pat',
          confirmedByName: 'Pat',
          confirmedLocalTime: CONFIRMED_TIME,
          resolutionNote: 'Called her',
        }),
      ],
    });
    const [row] = taskRows(day);
    expect(row.detail).toBe('Marked done by Pat at 2:05 PM');
    expect(row.note).toBe('Called her');
    expect(row.accessibilityLabel).toBe(
      '8:00 AM, Take medication, Done. Marked done by Pat at 2:05 PM. Note: Called her',
    );
  });
});

describe('alreadyDoneMessage', () => {
  it("is null when the returned confirmation is the signed-in caregiver's own", () => {
    expect(alreadyDoneMessage('user_me', 'user_me')).toBeNull();
  });

  it('says already done when another person confirmed first', () => {
    expect(alreadyDoneMessage('user_other', 'user_me')).toBe(ALREADY_DONE_MESSAGE);
    expect(ALREADY_DONE_MESSAGE).toBe('Already marked done.');
  });

  it('says already done when the confirmation has no recorded confirmer', () => {
    expect(alreadyDoneMessage(undefined, 'user_me')).toBe(ALREADY_DONE_MESSAGE);
  });

  it('says already done when the signed-in user is unknown', () => {
    expect(alreadyDoneMessage('user_other', null)).toBe(ALREADY_DONE_MESSAGE);
  });
});
