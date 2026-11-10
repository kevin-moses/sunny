// sunny_app/src/day/__tests__/pendingConfirms.test.ts
//
// Purpose: Tests for the durable pending-confirm queue. AsyncStorage is mocked at its boundary
// with an in-memory map; the real queue, sendConfirm, callMutation and toBackendError run, with
// only convex.mutation stubbed where the network is involved. Covers: the press is persisted
// before enqueue resolves, an instance is queued once, replay sends oldest first one at a time
// with via phone_app and pressedAt and empties storage, a new queue over the same storage (an
// app restart) still has and sends the entries, a network error / rate limit / timeout keeps
// the entry and stops the pass (order kept) and a retry runs later, a permanent rejection
// (not found, no longer paired, refused) removes the entry and is reported and logged, entries
// older than the maximum age are dropped as expired (day rollover), concurrent replay calls
// share one pass, a storage failure on enqueue leaves the queue unchanged, and applyPending
// marks queued tasks confirmed.
//
// Last modified: 2026-11-09

import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { ConvexError } from 'convex/values';
import { getFunctionName } from 'convex/server';

import { convex } from '../../backend/convex';
import { logger } from '../../logging/logger';
import type { DayTask } from '../types';
import {
  applyPending,
  createConfirmQueue,
  MAX_AGE_MS,
  RETRY_MS,
  SEND_TIMEOUT_MS,
  sendConfirm,
  STORAGE_KEY,
  toPending,
  type ConfirmQueue,
  type PendingConfirm,
  type Rejection,
} from '../pendingConfirms';

const mockStore = new Map<string, string>();
let mockFailWrites = false;

jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem: async (key: string) => mockStore.get(key) ?? null,
    setItem: async (key: string, value: string) => {
      if (mockFailWrites) throw new Error('disk full');
      mockStore.set(key, value);
    },
    removeItem: async (key: string) => void mockStore.delete(key),
  },
}));

jest.mock('../../backend/convex', () => ({ convex: { mutation: jest.fn() } }));

jest.mock('../../logging/logger', () => ({ logger: { warning: jest.fn() } }));

const mockMutation = convex.mutation as unknown as jest.Mock<(...a: unknown[]) => Promise<unknown>>;

const NOW = Date.parse('2026-11-09T12:00:00Z');

/**
 * purpose: Build a queued press.
 * @param id: (string) Instance id.
 * @param pressedAt: (number) Epoch ms of the press.
 * @return: (PendingConfirm) The entry.
 */
function entry(id: string, pressedAt = NOW): PendingConfirm {
  return { instanceId: id, label: `Task ${id}`, pressedAt };
}

/**
 * purpose: A queue over the real send with the faked clock.
 * @return: (ConfirmQueue) The queue.
 */
function makeQueue(): ConfirmQueue {
  return createConfirmQueue({ send: sendConfirm, now: () => Date.now() });
}

/**
 * purpose: The ids sent to the backend so far, in order.
 * @return: (string[]) Instance ids.
 */
function sentIds(): string[] {
  return mockMutation.mock.calls.map((c) => (c[1] as { instanceId: string }).instanceId);
}

/**
 * purpose: What storage currently holds.
 * @return: (PendingConfirm[]) The persisted entries.
 */
function stored(): PendingConfirm[] {
  const raw = mockStore.get(STORAGE_KEY);
  return raw === undefined ? [] : (JSON.parse(raw) as PendingConfirm[]);
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(NOW);
  mockStore.clear();
  mockFailWrites = false;
  mockMutation.mockReset();
  mockMutation.mockResolvedValue(null);
});

afterEach(() => {
  jest.useRealTimers();
});

