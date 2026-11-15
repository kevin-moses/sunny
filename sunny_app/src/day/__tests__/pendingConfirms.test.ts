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
// classifyFailure; applyPending (presses, undos, press again); toPending; toUndo. Undo entries:
// press, undo and a second press of one task are three entries, a second undo is not queued, an
// undo goes through undoPressedTask with the tap's age, order is kept per task through a server
// error and a backoff while other tasks are sent, a press dropped for good lets its undo go,
// stored undos survive a restart (malformed ones are ignored), an undo expires by its tap time,
// and too_late removes the undo with a log. applyPending after an undo: own press delivered
// shows open, own press still queued while another surface confirmed shows done, both queued
// and the server open shows open. Press ids (expo-crypto mocked): sent with the press and the
// same id with its undo, kept across a restart, old stored entries sent without one; stored
// items that are not entries (an unknown restore state, a prototype key, a non-text id) are
// dropped with a warning that gives only their count. clear() logs presses and undos. enqueue
// resolves with the stored entry, or with the queued one a duplicate was skipped for; an undo
// with an id restores only a confirm whose confirmPressIds hold that id.
//
// Last modified: 2026-11-14

import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { ConvexError } from 'convex/values';
import { getFunctionName } from 'convex/server';

import { convex } from '../../backend/convex';
import { logger } from '../../logging/logger';
import type { DayTask } from '../types';
import {
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
  SEND_MAX_LIFETIME_MS,
  type ConfirmQueue,
  type ConnectionSource,
  type ConnectionState,
} from '../pendingConfirms';
import {
  applyPending,
  newPressId,
  toPending,
  toUndo,
  type PendingConfirm,
  type PendingEntry,
  type PendingUndo,
} from '../pendingEntries';

jest.mock('expo-crypto', () => ({
  randomUUID: () => `id-${String(++mockIdCounter).padStart(16, '0')}`,
}));

let mockIdCounter = 0;

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
  logger: { info: jest.fn(), warning: jest.fn(), error: jest.fn() },
}));

const mockMutation = convex.mutation as unknown as jest.Mock<(...a: unknown[]) => Promise<unknown>>;

const NOW = Date.parse('2026-11-09T12:00:00Z');
const NETWORK_DOWN = (): Error => new Error('Network request failed');

function pressIdOf(id: string, pressedAt: number): string {
  return `pid-${id}-${pressedAt}`;
}

function entry(id: string, pressedAt = NOW, pressId = pressIdOf(id, pressedAt)): PendingConfirm {
  return {
    instanceId: id as PendingConfirm['instanceId'],
    label: `Task ${id}`,
    pressedAt,
    pressId,
  };
}

