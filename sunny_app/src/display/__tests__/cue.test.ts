// sunny_app/src/display/__tests__/cue.test.ts
//
// Purpose: Unit tests for the due cue rules (cue.ts): which tasks are owed a cue (due timed
// tasks, once per sent prompt, never anytime or finished ones; snoozed ones kept owed; a
// task cued within the minimum gap absorbed),
// how the remembered keys are
// kept to today's instances, the spoken time, and the words spoken (the caregiver's prompt,
// or the fixed template when the prompt is the backend's default).
//
// Last modified: 2026-11-09

import { describe, expect, it } from '@jest/globals';

import type { DayTask } from '../../day/types';
import {
  cueChoice,
  cueKey,
  cueSpeech,
  hasWrittenPrompt,
  isCueable,
  rememberCued,
  spokenTime,
} from '../cue';

/**
 * purpose: Build a task.
 * @param overrides: (Partial<Record<keyof DayTask, unknown>>) Fields to set.
 * @return: (DayTask) A due 08:00 medication with the default prompt unless overridden.
 */
function makeTask(overrides: Partial<Record<keyof DayTask, unknown>> = {}): DayTask {
  return {
    instanceId: 't1',
    type: 'medication',
    displayLabel: 'Morning pills',
    spokenPrompt: 'Time for Morning pills.',
    scheduledTime: '08:00',
    state: 'due',
    seniorPrompts: 0,
    snoozed: false,
    ...overrides,
  } as DayTask;
}

/** Spacing with no earlier cues. */
const NO_SPACING = { lastCueAt: new Map<string, number>(), now: 0, minGapMs: 120_000 };

/**
 * purpose: The tasks a cue plays for now.
 * @param tasks: (DayTask[]) The day view's tasks.
 * @param cued: (ReadonlySet<string>) Keys already played.
 * @return: (DayTask[]) The tasks to play.
 */
function tasksToCue(tasks: DayTask[], cued: ReadonlySet<string>): DayTask[] {
  return cueChoice(tasks, cued, NO_SPACING).play;
}

describe('cueChoice', () => {
  it('cues a due task that was not cued yet', () => {
    const task = makeTask();
    expect(tasksToCue([task], new Set())).toEqual([task]);
  });

  it('does not cue the same prompt twice', () => {
    const task = makeTask({ seniorPrompts: 1 });
    expect(tasksToCue([task], new Set(['t1:1']))).toEqual([]);
  });

  it('cues again when the backend sends a reprompt', () => {
    const task = makeTask({ seniorPrompts: 2 });
    expect(tasksToCue([task], new Set(['t1:1']))).toEqual([task]);
  });

  it('cues an escalated task the same way', () => {
    expect(tasksToCue([makeTask({ state: 'escalated' })], new Set())).toHaveLength(1);
  });

  it('never cues upcoming, finished or missed tasks', () => {
    const tasks = ['upcoming', 'confirmed', 'resolved', 'missed'].map((state, i) =>
      makeTask({ instanceId: `t${i}`, state }),
    );
    expect(tasksToCue(tasks, new Set())).toEqual([]);
  });

  it('never cues an anytime task', () => {
    expect(tasksToCue([makeTask({ scheduledTime: 'anytime' })], new Set())).toEqual([]);
  });

  it('keeps the day order when several are owed', () => {
    const a = makeTask({ instanceId: 'a' });
    const b = makeTask({ instanceId: 'b' });
    expect(tasksToCue([a, b], new Set()).map((t) => t.instanceId)).toEqual(['a', 'b']);
  });

  it('keeps a snoozed task owed: neither played nor remembered', () => {
    const snoozed = makeTask({ instanceId: 's', snoozed: true });
    const due = makeTask({ instanceId: 'd' });
    expect(cueChoice([snoozed, due], new Set(), NO_SPACING)).toEqual({
      play: [due],
      absorb: [],
    });
  });

  it('plays the owed cue once the snooze ends', () => {
    expect(cueChoice([makeTask()], new Set(), NO_SPACING).play).toHaveLength(1);
  });

  it('absorbs a new prompt for a task cued within the minimum gap, and plays it after', () => {
    const task = makeTask({ seniorPrompts: 2 });
    const lastCueAt = new Map([['t1', 1_000]]);
    expect(
      cueChoice([task], new Set(['t1:1']), { lastCueAt, now: 61_000, minGapMs: 120_000 }),
    ).toEqual({ play: [], absorb: [task] });
    expect(
      cueChoice([task], new Set(['t1:1']), { lastCueAt, now: 121_000, minGapMs: 120_000 }),
    ).toEqual({ play: [task], absorb: [] });
  });
});

describe('isCueable', () => {
  it('is true only for a due task that is not snoozed', () => {
    expect(isCueable(makeTask())).toBe(true);
    expect(isCueable(makeTask({ snoozed: true }))).toBe(false);
    expect(isCueable(makeTask({ state: 'confirmed' }))).toBe(false);
  });
});

describe('rememberCued', () => {
  it('adds the played keys and drops keys of instances no longer in the day', () => {
    const today = makeTask({ instanceId: 'today', seniorPrompts: 1 });
    const kept = rememberCued(new Set(['gone:0', 'today:0']), [today], [today]);
    expect([...kept].sort()).toEqual(['today:0', 'today:1']);
  });

  it('keeps instance ids that contain a colon intact', () => {
    const task = makeTask({ instanceId: 'a:b', seniorPrompts: 3 });
    expect([...rememberCued(new Set(), [task], [task])]).toEqual([cueKey(task)]);
  });
});

describe('spokenTime', () => {
  it("says o'clock on the hour", () => {
    expect(spokenTime('08:00')).toBe("8 o'clock");
    expect(spokenTime('12:00')).toBe("12 o'clock");
  });

  it('reads other times as a clock', () => {
    expect(spokenTime('14:30')).toBe('2:30');
  });
});

describe('cueSpeech', () => {
  it('speaks the caregiver-written prompt exactly', () => {
    const task = makeTask({ spokenPrompt: '  Time for your pills, the small white ones.  ' });
    expect(cueSpeech(task)).toBe('Time for your pills, the small white ones.');
  });

  it('uses the medication template when the prompt is the default', () => {
    expect(cueSpeech(makeTask())).toBe(
      "Time for Morning pills, at 8 o'clock. Press Done when you have taken them.",
    );
  });

  it('uses the finished template for other tasks and for a blank prompt', () => {
    const task = makeTask({
      type: 'routine',
      displayLabel: 'Walk',
      spokenPrompt: ' ',
      scheduledTime: '15:30',
    });
    expect(cueSpeech(task)).toBe('Time for Walk, at 3:30. Press Done when you have finished.');
  });
});

describe('hasWrittenPrompt', () => {
  it('treats only the backend default and blank as unwritten', () => {
    expect(hasWrittenPrompt(makeTask())).toBe(false);
    expect(hasWrittenPrompt(makeTask({ spokenPrompt: '' }))).toBe(false);
    expect(hasWrittenPrompt(makeTask({ spokenPrompt: 'Time for Evening pills.' }))).toBe(true);
  });
});
