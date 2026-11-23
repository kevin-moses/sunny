import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import React, { useSyncExternalStore } from 'react';
import { AccessibilityInfo } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { logger } from '../../logging/logger';
import { instanceIdOf, makeTask } from '../../testing/dayFixtures';
import { makeFakePressStore, type FakePressStore } from '../../testing/fakePressStore';
import { applyPresses, overlayEntries } from '../pressOverlay';
import type { DayTask } from '../types';
import {
  dayIsCurrent,
  doneTarget,
  MESSAGE_MS,
  NOT_PAIRED_MESSAGE,
  NOT_STORED_MESSAGE,
  STORE_TIMEOUT_MS,
  PRESS_GAP_MS,
  SETTLE_MS,
  UNDO_MS,
  useDoneAction,
  type DoneAction,
} from '../useDoneAction';

jest.mock('../../logging/logger', () => ({
  logger: { warning: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mounted: ReactTestRenderer[] = [];
let announce: jest.SpiedFunction<typeof AccessibilityInfo.announceForAccessibility>;
let announceQueued: jest.SpiedFunction<
  typeof AccessibilityInfo.announceForAccessibilityWithOptions
>;
const NOW = Date.parse('2026-11-09T08:00:00Z');

function task(overrides: Partial<DayTask> = {}): DayTask {
  return makeTask({ instanceId: instanceIdOf('inst1'), scheduledTime: '08:00', ...overrides });
}

const second = (): DayTask =>
  task({
    instanceId: instanceIdOf('inst2'),
    displayLabel: 'Evening pills',
    scheduledTime: '09:00',
  });

const early = (): DayTask =>
  task({
    instanceId: instanceIdOf('early1'),
    displayLabel: 'Evening pills',
    scheduledTime: '09:00',
    state: 'upcoming',
  });

interface Harness {
  get: () => DoneAction;
  everyRender: () => DoneAction[];
  shown: () => DayTask[];
  rerender: (day: DayTask[], isOffline?: boolean) => void;
  unmount: () => void;
}

function renderDone(store: FakePressStore, day: DayTask[], isOffline = false): Harness {
  const renders: DoneAction[] = [];
  let shownNow: DayTask[] = [];
  const record = (value: DoneAction, shown: DayTask[]): void => {
    renders.push(value);
    shownNow = shown;
  };
  const Probe = ({ tasks, off }: { tasks: DayTask[]; off: boolean }): null => {
    const seen = useSyncExternalStore(store.subscribe, store.getSeen);
    const shown = applyPresses(tasks, overlayEntries(seen.presses, 0));
    record(useDoneAction(doneTarget(shown, !off), off, store, shown), shown);
    return null;
  };
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(<Probe tasks={day} off={isOffline} />);
    mounted.push(renderer);
  });
  return {
    get: () => renders.at(-1) as DoneAction,
    everyRender: () => renders,
    shown: () => shownNow,
    rerender: (tasks, off = isOffline) =>
      act(() => renderer.update(<Probe tasks={tasks} off={off} />)),
    unmount: () => act(() => renderer.unmount()),
  };
}

async function press(h: Harness): Promise<void> {
  await act(async () => {
    h.get().pressDone();
  });
}

async function tapUndo(h: Harness): Promise<void> {
  await act(async () => {
    h.get().pressUndo();
  });
}

async function advance(ms: number): Promise<void> {
  await act(async () => {
    await jest.advanceTimersByTimeAsync(ms);
  });
}

function pressedIds(store: FakePressStore): string[] {
  return store.log().map((p) => p.instanceId);
}

function useHarnessClock(): void {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(NOW);
    (logger.warning as jest.Mock).mockClear();
    announce = jest
      .spyOn(AccessibilityInfo, 'announceForAccessibility')
      .mockImplementation(() => {});
    announceQueued = jest
      .spyOn(AccessibilityInfo, 'announceForAccessibilityWithOptions')
      .mockImplementation(() => {});
  });

  afterEach(() => {
    act(() => {
      mounted.splice(0).forEach((renderer) => renderer.unmount());
    });
    announce.mockRestore();
    announceQueued.mockRestore();
    jest.useRealTimers();
  });
}

