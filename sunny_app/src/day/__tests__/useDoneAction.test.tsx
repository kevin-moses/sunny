import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { ConvexError } from 'convex/values';
import { getFunctionName } from 'convex/server';
import React, { useSyncExternalStore } from 'react';
import { AccessibilityInfo } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { convex } from '../../backend/convex';
import { logger } from '../../logging/logger';
import {
  createConfirmQueue,
  sendConfirm,
  STORAGE_KEY,
  type ConfirmQueue,
} from '../pendingConfirms';
import { applyPending, type PendingEntry } from '../pendingEntries';
import type { DayTask } from '../types';
import {
  dayIsCurrent,
  doneTarget,
  MESSAGE_MS,
  NOT_STORED_MESSAGE,
  STORE_TIMEOUT_MS,
  PRESS_GAP_MS,
  SETTLE_MS,
  UNDO_MS,
  useDoneAction,
  type DoneAction,
} from '../useDoneAction';
import { usePendingConfirms } from '../usePendingConfirms';

jest.mock('expo-crypto', () => ({
  randomUUID: () => `press-${String(++mockIdCounter).padStart(16, '0')}`,
}));

let mockIdCounter = 0;

const mockStore = new Map<string, string>();
let mockFailWrites = false;

jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem: async (key: string) => mockStore.get(key) ?? null,
    setItem: async (key: string, value: string) => {
      if (mockWriteGate !== null) await mockWriteGate;
      if (mockFailWrites) throw new Error('disk full');
      mockStore.set(key, value);
    },
    removeItem: async (key: string) => void mockStore.delete(key),
  },
}));

let mockConnected = true;
let mockWriteGate: Promise<void> | null = null;

jest.mock('../../backend/convex', () => ({
  convex: {
    mutation: jest.fn(),
    connectionState: () => ({ isWebSocketConnected: mockConnected, hasEverConnected: true }),
  },
}));