describe('enqueue', () => {
  it('persists the press before it resolves', async () => {
    const queue = makeQueue();
    await queue.enqueue(entry('a'));
    expect(stored()).toEqual([entry('a')]);
    expect(queue.getEntries()).toEqual([entry('a')]);
  });

  it('queues an instance once', async () => {
    const queue = makeQueue();
    await queue.enqueue(entry('a'));
    await queue.enqueue(entry('a', NOW + 5));
    expect(stored()).toEqual([entry('a')]);
  });

  it('leaves the queue unchanged and rejects when storage fails', async () => {
    const queue = makeQueue();
    mockFailWrites = true;
    await expect(queue.enqueue(entry('a'))).rejects.toThrow('disk full');
    expect(queue.getEntries()).toEqual([]);
  });

  it('tells subscribers about changes', async () => {
    const queue = makeQueue();
    const listener = jest.fn();
    queue.subscribe(listener);
    await queue.enqueue(entry('a'));
    expect(listener).toHaveBeenCalled();
  });
});

describe('replay', () => {
  it('sends oldest first, one at a time, with via and pressedAt, and empties storage', async () => {
    const queue = makeQueue();
    await queue.enqueue(entry('a', NOW - 2000));
    await queue.enqueue(entry('b', NOW - 1000));
    let inFlight = 0;
    let maxInFlight = 0;
    mockMutation.mockImplementation(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await Promise.resolve();
      inFlight -= 1;
      return null;
    });
    await queue.replay();
    expect(sentIds()).toEqual(['a', 'b']);
    expect(maxInFlight).toBe(1);
    const [ref, args] = mockMutation.mock.calls[0];
    expect(getFunctionName(ref as never)).toBe('instances:confirmTaskInstance');
    expect(args).toEqual({ instanceId: 'a', via: 'phone_app', pressedAt: NOW - 2000 });
    expect(stored()).toEqual([]);
    expect(queue.getEntries()).toEqual([]);
  });

  it('survives an app restart: a new queue over the same storage still sends the press', async () => {
    await makeQueue().enqueue(entry('a'));
    const restarted = makeQueue();
    await restarted.load();
    expect(restarted.getEntries()).toEqual([entry('a')]);
    await restarted.replay();
    expect(sentIds()).toEqual(['a']);
    expect(stored()).toEqual([]);
  });

  it('shares one pass between concurrent calls', async () => {
    const queue = makeQueue();
    await queue.enqueue(entry('a'));
    await Promise.all([queue.replay(), queue.replay()]);
    expect(sentIds()).toEqual(['a']);
  });

  it('keeps the entry and stops at a network error, keeping order', async () => {
    const queue = makeQueue();
    await queue.enqueue(entry('a'));
    await queue.enqueue(entry('b'));
    mockMutation.mockRejectedValueOnce(new Error('Network request failed'));
    await queue.replay();
    expect(sentIds()).toEqual(['a']);
    expect(stored()).toEqual([entry('a'), entry('b')]);
  });

  it('keeps the entry on a rate limit', async () => {
    const queue = makeQueue();
    await queue.enqueue(entry('a'));
    mockMutation.mockRejectedValueOnce(new ConvexError({ code: 'limit', message: 'Slow down' }));
    await queue.replay();
    expect(stored()).toEqual([entry('a')]);
  });

  it('keeps the entry when the server does not answer in time', async () => {
    const queue = makeQueue();
    await queue.enqueue(entry('a'));
    mockMutation.mockReturnValueOnce(new Promise(() => {}));
    const pass = queue.replay();
    await jest.advanceTimersByTimeAsync(SEND_TIMEOUT_MS + 1);
    await pass;
    expect(stored()).toEqual([entry('a')]);
  });

  it('retries by itself after RETRY_MS and then empties the queue', async () => {
    const queue = makeQueue();
    await queue.enqueue(entry('a'));
    mockMutation.mockRejectedValueOnce(new Error('Network request failed'));
    await queue.replay();
    await jest.advanceTimersByTimeAsync(RETRY_MS + 1);
    expect(sentIds()).toEqual(['a', 'a']);
    expect(stored()).toEqual([]);
  });

  it.each([
    ['the instance is gone', { code: 'not_found', message: 'Task instance not found' }],
    ['the device is no longer paired', { code: 'forbidden', message: 'Not allowed' }],
    ['the confirm is refused', { code: 'invalid', message: 'This task is not due yet' }],
  ])('removes and reports a permanent rejection (%s), then sends the next', async (_n, data) => {
    const queue = makeQueue();
    const rejections: Rejection[] = [];
    queue.onRejection((r) => rejections.push(r));
    await queue.enqueue(entry('a'));
    await queue.enqueue(entry('b'));
    mockMutation.mockRejectedValueOnce(new ConvexError(data));
    await queue.replay();
    expect(sentIds()).toEqual(['a', 'b']);
    expect(stored()).toEqual([]);
    expect(rejections).toHaveLength(1);
    expect(rejections[0]).toMatchObject({ entry: entry('a'), reason: 'rejected' });
    expect(logger.warning).toHaveBeenCalledWith(
      'PendingConfirms',
      'Dropped a queued Done (rejected)',
      expect.objectContaining({ instanceId: 'a' }),
    );
  });

  it('treats an already confirmed instance as success (the server answers normally)', async () => {
    const queue = makeQueue();
    await queue.enqueue(entry('a'));
    mockMutation.mockResolvedValueOnce({ state: 'confirmed' });
    await queue.replay();
    expect(stored()).toEqual([]);
  });
});

