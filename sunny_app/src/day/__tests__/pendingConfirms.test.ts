// sunny_app/src/day/__tests__/pendingConfirms.test.ts
//
// Purpose: Tests for the durable pending-confirm queue. AsyncStorage is mocked at its boundary
// with an in-memory map; the real queue, sendConfirm, callMutation and toBackendError run, with
// only convex.mutation stubbed where the network is involved. Covers: the press is persisted
// before enqueue resolves, an instance is queued once, a write failure rolls back only the new
// entry, a failed read is retried and never overwrites stored presses; replay sends oldest first
// one at a time with via phone_app and pressedAgoMs (an age that ignores clock skew) and empties
// storage; a restart still has and sends the entries; no answer (network error, 429, 401, a
// timeout) keeps the entry and ends the pass while a server error moves on to the next entry;
// a permanent rejection (not found, forbidden, refused) removes the entry and is logged as an
// error with its details; a held send is awaited again instead of being called again and removes
// its entry when it lands; nothing is sent while offline; a press made during a pass is sent in
// it; an entry failing online for over ten minutes is logged loudly; clear() drops everything
// and ignores in-flight results; entries older than the maximum age are dropped as expired;
// classifyFailure; applyPending; toPending.
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
  classifyFailure,
  createConfirmQueue,
  MAX_AGE_MS,
  RETRY_MS,
  SEND_TIMEOUT_MS,
  sendConfirm,
  STORAGE_KEY,
  CORRUPT_KEY,
  BACKOFF_MS,
  STUCK_LOG_EVERY_MS,
  STUCK_MS,
  toPending,
  SEND_MAX_LIFETIME_MS,
  type ConfirmQueue,
  type ConnectionSource,
  type ConnectionState,
  type PendingConfirm,
} from '../pendingConfirms';

const mockStore = new Map<string, string>();
let mockFailWrites = false;
let mockFailReads = false;
let mockReadGate: Promise<void> | null = null;
let mockWriteGate: Promise<void> | null = null;
let mockConnected = true;

jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem: async (key: string) => {
      if (mockReadGate !== null) await mockReadGate;
      if (mockFailReads) throw new Error('read failed');
      return mockStore.get(key) ?? null;
    },
    setItem: async (key: string, value: string) => {
      if (mockWriteGate !== null) await mockWriteGate;
      if (mockFailWrites) throw new Error('disk full');
      mockStore.set(key, value);
    },
    removeItem: async (key: string) => void mockStore.delete(key),
  },
}));

jest.mock('../../backend/convex', () => ({
  convex: {
    mutation: jest.fn(),
    connectionState: () => ({ isWebSocketConnected: mockConnected, hasEverConnected: true }),
  },
}));

jest.mock('../../logging/logger', () => ({
  logger: { warning: jest.fn(), error: jest.fn() },
}));

const mockMutation = convex.mutation as unknown as jest.Mock<(...a: unknown[]) => Promise<unknown>>;

const NOW = Date.parse('2026-11-09T12:00:00Z');
const NETWORK_DOWN = (): Error => new Error('Network request failed');

/**
 * purpose: Build a queued press.
 * @param id: (string) Instance id.
 * @param pressedAt: (number) Epoch ms of the press.
 * @return: (PendingConfirm) The entry.
 */
function entry(id: string, pressedAt = NOW): PendingConfirm {
  return { instanceId: id as PendingConfirm['instanceId'], label: `Task ${id}`, pressedAt };
}

/**
 * purpose: A queue over the real send with the faked clock.
 * @return: (ConfirmQueue) The queue.
 */
function makeQueue(connection?: ConnectionSource): ConfirmQueue {
  return createConfirmQueue({ send: sendConfirm, now: () => Date.now(), connection });
}

/**
 * purpose: A connection source the test can drive.
 * @param initial: (ConnectionState) The state at the start.
 * @return: (object) The source and a function that announces a new state to the queue.
 */
