// sunny_app/src/day/__tests__/useDoneAction.test.tsx
//
// Purpose: Tests for the phone's Done button. doneTarget (pure): due or escalated wins over an
// earlier-listed upcoming task, otherwise the first upcoming task that is confirmable, never an
// unconfirmable, missed or anytime task. The real useDoneAction hook over a real queue and the
// real callMutation / toBackendError, with only convex.mutation (the network) and AsyncStorage
// (in memory) stubbed: a press is stored before "Checked off" shows and is sent with via
// phone_app and the press time; offline it is stored, not sent, and sent after the connection
// returns or the app restarts; a network failure keeps the press while the senior still sees
// "Checked off"; presses inside the gap and while being stored are ignored; the button is
// withdrawn for the settle period (two tasks due: a doubting second press sends nothing, then
// the next task is offered and its line is not shown under another task's button); a storage
// failure says so and keeps the task offered; a permanent rejection shows a calm line;
// announcements; nothing happens after unmount. Undo on the phone: offered and announced after
// a press, gone 30 s after the press itself (also when the press was stored late), replaced by
// a newer press, never hiding another task's Done; tapping it takes effect at once and the undo
// is sent after the press with the tap's age, online, offline, and as press, Undo, press again;
// too_late and permanent failures drop it with a log and no message; a network failure retries;
// a queued Undo survives a restart (with no offer after it); a double tap queues one; an Undo
// that cannot be stored is offered again. usePendingConfirms: the latest entry per task follows
// the queue, load at mount, replay at mount. DoneCard: label, due time for an early task,
// exactly one button with its label, onPress, message only, nothing, the Undo line under
// another task's Done with its label, and its large secondary look.
//
// Last modified: 2026-11-14

import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { ConvexError } from 'convex/values';
import { getFunctionName } from 'convex/server';
import React from 'react';
import { AccessibilityInfo, StyleSheet, type StyleProp, type ViewStyle } from 'react-native';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

import { convex } from '../../backend/convex';
import { logger } from '../../logging/logger';
import { DoneCard, type UndoOffer } from '../../components/DayComponents';
import { colors } from '../../theme/colors';
import {
  applyPending,
  createConfirmQueue,
  latestByInstance,
  sendConfirm,
  STORAGE_KEY,
  type ConfirmQueue,
  type PendingEntry,
} from '../pendingConfirms';
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

jest.mock('expo-symbols', () => ({ SymbolView: () => null }));

jest.mock('../../theme/ThemeProvider', () => ({ useTheme: () => ({ accentColor: '#FA8539' }) }));

const mockMutation = convex.mutation as unknown as jest.Mock<(...a: unknown[]) => Promise<unknown>>;
const mounted: ReactTestRenderer[] = [];
let announce: jest.SpiedFunction<typeof AccessibilityInfo.announceForAccessibility>;
const NOW = Date.parse('2026-11-09T08:00:00Z');

/**
 * purpose: Build a task fixture.
 * @param overrides: (Partial<DayTask>) Fields to change.
 * @return: (DayTask) The task.
 */
function task(overrides: Partial<DayTask> = {}): DayTask {
  return {
    instanceId: 'inst1',
    displayLabel: 'Morning pills',
    scheduledTime: '08:00',
    state: 'due',
    confirmable: true,
    ...overrides,
  } as unknown as DayTask;
}

/** A second due task. */
const second = (): DayTask =>
  task({ instanceId: 'inst2' as never, displayLabel: 'Evening pills', scheduledTime: '09:00' });

/**
 * purpose: A queue over the real send and the in-memory storage.
 * @return: (ConfirmQueue) The queue.
 */
function makeQueue(): ConfirmQueue {
  return createConfirmQueue({ send: sendConfirm, now: () => Date.now() });
}

/**
 * purpose: Render the real hook and expose its latest return value; the target and offline
 *          flag can be changed with rerender.
 * @param queue: (ConfirmQueue) The queue presses go to.
 * @param target: (DayTask | null) The task Done confirms.
 * @param isOffline: (boolean) Whether the phone is offline.
 * @return: (object) get (the current DoneAction), rerender and unmount.
 */