describe('doneTarget', () => {
  it('picks the first due task', () => {
    const first = task({ instanceId: instanceIdOf('a') });
    const done = task({ instanceId: instanceIdOf('x'), state: 'confirmed', confirmable: false });
    expect(doneTarget([done, first, task({ instanceId: instanceIdOf('b') })])).toBe(first);
  });

  it('picks an escalated task', () => {
    const late = task({ state: 'escalated' });
    expect(doneTarget([late])).toBe(late);
  });

  it('prefers a due task over an earlier-listed confirmable upcoming one', () => {
    const upcoming = task({ instanceId: instanceIdOf('e'), state: 'upcoming' });
    const due = task({ instanceId: instanceIdOf('d') });
    expect(doneTarget([upcoming, due])).toBe(due);
  });

  it('otherwise picks the first confirmable upcoming task', () => {
    const tooEarly = task({
      instanceId: instanceIdOf('t'),
      state: 'upcoming',
      confirmable: false,
    });
    const upcoming = task({ instanceId: instanceIdOf('e'), state: 'upcoming' });
    expect(
      doneTarget([tooEarly, upcoming, task({ instanceId: instanceIdOf('f'), state: 'upcoming' })]),
    ).toBe(upcoming);
  });

  it('is null when nothing may be confirmed', () => {
    expect(
      doneTarget([
        task({ state: 'upcoming', confirmable: false }),
        task({ state: 'missed' }),
        task({ state: 'confirmed', confirmable: false }),
      ]),
    ).toBeNull();
    expect(doneTarget([])).toBeNull();
  });

  it('skips the early step when early is not allowed (offline)', () => {
    const upcoming = task({ instanceId: instanceIdOf('e'), state: 'upcoming' });
    expect(doneTarget([upcoming], false)).toBeNull();
    expect(doneTarget([upcoming])).toBe(upcoming);
    const due = task({ instanceId: instanceIdOf('d') });
    expect(doneTarget([upcoming, due], false)).toBe(due);
  });

  it('never targets an anytime task', () => {
    expect(doneTarget([task({ scheduledTime: 'anytime' })])).toBeNull();
    expect(doneTarget([task({ scheduledTime: 'anytime', state: 'upcoming' })])).toBeNull();
  });
});

describe('dayIsCurrent', () => {
  const day = { localDate: '2026-11-09', timezone: 'America/New_York' };

  it('is true on the same local date', () => {
    expect(dayIsCurrent(day, Date.parse('2026-11-09T15:00:00Z'))).toBe(true);
  });

  it('is false the next morning (offline across midnight)', () => {
    expect(dayIsCurrent(day, Date.parse('2026-11-10T13:00:00Z'))).toBe(false);
  });

  it('uses the household zone, not UTC (11 PM in New York is still the same date)', () => {
    expect(dayIsCurrent(day, Date.parse('2026-11-10T03:30:00Z'))).toBe(true);
  });

  it('is true when the zone is unknown, so Done is never blocked by it', () => {
    expect(
      dayIsCurrent({ ...day, timezone: 'Not/AZone' }, Date.parse('2030-01-01T00:00:00Z')),
    ).toBe(true);
  });
});

