// sunny_app/src/day/pendingConfirms.ts
//
// Purpose: A small durable queue of Done presses that the server has not acknowledged yet, so
// pressing Done works the same with or without a connection. Written for both senior surfaces
// (the phone now, the home display later); it knows nothing about screens.
//
// Lifecycle of an entry:
//  1. enqueue() writes it to AsyncStorage and only then resolves, so the caller may show
//     "checked off" knowing the press survives an app close or a restart. The entry records the
//     instance id, its label and pressedAt (epoch ms of the press).
//  2. replay() sends entries oldest first, one at a time, through instances.confirmTaskInstance
//     with via "phone_app" and pressedAt, so the server records the time of the press, not the
//     time of the replay. Replay runs after every enqueue, on app launch and when the
//     connection returns (usePendingConfirms triggers it), and again after RETRY_MS while
//     entries remain.
//  3. An entry is removed only when the server has answered: success (the backend confirm is
//     idempotent for an instance that is already confirmed, and writes no second audit row), or
//     a permanent rejection (any BackendError with a status other than 0 or 429: the instance
//     no longer exists, the device is no longer paired, the confirm was refused). A network
//     failure, a server error, a rate limit or SEND_TIMEOUT_MS without an answer keeps the
//     entry and stops this pass, so order is preserved.
//  4. A permanent rejection is never silent: it is logged and passed to onRejection listeners
//     (the screen shows a calm line and the task shows as open again). Entries older than
//     MAX_AGE_MS are dropped the same way (reason "expired") when the queue loads or replays,
//     which also clears entries left over from previous days.
//
// The optimistic display (a queued task shows as checked and is not offered again) reads
// pendingIds(); it ends when the entry is removed. Convex also holds a mutation while its
// socket is down, but replay only sends one entry at a time and callers do not call the
// mutation themselves, so a press is sent by this queue alone (a send that timed out may still
// be delivered by the client later; the duplicate is harmless).
//
// Last modified: 2026-11-09

import AsyncStorage from '@react-native-async-storage/async-storage';

import { callMutation, toBackendError } from '../backend/api';
import { api } from '../backend/convexApi';
import { logger } from '../logging/logger';
import type { DayTask } from './types';

/** AsyncStorage key of the persisted queue. */
export const STORAGE_KEY = 'sunny.pendingConfirms.v1';

/** Entries older than this (ms since the press) are dropped as expired. */
export const MAX_AGE_MS = 48 * 60 * 60 * 1000;

/** How long (ms) a send may stay unanswered before the pass stops and the entry is kept. */
export const SEND_TIMEOUT_MS = 15_000;

/** How long (ms) after a pass that left entries behind the next pass runs by itself. */
export const RETRY_MS = 30_000;

/** One Done press waiting for the server. */
export interface PendingConfirm {
  /** The task instance the senior confirmed. */
  instanceId: string;
  /** The task's label, for messages. */
  label: string;
  /** When the senior pressed Done (epoch ms). */
  pressedAt: number;
}

/** Why an entry was removed without the server accepting it. */
export interface Rejection {
  entry: PendingConfirm;
  reason: 'rejected' | 'expired';
  /** The server's message, or a note that the entry expired. */
  detail: string;
}

/** Sends one entry; throws when the server did not accept it. */
export type SendConfirm = (entry: PendingConfirm) => Promise<void>;

/** The queue returned by createConfirmQueue. */
export interface ConfirmQueue {
  /** Read the persisted entries (once) and drop expired ones. */
  load: () => Promise<void>;
  /** Persist an entry, then resolve; an instance already queued is not queued twice. */
  enqueue: (entry: PendingConfirm) => Promise<void>;
  /** Send queued entries oldest first until one cannot be answered. */
  replay: () => Promise<void>;
  /** The current entries; the array is replaced on every change. */
  getEntries: () => readonly PendingConfirm[];
  /** Call the listener after every change to the entries. */
  subscribe: (listener: () => void) => () => void;
  /** Call the listener for every entry removed without being accepted. */
  onRejection: (listener: (rejection: Rejection) => void) => () => void;
}

/** Options of createConfirmQueue. */
export interface QueueOptions {
  send: SendConfirm;
  /** The clock; defaults to Date.now. */
  now?: () => number;
}

