import { describe, expect, it } from '@jest/globals';

import { buildAgenda } from '../../day/format';
import type { DayTask, DayViewData, EventOccurrence } from '../../day/types';
import type { UndoLineData } from '../../day/useDoneAction';
import {
  comingUpAt,
  dayRows,
  doneKeyLabel,
  eventIsOver,
  nextLine,
  notedAt,
  phoneClockTime,
  screenMode,
  stepTag,
  taskHeadline,
} from '../model';

const TODAY = '2026-11-09';
const AT = (hour: number, minute = 0): number =>
  Date.parse(`2026-11-09T${pad(hour)}:${pad(minute)}:00Z`);

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

function task(overrides: Partial<DayTask> = {}): DayTask {
  return {
    instanceId: 'pills' as never,
    displayLabel: 'Morning pills',
    screenSentence: null,
    pillDescription: null,
    checklistItems: [],
    step: null,
    scheduledTime: '09:30',
    state: 'due',
    confirmable: true,
    carriedOver: false,
    ...overrides,
  } as unknown as DayTask;
}

function event(overrides: Partial<EventOccurrence> = {}): EventOccurrence {
  return {
    eventId: 'visit' as never,
    label: 'Sarah visits',
    localDate: TODAY,
    startTime: '14:00',
    startsAt: AT(14),
    endsAt: null,
    visitorName: null,
    place: null,
    ...overrides,
  } as unknown as EventOccurrence;
}

function day(
  tasks: DayTask[],
  eventsToday: EventOccurrence[] = [],
  upcoming: EventOccurrence[] = [],
): DayViewData {
  return { localDate: TODAY, tasks, eventsToday, upcoming } as unknown as DayViewData;
}

const UNDO: UndoLineData = { label: 'Morning pills', text: 'Morning pills done.', pressedAt: 0 };

describe('screenMode', () => {
  it('shows the task when there is one, even while an Undo is still offered', () => {
    const shown = task();
    expect(screenMode({ task: shown, message: null, undo: UNDO, next: 'Next: x' })).toEqual({
      kind: 'task',
      task: shown,
      early: false,
      undo: UNDO,
      message: null,
    });
  });

  it('marks an upcoming task as early', () => {
    const mode = screenMode({
      task: task({ state: 'upcoming' }),
      message: null,
      undo: null,
      next: null,
    });
    expect(mode.kind === 'task' && mode.early).toBe(true);
  });

  it('shows the noted state while Undo is offered and nothing is on the key', () => {
    expect(screenMode({ task: null, message: 'm', undo: UNDO, next: 'Next: x' })).toEqual({
      kind: 'noted',
      undo: UNDO,
      message: 'm',
    });
  });

  it('shows a message on its own when nothing else is up', () => {
    expect(screenMode({ task: null, message: 'Wait', undo: null, next: 'Next: x' })).toEqual({
      kind: 'notice',
      message: 'Wait',
    });
  });

  it('is clear with the next item otherwise', () => {
    expect(screenMode({ task: null, message: null, undo: null, next: 'Next: x' })).toEqual({
      kind: 'clear',
      next: 'Next: x',
    });
  });
});

describe('taskHeadline', () => {
  it('uses the screen sentence and the pill description', () => {
    expect(
      taskHeadline(
        task({
          screenSentence: 'Take your morning pills.',
          pillDescription: 'the small white ones',
        }),
      ),
    ).toEqual({ sentence: 'Take your morning pills.', detail: 'the small white ones' });
  });

  it('falls back to the display label with no detail', () => {
    expect(taskHeadline(task())).toEqual({ sentence: 'Morning pills', detail: null });
  });

  it('shows the step text with the task label under it on a step task', () => {
    const stepped = task({
      screenSentence: 'Take your morning pills.',
      pillDescription: 'the small white ones',
      checklistItems: ['Fill a glass', 'Take the small white ones with water.', 'Rinse'],
      step: { index: 1, count: 3, text: 'Take the small white ones with water.' },
    });
    expect(taskHeadline(stepped)).toEqual({
      sentence: 'Take the small white ones with water.',
      detail: 'Morning pills',
    });
    expect(stepTag(stepped)).toBe('Step 2 of 3');
  });

  it('has no step tag on a single-step task', () => {
    expect(stepTag(task())).toBeNull();
  });
});

describe('doneKeyLabel', () => {
  it('reads Done and the label', () => {
    expect(doneKeyLabel(task(), false)).toBe('Done: Morning pills');
  });

  it('reads the time on the early key', () => {
    expect(doneKeyLabel(task({ scheduledTime: '10:15', state: 'upcoming' }), true)).toBe(
      'Done early: Morning pills, coming up at 10:15 am',
    );
    expect(comingUpAt(task({ scheduledTime: '10:15' }))).toBe('Coming up at 10:15 AM');
  });

  it('reads the step', () => {
    const stepped = task({ step: { index: 1, count: 2, text: 'Take your keys' } });
    expect(doneKeyLabel(stepped, false)).toBe('Done: Morning pills, step 2 of 2, Take your keys');
  });
});

