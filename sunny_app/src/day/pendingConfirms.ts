// sunny_app/src/day/pendingConfirms.ts
//
// Purpose: A small durable queue of Done presses that the server has not acknowledged yet, so
// pressing Done works the same with or without a connection. Written for both senior surfaces
// (the phone now, the home display later); it knows nothing about screens.
//
// Lifecycle of an entry:
//  1. enqueue() writes it to AsyncStorage and only then resolves, so the caller may show
//     "checked off" knowing the press survives an app close or a restart. The entry records the
//     instance id, its label and pressedAt (epoch ms on this device's clock). enqueue refuses
//     (rejects) while the stored queue has not been read successfully, so a failed read is never
//     treated as an empty queue and stored presses are never overwritten.
//  2. replay() sends entries oldest first, one at a time, through instances.confirmTaskInstance
//     with via "phone_app" and pressedAgoMs, the age of the press at send time. An age, not a
//     time, so a wrong device clock cannot move the record; the server records now minus the
//     age. Replay runs after every enqueue while online, at launch and when the connection
//     returns (usePendingConfirms calls replay and setOffline), and again after RETRY_MS while
//     entries remain. While the connection is known to be down, replay does nothing. The queue
//     keeps one send promise per instance id and re-awaits it on later passes instead of calling
//     again, so retries do not pile up held mutations in the Convex client; a held send that
//     lands later removes its entry.
//  3. An entry is removed only when the server has answered: success (the backend confirm is
//     idempotent for an instance that is already confirmed and writes no second audit row), or
//     a permanent rejection (a BackendError status other than 0, 401 and 429: the instance no
//     longer exists, the device is no longer paired, the confirm was refused). No answer at all
//     (network error, SEND_TIMEOUT_MS, 401 which can be a brief sign-in hiccup, 429) keeps the
//     entry and ends the pass; a server error (status 0 with another message) keeps the entry
//     and moves on to the next one, so one bad entry never blocks the rest. A pass walks the
//     live queue, so a press made during a pass is sent in it.
//  4. A rejected or expired entry (older than MAX_AGE_MS, which also clears entries left from
//     previous days) is logged as an error with the instance id, label, press time and reason.
//     The senior is told nothing: the row simply follows the server's state. An entry that has
//     failed while online for more than STUCK_MS is logged as an error on every pass, because
//     the phone would be showing a check while the server escalates.
//  5. clear() (unpair) drops everything: memory, storage, timer and in-flight sends, and logs
//     what was dropped, so entries from one pairing are never sent or shown under another.
//
// The optimistic display (a queued task shows as checked and is not offered again) reads the
// entries; it ends when the entry is removed.
//
// Last modified: 2026-11-09

import AsyncStorage from '@react-native-async-storage/async-storage';

import { callMutation, OFFLINE_ERROR_MESSAGE, toBackendError } from '../backend/api';
import { api } from '../backend/convexApi';
import { logger } from '../logging/logger';
import type { DayTask } from './types';

/** AsyncStorage key of the persisted queue. */
export const STORAGE_KEY = 'sunny.pendingConfirms.v1';

/** Entries older than this (ms since the press) are dropped as expired. */
export const MAX_AGE_MS = 48 * 60 * 60 * 1000;

/** How long (ms) a send may stay unanswered before the pass ends and the entry is kept. */
export const SEND_TIMEOUT_MS = 15_000;

/** How long (ms) after a pass that left entries behind the next pass runs by itself. */
export const RETRY_MS = 30_000;

/** An entry failing while online for longer than this (ms) is logged loudly. */
export const STUCK_MS = 10 * 60 * 1000;

/** One Done press waiting for the server. */
export interface PendingConfirm {
  /** The task instance the senior confirmed. */
  instanceId: DayTask['instanceId'];
  /** The task's label, for logs. */
  label: string;
  /** When the senior pressed Done (epoch ms, this device's clock). */
  pressedAt: number;
}

/** Sends one entry; throws when the server did not accept it. */
export type SendConfirm = (entry: PendingConfirm) => Promise<void>;

/** How a failed send is handled. */
export type FailureKind = 'permanent' | 'no_answer' | 'server_error';

/** The queue returned by createConfirmQueue. */
export interface ConfirmQueue {
  /** Read the persisted entries (retried on the next call if it failed) and drop expired ones. */
  load: () => Promise<void>;
  /** Persist an entry, then resolve; an instance already queued is not queued twice. */
  enqueue: (entry: PendingConfirm) => Promise<void>;
  /** Send queued entries oldest first (does nothing while offline or before a successful load). */
  replay: () => Promise<void>;
  /** Tell the queue whether the connection is known to be down. */
  setOffline: (offline: boolean) => void;
  /** Drop everything (memory, storage, timer, in-flight sends) and log what was dropped. */
  clear: () => Promise<void>;
  /** The current entries; the array is replaced on every change. */
  getEntries: () => readonly PendingConfirm[];
  /** Call the listener after every change to the entries. */
  subscribe: (listener: () => void) => () => void;
}