describe('expiry', () => {
  it('drops an entry from a previous day when the queue loads, and reports it', async () => {
    const old = entry('old', NOW - MAX_AGE_MS - 1000);
    const recent = entry('recent', NOW - 60_000);
    mockStore.set(STORAGE_KEY, JSON.stringify([old, recent]));
    const queue = makeQueue();
    const rejections: Rejection[] = [];
    queue.onRejection((r) => rejections.push(r));
    await queue.load();
    expect(queue.getEntries()).toEqual([recent]);
    expect(stored()).toEqual([recent]);
    expect(rejections).toMatchObject([{ entry: old, reason: 'expired' }]);
  });

  it('does not send an expired entry', async () => {
    const queue = makeQueue();
    await queue.enqueue(entry('a', NOW - 1000));
    jest.setSystemTime(NOW + MAX_AGE_MS + 5000);
    await queue.replay();
    expect(mockMutation).not.toHaveBeenCalled();
    expect(stored()).toEqual([]);
  });

  it('ignores unreadable stored data', async () => {
    mockStore.set(STORAGE_KEY, '{not json');
    const queue = makeQueue();
    await queue.load();
    expect(queue.getEntries()).toEqual([]);
  });

  it('ignores stored items that are not entries', async () => {
    mockStore.set(STORAGE_KEY, JSON.stringify([{ instanceId: 5 }, entry('a')]));
    const queue = makeQueue();
    await queue.load();
    expect(queue.getEntries()).toEqual([entry('a')]);
  });
});

describe('applyPending', () => {
  const tasks = [
    { instanceId: 'a', state: 'due', confirmable: true },
    { instanceId: 'b', state: 'upcoming', confirmable: true },
    { instanceId: 'c', state: 'confirmed', confirmable: false },
  ] as unknown as DayTask[];

  it('marks queued tasks confirmed and not confirmable', () => {
    const out = applyPending(tasks, new Set(['a']));
    expect(out[0]).toMatchObject({ state: 'confirmed', confirmable: false });
    expect(out[1]).toBe(tasks[1]);
  });

  it('returns the same list when nothing is queued', () => {
    expect(applyPending(tasks, new Set())).toBe(tasks);
  });

  it('leaves an already confirmed task as it is', () => {
    expect(applyPending(tasks, new Set(['c']))[2]).toBe(tasks[2]);
  });
});

describe('toPending', () => {
  it('builds an entry from a task and the press time', () => {
    const task = { instanceId: 'a', displayLabel: 'Pills' } as unknown as DayTask;
    expect(toPending(task, 7)).toEqual({ instanceId: 'a', label: 'Pills', pressedAt: 7 });
  });
});
