import { describe, expect, it } from '@jest/globals';

import { instanceIdOf, makeTask } from '../../testing/dayFixtures';
import type { LoggedPress } from '../pressLog';
import { applyPresses, overlayEntries, pressLabel } from '../pressOverlay';
import type { DayTask } from '../types';

const NOON = Date.parse('2026-11-09T12:00:00Z');
const STEPS = ['Put on your coat', 'Take your keys', 'Lock the door'];

function task(overrides: Partial<DayTask> = {}): DayTask {
  return makeTask({ instanceId: instanceIdOf('inst1'), scheduledTime: '12:00', ...overrides });
}

function multi(index: number, overrides: Partial<DayTask> = {}): DayTask {
  return task({
    displayLabel: 'Going out',
    checklistItems: STEPS,
    step: { index, count: STEPS.length, text: STEPS[index]! },
    ...overrides,
  });
}

function logged(overrides: Partial<LoggedPress> = {}): LoggedPress {
  return { pressId: 'P1', instanceId: 'inst1', step: 0, pressedAt: NOON, ...overrides };
}

function shown(day: DayTask[], log: LoggedPress[], answeredPresses = 0): DayTask {
  return applyPresses(day, overlayEntries(log, answeredPresses))[0]!;
}

describe('overlayEntries', () => {
  it('draws a press until the day view has caught up with its answer', () => {
    const kinds = (press: LoggedPress, dayCount: number): string[] =>
      overlayEntries([press], dayCount).map((e) => e.kind);
    expect(kinds(logged(), 9)).toEqual(['press']);
    expect(kinds(logged({ answer: { applied: true, answeredPresses: 5 } }), 4)).toEqual(['press']);
    expect(kinds(logged({ answer: { applied: true, answeredPresses: 5 } }), 5)).toEqual([]);
    expect(kinds(logged({ answer: { applied: true, answeredPresses: 5 } }), 6)).toEqual([]);
  });

  it('never draws a press the server refused or answered without a count', () => {
    expect(overlayEntries([logged({ answer: { applied: false, answeredPresses: 5 } })], 0)).toEqual(
      [],
    );
    expect(overlayEntries([logged({ answer: { applied: false } })], 0)).toEqual([]);
    expect(overlayEntries([logged({ answer: { applied: true } })], 0)).toEqual([]);
  });

  it('draws an undo by the same rule, on its own answer', () => {
    const answered = { applied: true, answeredPresses: 3 };
    const kinds = (undoAnswer: LoggedPress['answer'], dayCount: number): string[] =>
      overlayEntries(
        [logged({ answer: answered, undo: { undoneAt: NOON + 5_000, answer: undoAnswer } })],
        dayCount,
      ).map((e) => e.kind);
    expect(kinds(undefined, 3)).toEqual(['undo']);
    expect(kinds(undefined, 2)).toEqual(['press', 'undo']);
    expect(kinds({ applied: true, answeredPresses: 4 }, 3)).toEqual(['undo']);
    expect(kinds({ applied: true, answeredPresses: 4 }, 4)).toEqual([]);
    expect(kinds({ applied: false, answeredPresses: 4 }, 3)).toEqual([]);
  });

  it('orders by time across tasks and keeps an undo after its press when the clock went back', () => {
    const entries = overlayEntries(
      [
        logged({ pressId: 'A', pressedAt: NOON + 100, undo: { undoneAt: NOON + 40 } }),
        logged({ pressId: 'B', instanceId: 'inst2', pressedAt: NOON + 50 }),
      ],
      0,
    );
    expect(entries.map((e) => `${e.kind}:${e.pressId}`)).toEqual(['press:B', 'press:A', 'undo:A']);
  });
});