describe('useDoneAction', () => {
  useHarnessClock();

  it('stores the press with its step, and shows and announces one Undo line', async () => {
    const store = makeFakePressStore();
    const h = renderDone(store, [task()]);
    await press(h);
    expect(store.log()).toEqual([
      { pressId: 'press-0000000000000001', instanceId: 'inst1', step: 0, pressedAt: NOW },
    ]);
    expect(h.get().message).toBeNull();
    expect(h.get().undo).toEqual({
      label: 'Morning pills',
      text: 'Morning pills done.',
      pressedAt: NOW,
    });
    expect(announce).not.toHaveBeenCalled();
    expect(announceQueued).toHaveBeenCalledTimes(1);
    expect(announceQueued).toHaveBeenCalledWith('Morning pills done. Undo', { queue: true });
  });

  it('offline: says the press will be sent, until the server has answered it', async () => {
    const store = makeFakePressStore();
    const h = renderDone(store, [task()], true);
    await press(h);
    expect(h.get().message).toBeNull();
    expect(h.get().undo?.text).toBe(
      'Morning pills done. It will be sent when the internet is back.',
    );
    expect(announceQueued).toHaveBeenCalledWith(
      'Morning pills done. It will be sent when the internet is back. Undo',
      { queue: true },
    );
    act(() => store.answer('press-0000000000000001'));
    expect(h.get().undo?.text).toBe('Morning pills done.');
  });

  it('shows no offline note online, even while the press is still unsent', async () => {
    const store = makeFakePressStore();
    const h = renderDone(store, [task()]);
    await press(h);
    expect(store.log()[0]?.answer).toBeUndefined();
    expect(h.get().undo?.text).toBe('Morning pills done.');
  });

  it('stores nothing without a target', async () => {
    const store = makeFakePressStore();
    const h = renderDone(store, []);
    await press(h);
    expect(store.log()).toEqual([]);
    expect(h.get().message).toBeNull();
  });

  it('ignores a second press within the gap', async () => {
    const store = makeFakePressStore();
    store.failWrites(true);
    const h = renderDone(store, [task()]);
    await press(h);
    store.failWrites(false);
    await advance(PRESS_GAP_MS - 100);
    await press(h);
    expect(store.log()).toEqual([]);
    await advance(100);
    await press(h);
    expect(pressedIds(store)).toEqual(['inst1']);
  });

  it('says so and keeps the task offered when the press cannot be stored', async () => {
    const store = makeFakePressStore();
    store.failWrites(true);
    const h = renderDone(store, [task()]);
    await press(h);
    expect(h.get().message).toBe(NOT_STORED_MESSAGE);
    expect(h.get().task).not.toBeNull();
    expect(h.get().undo).toBeNull();
    await advance(MESSAGE_MS + 1);
    expect(h.get().message).toBeNull();
  });

  it('asks for the phone to be connected again when it has no device token', async () => {
    const store = makeFakePressStore();
    store.unpair();
    const h = renderDone(store, [task()]);
    await press(h);
    expect(h.get().message).toBe(NOT_PAIRED_MESSAGE);
    expect(h.get().task?.instanceId).toBe('inst1');
    expect(store.log()).toEqual([]);
  });

  it('shows the senior nothing alarming when the server refuses a press', async () => {
    const store = makeFakePressStore();
    const h = renderDone(store, [task()]);
    await press(h);
    act(() => store.answer('press-0000000000000001', { applied: false, answeredPresses: 1 }));
    await advance(SETTLE_MS + 1);
    expect(h.get().message).toBeNull();
    expect(h.get().undo?.text).toBe('Morning pills done.');
    expect(announce).not.toHaveBeenCalled();
    expect(announceQueued).toHaveBeenCalledTimes(1);
  });

  describe('when storing hangs', () => {
    it('asks the senior to press again, keeps the task offered and allows the next press', async () => {
      const store = makeFakePressStore();
      store.holdWrites();
      const h = renderDone(store, [task()]);
      await press(h);
      expect(h.get().message).toBeNull();
      await advance(STORE_TIMEOUT_MS + 1);
      expect(store.log()).toEqual([]);
      expect(h.get().message).toBe(NOT_STORED_MESSAGE);
      expect(h.get().task?.instanceId).toBe('inst1');
      await advance(PRESS_GAP_MS);
      await press(h);
      await advance(STORE_TIMEOUT_MS + 1);
      expect(h.get().message).toBe(NOT_STORED_MESSAGE);
    });

    it('a late successful write replaces the press-again line with the Undo line and holds', async () => {
      const store = makeFakePressStore();
      const release = store.holdWrites();
      const h = renderDone(store, [task(), second()]);
      await press(h);
      await advance(STORE_TIMEOUT_MS + 1);
      await act(async () => release());
      await advance(0);
      expect(pressedIds(store)).toEqual(['inst1']);
      expect(h.get().message).toBeNull();
      expect(h.get().undo?.text).toBe('Morning pills done.');
      expect(h.get().task).toBeNull();
      await advance(UNDO_MS);
      expect(h.get().task?.instanceId).toBe('inst2');
    });
  });

  describe('two tasks due', () => {
    it('withdraws the button after a press and refuses a doubting second press', async () => {
      const store = makeFakePressStore();
      const h = renderDone(store, [task(), second()]);
      await press(h);
      expect(h.get().task).toBeNull();
      expect(h.get().undo?.text).toBe('Morning pills done.');
      await advance(1000);
      await press(h);
      expect(pressedIds(store)).toEqual(['inst1']);
    });

    it('after Done on a task with no further step, holds Noted and Undo for the whole Undo window', async () => {
      const store = makeFakePressStore();
      const h = renderDone(store, [task(), second()]);
      await press(h);
      await advance(UNDO_MS - 1);
      expect(h.get().task).toBeNull();
      expect(h.get().undo?.text).toBe('Morning pills done.');
      await advance(1);
      expect(h.get().task?.instanceId).toBe('inst2');
      expect(h.get().undo).toBeNull();
    });

    it('offers the next task once the Undo window is over; its press makes a new Undo offer', async () => {
      const store = makeFakePressStore();
      const h = renderDone(store, [task(), second()]);
      await press(h);
      await advance(UNDO_MS);
      expect(h.get().task?.instanceId).toBe('inst2');
      expect(h.get().message).toBeNull();
      await press(h);
      expect(pressedIds(store)).toEqual(['inst1', 'inst2']);
      expect(h.get().undo?.text).toBe('Evening pills done.');
    });
  });

  describe('a due task and an early one', () => {
    it('does not offer the early task until the Undo window is over', async () => {
      const store = makeFakePressStore();
      const h = renderDone(store, [task(), early()]);
      await press(h);
      await advance(MESSAGE_MS + 1);
      expect(h.get().task).toBeNull();
      expect(h.get().undo?.text).toBe('Morning pills done.');
      await advance(UNDO_MS - MESSAGE_MS - 1);
      expect(h.get().task?.instanceId).toBe('early1');
      expect(h.get().message).toBeNull();
    });

    it('a press handler captured before the previous press cannot record the early task', async () => {
      const store = makeFakePressStore();
      const h = renderDone(store, [early()]);
      const stale = h.get().pressDone;
      h.rerender([task(), early()]);
      await press(h);
      expect(pressedIds(store)).toEqual(['inst1']);
      await advance(SETTLE_MS + 1);
      await act(async () => {
        stale();
      });
      expect(pressedIds(store)).toEqual(['inst1']);
    });

    it('a press on the early task is refused during the hold, then allowed', async () => {
      const store = makeFakePressStore();
      const h = renderDone(store, [task(), early()]);
      await press(h);
      await advance(SETTLE_MS + 1);
      await press(h);
      expect(pressedIds(store)).toEqual(['inst1']);
      await advance(UNDO_MS);
      await press(h);
      expect(pressedIds(store)).toEqual(['inst1', 'early1']);
    });
  });

  describe('after unmount', () => {
    it('does not announce or arm timers when a press finishes storing', async () => {
      const store = makeFakePressStore();
      const release = store.holdWrites();
      const h = renderDone(store, [task()]);
      await press(h);
      h.unmount();
      announce.mockClear();
      announceQueued.mockClear();
      const timers = jest.getTimerCount();
      await act(async () => release());
      await advance(0);
      expect(announce).not.toHaveBeenCalled();
      expect(announceQueued).not.toHaveBeenCalled();
      expect(jest.getTimerCount()).toBeLessThanOrEqual(timers);
    });

    it('clears the timer that ends the Undo window', async () => {
      const store = makeFakePressStore();
      const h = renderDone(store, [task()]);
      await press(h);
      expect(h.get().undo).not.toBeNull();
      const before = jest.getTimerCount();
      h.unmount();
      expect(jest.getTimerCount()).toBe(before - 1);
    });
  });
});