/** Options of createConfirmQueue. */
export interface QueueOptions {
  send: SendConfirm;
  /** The clock; defaults to Date.now. */
  now?: () => number;
}

/** What is known about an entry that keeps failing. */
interface Failure {
  attempts: number;
  /** When it first failed while online. */
  since: number;
}

/**
 * purpose: Send one entry to the backend as a senior device.
 * @param entry: (PendingConfirm) The press.
 * @return: (Promise<void>) Resolves when the server accepted it.
 * @raises: BackendError when the call failed.
 */
export async function sendConfirm(entry: PendingConfirm): Promise<void> {
  await callMutation(api.instances.confirmTaskInstance, {
    instanceId: entry.instanceId,
    via: 'phone_app',
    pressedAgoMs: Math.max(0, Date.now() - entry.pressedAt),
  });
}

/**
 * purpose: Decide what a failed send means for its entry.
 * @param error: (unknown) What the send threw.
 * @return: (FailureKind) 'no_answer' for a lost connection, a timeout, 401 (a brief sign-in
 *          hiccup, not a removed device, which is 403) and 429; 'server_error' for a status 0
 *          failure that is not a lost connection; otherwise 'permanent'.
 */
export function classifyFailure(error: unknown): FailureKind {
  const { status, message } = toBackendError(error);
  if (status === 401 || status === 429) return 'no_answer';
  if (status === 0) return message === OFFLINE_ERROR_MESSAGE ? 'no_answer' : 'server_error';
  return 'permanent';
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
  let loading: Promise<void> | null = null;
  let loadedOk = false;
  let replaying: Promise<void> | null = null;
  let writes: Promise<void> = Promise.resolve();
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let generation = 0;
  let offline = false;
  const inflight = new Map<string, Promise<void>>();
  const failures = new Map<string, Failure>();
  const listeners = new Set<() => void>();

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
   * @return: (Promise<void>) Resolves when written; rejects when storage fails or the stored
   *          queue has not been read yet (so stored presses are never overwritten).
   */
  const persist = (): Promise<void> => {
    if (!loadedOk) return Promise.reject(new Error('The stored queue has not been read'));
    const snapshot = JSON.stringify(entries);
    const write = writes.then(() => AsyncStorage.setItem(STORAGE_KEY, snapshot));
    writes = write.catch(() => undefined);
    return write;
  };

  /**
   * purpose: Log an entry that left the queue without the server accepting it.
   * @param entry: (PendingConfirm) The entry.
   * @param reason: ('rejected' | 'expired') Why it left.
   * @param detail: (string) The server's message, or a note.
   * @return: (void)
   */
  const logDropped = (
    entry: PendingConfirm,
    reason: 'rejected' | 'expired',
    detail: string,
  ): void => {
    logger.error('PendingConfirms', `Dropped a queued Done (${reason})`, {
      instanceId: entry.instanceId,
      label: entry.label,
      pressedAt: entry.pressedAt,
      reason,
      detail,
    });
  };

  /**
   * purpose: Remove one entry, persist the removal and tell subscribers.
   * @param instanceId: (string) The entry's instance.
   * @return: (Promise<void>) Resolves when the removal is stored (a storage failure is logged;
   *          the entry would then be sent again later, which is harmless).
   */
  const remove = async (instanceId: string): Promise<void> => {
    failures.delete(instanceId);
    if (!entries.some((e) => e.instanceId === instanceId)) return;
    setEntries(entries.filter((e) => e.instanceId !== instanceId));
    await persist().catch((error: unknown) =>
      logger.warning('PendingConfirms', 'Could not store the queue', { error: String(error) }),
    );
  };

  /**
   * purpose: Drop entries older than MAX_AGE_MS, logging each as expired.
   * @return: (Promise<void>) Resolves when the removals are stored.
   */
  const dropExpired = async (): Promise<void> => {
    const expired = entries.filter((e) => now() - e.pressedAt > MAX_AGE_MS);
    for (const entry of expired) {
      await remove(entry.instanceId);
      logDropped(entry, 'expired', 'The press is too old to send.');
    }
  };

  /**
   * purpose: Read the persisted entries once and drop expired ones. Resolves either way; after
   *          a failed read the next call reads again and nothing is persisted meanwhile.
   * @return: (Promise<void>) Resolves when the attempt ended.
   */
  const load = (): Promise<void> => {
    loading ??= (async () => {
      try {
        const raw = await AsyncStorage.getItem(STORAGE_KEY);
        const parsed: unknown = raw === null ? [] : JSON.parse(raw);
        const stored = Array.isArray(parsed) ? parsed.filter(isEntry) : [];
        const known = new Set(entries.map((e) => e.instanceId));
        setEntries([...stored.filter((e) => !known.has(e.instanceId)), ...entries]);
        loadedOk = true;
      } catch (error) {
        logger.warning('PendingConfirms', 'Could not read the queue', { error: String(error) });
        loading = null;
        return;
      }
      await dropExpired();
    })();
    return loading;
  };

  /**
   * purpose: Add a press and store it before resolving.
   * @param entry: (PendingConfirm) The press.
   * @return: (Promise<void>) Resolves once stored (or when the instance is already queued).
   * @raises: An error when the stored queue could not be read or the press could not be
   *          stored; only the new entry is rolled back.
   */
  const enqueue = async (entry: PendingConfirm): Promise<void> => {
    await load();
    if (!loadedOk) throw new Error('The stored queue could not be read');
    if (entries.some((e) => e.instanceId === entry.instanceId)) return;
    setEntries([...entries, entry]);
    try {
      await persist();
    } catch (error) {
      setEntries(entries.filter((e) => e.instanceId !== entry.instanceId));
      throw error;
    }
  };

  /**
   * purpose: Start a send for an entry, or return the one already running for its instance. A
   *          send that lands after the pass gave up removes its entry.
   * @param entry: (PendingConfirm) The entry.
   * @param gen: (number) The generation the pass started in.
   * @return: (Promise<void>) The send.
   */
  const sendOnce = (entry: PendingConfirm, gen: number): Promise<void> => {
    const running = inflight.get(entry.instanceId);
    if (running !== undefined) return running;
    const send = options.send(entry);
    inflight.set(entry.instanceId, send);
    send.then(
      () => {
        if (inflight.get(entry.instanceId) === send) inflight.delete(entry.instanceId);
        if (gen === generation) void remove(entry.instanceId);
      },
      () => {
        if (inflight.get(entry.instanceId) === send) inflight.delete(entry.instanceId);
      },
    );
    return send;
  };

  /**
   * purpose: Note a failed send; log loudly when it has been failing online for STUCK_MS.
   * @param entry: (PendingConfirm) The entry.
   * @param error: (unknown) What the send threw.
   * @return: (void)
   */
  const noteFailure = (entry: PendingConfirm, error: unknown): void => {
    if (offline) return;
    const known = failures.get(entry.instanceId) ?? { attempts: 0, since: now() };
    const next = { attempts: known.attempts + 1, since: known.since };
    failures.set(entry.instanceId, next);
    if (now() - next.since > STUCK_MS) {
      logger.error('PendingConfirms', 'A queued Done has failed for over 10 minutes while online', {
        instanceId: entry.instanceId,
        label: entry.label,
        pressedAt: entry.pressedAt,
        attempts: next.attempts,
        error: toBackendError(error).message,
      });
    }
  };

  /**
   * purpose: One pass over the live queue, oldest first.
   * @return: (Promise<void>) Resolves when every entry was tried or one got no answer.
   */
  const pass = async (): Promise<void> => {
    const gen = generation;
    await load();
    if (!loadedOk || offline || gen !== generation) return;
    await dropExpired();
    const tried = new Set<string>();
    for (;;) {
      const entry = entries.find((e) => !tried.has(e.instanceId));
      if (entry === undefined) break;
      tried.add(entry.instanceId);
      try {
        await withTimeout(sendOnce(entry, gen));
        if (gen !== generation) return;
        await remove(entry.instanceId);
      } catch (error) {
        if (gen !== generation) return;
        const kind = classifyFailure(error);
        if (kind === 'permanent') {
          await remove(entry.instanceId);
          logDropped(entry, 'rejected', toBackendError(error).message);
          continue;
        }
        noteFailure(entry, error);
        if (kind === 'no_answer') break;
      }
    }
    clearTimeout(retryTimer);
    if (entries.length > 0 && !offline && gen === generation) {
      retryTimer = setTimeout(() => void replay(), RETRY_MS);
    }
  };

  /**
   * purpose: Run a pass, or join the one already running (one pass at a time overall).
   * @return: (Promise<void>) Resolves when that pass ends.
   */
  const replay = (): Promise<void> => {
    replaying ??= pass().finally(() => {
      replaying = null;
    });
    return replaying;
  };

  /**
   * purpose: Record whether the connection is known to be down; going offline stops the retry
   *          timer.
   * @param next: (boolean) True when offline.
   * @return: (void)
   */
  const setOffline = (next: boolean): void => {
    offline = next;
    if (next) clearTimeout(retryTimer);
  };

  /**
   * purpose: Forget every queued press (the device was unpaired), logging what was dropped.
   * @return: (Promise<void>) Resolves when storage is cleared (a storage failure is logged).
   */
  const clear = async (): Promise<void> => {
    generation += 1;
    clearTimeout(retryTimer);
    inflight.clear();
    failures.clear();
    const dropped = entries;
    loading = null;
    loadedOk = false;
    replaying = null;
    if (dropped.length > 0) {
      logger.error('PendingConfirms', 'Dropped queued Done presses on unpair', {
        count: dropped.length,
        entries: dropped.map((e) => ({
          instanceId: e.instanceId,
          label: e.label,
          pressedAt: e.pressedAt,
        })),
      });
    }
    setEntries([]);
    await AsyncStorage.removeItem(STORAGE_KEY).catch((error: unknown) =>
      logger.warning('PendingConfirms', 'Could not clear the stored queue', {
        error: String(error),
      }),
    );
  };

  return {
    load,
    enqueue,
    replay,
    setOffline,
    clear,
    getEntries: () => entries,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
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