function fakeConnection(initial: ConnectionState): {
  source: ConnectionSource;
  emit: (state: ConnectionState) => void;
} {
  let current = initial;
  const listeners = new Set<(state: ConnectionState) => void>();
  return {
    source: {
      current: () => current,
      subscribe: (listener) => {
        listeners.add(listener);
        return () => void listeners.delete(listener);
      },
    },
    emit: (state) => {
      current = state;
      mockConnected = state.connected;
      listeners.forEach((listener) => listener(state));
    },
  };
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
  mockFailReads = false;
  mockReadGate = null;
  mockWriteGate = null;
  mockConnected = true;
  mockMutation.mockReset();
  mockMutation.mockResolvedValue({ status: 'confirmed' });
  (logger.error as jest.Mock).mockClear();
  (logger.warning as jest.Mock).mockClear();
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

  it('rolls back only the new entry when the write fails', async () => {
    const queue = makeQueue();
    await queue.enqueue(entry('a'));
    mockFailWrites = true;
    await expect(queue.enqueue(entry('b'))).rejects.toThrow('disk full');
    expect(queue.getEntries()).toEqual([entry('a')]);
  });

  it('tells subscribers about changes', async () => {
    const queue = makeQueue();
    const listener = jest.fn();
    queue.subscribe(listener);
    await queue.enqueue(entry('a'));
    expect(listener).toHaveBeenCalled();
  });

  it('refuses while the stored queue cannot be read, and never overwrites stored presses', async () => {
    mockStore.set(STORAGE_KEY, JSON.stringify([entry('old')]));
    const queue = makeQueue();
    mockFailReads = true;
    await expect(queue.enqueue(entry('a'))).rejects.toThrow('could not be read');
    expect(stored()).toEqual([entry('old')]);
    mockFailReads = false;
    await queue.enqueue(entry('a'));
    expect(stored()).toEqual([entry('old'), entry('a')]);
  });
});