describe('a Done pressed on the widget or the Lock Screen', () => {
  useHarnessClock();

  it('is offered for Undo on the Today screen for what is left of its 30 seconds', async () => {
    const store = makeFakePressStore();
    const h = renderDone(store, [task(), second()]);
    expect(h.get().task?.instanceId).toBe('inst1');
    jest.setSystemTime(NOW + 12_000);
    act(() => {
      store.pressedElsewhere({ instanceId: 'inst1', step: 0, pressedAt: NOW + 2_000 });
    });
    expect(h.get().task).toBeNull();
    expect(h.get().undo).toEqual({
      label: 'Morning pills',
      text: 'Morning pills done.',
      pressedAt: NOW + 2_000,
    });
    expect(announceQueued).toHaveBeenCalledWith('Morning pills done. Undo', { queue: true });
    await advance(19_999);
    expect(h.get().undo).not.toBeNull();
    await advance(1);
    expect(h.get().undo).toBeNull();
    expect(h.get().task?.instanceId).toBe('inst2');
  });

  it('is taken back by Undo, which names that press', async () => {
    const store = makeFakePressStore();
    const pressed = store.pressedElsewhere({ instanceId: 'inst1', step: 0, pressedAt: NOW });
    jest.setSystemTime(NOW + 5_000);
    const h = renderDone(store, [task()]);
    expect(h.get().undo?.label).toBe('Morning pills');
    await tapUndo(h);
    expect(store.log()).toEqual([{ ...pressed, undo: { undoneAt: NOW + 5_000 } }]);
    expect(h.get().undo).toBeNull();
    expect(h.get().task?.instanceId).toBe('inst1');
    expect(announceQueued).toHaveBeenLastCalledWith('Morning pills is not done.', { queue: true });
  });

  it('shows nothing of a press whose 30 seconds were over before the app opened', async () => {
    const store = makeFakePressStore();
    store.pressedElsewhere({ instanceId: 'inst1', step: 0, pressedAt: NOW - UNDO_MS });
    const h = renderDone(store, [task(), second()]);
    await advance(0);
    expect(h.everyRender().map((r) => r.undo)).toEqual(h.everyRender().map(() => null));
    expect(h.everyRender().map((r) => r.task?.instanceId)).toEqual(
      h.everyRender().map(() => 'inst2'),
    );
    expect(announceQueued).not.toHaveBeenCalled();
  });

  it('a press read late shows no stale Undo, even for one render', async () => {
    const store = makeFakePressStore();
    const h = renderDone(store, [task(), second()]);
    jest.setSystemTime(NOW + 10 * 60_000);
    act(() => {
      store.pressedElsewhere({ instanceId: 'inst1', step: 0, pressedAt: NOW + 60_000 });
    });
    await advance(0);
    expect(h.everyRender().map((r) => r.undo)).toEqual(h.everyRender().map(() => null));
    expect(h.get().task?.instanceId).toBe('inst2');
  });

  it('keeps its offer when the app is opened again inside the 30 seconds', async () => {
    const store = makeFakePressStore();
    const first = renderDone(store, [task()]);
    await press(first);
    first.unmount();
    jest.setSystemTime(NOW + 10_000);
    const again = renderDone(store, [task()]);
    expect(again.get().undo?.pressedAt).toBe(NOW);
    expect(again.get().task).toBeNull();
    await advance(20_000);
    expect(again.get().undo).toBeNull();
  });

  it('offers nothing for a press on a task the day does not list', async () => {
    const store = makeFakePressStore();
    store.pressedElsewhere({ instanceId: 'gone', step: 0, pressedAt: NOW });
    const h = renderDone(store, [task()]);
    expect(h.get().undo).toBeNull();
    expect(h.get().task?.instanceId).toBe('inst1');
  });
});