/**
 * purpose: Send one entry to the backend as the senior's phone.
 * @param entry: (PendingConfirm) The press.
 * @return: (Promise<void>) Resolves when the server accepted it.
 * @raises: BackendError when the call failed.
 */
export async function sendConfirm(entry: PendingConfirm): Promise<void> {
  await callMutation(api.instances.confirmTaskInstance, {
    instanceId: entry.instanceId as never,
    via: 'phone_app',
    pressedAt: entry.pressedAt,
  });
}

/**
 * purpose: Whether a failed send should be retried later: the request never got a definite
 *          answer (status 0: offline, server error) or was rate limited (429).
 * @param error: (unknown) What the send threw.
 * @return: (boolean) True when the entry must be kept.
 */
export function isTransient(error: unknown): boolean {
  const { status } = toBackendError(error);
  return status === 0 || status === 429;
}

/**
 * purpose: Whether a persisted value is a usable entry.
 * @param value: (unknown) A parsed JSON element.
 * @return: (boolean) True for an object with a string id, string label and finite pressedAt.
 */
function isEntry(value: unknown): value is PendingConfirm {
  const entry = value as Partial<PendingConfirm> | null;
  return (
    typeof entry === 'object' &&
    entry !== null &&
    typeof entry.instanceId === 'string' &&
    typeof entry.label === 'string' &&
    typeof entry.pressedAt === 'number' &&
    Number.isFinite(entry.pressedAt)
  );
}

/**
 * purpose: Race a send against SEND_TIMEOUT_MS.
 * @param send: (Promise<void>) The send in progress.
 * @return: (Promise<void>) Resolves when it finishes.
 * @raises: The send's error, or an Error('Network request timed out') on timeout.
 */