describe('applyPresses', () => {
  it('shows a pressed task done and a pressed step as the next step', () => {
    expect(shown([task()], [logged()])).toMatchObject({ state: 'confirmed', confirmable: false });
    expect(shown([multi(0)], [logged()])).toMatchObject({
      state: 'due',
      step: { index: 1, text: 'Take your keys' },
    });
    expect(shown([multi(2)], [logged({ step: 2 })])).toMatchObject({ state: 'confirmed' });
  });

  it('ignores a press of a step the task is not on', () => {
    expect(shown([multi(1)], [logged({ step: 0 })])).toMatchObject({ step: { index: 1 } });
    expect(shown([multi(0)], [logged({ step: 2 })])).toMatchObject({ step: { index: 0 } });
  });

  it('changes nothing once the day view lists the press id itself', () => {
    const confirmed = task({ state: 'confirmed', confirmable: false, confirmPressIds: ['P1'] });
    expect(shown([confirmed], [logged()])).toBe(confirmed);
    const advanced = multi(1, { stepPressIds: ['P1'] });
    expect(shown([advanced], [logged()])).toBe(advanced);
  });

  it('leaves a task that another device confirmed as it is', () => {
    const elsewhere = task({ state: 'confirmed', confirmable: false });
    expect(shown([elsewhere], [logged({ undo: { undoneAt: NOON + 1 } })])).toBe(elsewhere);
  });

  it('an undo of a press not yet on the server shows the task exactly as it was', () => {
    const before = task({ state: 'escalated' });
    expect(shown([before], [logged({ undo: { undoneAt: NOON + 5_000 } })])).toBe(before);
    const step = multi(1);
    expect(shown([step], [logged({ step: 1, undo: { undoneAt: NOON + 5_000 } })])).toEqual(step);
  });

  it('an undo of a press the server already confirmed shows the task due again', () => {
    const confirmed = task({ state: 'confirmed', confirmable: false, confirmPressIds: ['P1'] });
    const press = logged({
      answer: { applied: true, answeredPresses: 1 },
      undo: { undoneAt: NOON + 5_000 },
    });
    expect(shown([confirmed], [press], 1)).toMatchObject({ state: 'due', confirmable: true });
  });

  it('shows the state the server says an undo restores, and due when it says nothing', () => {
    const press = logged({
      answer: { applied: true, answeredPresses: 1 },
      undo: { undoneAt: NOON + 5_000 },
    });
    const restoring = (undoRestoresState: DayTask['undoRestoresState']): DayTask =>
      task({ state: 'confirmed', confirmable: false, confirmPressIds: ['P1'], undoRestoresState });
    expect(shown([restoring('upcoming')], [press], 1)).toMatchObject({
      state: 'upcoming',
      confirmable: true,
    });
    expect(shown([restoring('escalated')], [press], 1).state).toBe('escalated');
    expect(shown([restoring(null)], [press], 1).state).toBe('due');
  });

  it('an undo of a step press the server already has shows the step again', () => {
    const advanced = multi(1, { stepPressIds: ['P1'] });
    const press = logged({
      answer: { applied: true, answeredPresses: 1 },
      undo: { undoneAt: NOON + 5_000 },
    });
    expect(shown([advanced], [press], 1)).toMatchObject({
      state: 'due',
      step: { index: 0, text: 'Put on your coat' },
    });
  });

  it('follows press, undo and press again in the order they were made', () => {
    const log = [
      logged({ pressId: 'P1', undo: { undoneAt: NOON + 5_000 } }),
      logged({ pressId: 'P2', pressedAt: NOON + 9_000 }),
    ];
    expect(shown([task()], log)).toMatchObject({ state: 'confirmed' });
    expect(shown([task()], [log[0]!])).toMatchObject({ state: 'due' });
  });

  it('shows the server day once it has caught up with a press and its undo', () => {
    const reopened = task();
    const press = logged({
      answer: { applied: true, answeredPresses: 1 },
      undo: { undoneAt: NOON + 5_000, answer: { applied: true, answeredPresses: 2 } },
    });
    expect(shown([reopened], [press], 2)).toBe(reopened);
    const stillConfirmed = task({
      state: 'confirmed',
      confirmable: false,
      confirmPressIds: ['P1'],
    });
    expect(shown([stillConfirmed], [press], 1)).toMatchObject({ state: 'due' });
    expect(shown([task()], [press], 0)).toMatchObject({ state: 'due' });
  });

  it('touches only the tasks that were pressed', () => {
    const other = task({ instanceId: instanceIdOf('inst2') });
    const day = [task(), other];
    expect(applyPresses(day, overlayEntries([logged()], 0))[1]).toBe(other);
    expect(applyPresses(day, [])).toBe(day);
  });
});

describe('pressLabel', () => {
  it('names the step only while another step follows', () => {
    expect(pressLabel(task())).toBe('Morning pills');
    expect(pressLabel(multi(0))).toBe('Going out, step 1');
    expect(pressLabel(multi(2))).toBe('Going out');
  });
});