describe('Undo on the phone', () => {
  useHarnessClock();

  function stepOf(index: number, overrides: Partial<DayTask> = {}): DayTask {
    const steps = ['Put on your coat', 'Lock the door'];
    return task({
      displayLabel: 'Going out',
      checklistItems: steps,
      step: { index, count: steps.length, text: steps[index]! },
      ...overrides,
    });
  }

  it('keeps the time of the press on the offer while time passes', async () => {
    const h = renderDone(makeFakePressStore(), [task()]);
    await press(h);
    await advance(UNDO_MS - 1_000);
    expect(h.get().undo?.pressedAt).toBe(NOW);
  });

  it('withdraws the offer 30 seconds after the press', async () => {
    expect(UNDO_MS).toBe(30_000);
    const h = renderDone(makeFakePressStore(), [task()]);
    await press(h);
    await advance(29_999);
    expect(h.get().undo?.label).toBe('Morning pills');
    await advance(1);
    expect(h.get().undo).toBeNull();
    expect(h.get().message).toBeNull();
  });

  it('a new press replaces the offer; only the latest press has one', async () => {
    const h = renderDone(makeFakePressStore(), [stepOf(0)]);
    await press(h);
    expect(h.get().undo?.label).toBe('Going out, step 1');
    await advance(SETTLE_MS + 1);
    await press(h);
    expect(h.get().undo?.label).toBe('Going out');
  });

  it('shows the next step on the Done key beside the Undo offer of the step before', async () => {
    const h = renderDone(makeFakePressStore(), [stepOf(0)]);
    await press(h);
    expect(h.get().task).toBeNull();
    await advance(SETTLE_MS);
    expect(h.get().task?.step?.index).toBe(1);
    expect(h.get().undo?.label).toBe('Going out, step 1');
  });

  it('holds the next step of a task done early until the message time is over', async () => {
    const h = renderDone(makeFakePressStore(), [stepOf(0, { state: 'upcoming' })]);
    await press(h);
    await advance(SETTLE_MS + 1);
    expect(h.get().task).toBeNull();
    await advance(MESSAGE_MS - SETTLE_MS);
    expect(h.get().task?.step?.index).toBe(1);
  });

  it('withdraws the offer, stores the undo of that press and shows the task open again', async () => {
    const store = makeFakePressStore();
    const h = renderDone(store, [task()]);
    await press(h);
    jest.setSystemTime(NOW + 1000);
    await tapUndo(h);
    expect(h.get().undo).toBeNull();
    expect(h.get().message).toBeNull();
    expect(h.get().task?.instanceId).toBe('inst1');
    expect(store.log()).toEqual([
      {
        pressId: 'press-0000000000000001',
        instanceId: 'inst1',
        step: 0,
        pressedAt: NOW,
        undo: { undoneAt: NOW + 1000 },
      },
    ]);
    expect(announceQueued).toHaveBeenLastCalledWith('Morning pills is not done.', { queue: true });
  });

  it('keeps the hold until the undo is stored, then lifts it', async () => {
    const store = makeFakePressStore();
    const h = renderDone(store, [task(), second()], true);
    await press(h);
    const release = store.holdWrites();
    await tapUndo(h);
    expect(h.get().task).toBeNull();
    expect(h.get().undo).toBeNull();
    await act(async () => release());
    await advance(0);
    expect(h.get().task?.instanceId).toBe('inst1');
  });

  it('holds Noted and the offer again when the undo cannot be stored, until the window is over', async () => {
    const store = makeFakePressStore();
    const h = renderDone(store, [task(), second()], true);
    await press(h);
    await advance(SETTLE_MS + 1);
    expect(h.get().task).toBeNull();
    store.failWrites(true);
    await tapUndo(h);
    await advance(0);
    expect(h.get().undo?.label).toBe('Morning pills');
    expect(h.get().task).toBeNull();
    expect(h.get().message).toBeNull();
    await advance(UNDO_MS - SETTLE_MS - 1);
    expect(h.get().undo).toBeNull();
    expect(h.get().task?.instanceId).toBe('inst2');
    expect(store.log()[0]?.undo).toBeUndefined();
    expect(logger.warning).toHaveBeenCalledWith(
      'DoneAction',
      'Could not store an Undo',
      expect.objectContaining({ instanceId: 'inst1' }),
    );
  });

  it('an undo write that times out and lands later withdraws the offer and lifts the hold', async () => {
    const store = makeFakePressStore();
    const h = renderDone(store, [task(), second()], true);
    await press(h);
    const release = store.holdWrites();
    await tapUndo(h);
    await advance(STORE_TIMEOUT_MS + 1);
    expect(h.get().undo?.label).toBe('Morning pills');
    expect(h.get().task).toBeNull();
    await act(async () => release());
    await advance(0);
    expect(h.get().undo).toBeNull();
    expect(h.get().task?.instanceId).toBe('inst1');
    expect(store.log()[0]?.undo).toEqual({ undoneAt: NOW + STORE_TIMEOUT_MS + 1 });
    expect(announceQueued).toHaveBeenLastCalledWith('Morning pills is not done.', { queue: true });
  });

  it('announces "is not done" exactly once across later day-view re-renders', async () => {
    const store = makeFakePressStore();
    const h = renderDone(store, [task()]);
    await press(h);
    await tapUndo(h);
    await advance(0);
    for (let minute = 0; minute < 3; minute++) {
      h.rerender([task()]);
      await advance(0);
    }
    const notDone = announceQueued.mock.calls.filter(([text]) => text.endsWith('is not done.'));
    expect(notDone).toHaveLength(1);
  });

  it.each([
    ['answered', ['press-display-confirm']],
    ['still unsent', []],
  ])(
    'confirmed by another surface, our press %s: stays done and says nothing',
    async (sent, confirmPressIds) => {
      const display = task({ state: 'confirmed', confirmable: false, confirmPressIds });
      const store = makeFakePressStore();
      const h = renderDone(store, [task()]);
      await press(h);
      if (sent === 'answered') {
        act(() => store.answer('press-0000000000000001', { applied: true, answeredPresses: 0 }));
      }
      h.rerender([display]);
      announceQueued.mockClear();
      await tapUndo(h);
      await advance(0);
      expect(h.shown()[0]).toMatchObject({ state: 'confirmed', confirmable: false });
      expect(announceQueued).not.toHaveBeenCalledWith('Morning pills is not done.', {
        queue: true,
      });
    },
  );

  it('a second tap on Undo stores nothing more', async () => {
    const store = makeFakePressStore();
    const storeUndo = jest.spyOn(store, 'storeUndo');
    const h = renderDone(store, [task()], true);
    await press(h);
    const undo = h.get().pressUndo;
    await act(async () => {
      undo();
      undo();
    });
    expect(storeUndo).toHaveBeenCalledTimes(1);
  });

  it('an Undo tapped after its 30 seconds stores nothing', async () => {
    const store = makeFakePressStore();
    const h = renderDone(store, [task()]);
    await press(h);
    const late = h.get().pressUndo;
    await advance(UNDO_MS);
    await act(async () => {
      late();
    });
    expect(store.log()[0]?.undo).toBeUndefined();
  });

  it('no Undo is offered after a press that was undone', async () => {
    const store = makeFakePressStore();
    const first = renderDone(store, [task()]);
    await press(first);
    await tapUndo(first);
    first.unmount();
    const again = renderDone(store, [task()]);
    expect(again.get().undo).toBeNull();
    expect(again.get().task?.instanceId).toBe('inst1');
  });
});