describe('notedAt', () => {
  it('uses the phone clock for the time of the press', () => {
    const pressedAt = new Date(2026, 10, 9, 9, 41, 30).getTime();
    expect(notedAt(pressedAt)).toBe('Noted at 9:41 AM');
  });

  it('writes noon and midnight in the 12-hour form', () => {
    expect(phoneClockTime(new Date(2026, 10, 9, 12, 5).getTime())).toBe('12:05 PM');
    expect(phoneClockTime(new Date(2026, 10, 9, 0, 5).getTime())).toBe('12:05 AM');
  });
});

describe('eventIsOver', () => {
  it('is over after its end', () => {
    const withEnd = event({ endsAt: AT(15) });
    expect(eventIsOver(withEnd, AT(14, 59))).toBe(false);
    expect(eventIsOver(withEnd, AT(15))).toBe(true);
  });

  it('is over 60 minutes after its start when it has no end', () => {
    expect(eventIsOver(event(), AT(14, 59))).toBe(false);
    expect(eventIsOver(event(), AT(15))).toBe(true);
  });
});

describe('nextLine', () => {
  const lunch = task({
    instanceId: 'lunch' as never,
    displayLabel: 'Lunch',
    scheduledTime: '12:30',
    state: 'upcoming',
  });

  it('names the next open timed task', () => {
    const today = day([task({ state: 'confirmed' }), lunch], [event()]);
    expect(nextLine(today, buildAgenda(today), AT(10))).toBe('Next: Lunch at 12:30 PM');
  });

  it('names an event today when it comes first', () => {
    const today = day([lunch], [event({ startTime: '11:00', startsAt: AT(11) })]);
    expect(nextLine(today, buildAgenda(today), AT(10))).toBe('Next: Sarah visits at 11:00 AM');
  });

  it('skips an event that has started, and done, missed and anytime tasks', () => {
    const today = day(
      [
        task({ state: 'confirmed' }),
        task({ instanceId: 'm' as never, state: 'missed', scheduledTime: '08:00' }),
        task({ instanceId: 'a' as never, state: 'upcoming', scheduledTime: 'anytime' }),
      ],
      [
        event({ startTime: '09:00', startsAt: AT(9) }),
        event({ eventId: 'tea' as never, label: 'Tea', startTime: '16:00', startsAt: AT(16) }),
      ],
    );
    expect(nextLine(today, buildAgenda(today), AT(10))).toBe('Next: Tea at 4:00 PM');
  });

  it('names the next event from the coming days with its day when today has none', () => {
    const tomorrow = event({ localDate: '2026-11-10', startsAt: AT(14) + 86_400_000 });
    const today = day([task({ state: 'confirmed' })], [], [tomorrow]);
    expect(nextLine(today, buildAgenda(today), AT(10))).toBe(
      'Next: Sarah visits tomorrow at 2:00 PM',
    );
  });

  it('names a later weekday by name', () => {
    const thursday = event({ localDate: '2026-11-12', startTime: '15:00' });
    const today = day([], [], [thursday]);
    expect(nextLine(today, buildAgenda(today), AT(10))).toBe(
      'Next: Sarah visits Thursday at 3:00 PM',
    );
  });

  it('is null with nothing at all', () => {
    const today = day([task({ state: 'confirmed' })]);
    expect(nextLine(today, buildAgenda(today), AT(10))).toBeNull();
  });
});

describe('dayRows', () => {
  function rowsFor(tasks: DayTask[], shown: DayTask | null, events: EventOccurrence[] = []) {
    return dayRows(buildAgenda(day(tasks, events)), shown, AT(10));
  }

  it('shows the task on the Done key as the now row', () => {
    const due = task();
    expect(rowsFor([due], due)[0]).toMatchObject({
      time: '9:30 AM',
      label: 'Morning pills',
      mark: 'none',
      tone: 'now',
      spoken: 'Due now',
    });
  });

  it('shows the early task as a strong row without the now fill', () => {
    const early = task({ state: 'upcoming', scheduledTime: '10:15' });
    expect(rowsFor([early], early)[0]).toMatchObject({ tone: 'early', spoken: 'Coming up' });
  });

  it('keeps other open tasks plain, even a due one that is not on the key', () => {
    const later = task({ instanceId: 'b' as never, state: 'upcoming', scheduledTime: '12:30' });
    const due = task();
    expect(rowsFor([due, later], null).map((r) => r.tone)).toEqual(['plain', 'plain']);
  });

  it('greys a done task with a check and says done', () => {
    for (const state of ['confirmed', 'resolved'] as const) {
      expect(rowsFor([task({ state })], null)[0]).toMatchObject({
        mark: 'done',
        tone: 'grey',
        spoken: 'Done',
      });
    }
  });

  it('greys a missed task with no mark and never says missed', () => {
    const row = rowsFor([task({ state: 'missed' })], null)[0]!;
    expect(row).toMatchObject({ mark: 'none', tone: 'grey' });
    expect(row.spoken).not.toMatch(/missed|late|overdue|forgot|failed/i);
  });

  it('marks an event with the calendar and greys it once it is over', () => {
    const rows = rowsFor([], null, [
      event({ eventId: 'walk' as never, label: 'Walk', startTime: '08:00', startsAt: AT(8) }),
      event(),
    ]);
    expect(rows.map((r) => [r.label, r.mark, r.tone, r.spoken])).toEqual([
      ['Walk', 'event', 'grey', 'Earlier today'],
      ['Sarah visits', 'event', 'plain', ''],
    ]);
  });
});
