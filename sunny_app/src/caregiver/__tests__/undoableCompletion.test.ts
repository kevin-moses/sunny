// sunny_app/src/caregiver/__tests__/undoableCompletion.test.ts
//
// Purpose: Unit tests for the undo window's controller (createCompletionController), run with
// fake timers: a completion is sent only after the delay, undo sends nothing, a second completion
// commits the first at once, and flush (background, tab switch, unmount) commits immediately.
//
// Last modified: 2026-11-01

import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

import { createCompletionController, UNDO_DELAY_MS } from '../useUndoableCompletion';

/**
 * purpose: Build a controller whose commits and pending-id changes are recorded.
 * @return: (object) The controller, the committed ids and the sequence of pending ids.
 */
function setup() {
  const committed: string[] = [];
  const changes: (string | null)[] = [];
  const controller = createCompletionController<string>({
    delayMs: UNDO_DELAY_MS,
    commit: (id) => committed.push(id),
    onChange: (id) => changes.push(id),
  });
  return { controller, committed, changes };
}

describe('createCompletionController', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('shows the task as pending and sends nothing before the delay', () => {
    const { controller, committed, changes } = setup();
    controller.start('a');
    jest.advanceTimersByTime(UNDO_DELAY_MS - 1);
    expect(committed).toEqual([]);
    expect(changes).toEqual(['a']);
  });

  it('commits once when the delay passes and clears the pending id', () => {
    const { controller, committed, changes } = setup();
    controller.start('a');
    jest.advanceTimersByTime(UNDO_DELAY_MS);
    expect(committed).toEqual(['a']);
    expect(changes).toEqual(['a', null]);
    jest.advanceTimersByTime(UNDO_DELAY_MS * 2);
    expect(committed).toEqual(['a']);
  });

  it('sends nothing after undo, even once the delay would have passed', () => {
    const { controller, committed, changes } = setup();
    controller.start('a');
    jest.advanceTimersByTime(2000);
    controller.undo();
    jest.advanceTimersByTime(UNDO_DELAY_MS * 2);
    expect(committed).toEqual([]);
    expect(changes).toEqual(['a', null]);
  });

  it('commits the previous task at once when another is started', () => {
    const { controller, committed, changes } = setup();
    controller.start('a');
    jest.advanceTimersByTime(1000);
    controller.start('b');
    expect(committed).toEqual(['a']);
    expect(changes).toEqual(['a', null, 'b']);
    jest.advanceTimersByTime(UNDO_DELAY_MS - 1);
    expect(committed).toEqual(['a']);
    jest.advanceTimersByTime(1);
    expect(committed).toEqual(['a', 'b']);
  });

  it('restarts the window, without committing twice, when the same task is started again', () => {
    const { controller, committed } = setup();
    controller.start('a');
    jest.advanceTimersByTime(3000);
    controller.start('a');
    jest.advanceTimersByTime(3000);
    expect(committed).toEqual([]);
    jest.advanceTimersByTime(2000);
    expect(committed).toEqual(['a']);
  });

  it('flush commits the pending task immediately and stops the timer', () => {
    const { controller, committed, changes } = setup();
    controller.start('a');
    controller.flush();
    expect(committed).toEqual(['a']);
    expect(changes).toEqual(['a', null]);
    jest.advanceTimersByTime(UNDO_DELAY_MS * 2);
    expect(committed).toEqual(['a']);
  });

  it('flush and undo do nothing when nothing is pending', () => {
    const { controller, committed, changes } = setup();
    controller.flush();
    expect(committed).toEqual([]);
    expect(changes).toEqual([]);
    controller.undo();
    expect(committed).toEqual([]);
  });
});