async function withTimeout(send: Promise<void>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('Network request timed out')), SEND_TIMEOUT_MS);
  });
  try {
    await Promise.race([send, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * purpose: Create a pending-confirm queue over AsyncStorage.
 * @param options: (QueueOptions) The send function and an optional clock.
 * @return: (ConfirmQueue) The queue.
 */
export function createConfirmQueue(options: QueueOptions): ConfirmQueue {
  const now = options.now ?? Date.now;
  let entries: readonly PendingConfirm[] = [];
  let loaded: Promise<void> | null = null;
  let replaying: Promise<void> | null = null;
  let writes: Promise<void> = Promise.resolve();
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  const listeners = new Set<() => void>();
  const rejectionListeners = new Set<(rejection: Rejection) => void>();

  /**
   * purpose: Replace the entries and tell subscribers.
   * @param next: (readonly PendingConfirm[]) The new entries.
   * @return: (void)
   */
  const setEntries = (next: readonly PendingConfirm[]): void => {
    entries = next;
    listeners.forEach((listener) => listener());
  };

  /**
   * purpose: Write the current entries to storage, after earlier writes finished.
   * @return: (Promise<void>) Resolves when written; rejects when storage fails.
   */
  const persist = (): Promise<void> => {
    const snapshot = JSON.stringify(entries);
    const write = writes.then(() => AsyncStorage.setItem(STORAGE_KEY, snapshot));
    writes = write.catch(() => undefined);
    return write;
  };

  /**
   * purpose: Log an entry that left the queue unaccepted and tell the listeners.
   * @param rejection: (Rejection) The entry, reason and detail.
   * @return: (void)
   */
  const reject = (rejection: Rejection): void => {
    logger.warning('PendingConfirms', `Dropped a queued Done (${rejection.reason})`, {
      instanceId: rejection.entry.instanceId,
      pressedAt: rejection.entry.pressedAt,
      detail: rejection.detail,
    });
    rejectionListeners.forEach((listener) => listener(rejection));
  };

  /**
   * purpose: Remove one entry, persist the removal and tell subscribers.
   * @param instanceId: (string) The entry's instance.
   * @return: (Promise<void>) Resolves when the removal is stored (a storage failure is logged;
   *          the entry would then be sent again later, which is harmless).
   */
  const remove = async (instanceId: string): Promise<void> => {
    setEntries(entries.filter((e) => e.instanceId !== instanceId));
    await persist().catch((error: unknown) =>
      logger.warning('PendingConfirms', 'Could not store the queue', { error: String(error) }),
    );
  };

  /**
   * purpose: Drop entries older than MAX_AGE_MS, reporting each as expired.
   * @return: (Promise<void>) Resolves when the removals are stored.
   */
  const dropExpired = async (): Promise<void> => {
    const expired = entries.filter((e) => now() - e.pressedAt > MAX_AGE_MS);
    for (const entry of expired) {
      await remove(entry.instanceId);
      reject({ entry, reason: 'expired', detail: 'The press is too old to send.' });
    }
  };

  /**
   * purpose: Read the persisted entries once and drop expired ones.
   * @return: (Promise<void>) Resolves when loaded; a storage or parse failure is logged and
   *          leaves the queue empty.
   */
  const load = (): Promise<void> => {
    loaded ??= (async () => {
      try {
        const raw = await AsyncStorage.getItem(STORAGE_KEY);
        const parsed: unknown = raw === null ? [] : JSON.parse(raw);
        const stored = Array.isArray(parsed) ? parsed.filter(isEntry) : [];
        if (stored.length > 0) setEntries([...stored, ...entries]);
      } catch (error) {
        logger.warning('PendingConfirms', 'Could not read the queue', { error: String(error) });
      }
      await dropExpired();
    })();
    return loaded;
  };

  /**
   * purpose: Add a press and store it before resolving.
   * @param entry: (PendingConfirm) The press.
   * @return: (Promise<void>) Resolves once stored (or when the instance is already queued).
   * @raises: The storage error when the press could not be stored; the queue is left as it was.
   */
  const enqueue = async (entry: PendingConfirm): Promise<void> => {
    await load();
    if (entries.some((e) => e.instanceId === entry.instanceId)) return;
    const before = entries;
    setEntries([...entries, entry]);
    try {
      await persist();
    } catch (error) {
      setEntries(before);
      throw error;
    }
  };

  /**
   * purpose: One pass over the queue, oldest first.
   * @return: (Promise<void>) Resolves when the queue is empty or an entry could not be answered.
   */
  const pass = async (): Promise<void> => {
    await load();
    await dropExpired();
    for (const entry of [...entries]) {
      try {
        await withTimeout(options.send(entry));
        await remove(entry.instanceId);
      } catch (error) {
        if (isTransient(error)) break;
        await remove(entry.instanceId);
        reject({ entry, reason: 'rejected', detail: toBackendError(error).message });
      }
    }
    clearTimeout(retryTimer);
    if (entries.length > 0) retryTimer = setTimeout(() => void replay(), RETRY_MS);
  };

  /**
   * purpose: Run a pass, or join the one already running (one send at a time overall).
   * @return: (Promise<void>) Resolves when that pass ends.
   */
  const replay = (): Promise<void> => {
    replaying ??= pass().finally(() => {
      replaying = null;
    });
    return replaying;
  };

  return {
    load,
    enqueue,
    replay,
    getEntries: () => entries,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    onRejection: (listener) => {
      rejectionListeners.add(listener);
      return () => void rejectionListeners.delete(listener);
    },
  };
}

/** The app's queue, sending through the real backend. */
export const confirmQueue: ConfirmQueue = createConfirmQueue({ send: sendConfirm });

/**
 * purpose: The task a queued press was made for, as an entry.
 * @param task: (Pick<DayTask, 'instanceId' | 'displayLabel'>) The task.
 * @param pressedAt: (number) Epoch ms of the press.
 * @return: (PendingConfirm) The entry.
 */
export function toPending(
  task: Pick<DayTask, 'instanceId' | 'displayLabel'>,
  pressedAt: number,
): PendingConfirm {
  return { instanceId: task.instanceId, label: task.displayLabel, pressedAt };
}

/**
 * purpose: Show queued tasks as confirmed, so the list reads checked and the Done card does
 *          not offer them again until the server catches up.
 * @param tasks: (DayTask[]) The day view's tasks.
 * @param pendingIds: (ReadonlySet<string>) Instance ids with a queued press.
 * @return: (DayTask[]) The same tasks, those queued marked confirmed and not confirmable.
 */
export function applyPending(tasks: DayTask[], pendingIds: ReadonlySet<string>): DayTask[] {
  if (pendingIds.size === 0) return tasks;
  return tasks.map((task) =>
    pendingIds.has(task.instanceId) && task.state !== 'confirmed' && task.state !== 'resolved'
      ? { ...task, state: 'confirmed', confirmable: false }
      : task,
  );
}
