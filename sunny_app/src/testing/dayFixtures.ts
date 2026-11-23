import type { DayTask, DayViewData, EventOccurrence } from '../day/types';

export const FIXTURE_DATE = '2026-11-09';

export function instanceIdOf(id: string): DayTask['instanceId'] {
  return id as DayTask['instanceId'];
}

export function eventIdOf(id: string): EventOccurrence['eventId'] {
  return id as EventOccurrence['eventId'];
}

export function makeTask(overrides: Partial<DayTask> = {}): DayTask {
  return {
    instanceId: instanceIdOf('pills'),
    localDate: FIXTURE_DATE,
    carriedOver: false,
    taskId: 'pillsTask' as DayTask['taskId'],
    type: 'medication',
    displayLabel: 'Morning pills',
    spokenPrompt: 'Time for your morning pills.',
    screenSentence: 'Take your morning pills.',
    pillDescription: 'the small white ones',
    checklistItems: [],
    step: null,
    highPriority: false,
    scheduledTime: '09:30',
    state: 'due',
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
    confirmable: true,
    reopenable: false,
    confirmPressIds: [],
    stepPressIds: [],
    seniorPrompts: 0,
    snoozed: false,
    snoozedUntil: null,
    ...overrides,
  };
}

export function makeEvent(overrides: Partial<EventOccurrence> = {}): EventOccurrence {
  return {
    eventId: eventIdOf('visit'),
    title: 'Sarah visits',
    label: 'Sarah visits',
    startsOn: FIXTURE_DATE,
    startTime: '14:00',
    durationMinutes: null,
    place: null,
    visitorName: null,
    notes: null,
    repeatDays: null,
    repeatUntil: null,
    createdVia: 'caregiver',
    cancelled: false,
    localDate: FIXTURE_DATE,
    startsAt: Date.parse(`${FIXTURE_DATE}T14:00:00Z`),
    endsAt: null,
    ...overrides,
  };
}

export function makeDay(overrides: Partial<DayViewData> = {}): DayViewData {
  return {
    seniorPreferredName: 'Margaret',
    timezone: 'UTC',
    localNow: `${FIXTURE_DATE}T10:00`,
    localDate: FIXTURE_DATE,
    weekday: 'Monday',
    dateLabel: 'November 9',
    header: 'Monday morning',
    tasks: [],
    answeredPresses: 0,
    upcomingTasks: [],
    eventsToday: [],
    nextUp: null,
    upcoming: [],
    ...overrides,
  };
}