describe('replay', () => {
  it('sends oldest first, one at a time, with via and the press age, and empties storage', async () => {
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
      return { status: 'confirmed' };
    });
    await queue.replay();
    expect(sentIds()).toEqual(['a', 'b']);
    expect(maxInFlight).toBe(1);
    const [ref, args] = mockMutation.mock.calls[0];
    expect(getFunctionName(ref as never)).toBe('instances:confirmPressedTask');
    expect(args).toEqual({ instanceId: 'a', via: 'phone_app', pressedAgoMs: 2000 });
    expect(stored()).toEqual([]);
    expect(queue.getEntries()).toEqual([]);
  });

  it('sends the age at send time, so a later replay carries the longer age', async () => {
    const queue = makeQueue();
    await queue.enqueue(entry('a', NOW));
    jest.setSystemTime(NOW + 3 * 3_600_000);
    await queue.replay();
    expect((mockMutation.mock.calls[0][1] as { pressedAgoMs: number }).pressedAgoMs).toBe(
      3 * 3_600_000,
    );
  });

  it('never sends a negative age when the device clock moved back', async () => {
    const queue = makeQueue();
    await queue.enqueue(entry('a', NOW + 60_000));
    await queue.replay();
    expect((mockMutation.mock.calls[0][1] as { pressedAgoMs: number }).pressedAgoMs).toBe(0);
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

  it('keeps the entry and ends the pass at a network error, keeping order', async () => {
    const queue = makeQueue();
    await queue.enqueue(entry('a'));
    await queue.enqueue(entry('b'));
    mockMutation.mockRejectedValueOnce(NETWORK_DOWN());
    await queue.replay();
    expect(sentIds()).toEqual(['a']);
    expect(stored()).toEqual([entry('a'), entry('b')]);
  });

  it.each([
    ['a rate limit', { code: 'limit', message: 'Slow down' }],
    ['a missing sign-in (401)', { code: 'unauthenticated', message: 'Sign in' }],
  ])('keeps the entry on %s', async (_name, data) => {
    const queue = makeQueue();
    await queue.enqueue(entry('a'));
    mockMutation.mockRejectedValueOnce(new ConvexError(data));
    await queue.replay();
    expect(stored()).toEqual([entry('a')]);
    expect(logger.error).not.toHaveBeenCalled();
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

  it('moves on to the next entry after a server error', async () => {
    const queue = makeQueue();
    await queue.enqueue(entry('a'));
    await queue.enqueue(entry('b'));
    mockMutation.mockRejectedValueOnce(new Error('boom'));
    await queue.replay();
    expect(sentIds()).toEqual(['a', 'b']);
    expect(stored()).toEqual([entry('a')]);
  });

  it('retries by itself after RETRY_MS and then empties the queue', async () => {
    const queue = makeQueue();
    await queue.enqueue(entry('a'));
    mockMutation.mockRejectedValueOnce(NETWORK_DOWN());
    await queue.replay();
    await jest.advanceTimersByTimeAsync(RETRY_MS + 1);
    expect(sentIds()).toEqual(['a', 'a']);
    expect(stored()).toEqual([]);
  });

  it.each([
    ['the instance is gone', { code: 'not_found', message: 'Task instance not found' }],
    ['the device is no longer paired', { code: 'forbidden', message: 'Not allowed' }],
    ['the confirm is refused', { code: 'invalid', message: 'This task is not due yet' }],
  ])('removes and logs a permanent rejection (%s), then sends the next', async (_n, data) => {
    const queue = makeQueue();
    await queue.enqueue(entry('a', NOW - 5000));
    await queue.enqueue(entry('b'));
    mockMutation.mockRejectedValueOnce(new ConvexError(data));
    await queue.replay();
    expect(sentIds()).toEqual(['a', 'b']);
    expect(stored()).toEqual([]);
    expect(logger.error).toHaveBeenCalledWith(
      'PendingConfirms',
      'Dropped a queued Done (rejected)',
      expect.objectContaining({
        instanceId: 'a',
        label: 'Task a',
        pressedAt: NOW - 5000,
        reason: 'rejected',
      }),
    );
  });

  it('treats an already confirmed instance as success (the server answers normally)', async () => {
    const queue = makeQueue();
    await queue.enqueue(entry('a'));
    mockMutation.mockResolvedValueOnce({ status: 'confirmed', instance: {} });
    await queue.replay();
    expect(stored()).toEqual([]);
  });

  it('awaits a held send again instead of calling again, and removes the entry when it lands', async () => {
    const queue = makeQueue();
    await queue.enqueue(entry('a'));
    let finish!: () => void;
    mockMutation.mockReturnValue(
      new Promise((resolve) => (finish = () => resolve({ status: 'confirmed' }))),
    );
    const first = queue.replay();
    await jest.advanceTimersByTimeAsync(SEND_TIMEOUT_MS + 1);
    await first;
    const second = queue.replay();
    await jest.advanceTimersByTimeAsync(SEND_TIMEOUT_MS + 1);
    await second;
    expect(mockMutation).toHaveBeenCalledTimes(1);
    finish();
    await jest.advanceTimersByTimeAsync(0);
    expect(stored()).toEqual([]);
  });

  it('sends a press made during a pass in that pass', async () => {
    const queue = makeQueue();
    await queue.enqueue(entry('a'));
    let finish!: () => void;
    mockMutation.mockReturnValueOnce(new Promise<void>((resolve) => (finish = resolve)));
    const pass = queue.replay();
    await jest.advanceTimersByTimeAsync(0);
    await queue.enqueue(entry('b'));
    finish();
    await pass;
    expect(sentIds()).toEqual(['a', 'b']);
  });

  it('does nothing while offline and sends after the connection returns', async () => {
    const queue = makeQueue();
    await queue.enqueue(entry('a'));
    queue.setOffline(true);
    await queue.replay();
    expect(mockMutation).not.toHaveBeenCalled();
    queue.setOffline(false);
    await queue.replay();
    expect(sentIds()).toEqual(['a']);
  });

  it('stops the retry timer when the connection goes down', async () => {
    const queue = makeQueue();
    await queue.enqueue(entry('a'));
    mockMutation.mockRejectedValueOnce(NETWORK_DOWN());
    await queue.replay();
    queue.setOffline(true);
    await jest.advanceTimersByTimeAsync(RETRY_MS * 3);
    expect(mockMutation).toHaveBeenCalledTimes(1);
  });

  it('logs loudly when an entry has failed online for more than ten minutes', async () => {
    const queue = makeQueue();
    await queue.enqueue(entry('a'));
    mockMutation.mockRejectedValue(new Error('boom'));
    await queue.replay();
    expect(logger.error).not.toHaveBeenCalled();
    jest.setSystemTime(NOW + STUCK_MS + 1000);
    await queue.replay();
    expect(logger.error).toHaveBeenCalledWith(
      'PendingConfirms',
      'A queued Done has failed for over 10 minutes while online',
      expect.objectContaining({ instanceId: 'a', attempts: 2 }),
    );
  });
});

describe('clear', () => {
  it('drops memory and storage, logs what was dropped, and ignores a send that lands later', async () => {
    const queue = makeQueue();
    await queue.enqueue(entry('a'));
    let finish!: () => void;
    mockMutation.mockReturnValue(new Promise<void>((resolve) => (finish = resolve)));
    const pass = queue.replay();
    await jest.advanceTimersByTimeAsync(0);
    await queue.clear();
    finish();
    await pass;
    expect(queue.getEntries()).toEqual([]);
    expect(stored()).toEqual([]);
    expect(logger.error).toHaveBeenCalledWith(
      'PendingConfirms',
      'Dropped queued Done presses on unpair',
      expect.objectContaining({ count: 1 }),
    );
  });

  it('stops the retry loop and starts empty for the next pairing', async () => {
    const queue = makeQueue();
    await queue.enqueue(entry('a'));
    mockMutation.mockRejectedValueOnce(NETWORK_DOWN());
    await queue.replay();
    await queue.clear();
    await jest.advanceTimersByTimeAsync(RETRY_MS * 3);
    expect(mockMutation).toHaveBeenCalledTimes(1);
    await queue.enqueue(entry('z'));
    expect(stored()).toEqual([entry('z')]);
  });
});

describe('expiry', () => {
  it('drops an entry from a previous day when the queue loads, and logs it', async () => {
    const old = entry('old', NOW - MAX_AGE_MS - 1000);
    const recent = entry('recent', NOW - 60_000);
    mockStore.set(STORAGE_KEY, JSON.stringify([old, recent]));
    const queue = makeQueue();
    await queue.load();
    expect(queue.getEntries()).toEqual([recent]);
    expect(stored()).toEqual([recent]);
    expect(logger.error).toHaveBeenCalledWith(
      'PendingConfirms',
      'Dropped a queued Done (expired)',
      expect.objectContaining({ instanceId: 'old', reason: 'expired' }),
    );
  });

  it('does not send an expired entry', async () => {
    const queue = makeQueue();
    await queue.enqueue(entry('a', NOW - 1000));
    jest.setSystemTime(NOW + MAX_AGE_MS + 5000);
    await queue.replay();
    expect(mockMutation).not.toHaveBeenCalled();
    expect(stored()).toEqual([]);
  });

  it('recovers from corrupt stored JSON: copies it aside, logs, and starts empty and usable', async () => {
    mockStore.set(STORAGE_KEY, '{not json');
    const queue = makeQueue();
    await queue.load();
    expect(queue.getEntries()).toEqual([]);
    expect(mockStore.get(CORRUPT_KEY)).toBe('{not json');
    expect(logger.error).toHaveBeenCalledWith(
      'PendingConfirms',
      'The stored queue was corrupt; starting empty',
      expect.objectContaining({ copiedTo: CORRUPT_KEY }),
    );
    await queue.enqueue(entry('a'));
    expect(stored()).toEqual([entry('a')]);
  });

  it('treats a stored value that is not an array as corrupt too', async () => {
    mockStore.set(STORAGE_KEY, '{"a":1}');
    const queue = makeQueue();
    await queue.enqueue(entry('a'));
    expect(mockStore.get(CORRUPT_KEY)).toBe('{"a":1}');
    expect(stored()).toEqual([entry('a')]);
  });

  it('logs once at error level after several failed reads in a row, and keeps retrying', async () => {
    const queue = makeQueue();
    mockFailReads = true;
    for (let i = 0; i < 4; i++) await queue.load();
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith(
      'PendingConfirms',
      'Could not read the queue',
      expect.objectContaining({ failuresInARow: 3 }),
    );
    mockFailReads = false;
    await queue.enqueue(entry('a'));
    expect(stored()).toEqual([entry('a')]);
  });

  it('ignores stored items that are not entries', async () => {
    mockStore.set(STORAGE_KEY, JSON.stringify([{ instanceId: 5 }, entry('a')]));
    const queue = makeQueue();
    await queue.load();
    expect(queue.getEntries()).toEqual([entry('a')]);
  });
});

describe('a press becomes visible only once it is stored', () => {
  it('is not in the entries while the write hangs, and appears when it finishes', async () => {
    const queue = makeQueue();
    let release!: () => void;
    mockWriteGate = new Promise<void>((resolve) => (release = resolve));
    const adding = queue.enqueue(entry('a'));
    await jest.advanceTimersByTimeAsync(0);
    expect(queue.getEntries()).toEqual([]);
    release();
    await adding;
    expect(queue.getEntries()).toEqual([entry('a')]);
  });

  it('a write queued behind a slow one never drops the press being added', async () => {
    const queue = makeQueue();
    await queue.enqueue(entry('a'));
    let release!: () => void;
    mockWriteGate = new Promise<void>((resolve) => (release = resolve));
    const adding = queue.enqueue(entry('b'));
    await jest.advanceTimersByTimeAsync(0);
    const removing = queue.replay();
    await jest.advanceTimersByTimeAsync(0);
    release();
    await adding;
    await removing;
    expect(stored().map((e) => e.instanceId)).toContain('b');
  });
});

describe('the queue follows the connection by itself (no screen involved)', () => {
  it('sends a press queued before the first connect as soon as the socket connects', async () => {
    const { source, emit } = fakeConnection({ connected: false, offline: false });
    const queue = makeQueue(source);
    await queue.enqueue(entry('a', NOW));
    expect(mockMutation).not.toHaveBeenCalled();
    jest.setSystemTime(NOW + 3_600_000);
    emit({ connected: true, offline: false });
    await jest.advanceTimersByTimeAsync(0);
    expect(sentIds()).toEqual(['a']);
    expect((mockMutation.mock.calls[0][1] as { pressedAgoMs: number }).pressedAgoMs).toBe(
      3_600_000,
    );
  });

  it('stays quiet while offline and replays on reconnect, with no screen mounted', async () => {
    const { source, emit } = fakeConnection({ connected: true, offline: false });
    const queue = makeQueue(source);
    await queue.load();
    emit({ connected: false, offline: true });
    await queue.enqueue(entry('a'));
    await queue.replay();
    expect(mockMutation).not.toHaveBeenCalled();
    emit({ connected: true, offline: false });
    await jest.advanceTimersByTimeAsync(0);
    expect(sentIds()).toEqual(['a']);
  });
});

describe('a send that never settles', () => {
  it('is re-awaited within its lifetime, then abandoned and replaced by a fresh send', async () => {
    const queue = makeQueue();
    await queue.enqueue(entry('a'));
    mockMutation.mockReturnValue(new Promise(() => {}));
    const first = queue.replay();
    await jest.advanceTimersByTimeAsync(SEND_TIMEOUT_MS + 1);
    await first;
    expect(mockMutation).toHaveBeenCalledTimes(1);
    jest.setSystemTime(NOW + SEND_MAX_LIFETIME_MS + 1000);
    mockMutation.mockResolvedValue({ status: 'confirmed' });
    await queue.replay();
    expect(mockMutation).toHaveBeenCalledTimes(2);
    expect(stored()).toEqual([]);
  });
});

describe('backoff survives a connection flap', () => {
  it('does not retry a server-error entry sooner because the connection dropped and returned', async () => {
    const queue = makeQueue();
    await queue.enqueue(entry('a'));
    mockMutation.mockRejectedValue(new Error('boom'));
    await queue.replay();
    queue.setOffline(true);
    queue.setOffline(false);
    await queue.replay();
    expect(mockMutation).toHaveBeenCalledTimes(1);
  });
});

describe('never sends while the socket is down', () => {
  it('does not call the mutation and keeps the entry', async () => {
    const queue = makeQueue();
    await queue.enqueue(entry('a'));
    mockConnected = false;
    await queue.replay();
    expect(mockMutation).not.toHaveBeenCalled();
    expect(stored()).toEqual([entry('a')]);
  });

  it('sends a press queued before the first connect once connected, with the age at that send', async () => {
    const queue = makeQueue();
    mockConnected = false;
    await queue.enqueue(entry('a', NOW));
    await queue.replay();
    expect(mockMutation).not.toHaveBeenCalled();
    jest.setSystemTime(NOW + 2 * 3_600_000);
    mockConnected = true;
    await queue.replay();
    expect(mockMutation).toHaveBeenCalledTimes(1);
    expect((mockMutation.mock.calls[0][1] as { pressedAgoMs: number }).pressedAgoMs).toBe(
      2 * 3_600_000,
    );
  });

  it('retries by itself and sends once the socket is back', async () => {
    const queue = makeQueue();
    await queue.enqueue(entry('a'));
    mockConnected = false;
    await queue.replay();
    mockConnected = true;
    await jest.advanceTimersByTimeAsync(RETRY_MS + 1);
    expect(sentIds()).toEqual(['a']);
  });

  it('stops the pass when the connection goes offline mid-pass', async () => {
    const queue = makeQueue();
    await queue.enqueue(entry('a'));
    await queue.enqueue(entry('b'));
    let finish!: () => void;
    mockMutation.mockReturnValueOnce(
      new Promise((resolve) => (finish = () => resolve({ status: 'confirmed' }))),
    );
    const pass = queue.replay();
    await jest.advanceTimersByTimeAsync(0);
    queue.setOffline(true);
    finish();
    await pass;
    expect(sentIds()).toEqual(['a']);
    expect(stored()).toEqual([entry('b')]);
  });
});

describe('a rejected result', () => {
  it('removes the entry and logs it as an error', async () => {
    const queue = makeQueue();
    await queue.enqueue(entry('a'));
    mockMutation.mockResolvedValueOnce({ status: 'rejected', reason: 'The task no longer exists' });
    await queue.replay();
    expect(stored()).toEqual([]);
    expect(logger.error).toHaveBeenCalledWith(
      'PendingConfirms',
      'Dropped a queued Done (rejected)',
      expect.objectContaining({ instanceId: 'a', detail: 'The task no longer exists' }),
    );
  });
});

describe('backoff and stuck logging', () => {
  it('waits out the backoff after a server error, then retries with a longer wait', async () => {
    const queue = makeQueue();
    await queue.enqueue(entry('a'));
    mockMutation.mockRejectedValue(new Error('boom'));
    await queue.replay();
    await queue.replay();
    expect(mockMutation).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(BACKOFF_MS[0]! + 1);
    expect(mockMutation).toHaveBeenCalledTimes(2);
    await jest.advanceTimersByTimeAsync(BACKOFF_MS[0]! + 1);
    expect(mockMutation).toHaveBeenCalledTimes(2);
    await jest.advanceTimersByTimeAsync(BACKOFF_MS[1]! - BACKOFF_MS[0]!);
    expect(mockMutation).toHaveBeenCalledTimes(3);
  });

  it('logs the stuck error once on crossing the threshold, then hourly', async () => {
    const queue = makeQueue();
    await queue.enqueue(entry('a'));
    mockMutation.mockRejectedValue(new Error('boom'));
    await queue.replay();
    jest.setSystemTime(NOW + STUCK_MS + 1000);
    await queue.replay();
    expect(logger.error).toHaveBeenCalledTimes(1);
    jest.setSystemTime(NOW + STUCK_MS + 1000 + 30 * 60_000);
    await queue.replay();
    expect(logger.error).toHaveBeenCalledTimes(1);
    jest.setSystemTime(NOW + STUCK_MS + 1000 + STUCK_LOG_EVERY_MS + 1000);
    await queue.replay();
    expect(logger.error).toHaveBeenCalledTimes(2);
  });

  it('a sustained 401 produces the stuck log', async () => {
    const queue = makeQueue();
    await queue.enqueue(entry('a'));
    mockMutation.mockRejectedValue(new ConvexError({ code: 'unauthenticated', message: 'x' }));
    await queue.replay();
    jest.setSystemTime(NOW + STUCK_MS + 1000);
    await queue.replay();
    expect(logger.error).toHaveBeenCalledWith(
      'PendingConfirms',
      'A queued Done has failed for over 10 minutes while online',
      expect.objectContaining({ instanceId: 'a' }),
    );
  });

  it('going offline restarts the failure clock', async () => {
    const queue = makeQueue();
    await queue.enqueue(entry('a'));
    mockMutation.mockRejectedValue(new Error('boom'));
    await queue.replay();
    queue.setOffline(true);
    jest.setSystemTime(NOW + STUCK_MS + 60_000);
    queue.setOffline(false);
    await queue.replay();
    expect(logger.error).not.toHaveBeenCalled();
  });
});

describe('clear racing other work', () => {
  it('discards a load that was in flight when clear ran', async () => {
    mockStore.set(STORAGE_KEY, JSON.stringify([entry('old')]));
    const queue = makeQueue();
    let release!: () => void;
    mockReadGate = new Promise<void>((resolve) => (release = resolve));
    const loading = queue.load();
    await jest.advanceTimersByTimeAsync(0);
    await queue.clear();
    mockReadGate = null;
    release();
    await loading;
    expect(queue.getEntries()).toEqual([]);
    expect(stored()).toEqual([]);
    await queue.enqueue(entry('new'));
    expect(stored()).toEqual([entry('new')]);
  });

  it('a queued write cannot restore the old snapshot after clear', async () => {
    const queue = makeQueue();
    await queue.enqueue(entry('a'));
    const second = queue.enqueue(entry('b'));
    await queue.clear();
    await second.catch(() => undefined);
    expect(stored()).toEqual([]);
  });

  it('an old pass does not null the replaying handle of a newer pass', async () => {
    const queue = makeQueue();
    await queue.enqueue(entry('a'));
    let finishFirst!: () => void;
    mockMutation.mockReturnValueOnce(
      new Promise((resolve) => (finishFirst = () => resolve({ status: 'confirmed' }))),
    );
    const first = queue.replay();
    await jest.advanceTimersByTimeAsync(0);
    await queue.clear();
    await queue.enqueue(entry('b'));
    mockMutation.mockReturnValueOnce(new Promise(() => {}));
    const second = queue.replay();
    await jest.advanceTimersByTimeAsync(0);
    finishFirst();
    await first;
    expect(queue.replay()).toBe(second);
  });

  it('a send that lands after clear does not touch the new pairing', async () => {
    const queue = makeQueue();
    await queue.enqueue(entry('a'));
    let finish!: () => void;
    mockMutation.mockReturnValueOnce(
      new Promise((resolve) => (finish = () => resolve({ status: 'confirmed' }))),
    );
    const pass = queue.replay();
    await jest.advanceTimersByTimeAsync(0);
    await queue.clear();
    await queue.enqueue(entry('a', NOW + 1));
    finish();
    await pass;
    expect(queue.getEntries()).toEqual([entry('a', NOW + 1)]);
  });
});

describe('classifyFailure', () => {
  it.each([
    ['a network error', NETWORK_DOWN(), 'no_answer'],
    ['a timeout', new Error('Network request timed out'), 'no_answer'],
    ['401', new ConvexError({ code: 'unauthenticated', message: 'x' }), 'no_answer'],
    ['429', new ConvexError({ code: 'limit', message: 'x' }), 'no_answer'],
    ['an unexpected server error', new Error('boom'), 'server_error'],
    ['403', new ConvexError({ code: 'forbidden', message: 'x' }), 'permanent'],
    ['404', new ConvexError({ code: 'not_found', message: 'x' }), 'permanent'],
    ['400', new ConvexError({ code: 'invalid', message: 'x' }), 'permanent'],
  ])('%s', (_name, error, expected) => {
    expect(classifyFailure(error)).toBe(expected);
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