jest.mock('../../logging/logger', () => ({
  logger: { warning: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockMutation = convex.mutation as unknown as jest.Mock<(...a: unknown[]) => Promise<unknown>>;
const mounted: ReactTestRenderer[] = [];
let announce: jest.SpiedFunction<typeof AccessibilityInfo.announceForAccessibility>;
let announceQueued: jest.SpiedFunction<
  typeof AccessibilityInfo.announceForAccessibilityWithOptions
>;
const NOW = Date.parse('2026-11-09T08:00:00Z');

function task(overrides: Partial<DayTask> = {}): DayTask {
  return {
    instanceId: 'inst1',
    displayLabel: 'Morning pills',
    scheduledTime: '08:00',
    step: null,
    state: 'due',
    confirmable: true,
    ...overrides,
  } as unknown as DayTask;
}

const second = (): DayTask =>
  task({ instanceId: 'inst2' as never, displayLabel: 'Evening pills', scheduledTime: '09:00' });

function makeQueue(): ConfirmQueue {
  return createConfirmQueue({ send: sendConfirm, now: () => Date.now() });
}

function renderDone(
  queue: ConfirmQueue,
  target: DayTask | null,
  isOffline = false,
  server?: DayTask[],
): {
  get: () => DoneAction;
  rerender: (target: DayTask | null, isOffline?: boolean, server?: DayTask[]) => void;
  unmount: () => void;
} {
  let latest: DoneAction | undefined;
  const record = (value: DoneAction): void => {
    latest = value;
  };
  const Probe = ({ t, off, day }: { t: DayTask | null; off: boolean; day?: DayTask[] }): null => {
    const entries = useSyncExternalStore(queue.subscribe, queue.getEntries);
    const shown = applyPending(day ?? (t === null ? [] : [t]), entries);
    record(useDoneAction(t, off, queue, shown));
    return null;
  };
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(<Probe t={target} off={isOffline} day={server} />);
    mounted.push(renderer);
  });
  return {
    get: () => latest as DoneAction,
    rerender: (t, off = false, day = server) =>
      act(() => renderer.update(<Probe t={t} off={off} day={day} />)),
    unmount: () => act(() => renderer.unmount()),
  };
}

async function press(h: { get: () => DoneAction }): Promise<void> {
  await act(async () => {
    h.get().pressDone();
  });
}

async function advance(ms: number): Promise<void> {
  await act(async () => {
    await jest.advanceTimersByTimeAsync(ms);
  });
}

function sentIds(): string[] {
  return mockMutation.mock.calls.map((c) => (c[1] as { instanceId: string }).instanceId);
}

describe('doneTarget', () => {
  it('picks the first due task', () => {
    const first = task({ instanceId: 'a' as never });
    const done = task({ instanceId: 'x' as never, state: 'confirmed', confirmable: false });
    expect(doneTarget([done, first, task({ instanceId: 'b' as never })])).toBe(first);
  });

  it('picks an escalated task', () => {
    const late = task({ state: 'escalated' });
    expect(doneTarget([late])).toBe(late);
  });

  it('prefers a due task over an earlier-listed confirmable upcoming one', () => {
    const early = task({ instanceId: 'e' as never, state: 'upcoming' });
    const due = task({ instanceId: 'd' as never });
    expect(doneTarget([early, due])).toBe(due);
  });

  it('otherwise picks the first confirmable upcoming task', () => {
    const tooEarly = task({ instanceId: 't' as never, state: 'upcoming', confirmable: false });
    const early = task({ instanceId: 'e' as never, state: 'upcoming' });
    expect(
      doneTarget([tooEarly, early, task({ instanceId: 'f' as never, state: 'upcoming' })]),
    ).toBe(early);
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
    const early = task({ instanceId: 'e' as never, state: 'upcoming' });
    expect(doneTarget([early], false)).toBeNull();
    expect(doneTarget([early])).toBe(early);
    const due = task({ instanceId: 'd' as never });
    expect(doneTarget([early, due], false)).toBe(due);
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
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(NOW);
    mockStore.clear();
    mockFailWrites = false;
    mockWriteGate = null;
    mockWriteGate = null;
    mockMutation.mockReset();
    mockConnected = true;
    mockMutation.mockResolvedValue({ status: 'confirmed' });
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

  it('stores the press, shows and announces one Undo line, and sends it with its time and id', async () => {
    const h = renderDone(makeQueue(), task());
    await press(h);
    expect(h.get().message).toBeNull();
    expect(h.get().undo).toEqual({
      label: 'Morning pills',
      text: 'Morning pills done.',
      pressedAt: NOW,
    });
    expect(announce).not.toHaveBeenCalled();
    expect(announceQueued).toHaveBeenCalledWith('Morning pills done. Undo', { queue: true });
    expect(mockMutation).toHaveBeenCalledTimes(1);
    expect(mockMutation.mock.calls[0][1]).toEqual({
      instanceId: 'inst1',
      via: 'phone_app',
      pressedAgoMs: 0,
      pressId: expect.stringMatching(/^press-\d{16}$/),
      step: 0,
    });
    expect(JSON.parse(mockStore.get(STORAGE_KEY) ?? '[]')).toEqual([]);
  });

  it('stores the press before showing success', async () => {
    mockMutation.mockReturnValue(new Promise(() => {}));
    const h = renderDone(makeQueue(), task());
    await press(h);
    expect(JSON.parse(mockStore.get(STORAGE_KEY) ?? '[]')).toHaveLength(1);
    expect(h.get().undo?.text).toBe('Morning pills done.');
  });

  it('offline: stores without sending, says it will be sent, and sends after reconnect', async () => {
    const queue = makeQueue();
    const h = renderDone(queue, task(), true);
    await press(h);
    expect(mockMutation).not.toHaveBeenCalled();
    expect(h.get().message).toBeNull();
    expect(h.get().undo?.text).toBe(
      'Morning pills done. It will be sent when the internet is back.',
    );
    expect(announceQueued).toHaveBeenCalledWith(
      'Morning pills done. It will be sent when the internet is back. Undo',
      { queue: true },
    );
    await act(async () => {
      await queue.replay();
    });
    expect(sentIds()).toEqual(['inst1']);
    expect((mockMutation.mock.calls[0][1] as { pressedAgoMs: number }).pressedAgoMs).toBe(0);
  });

  it('offline press survives an app restart and is sent with the age of the press', async () => {
    const h = renderDone(makeQueue(), task(), true);
    await press(h);
    h.unmount();
    jest.setSystemTime(NOW + 3 * 3_600_000);
    const restarted = makeQueue();
    await act(async () => {
      await restarted.replay();
    });
    expect(sentIds()).toEqual(['inst1']);
    expect((mockMutation.mock.calls[0][1] as { pressedAgoMs: number }).pressedAgoMs).toBe(
      3 * 3_600_000,
    );
  });

  it('a network failure keeps the press and the senior still sees it done', async () => {
    mockMutation.mockRejectedValue(new Error('Network request failed'));
    const h = renderDone(makeQueue(), task());
    await press(h);
    expect(h.get().undo?.text).toBe('Morning pills done.');
    expect(JSON.parse(mockStore.get(STORAGE_KEY) ?? '[]')).toHaveLength(1);
  });

  it('sends nothing without a target', async () => {
    const h = renderDone(makeQueue(), null);
    await press(h);
    expect(mockMutation).not.toHaveBeenCalled();
    expect(h.get().message).toBeNull();
  });

  it('ignores a second press within the gap', async () => {
    const h = renderDone(makeQueue(), task());
    mockMutation.mockRejectedValue(new Error('Network request failed'));
    await press(h);
    h.rerender(task());
    await advance(PRESS_GAP_MS - 100);
    await press(h);
    expect(mockMutation).toHaveBeenCalledTimes(1);
  });

  it('says so and keeps the task offered when the press cannot be stored', async () => {
    mockFailWrites = true;
    const h = renderDone(makeQueue(), task());
    await press(h);
    expect(h.get().message).toBe(NOT_STORED_MESSAGE);
    expect(h.get().task).not.toBeNull();
    expect(mockMutation).not.toHaveBeenCalled();
  });

  it('clears the press-again line after MESSAGE_MS', async () => {
    mockFailWrites = true;
    const h = renderDone(makeQueue(), task());
    await press(h);
    expect(h.get().message).toBe(NOT_STORED_MESSAGE);
    await advance(MESSAGE_MS + 1);
    expect(h.get().message).toBeNull();
  });

  it('shows the senior nothing alarming when the server permanently refuses a queued press', async () => {
    mockMutation.mockRejectedValue(new ConvexError({ code: 'not_found', message: 'gone' }));
    const h = renderDone(makeQueue(), task());
    await press(h);
    await advance(SETTLE_MS + 1);
    expect(h.get().message).toBeNull();
    expect(h.get().undo?.text).toBe('Morning pills done.');
    expect(announce).not.toHaveBeenCalled();
    expect(announceQueued).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith(
      'PendingConfirms',
      'Dropped a queued Done (rejected)',
      expect.objectContaining({ instanceId: 'inst1' }),
    );
  });

  it('asks the senior to press again when storing hangs, and allows the next press', async () => {
    const queue = makeQueue();
    const hung: ConfirmQueue = { ...queue, enqueue: () => new Promise(() => {}) };
    const h = renderDone(hung, task());
    await press(h);
    expect(h.get().message).toBeNull();
    await advance(STORE_TIMEOUT_MS + 1);
    expect(h.get().message).toBe(NOT_STORED_MESSAGE);
    expect(h.get().task).not.toBeNull();
    await advance(PRESS_GAP_MS);
    await press(h);
    await advance(STORE_TIMEOUT_MS + 1);
    expect(h.get().message).toBe(NOT_STORED_MESSAGE);
  });

  describe('two tasks due', () => {
    it('withdraws the button after a press and refuses a doubting second press', async () => {
      const h = renderDone(makeQueue(), task());
      await press(h);
      h.rerender(second());
      expect(h.get().task).toBeNull();
      expect(h.get().undo?.text).toBe('Morning pills done.');
      await advance(1000);
      await press(h);
      expect(sentIds()).toEqual(['inst1']);
    });

    it('offers the next task after the settle period; its press replaces the Undo line', async () => {
      const h = renderDone(makeQueue(), task());
      await press(h);
      h.rerender(second());
      await advance(SETTLE_MS + 1);
      expect(h.get().task?.instanceId).toBe('inst2');
      expect(h.get().message).toBeNull();
      await press(h);
      expect(sentIds()).toEqual(['inst1', 'inst2']);
      expect(h.get().undo?.text).toBe('Evening pills done.');
    });
  });

  describe('a due task and an early one', () => {
    const early = (): DayTask =>
      task({
        instanceId: 'early1' as never,
        displayLabel: 'Evening pills',
        scheduledTime: '09:00',
        state: 'upcoming',
      });

    it('does not offer the early task until MESSAGE_MS after the press', async () => {
      const h = renderDone(makeQueue(), task());
      await press(h);
      h.rerender(early());
      await advance(SETTLE_MS + 1);
      expect(h.get().task).toBeNull();
      expect(h.get().undo?.text).toBe('Morning pills done.');
      await advance(MESSAGE_MS - SETTLE_MS);
      expect(h.get().task?.instanceId).toBe('early1');
      expect(h.get().message).toBeNull();
    });

    it('a press handler captured before the previous press cannot record the early task', async () => {
      const h = renderDone(makeQueue(), early());
      const stale = h.get().pressDone;
      h.rerender(task());
      await press(h);
      expect(sentIds()).toEqual(['inst1']);
      await advance(SETTLE_MS + 1);
      await act(async () => {
        stale();
      });
      expect(sentIds()).toEqual(['inst1']);
    });

    it('still offers a due task after the normal settle period', async () => {
      const h = renderDone(makeQueue(), task());
      await press(h);
      h.rerender(second());
      await advance(SETTLE_MS + 1);
      expect(h.get().task?.instanceId).toBe('inst2');
    });

    it('a press on the early task is refused during the block, then allowed', async () => {
      const h = renderDone(makeQueue(), task());
      await press(h);
      h.rerender(early());
      await advance(SETTLE_MS + 1);
      await press(h);
      expect(sentIds()).toEqual(['inst1']);
      await advance(MESSAGE_MS);
      await press(h);
      expect(sentIds()).toEqual(['inst1', 'early1']);
    });
  });

  describe('when storing hangs', () => {
    function gatedQueue(): { queue: ConfirmQueue; release: () => void } {
      let release!: () => void;
      mockWriteGate = new Promise<void>((resolve) => (release = resolve));
      return { queue: makeQueue(), release };
    }

    it('does not read checked, keeps the same task offered, and shows the press-again line', async () => {
      const { queue } = gatedQueue();
      const h = renderDone(queue, task());
      await press(h);
      await advance(STORE_TIMEOUT_MS + 1);
      expect(queue.getEntries()).toEqual([]);
      expect(h.get().task?.instanceId).toBe('inst1');
      expect(h.get().message).toBe(NOT_STORED_MESSAGE);
    });

    it('a late successful write replaces the press-again line with the Undo line and settles', async () => {
      const { queue, release } = gatedQueue();
      const h = renderDone(queue, task());
      await press(h);
      await advance(STORE_TIMEOUT_MS + 1);
      mockWriteGate = null;
      await act(async () => release());
      await advance(0);
      expect(sentIds()).toEqual(['inst1']);
      expect(h.get().message).toBeNull();
      expect(h.get().undo?.text).toBe('Morning pills done.');
      expect(h.get().task).toBeNull();
      await advance(SETTLE_MS + 1);
      h.rerender(second());
      expect(h.get().task?.instanceId).toBe('inst2');
    });
  });

  describe('after unmount', () => {
    it('does not announce or schedule timers when a press finishes storing', async () => {
      const queue = makeQueue();
      let release!: () => void;
      const realEnqueue = queue.enqueue;
      const gated: ConfirmQueue = {
        ...queue,
        enqueue: async (e) => {
          await new Promise<void>((resolve) => (release = resolve));
          return await realEnqueue(e);
        },
      };
      const h = renderDone(gated, task());
      await press(h);
      h.unmount();
      announce.mockClear();
      announceQueued.mockClear();
      const timers = jest.getTimerCount();
      await act(async () => release());
      await advance(0);
      expect(announce).not.toHaveBeenCalled();
      expect(announceQueued).not.toHaveBeenCalled();
      expect(jest.getTimerCount()).toBeLessThanOrEqual(timers + 1);
    });

    it('clears every timer it armed, the Undo offer timer included', async () => {
      const h = renderDone(makeQueue(), task());
      await press(h);
      expect(h.get().undo).not.toBeNull();
      const before = jest.getTimerCount();
      h.unmount();
      expect(jest.getTimerCount()).toBe(before - 2);
    });
  });
});

describe('Undo on the phone', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(NOW);
    mockStore.clear();
    mockFailWrites = false;
    mockWriteGate = null;
    mockConnected = true;
    mockMutation.mockReset();
    mockMutation.mockImplementation(async (ref) => serverAnswer(ref));
    (logger.error as jest.Mock).mockClear();
    (logger.info as jest.Mock).mockClear();
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

  function serverAnswer(ref: unknown): { status: string } {
    return getFunctionName(ref as never) === 'instances:undoPressedTask'
      ? { status: 'undone' }
      : { status: 'confirmed' };
  }

  function calls(): [string, unknown][] {
    return mockMutation.mock.calls.map((c) => [getFunctionName(c[0] as never), c[1]]);
  }

  function pressId(n: number): string {
    return `press-${String(firstId + n).padStart(16, '0')}`;
  }

  let firstId = 0;
  beforeEach(() => {
    firstId = mockIdCounter;
  });

  async function tapUndo(h: { get: () => DoneAction }): Promise<void> {
    await act(async () => {
      h.get().pressUndo();
    });
  }

  it('offers Undo for the pressed task as the one line and announces it, queued', async () => {
    const h = renderDone(makeQueue(), task());
    await press(h);
    expect(h.get().undo).toEqual({
      label: 'Morning pills',
      text: 'Morning pills done.',
      pressedAt: NOW,
    });
    expect(h.get().message).toBeNull();
    expect(announceQueued).toHaveBeenCalledWith('Morning pills done. Undo', { queue: true });
  });

  it('keeps the time of the press on the offer while time passes', async () => {
    const h = renderDone(makeQueue(), task());
    await press(h);
    await advance(UNDO_MS - 1_000);
    expect(h.get().undo?.pressedAt).toBe(NOW);
  });

  it('withdraws the offer 30 seconds after the press', async () => {
    expect(UNDO_MS).toBe(30_000);
    const h = renderDone(makeQueue(), task());
    await press(h);
    await advance(29_999);
    expect(h.get().undo?.label).toBe('Morning pills');
    await advance(1);
    expect(h.get().undo).toBeNull();
    expect(h.get().message).toBeNull();
  });

  it('counts the 30 seconds from the press, not from when the press was stored', async () => {
    let release!: () => void;
    mockWriteGate = new Promise<void>((resolve) => (release = resolve));
    const h = renderDone(makeQueue(), task());
    await press(h);
    await advance(10_000);
    mockWriteGate = null;
    await act(async () => release());
    await advance(0);
    expect(h.get().undo?.label).toBe('Morning pills');
    await advance(20_000);
    expect(h.get().undo).toBeNull();
  });

  it('a new press replaces the offer; only the latest press has one', async () => {
    const h = renderDone(makeQueue(), task());
    await press(h);
    h.rerender(second());
    await advance(SETTLE_MS + 1);
    await press(h);
    expect(h.get().undo?.label).toBe('Evening pills');
  });

  it('does not hide the Done button of another due task', async () => {
    const h = renderDone(makeQueue(), task());
    await press(h);
    h.rerender(second());
    await advance(SETTLE_MS + 1);
    expect(h.get().task?.instanceId).toBe('inst2');
    expect(h.get().undo?.label).toBe('Morning pills');
  });

  it('online: withdraws the offer, sends the undo after the press with the tap age and the id', async () => {
    const queue = makeQueue();
    const h = renderDone(queue, task());
    await press(h);
    jest.setSystemTime(NOW + 1000);
    await tapUndo(h);
    expect(h.get().undo).toBeNull();
    expect(h.get().message).toBeNull();
    expect(h.get().task?.instanceId).toBe('inst1');
    await advance(0);
    expect(calls()).toEqual([
      [
        'instances:confirmPressedTask',
        { instanceId: 'inst1', via: 'phone_app', pressedAgoMs: 0, pressId: pressId(1), step: 0 },
      ],
      ['instances:undoPressedTask', { instanceId: 'inst1', undoneAgoMs: 0, pressId: pressId(1) }],
    ]);
    expect(queue.getEntries()).toEqual([]);
    expect(announceQueued).toHaveBeenLastCalledWith('Morning pills is not done.', { queue: true });
  });

  it('keeps the settle block until the undo is stored, then lifts it', async () => {
    const queue = makeQueue();
    const h = renderDone(queue, task(), true);
    await press(h);
    h.rerender(second(), true);
    let release!: () => void;
    mockWriteGate = new Promise<void>((resolve) => (release = resolve));
    await tapUndo(h);
    expect(h.get().task).toBeNull();
    mockWriteGate = null;
    await act(async () => release());
    await advance(0);
    expect(h.get().task?.instanceId).toBe('inst2');
  });

  it('re-enters the settle block when the undo cannot be stored, beside the offer again', async () => {
    const queue = makeQueue();
    const h = renderDone(queue, task(), true);
    await press(h);
    h.rerender(second(), true);
    await advance(SETTLE_MS + 1);
    expect(h.get().task?.instanceId).toBe('inst2');
    mockFailWrites = true;
    await tapUndo(h);
    await advance(0);
    expect(h.get().undo?.label).toBe('Morning pills');
    expect(h.get().task).toBeNull();
    expect(h.get().message).toBeNull();
    expect(queue.getEntries()).toHaveLength(1);
    expect(logger.warning).toHaveBeenCalledWith(
      'DoneAction',
      'Could not store an Undo',
      expect.objectContaining({ instanceId: 'inst1' }),
    );
  });

  it('an undo write that times out and lands later withdraws the offer and lifts the block', async () => {
    const queue = makeQueue();
    const h = renderDone(queue, task(), true);
    await press(h);
    h.rerender(second(), true, [task(), second()]);
    let release!: () => void;
    mockWriteGate = new Promise<void>((resolve) => (release = resolve));
    await tapUndo(h);
    await advance(STORE_TIMEOUT_MS + 1);
    expect(h.get().undo?.label).toBe('Morning pills');
    expect(h.get().task).toBeNull();
    mockWriteGate = null;
    await act(async () => release());
    await advance(0);
    expect(h.get().undo).toBeNull();
    expect(h.get().task?.instanceId).toBe('inst2');
    expect(queue.getEntries().map((e) => e.kind ?? 'press')).toEqual(['press', 'undo']);
    expect(announceQueued).toHaveBeenLastCalledWith('Morning pills is not done.', { queue: true });
  });

  it('shows the task open again and offers Done while the server still has its own confirm', async () => {
    const queue = makeQueue();
    const h = renderDone(queue, task());
    await press(h);
    mockConnected = false;
    await tapUndo(h);
    const server = [
      task({ state: 'confirmed', confirmable: false, confirmPressIds: [pressId(1)] }),
    ];
    const shown = applyPending(server, queue.getEntries());
    expect(shown[0]).toMatchObject({ state: 'due', confirmable: true });
    expect(doneTarget(shown)?.instanceId).toBe('inst1');
  });

  it('announces "is not done" only when the screen shows the task open after the undo', async () => {
    const own = task({ state: 'confirmed', confirmable: false, confirmPressIds: [pressId(1)] });
    const queue = makeQueue();
    const h = renderDone(queue, task());
    await press(h);
    mockConnected = false;
    h.rerender(task(), false, [own]);
    await tapUndo(h);
    await advance(0);
    expect(announceQueued).toHaveBeenLastCalledWith('Morning pills is not done.', { queue: true });
  });

  it('announces "is not done" exactly once across later day-view re-renders', async () => {
    const own = (): DayTask =>
      task({ state: 'confirmed', confirmable: false, confirmPressIds: [pressId(1)] });
    const queue = makeQueue();
    const h = renderDone(queue, task());
    await press(h);
    mockConnected = false;
    h.rerender(task(), false, [own()]);
    await tapUndo(h);
    await advance(0);
    for (let minute = 0; minute < 3; minute++) {
      h.rerender(task(), false, [own()]);
      await advance(0);
    }
    const notDone = announceQueued.mock.calls.filter(([text]) => text.endsWith('is not done.'));
    expect(notDone).toHaveLength(1);
  });

  it('confirmed by another surface (its id not ours): stays done and says nothing', async () => {
    const display = task({
      state: 'confirmed',
      confirmable: false,
      confirmPressIds: ['press-display-confirm'],
    });
    const queue = makeQueue();
    const h = renderDone(queue, task());
    await press(h);
    mockConnected = false;
    h.rerender(task(), false, [display]);
    announceQueued.mockClear();
    await tapUndo(h);
    await advance(0);
    const shown = applyPending([display], queue.getEntries());
    expect(shown[0]).toMatchObject({ state: 'confirmed', confirmable: false });
    expect(announceQueued).not.toHaveBeenCalledWith('Morning pills is not done.', {
      queue: true,
    });
  });

  it('offline: press then Undo are both stored and sent in order with their ages and id', async () => {
    const queue = makeQueue();
    const h = renderDone(queue, task(), true);
    await press(h);
    jest.setSystemTime(NOW + 10_000);
    await tapUndo(h);
    expect(mockMutation).not.toHaveBeenCalled();
    expect(queue.getEntries().map((e) => e.kind ?? 'press')).toEqual(['press', 'undo']);
    jest.setSystemTime(NOW + 600_000);
    await act(async () => {
      await queue.replay();
    });
    expect(calls()).toEqual([
      [
        'instances:confirmPressedTask',
        {
          instanceId: 'inst1',
          via: 'phone_app',
          pressedAgoMs: 600_000,
          pressId: pressId(1),
          step: 0,
        },
      ],
      [
        'instances:undoPressedTask',
        { instanceId: 'inst1', undoneAgoMs: 590_000, pressId: pressId(1) },
      ],
    ]);
  });

  it('offline: press, Undo, press again are sent in that order, each press with its own id', async () => {
    const queue = makeQueue();
    const h = renderDone(queue, task(), true);
    await press(h);
    jest.setSystemTime(NOW + 10_000);
    await tapUndo(h);
    jest.setSystemTime(NOW + 20_000);
    await press(h);
    expect(h.get().undo?.label).toBe('Morning pills');
    jest.setSystemTime(NOW + 900_000);
    await act(async () => {
      await queue.replay();
    });
    expect(calls()).toEqual([
      [
        'instances:confirmPressedTask',
        {
          instanceId: 'inst1',
          via: 'phone_app',
          pressedAgoMs: 900_000,
          pressId: pressId(1),
          step: 0,
        },
      ],
      [
        'instances:undoPressedTask',
        { instanceId: 'inst1', undoneAgoMs: 890_000, pressId: pressId(1) },
      ],
      [
        'instances:confirmPressedTask',
        {
          instanceId: 'inst1',
          via: 'phone_app',
          pressedAgoMs: 880_000,
          pressId: pressId(2),
          step: 0,
        },
      ],
    ]);
  });

  it('too_late: drops the undo, logs it, and says nothing to the senior', async () => {
    mockMutation.mockImplementation(async (ref) =>
      getFunctionName(ref as never) === 'instances:undoPressedTask'
        ? { status: 'too_late' }
        : { status: 'confirmed' },
    );
    const queue = makeQueue();
    const h = renderDone(queue, task());
    await press(h);
    await tapUndo(h);
    await advance(0);
    expect(queue.getEntries()).toEqual([]);
    expect(h.get().message).toBeNull();
    expect(logger.info).toHaveBeenCalledWith(
      'PendingConfirms',
      'An Undo came too late; the task stays done',
      expect.objectContaining({ instanceId: 'inst1', kind: 'undo' }),
    );
  });

  it.each([
    ['forbidden', { code: 'forbidden', message: 'no' }],
    ['invalid', { code: 'invalid', message: 'bad age' }],
    ['not found', { code: 'not_found', message: 'gone' }],
  ])(
    'an undo that fails for good (%s) is dropped and logged, with no message',
    async (_n, data) => {
      mockMutation.mockImplementation(async (ref) => {
        if (getFunctionName(ref as never) === 'instances:undoPressedTask') {
          throw new ConvexError(data);
        }
        return { status: 'confirmed' };
      });
      const queue = makeQueue();
      const h = renderDone(queue, task());
      await press(h);
      await tapUndo(h);
      await advance(0);
      expect(queue.getEntries()).toEqual([]);
      expect(h.get().message).toBeNull();
      expect(logger.error).toHaveBeenCalledWith(
        'PendingConfirms',
        'Dropped a queued Undo (rejected)',
        expect.objectContaining({ instanceId: 'inst1', kind: 'undo', undoneAt: NOW }),
      );
    },
  );

  it('a network failure keeps the undo queued and retries it', async () => {
    const queue = makeQueue();
    const h = renderDone(queue, task());
    await press(h);
    mockMutation.mockRejectedValueOnce(new Error('Network request failed'));
    await tapUndo(h);
    await advance(0);
    expect(queue.getEntries()).toHaveLength(1);
    expect(queue.getEntries()[0]).toMatchObject({ kind: 'undo' });
    await advance(30_000);
    expect(queue.getEntries()).toEqual([]);
    expect(calls().map(([name]) => name)).toEqual([
      'instances:confirmPressedTask',
      'instances:undoPressedTask',
      'instances:undoPressedTask',
    ]);
  });

  it('a queued Undo survives a restart and is sent then with its id; no Undo is offered after it', async () => {
    const h = renderDone(makeQueue(), task(), true);
    await press(h);
    jest.setSystemTime(NOW + 3000);
    await tapUndo(h);
    h.unmount();
    jest.setSystemTime(NOW + 60_000);
    const restarted = makeQueue();
    const after = renderDone(restarted, task());
    expect(after.get().undo).toBeNull();
    await act(async () => {
      await restarted.replay();
    });
    expect(calls()).toEqual([
      [
        'instances:confirmPressedTask',
        {
          instanceId: 'inst1',
          via: 'phone_app',
          pressedAgoMs: 60_000,
          pressId: pressId(1),
          step: 0,
        },
      ],
      [
        'instances:undoPressedTask',
        { instanceId: 'inst1', undoneAgoMs: 57_000, pressId: pressId(1) },
      ],
    ]);
  });

  it('a press stored late, then pressed again: the offer names the press actually queued', async () => {
    let release!: () => void;
    mockWriteGate = new Promise<void>((resolve) => (release = resolve));
    const queue = makeQueue();
    const h = renderDone(queue, task(), true);
    await press(h);
    await advance(STORE_TIMEOUT_MS + 1);
    expect(h.get().message).toBe(NOT_STORED_MESSAGE);
    await press(h);
    mockWriteGate = null;
    await act(async () => release());
    await advance(0);
    expect(queue.getEntries()).toHaveLength(1);
    await tapUndo(h);
    await act(async () => {
      await queue.replay();
    });
    const sent = calls().map(([, args]) => (args as { pressId?: string }).pressId);
    expect(sent).toEqual([pressId(1), pressId(1)]);
  });

  it('shows the offline note only while offline and while the press is still queued', async () => {
    const queue = makeQueue();
    const h = renderDone(queue, task(), true);
    await press(h);
    expect(h.get().undo?.text).toBe(
      'Morning pills done. It will be sent when the internet is back.',
    );
    await act(async () => {
      await queue.replay();
    });
    expect(queue.getEntries()).toEqual([]);
    expect(h.get().undo?.text).toBe('Morning pills done.');
  });

  it('shows no offline note online, even while the press is still queued', async () => {
    mockMutation.mockReturnValue(new Promise(() => {}));
    const queue = makeQueue();
    const h = renderDone(queue, task());
    await press(h);
    expect(queue.getEntries()).toHaveLength(1);
    expect(h.get().undo?.text).toBe('Morning pills done.');
  });

  it('a second tap on Undo queues nothing more', async () => {
    const queue = makeQueue();
    const h = renderDone(queue, task(), true);
    await press(h);
    const undo = h.get().pressUndo;
    await act(async () => {
      undo();
      undo();
    });
    expect(queue.getEntries()).toHaveLength(2);
  });
});

describe('usePendingConfirms', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(NOW);
    mockStore.clear();
    mockFailWrites = false;
    mockWriteGate = null;
    mockMutation.mockReset();
    mockConnected = true;
    mockMutation.mockResolvedValue({ status: 'confirmed' });
  });

  afterEach(() => {
    act(() => {
      mounted.splice(0).forEach((renderer) => renderer.unmount());
    });
    jest.useRealTimers();
  });

  function renderPending(queue: ConfirmQueue) {
    let latest: readonly PendingEntry[] = [];
    const record = (value: readonly PendingEntry[]): void => {
      latest = value;
    };
    const Probe = (): null => {
      record(usePendingConfirms(queue));
      return null;
    };
    act(() => {
      mounted.push(create(<Probe />));
    });
    return { get: () => latest };
  }

  it('shows ids stored before the app was closed and replays them at launch', async () => {
    await makeQueue().enqueue({
      instanceId: 'inst1' as never,
      label: 'Pills',
      pressedAt: NOW,
      pressId: 'pid-0000000000000001',
    });
    mockMutation.mockReturnValue(new Promise(() => {}));
    const h = renderPending(makeQueue());
    await advance(0);
    expect(h.get().map((e) => e.instanceId)).toEqual(['inst1']);
    expect(sentIds()).toEqual(['inst1']);
  });
});