function undo(
  id: string,
  undoneAt = NOW,
  state: DayTask['state'] = 'due',
  label = `Task ${id}`,
  pressId = pressIdOf(id, NOW),
): PendingUndo {
  return {
    kind: 'undo',
    instanceId: id as PendingUndo['instanceId'],
    label,
    undoneAt,
    restore: { state, confirmable: true },
    pressId,
  };
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
  (logger.info as jest.Mock).mockClear();
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

  it('resolves with the stored entry, or with the queued one a duplicate was skipped for', async () => {
    const queue = makeQueue();
    const first = entry('a', NOW, 'pid-0000000000000001');
    expect(await queue.enqueue(first)).toBe(first);
    expect(await queue.enqueue(entry('a', NOW + 5, 'pid-0000000000000002'))).toBe(first);
    const back = undo('a', NOW + 6, 'due', 'Task a', 'pid-0000000000000001');
    expect(await queue.enqueue(back)).toBe(back);
    expect(await queue.enqueue(undo('a', NOW + 7))).toBe(back);
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
    expect(args).toEqual({
      instanceId: 'a',
      via: 'phone_app',
      pressedAgoMs: 2000,
      pressId: pressIdOf('a', NOW - 2000),
    });
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
      'Dropped queued Done presses and Undos on unpair',
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

  it('ignores stored items that are not entries, with a warning that gives only their count', async () => {
    mockStore.set(STORAGE_KEY, JSON.stringify([{ instanceId: 5 }, entry('a'), 'secret']));
    const queue = makeQueue();
    await queue.load();
    expect(queue.getEntries()).toEqual([entry('a')]);
    expect(logger.warning).toHaveBeenCalledWith(
      'PendingConfirms',
      'Ignored stored items that are not entries',
      { count: 2 },
    );
  });

  it('logs nothing when every stored item is an entry', async () => {
    mockStore.set(STORAGE_KEY, JSON.stringify([entry('a')]));
    await makeQueue().load();
    expect(logger.warning).not.toHaveBeenCalled();
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
    { instanceId: 'd', state: 'resolved', confirmable: false },
  ] as unknown as DayTask[];

  /**
   * purpose: A queue list, for readability.
   * @param list: (PendingEntry[]) Entries, oldest first.
   * @return: (PendingEntry[]) The same entries.
   */
  const own = { ...tasks[2], confirmPressIds: [pressIdOf('c', NOW)] } as DayTask;

  const queued = (...list: PendingEntry[]): PendingEntry[] => list;

  it('marks queued tasks confirmed and not confirmable', () => {
    const out = applyPending(tasks, queued(entry('a')));
    expect(out[0]).toMatchObject({ state: 'confirmed', confirmable: false });
    expect(out[1]).toBe(tasks[1]);
  });

  it('returns the same list when nothing is queued', () => {
    expect(applyPending(tasks, [])).toBe(tasks);
  });

  it('leaves an already confirmed task as it is', () => {
    expect(applyPending(tasks, queued(entry('c')))[2]).toBe(tasks[2]);
  });

  it('own press delivered, undo queued: the server says confirmed and the task shows open', () => {
    const out = applyPending([own], queued(undo('c', NOW + 1, 'upcoming')));
    expect(out[0]).toMatchObject({ state: 'upcoming', confirmable: true });
  });

  it('an undo with an id restores only a confirm whose confirmPressIds hold that id', () => {
    const PID = 'pid-0000000000000001';
    const ours = { ...tasks[2], confirmPressIds: ['pid-confirming-press', PID] } as DayTask;
    const theirs = { ...tasks[2], confirmPressIds: ['pid-of-the-display'] } as DayTask;
    const back = undo('c', NOW + 1, 'upcoming', 'Task c', PID);
    expect(applyPending([ours], queued(back))[0]).toMatchObject({ state: 'upcoming' });
    expect(applyPending([theirs], queued(back))[0]).toBe(theirs);
  });

  it('own press still queued ahead of the undo and confirmed by another surface: shows done', () => {
    const out = applyPending(tasks, queued(entry('c'), undo('c', NOW + 1)));
    expect(out[2]).toBe(tasks[2]);
    expect(out[2]).toMatchObject({ state: 'confirmed', confirmable: false });
  });

  it('press and undo both queued and the server not done: shows open as the server says', () => {
    const out = applyPending(tasks, queued(entry('a'), undo('a', NOW + 1)));
    expect(out[0]).toBe(tasks[0]);
    expect(out[0]).toMatchObject({ state: 'due', confirmable: true });
  });

  it('after an undo leaves a task resolved by a caregiver as it is', () => {
    expect(applyPending(tasks, queued(undo('d')))[3]).toBe(tasks[3]);
  });

  it('press, undo, press again reads confirmed', () => {
    const out = applyPending(tasks, queued(entry('a'), undo('a', NOW + 1), entry('a', NOW + 2)));
    expect(out[0]).toMatchObject({ state: 'confirmed', confirmable: false });
  });

  it('offline after a delivered Done, then Undo, Done, Undo: shows open as the senior last asked', () => {
    const second = pressIdOf('c', NOW + 2);
    const out = applyPending(
      [own],
      queued(
        undo('c', NOW + 1, 'due'),
        entry('c', NOW + 2),
        undo('c', NOW + 3, 'due', 'Task c', second),
      ),
    );
    expect(out[0]).toMatchObject({ state: 'due', confirmable: true });
  });

  it('an undo of a local press shows the task as the server shows it now', () => {
    const escalated = { ...tasks[0], state: 'escalated' } as DayTask;
    const out = applyPending([escalated], queued(entry('a'), undo('a', NOW + 1, 'due')));
    expect(out[0]).toBe(escalated);
  });

  it('a press landing on its own delivered confirm can be undone', () => {
    const later = pressIdOf('c', NOW + 1);
    const out = applyPending(
      [own],
      queued(entry('c', NOW + 1), undo('c', NOW + 2, 'upcoming', 'Task c', later)),
    );
    expect(out[0]).toMatchObject({ state: 'upcoming', confirmable: true });
  });

  it('a press landing on another surface confirm cannot be undone', () => {
    const later = pressIdOf('c', NOW + 1);
    const out = applyPending(
      tasks,
      queued(entry('c', NOW + 1), undo('c', NOW + 2, 'upcoming', 'Task c', later)),
    );
    expect(out[2]).toBe(tasks[2]);
  });

  it('an undo naming a press that is no longer the confirmation changes nothing', () => {
    const out = applyPending([own], queued(undo('c', NOW + 1), undo('c', NOW + 2)));
    expect(out[0]).toMatchObject({ state: 'due', confirmable: true });
    const stale = applyPending(tasks, queued(undo('c', NOW + 1, 'due', 'Task c', 'pid-gone')));
    expect(stale[2]).toBe(tasks[2]);
  });
});

describe('undo entries in the queue', () => {
  it('queues press, undo and a second press of one task as three entries', async () => {
    const queue = makeQueue();
    await queue.enqueue(entry('a'));
    await queue.enqueue(undo('a', NOW + 1));
    await queue.enqueue(entry('a', NOW + 2));
    expect(stored()).toEqual([entry('a'), undo('a', NOW + 1), entry('a', NOW + 2)]);
  });

  it('does not queue a second undo behind an undo', async () => {
    const queue = makeQueue();
    await queue.enqueue(entry('a'));
    await queue.enqueue(undo('a', NOW + 1));
    await queue.enqueue(undo('a', NOW + 2));
    expect(stored()).toHaveLength(2);
  });

  it('sends an undo through undoPressedTask with the age of the tap', async () => {
    const queue = makeQueue();
    await queue.enqueue(undo('a', NOW - 4000));
    await queue.replay();
    const [ref, args] = mockMutation.mock.calls[0];
    expect(getFunctionName(ref as never)).toBe('instances:undoPressedTask');
    expect(args).toEqual({ instanceId: 'a', undoneAgoMs: 4000, pressId: pressIdOf('a', NOW) });
    expect(stored()).toEqual([]);
  });

  it('a server error on a press holds that task undo, while other tasks are sent', async () => {
    const queue = makeQueue();
    await queue.enqueue(entry('a'));
    await queue.enqueue(undo('a', NOW + 1));
    await queue.enqueue(entry('b', NOW + 2));
    mockMutation.mockRejectedValueOnce(new Error('boom'));
    await queue.replay();
    expect(sentIds()).toEqual(['a', 'b']);
    expect(queue.getEntries()).toEqual([entry('a'), undo('a', NOW + 1)]);
  });

  it('a press waiting out its backoff still holds the undo behind it', async () => {
    const queue = makeQueue();
    await queue.enqueue(entry('a'));
    await queue.enqueue(undo('a', NOW + 1));
    mockMutation.mockRejectedValueOnce(new Error('boom'));
    await queue.replay();
    await queue.replay();
    expect(sentIds()).toEqual(['a']);
    await jest.advanceTimersByTimeAsync(BACKOFF_MS[0]!);
    expect(sentIds()).toEqual(['a', 'a', 'a']);
    expect(queue.getEntries()).toEqual([]);
  });

  it('a press dropped for good lets the undo behind it go out', async () => {
    const queue = makeQueue();
    await queue.enqueue(entry('a'));
    await queue.enqueue(undo('a', NOW + 1));
    mockMutation.mockRejectedValueOnce(new ConvexError({ code: 'not_found', message: 'gone' }));
    await queue.replay();
    expect(sentIds()).toEqual(['a', 'a']);
    expect(queue.getEntries()).toEqual([]);
  });

  it('keeps stored undo entries across a restart and ignores malformed ones', async () => {
    const bad = { kind: 'undo', instanceId: 'x', label: 'X', undoneAt: NOW };
    mockStore.set(STORAGE_KEY, JSON.stringify([entry('a'), undo('a', NOW + 1), bad]));
    const queue = makeQueue();
    await queue.load();
    expect(queue.getEntries()).toEqual([entry('a'), undo('a', NOW + 1)]);
  });

  it('expires an undo by the time of its tap', async () => {
    mockStore.set(STORAGE_KEY, JSON.stringify([undo('old', NOW - MAX_AGE_MS - 1)]));
    const queue = makeQueue();
    await queue.load();
    expect(queue.getEntries()).toEqual([]);
    expect(logger.error).toHaveBeenCalledWith(
      'PendingConfirms',
      'Dropped a queued Undo (expired)',
      expect.objectContaining({ instanceId: 'old', kind: 'undo' }),
    );
  });

  it('logs and removes an undo answered too_late', async () => {
    mockMutation.mockResolvedValueOnce({ status: 'too_late' });
    const queue = makeQueue();
    await queue.enqueue(undo('a'));
    await queue.replay();
    expect(queue.getEntries()).toEqual([]);
    expect(logger.info).toHaveBeenCalledWith(
      'PendingConfirms',
      'An Undo came too late; the task stays done',
      expect.objectContaining({ instanceId: 'a', undoneAt: NOW }),
    );
  });
});

describe('toUndo', () => {
  it('builds an undo from the task as it was when pressed and the tap time', () => {
    const task = {
      instanceId: 'a',
      displayLabel: 'Pills',
      state: 'due',
      confirmable: true,
    } as unknown as DayTask;
    expect(toUndo(task, 9, 'pid-0000000000000001')).toEqual(
      undo('a', 9, 'due', 'Pills', 'pid-0000000000000001'),
    );
  });
});

describe('toPending', () => {
  it('builds an entry from a task, the press time and the press id', () => {
    const task = { instanceId: 'a', displayLabel: 'Pills' } as unknown as DayTask;
    expect(toPending(task, 7, 'pid-0000000000000001')).toEqual({
      instanceId: 'a',
      label: 'Pills',
      pressedAt: 7,
      pressId: 'pid-0000000000000001',
    });
  });
});

describe('press ids', () => {
  /** A press id in the server's accepted form. */
  const PID = 'pid-0000000000000001';

  /**
   * purpose: The arguments of the sent calls, in order.
   * @return: (unknown[]) Arguments.
   */
  const sentArgs = (): unknown[] => mockMutation.mock.calls.map((c) => c[1]);

  it('newPressId comes from the platform CSPRNG', () => {
    expect(newPressId()).toMatch(/^id-\d{16}$/);
  });

  it('sends the press id with the press and the same id with its undo', async () => {
    const queue = makeQueue();
    await queue.enqueue(entry('a', NOW, PID));
    await queue.enqueue(undo('a', NOW + 1, 'due', 'Task a', PID));
    mockMutation.mockImplementation(async (ref) =>
      getFunctionName(ref as never) === 'instances:undoPressedTask'
        ? { status: 'undone' }
        : { status: 'confirmed' },
    );
    jest.setSystemTime(NOW + 5000);
    await queue.replay();
    expect(sentArgs()).toEqual([
      { instanceId: 'a', via: 'phone_app', pressedAgoMs: 5000, pressId: PID },
      { instanceId: 'a', undoneAgoMs: 4999, pressId: PID },
    ]);
  });

  it('keeps the ids across a restart', async () => {
    await makeQueue().enqueue(entry('a', NOW, PID));
    await makeQueue().enqueue(undo('a', NOW + 1, 'due', 'Task a', PID));
    expect(stored()).toEqual([entry('a', NOW, PID), undo('a', NOW + 1, 'due', 'Task a', PID)]);
    const restarted = makeQueue();
    await restarted.replay();
    expect(sentArgs().map((a) => (a as { pressId?: string }).pressId)).toEqual([PID, PID]);
  });

  it('ignores stored entries without a press id, or with a kind a press never has', async () => {
    const { pressId: _press, ...noIdPress } = entry('x');
    const { pressId: _undo, ...noIdUndo } = undo('y');
    const pressKind = { ...entry('z'), kind: 'press' };
    mockStore.set(STORAGE_KEY, JSON.stringify([noIdPress, noIdUndo, pressKind, entry('a')]));
    const queue = makeQueue();
    await queue.load();
    expect(queue.getEntries()).toEqual([entry('a')]);
    expect(logger.warning).toHaveBeenCalledWith(
      'PendingConfirms',
      'Ignored stored items that are not entries',
      { count: 3 },
    );
  });

  it('ignores a stored undo whose saved state is not a known state, or whose id is not text', async () => {
    const badState = { ...undo('x'), restore: { state: 'gone', confirmable: true } };
    const badProto = { ...undo('y'), restore: { state: 'toString', confirmable: true } };
    const badId = { ...entry('z'), pressId: 7 };
    mockStore.set(STORAGE_KEY, JSON.stringify([badState, badProto, badId, entry('a')]));
    const queue = makeQueue();
    await queue.load();
    expect(queue.getEntries()).toEqual([entry('a')]);
    expect(logger.warning).toHaveBeenCalledWith(
      'PendingConfirms',
      'Ignored stored items that are not entries',
      { count: 3 },
    );
  });
});