describe('Done on a multi-step task', () => {
  useHarnessClock();

  const STEPS = ['Put on your coat', 'Take your keys', 'Lock the door'];

  function multi(index: number, overrides: Partial<DayTask> = {}): DayTask {
    return task({
      displayLabel: 'Going out',
      checklistItems: STEPS,
      step: { index, count: STEPS.length, text: STEPS[index]! },
      ...overrides,
    });
  }

  it('offline, each press shows the next step and only the last press shows the task done', async () => {
    const store = makeFakePressStore();
    const h = renderDone(store, [multi(0)], true);
    await press(h);
    expect(h.get().undo).toEqual({
      label: 'Going out, step 1',
      text: 'Going out, step 1 done. It will be sent when the internet is back.',
      pressedAt: NOW,
    });
    expect(h.shown()[0]).toMatchObject({
      state: 'due',
      step: { index: 1, text: 'Take your keys' },
    });
    await advance(SETTLE_MS);
    await press(h);
    expect(h.shown()[0]).toMatchObject({ state: 'due', step: { index: 2, text: 'Lock the door' } });
    await advance(SETTLE_MS);
    await press(h);
    expect(h.get().undo?.text).toBe('Going out done. It will be sent when the internet is back.');
    expect(h.shown()[0]).toMatchObject({ state: 'confirmed', confirmable: false });
    expect(store.log().map((p) => p.step)).toEqual([0, 1, 2]);
  });

  it('Undo of a step press shows the step again and says that step is not done', async () => {
    const store = makeFakePressStore();
    const h = renderDone(store, [multi(0)], true);
    await press(h);
    await tapUndo(h);
    expect(h.shown()[0]).toMatchObject({
      state: 'due',
      step: { index: 0, text: 'Put on your coat' },
    });
    expect(announceQueued).toHaveBeenCalledWith('Going out, step 1 is not done.', {
      queue: true,
    });
  });
});