function renderDone(
  queue: ConfirmQueue,
  target: DayTask | null,
  isOffline = false,
): {
  get: () => DoneAction;
  rerender: (target: DayTask | null, isOffline?: boolean) => void;
  unmount: () => void;
} {
  let latest: DoneAction | undefined;
  const record = (value: DoneAction): void => {
    latest = value;
  };
  /**
   * purpose: Test component that runs the hook and records its latest return value.
   * @param props: ({ t, off }) The target task and the offline flag.
   * @return: (null) Renders nothing.
   */
  const Probe = ({ t, off }: { t: DayTask | null; off: boolean }): null => {
    record(useDoneAction(t, off, queue));
    return null;
  };
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(<Probe t={target} off={isOffline} />);
    mounted.push(renderer);
  });
  return {
    get: () => latest as DoneAction,
    rerender: (t, off = false) => act(() => renderer.update(<Probe t={t} off={off} />)),
    unmount: () => act(() => renderer.unmount()),
  };
}

/**
 * purpose: Press Done inside act and let promises settle.
 * @param h: (object) The rendered hook.
 * @return: (Promise<void>)
 */
async function press(h: { get: () => DoneAction }): Promise<void> {
  await act(async () => {
    h.get().pressDone();
  });
}

/**
 * purpose: Advance fake time inside act.
 * @param ms: (number) Milliseconds.
 * @return: (Promise<void>)
 */
async function advance(ms: number): Promise<void> {
  await act(async () => {
    await jest.advanceTimersByTimeAsync(ms);
  });
}