describe('Done on a multi-step task', () => {
  const STEPS = ['Put on your coat', 'Take your keys', 'Lock the door'];

  function multi(index: number, overrides: Partial<DayTask> = {}): DayTask {
    return task({
      displayLabel: 'Going out',
      checklistItems: STEPS,
      step: { index, count: STEPS.length, text: STEPS[index]! },
      ...overrides,
    });
  }

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(NOW);
    mockStore.clear();
    mockFailWrites = false;
    mockWriteGate = null;
    mockConnected = false;
    mockMutation.mockReset();
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

  it('offline, each press shows the next step and only the last press shows the task done', async () => {
    const queue = makeQueue();
    const h = renderDone(queue, multi(0), true);
    await press(h);
    expect(h.get().undo).toEqual({
      label: 'Going out, step 1',
      text: 'Going out, step 1 done. It will be sent when the internet is back.',
      pressedAt: NOW,
    });
    let shown = applyPending([multi(0)], queue.getEntries());
    expect(shown[0]).toMatchObject({ state: 'due', step: { index: 1, text: 'Take your keys' } });
    await advance(SETTLE_MS);
    h.rerender(shown[0]!, true, [multi(0)]);
    await press(h);
    shown = applyPending([multi(0)], queue.getEntries());
    expect(shown[0]).toMatchObject({ state: 'due', step: { index: 2, text: 'Lock the door' } });
    await advance(SETTLE_MS);
    h.rerender(shown[0]!, true, [multi(0)]);
    await press(h);
    expect(h.get().undo?.text).toBe('Going out done. It will be sent when the internet is back.');
    shown = applyPending([multi(0)], queue.getEntries());
    expect(shown[0]).toMatchObject({ state: 'confirmed', confirmable: false });
    expect(queue.getEntries().map((e) => (e.kind === 'undo' ? null : e.step))).toEqual([0, 1, 2]);
    expect(mockMutation).not.toHaveBeenCalled();
  });

  it('Undo of a step press shows the step again and says that step is not done', async () => {
    const queue = makeQueue();
    const h = renderDone(queue, multi(0), true);
    await press(h);
    await act(async () => {
      h.get().pressUndo();
    });
    const shown = applyPending([multi(0)], queue.getEntries());
    expect(shown[0]).toMatchObject({ state: 'due', step: { index: 0, text: 'Put on your coat' } });
    expect(announceQueued).toHaveBeenCalledWith('Going out, step 1 is not done.', {
      queue: true,
    });
  });
});