/**
 * purpose: The instance ids sent to the backend so far.
 * @return: (string[]) Ids in order.
 */
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
  });

  afterEach(() => {
    act(() => {
      mounted.splice(0).forEach((renderer) => renderer.unmount());
    });
    announce.mockRestore();
    jest.useRealTimers();
  });

  it('stores the press, shows and announces the result, and sends it with the press time', async () => {
    const h = renderDone(makeQueue(), task());
    await press(h);
    expect(h.get().message).toBe('Checked off: Morning pills.');
    expect(announce).toHaveBeenCalledWith('Checked off: Morning pills.');
    expect(mockMutation).toHaveBeenCalledTimes(1);
    expect(mockMutation.mock.calls[0][1]).toEqual({
      instanceId: 'inst1',
      via: 'phone_app',
      pressedAgoMs: 0,
    });
    expect(JSON.parse(mockStore.get(STORAGE_KEY) ?? '[]')).toEqual([]);
  });

  it('stores the press before showing success', async () => {
    mockMutation.mockReturnValue(new Promise(() => {}));
    const h = renderDone(makeQueue(), task());
    await press(h);
    expect(JSON.parse(mockStore.get(STORAGE_KEY) ?? '[]')).toHaveLength(1);
    expect(h.get().message).toBe('Checked off: Morning pills.');
  });

  it('offline: stores without sending, says it will be sent, and sends after reconnect', async () => {
    const queue = makeQueue();
    const h = renderDone(queue, task(), true);
    await press(h);
    expect(mockMutation).not.toHaveBeenCalled();
    expect(h.get().message).toBe(
      'Checked off: Morning pills. It will be sent when the internet is back.',
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

  it('a network failure keeps the press and the senior still sees "Checked off"', async () => {
    mockMutation.mockRejectedValue(new Error('Network request failed'));
    const h = renderDone(makeQueue(), task());
    await press(h);
    expect(h.get().message).toBe('Checked off: Morning pills.');
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

  it('clears the result line after MESSAGE_MS', async () => {
    const h = renderDone(makeQueue(), task());
    await press(h);
    await advance(MESSAGE_MS + 1);
    expect(h.get().message).toBeNull();
  });

  it('shows the senior nothing alarming when the server permanently refuses a queued press', async () => {
    mockMutation.mockRejectedValue(new ConvexError({ code: 'not_found', message: 'gone' }));
    const h = renderDone(makeQueue(), task());
    await press(h);
    await advance(SETTLE_MS + 1);
    expect(h.get().message).toBe('Checked off: Morning pills.');
    expect(announce).toHaveBeenCalledTimes(1);
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
      expect(h.get().message).toBe('Checked off: Morning pills.');
      await advance(1000);
      await press(h);
      expect(sentIds()).toEqual(['inst1']);
    });

    it('offers the next task after the settle period, without the first task line', async () => {
      const h = renderDone(makeQueue(), task());
      await press(h);
      h.rerender(second());
      await advance(SETTLE_MS + 1);
      expect(h.get().task?.instanceId).toBe('inst2');
      expect(h.get().message).toBeNull();
      await press(h);
      expect(sentIds()).toEqual(['inst1', 'inst2']);
      expect(h.get().message).toBe('Checked off: Evening pills.');
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

    it('does not offer the early task until the Checked off line has finished', async () => {
      const h = renderDone(makeQueue(), task());
      await press(h);
      h.rerender(early());
      await advance(SETTLE_MS + 1);
      expect(h.get().task).toBeNull();
      expect(h.get().message).toBe('Checked off: Morning pills.');
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
    /**
     * purpose: A queue whose first storage write waits for the returned release function.
     * @return: (object) the queue and the release function.
     */
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

    it('a late successful write applies the checked-off line and the settle block', async () => {
      const { queue, release } = gatedQueue();
      const h = renderDone(queue, task());
      await press(h);
      await advance(STORE_TIMEOUT_MS + 1);
      mockWriteGate = null;
      await act(async () => release());
      await advance(0);
      expect(sentIds()).toEqual(['inst1']);
      expect(h.get().message).toBe('Checked off: Morning pills.');
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
          await realEnqueue(e);
        },
      };
      const h = renderDone(gated, task());
      await press(h);
      h.unmount();
      announce.mockClear();
      const timers = jest.getTimerCount();
      await act(async () => release());
      await advance(0);
      expect(announce).not.toHaveBeenCalled();
      expect(jest.getTimerCount()).toBeLessThanOrEqual(timers + 1);
    });
  });
});

describe('Undo on the phone', () => {
  let announceQueued: jest.SpiedFunction<
    typeof AccessibilityInfo.announceForAccessibilityWithOptions
  >;

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

  /**
   * purpose: What the server answers a call: undone for an undo, confirmed for a press.
   * @param ref: (unknown) The mutation reference.
   * @return: (object) The result.
   */
  function serverAnswer(ref: unknown): { status: string } {
    return getFunctionName(ref as never) === 'instances:undoPressedTask'
      ? { status: 'undone' }
      : { status: 'confirmed' };
  }

  /**
   * purpose: The calls sent so far, as the mutation name and its arguments.
   * @return: ([string, unknown][]) In order.
   */
  function calls(): [string, unknown][] {
    return mockMutation.mock.calls.map((c) => [getFunctionName(c[0] as never), c[1]]);
  }

  /**
   * purpose: Tap Undo inside act and let promises settle.
   * @param h: (object) The rendered hook.
   * @return: (Promise<void>)
   */
  async function tapUndo(h: { get: () => DoneAction }): Promise<void> {
    await act(async () => {
      h.get().pressUndo();
    });
  }

  it('offers Undo for the pressed task and announces it, queued behind the result line', async () => {
    const h = renderDone(makeQueue(), task());
    await press(h);
    expect(h.get().undoLabel).toBe('Morning pills');
    expect(announceQueued).toHaveBeenCalledWith('Morning pills done. Undo', { queue: true });
  });

  it('withdraws the offer 30 seconds after the press', async () => {
    const h = renderDone(makeQueue(), task());
    await press(h);
    await advance(UNDO_MS - 1);
    expect(h.get().undoLabel).toBe('Morning pills');
    await advance(1);
    expect(h.get().undoLabel).toBeNull();
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
    expect(h.get().undoLabel).toBe('Morning pills');
    await advance(UNDO_MS - 10_000);
    expect(h.get().undoLabel).toBeNull();
  });

  it('a new press replaces the offer; only the latest press has one', async () => {
    const h = renderDone(makeQueue(), task());
    await press(h);
    h.rerender(second());
    await advance(SETTLE_MS + 1);
    await press(h);
    expect(h.get().undoLabel).toBe('Evening pills');
  });

  it('does not hide the Done button of another due task', async () => {
    const h = renderDone(makeQueue(), task());
    await press(h);
    h.rerender(second());
    await advance(SETTLE_MS + 1);
    expect(h.get().task?.instanceId).toBe('inst2');
    expect(h.get().undoLabel).toBe('Morning pills');
  });

  it('online: takes effect at once and sends the undo after the press, with the tap age', async () => {
    const queue = makeQueue();
    const h = renderDone(queue, task());
    await press(h);
    jest.setSystemTime(NOW + 5000);
    await tapUndo(h);
    expect(h.get().undoLabel).toBeNull();
    expect(h.get().message).toBeNull();
    expect(h.get().task?.instanceId).toBe('inst1');
    await advance(0);
    expect(calls()).toEqual([
      ['instances:confirmPressedTask', { instanceId: 'inst1', via: 'phone_app', pressedAgoMs: 0 }],
      ['instances:undoPressedTask', { instanceId: 'inst1', undoneAgoMs: 0 }],
    ]);
    expect(queue.getEntries()).toEqual([]);
  });

  it('shows the task open again and offers Done while the server still says confirmed', async () => {
    const queue = makeQueue();
    const h = renderDone(queue, task(), true);
    await press(h);
    await tapUndo(h);
    const server = [task({ state: 'confirmed', confirmable: false })];
    const shown = applyPending(server, latestByInstance(queue.getEntries()));
    expect(shown[0]).toMatchObject({ state: 'due', confirmable: true });
    expect(doneTarget(shown)?.instanceId).toBe('inst1');
  });

  it('offline: press then Undo are both stored and sent in order with their ages', async () => {
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
        { instanceId: 'inst1', via: 'phone_app', pressedAgoMs: 600_000 },
      ],
      ['instances:undoPressedTask', { instanceId: 'inst1', undoneAgoMs: 590_000 }],
    ]);
  });

  it('offline: press, Undo, press again are sent in that order and end with a press', async () => {
    const queue = makeQueue();
    const h = renderDone(queue, task(), true);
    await press(h);
    jest.setSystemTime(NOW + 10_000);
    await tapUndo(h);
    jest.setSystemTime(NOW + 20_000);
    await press(h);
    expect(h.get().undoLabel).toBe('Morning pills');
    jest.setSystemTime(NOW + 900_000);
    await act(async () => {
      await queue.replay();
    });
    expect(calls()).toEqual([
      [
        'instances:confirmPressedTask',
        { instanceId: 'inst1', via: 'phone_app', pressedAgoMs: 900_000 },
      ],
      ['instances:undoPressedTask', { instanceId: 'inst1', undoneAgoMs: 890_000 }],
      [
        'instances:confirmPressedTask',
        { instanceId: 'inst1', via: 'phone_app', pressedAgoMs: 880_000 },
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

  it('a queued Undo survives a restart and is sent then; no Undo is offered after it', async () => {
    const h = renderDone(makeQueue(), task(), true);
    await press(h);
    jest.setSystemTime(NOW + 3000);
    await tapUndo(h);
    h.unmount();
    jest.setSystemTime(NOW + 60_000);
    const restarted = makeQueue();
    const after = renderDone(restarted, task());
    expect(after.get().undoLabel).toBeNull();
    await act(async () => {
      await restarted.replay();
    });
    expect(calls()).toEqual([
      [
        'instances:confirmPressedTask',
        { instanceId: 'inst1', via: 'phone_app', pressedAgoMs: 60_000 },
      ],
      ['instances:undoPressedTask', { instanceId: 'inst1', undoneAgoMs: 57_000 }],
    ]);
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

  it('an Undo that cannot be stored is logged and offered again, with no message', async () => {
    const queue = makeQueue();
    const h = renderDone(queue, task(), true);
    await press(h);
    mockFailWrites = true;
    await tapUndo(h);
    await advance(0);
    expect(h.get().undoLabel).toBe('Morning pills');
    expect(h.get().message).toBeNull();
    expect(queue.getEntries()).toHaveLength(1);
    expect(logger.warning).toHaveBeenCalledWith(
      'DoneAction',
      'Could not store an Undo',
      expect.objectContaining({ instanceId: 'inst1' }),
    );
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

  /**
   * purpose: Render the hook and expose the latest map of queued entries by instance.
   * @param queue: (ConfirmQueue) The queue.
   * @return: (object) get.
   */
  function renderPending(queue: ConfirmQueue) {
    let latest: ReadonlyMap<string, PendingEntry> = new Map();
    const record = (value: ReadonlyMap<string, PendingEntry>): void => {
      latest = value;
    };
    /**
     * purpose: Test component that records the hook's latest value.
     * @return: (null) Renders nothing.
     */
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
    await makeQueue().enqueue({ instanceId: 'inst1' as never, label: 'Pills', pressedAt: NOW });
    mockMutation.mockReturnValue(new Promise(() => {}));
    const h = renderPending(makeQueue());
    await advance(0);
    expect(h.get().has('inst1')).toBe(true);
    expect(sentIds()).toEqual(['inst1']);
  });
});

describe('DoneCard', () => {
  afterEach(() => {
    act(() => {
      mounted.splice(0).forEach((renderer) => renderer.unmount());
    });
  });

  /**
   * purpose: Whether a node is the outermost composite that carries the button role.
   * @param node: (ReactTestInstance) The node.
   * @return: (boolean) True for such a node.
   */
  function isButton(node: ReactTestInstance): boolean {
    const own = (n: ReactTestInstance): boolean =>
      typeof n.type !== 'string' && n.props.accessibilityRole === 'button';
    return own(node) && !(node.parent !== null && own(node.parent));
  }

  /**
   * purpose: Render the card and report what it shows.
   * @param props: (object) The task, message, press handler and Undo offer.
   * @return: (object) texts, the buttons found, and whether nothing rendered.
   */
  function render(props: {
    task: DayTask | null;
    message: string | null;
    onPress?: () => void;
    undo?: UndoOffer | null;
  }) {
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(
        <DoneCard
          task={props.task}
          message={props.message}
          onPress={props.onPress ?? (() => {})}
          undo={props.undo}
        />,
      );
      mounted.push(renderer);
    });
    const root = renderer.root;
    return {
      texts: root
        .findAll((n) => (n.type as unknown) === 'Text')
        .map((n) => String(n.props.children)),
      buttons: root.findAll(isButton),
      empty: renderer.toJSON() === null,
    };
  }

  it('shows the task label and exactly one Done button with its label', () => {
    const out = render({ task: task(), message: null });
    expect(out.texts).toContain('Morning pills');
    expect(out.texts).toContain('Done');
    expect(out.texts.some((t) => t.startsWith('Coming up'))).toBe(false);
    expect(out.buttons).toHaveLength(1);
    expect(out.buttons[0].props.accessibilityLabel).toBe('Done: Morning pills');
  });

  it('makes an early task unmistakably different: heading, label and "Done early"', () => {
    const out = render({
      task: task({ state: 'upcoming', scheduledTime: '12:30' }),
      message: null,
    });
    expect(out.texts).toEqual(['Coming up at 12:30 PM', 'Morning pills', 'Done early']);
    expect(out.buttons).toHaveLength(1);
    expect(out.buttons[0].props.accessibilityLabel).toBe(
      'Done early: Morning pills, coming up at 12:30 pm',
    );
  });

  it('calls onPress when the button is pressed', () => {
    const onPress = jest.fn();
    const out = render({ task: task(), message: null, onPress });
    act(() => out.buttons[0].props.onPress());
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('shows only the message, with no button, when there is no task', () => {
    const out = render({ task: null, message: 'Checked off: Morning pills.' });
    expect(out.texts).toEqual(['Checked off: Morning pills.']);
    expect(out.buttons).toHaveLength(0);
  });

  it('renders nothing when there is no task and no message', () => {
    expect(render({ task: null, message: null }).empty).toBe(true);
  });

  it('shows the Undo line under another task Done button, with its own label', () => {
    const onUndo = jest.fn();
    const out = render({
      task: second(),
      message: null,
      undo: { label: 'Morning pills', onPress: onUndo },
    });
    expect(out.texts).toEqual(['Evening pills', 'Done', 'Morning pills done.', 'Undo']);
    expect(out.buttons.map((b) => b.props.accessibilityLabel)).toEqual([
      'Done: Evening pills',
      'Undo Morning pills done',
    ]);
    act(() => out.buttons[1].props.onPress());
    expect(onUndo).toHaveBeenCalledTimes(1);
  });

  it('draws Undo as a large secondary control, not the filled Done style', () => {
    const out = render({ task: null, message: null, undo: { label: 'Pills', onPress: () => {} } });
    expect(out.empty).toBe(false);
    const style = StyleSheet.flatten(
      (out.buttons[0].props.style as (s: { pressed: boolean }) => StyleProp<ViewStyle>)({
        pressed: false,
      }),
    );
    expect(style.minHeight).toBeGreaterThanOrEqual(60);
    expect(style.backgroundColor).not.toBe(colors.success);
    expect(style.backgroundColor).toBe(colors.surface);
  });
});
