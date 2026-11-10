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
//     treated as an empty queue and stored presses are never overwritten. The entry shows in
//     getEntries (and so the task reads checked) only once its write has finished; presses are
//     added one at a time.
//  2. replay() sends entries oldest first, one at a time, through instances.confirmPressedTask
//     with via "phone_app" and pressedAgoMs, the age of the press at send time. An age, not a
//     time, so a wrong device clock cannot move the record; the server records now minus the
//     age. Replay runs after every enqueue while online, at launch, whenever the socket
//     connects (the queue follows the Convex connection itself from its first use, so it
//     keeps working while no screen is mounted) and again after the retry delay while
//     entries remain.
//  3. Never send while the socket is down. The Convex client never rejects a mutation while it
//     is disconnected: it holds the original message and resends it on reconnect, so an age
//     computed at call time would be hours stale when it arrives and would look like a live
//     press. sendConfirm therefore checks convex.connectionState().isWebSocketConnected
//     immediately before computing the age and calling, and treats "not connected" as no answer
//     (the entry stays, the pass ends). This also covers a fresh launch, where isOffline is
//     false until the first connect. The pass re-checks offline and the generation at the top
//     of every iteration. One race remains: the socket can drop between the check and the
//     server's acknowledgement; the held message then goes out on reconnect with its age from
//     send time, so the record errs late, by at most the time the client needs to notice the
//     drop (its ping detection), and the server still marks it late-synced if over 5 minutes.
//     The queue keeps one send promise per instance id and re-awaits it on later passes instead
//     of calling again, so retries never pile up held mutations; a held send that lands later
//     removes its entry. A send unanswered for SEND_MAX_LIFETIME_MS is abandoned and a fresh
//     one may start (only while connected; the server is idempotent, so whichever lands first
//     records the press and the other changes nothing).
//  4. An entry is removed only when the server has answered: success (the backend confirm is
//     idempotent for an instance that is already confirmed and writes no second audit row), a
//     "rejected" result (the server could not apply the press and wrote an audit row, see
//     confirmPressedTask), or any other permanent error (a BackendError status other than 0,
//     401 and 429: the device is no longer paired, ...).
//  5. No answer at all (network error, SEND_TIMEOUT_MS, not connected, 401 which can be a brief
//     sign-in hiccup, 429) keeps the entry and ends the pass. By design that blocks the entries
//     behind it, including during a sustained 401: order matters and nothing behind it could
//     succeed either. A server error (status 0 with another message) keeps the entry and moves
//     on to the next one, with per-entry backoff (BACKOFF_MS). A pass walks the live queue, so a
//     press made during a pass is sent in it.
//  6. A rejected or expired entry (older than MAX_AGE_MS, which also clears entries left from
//     previous days) is logged as an error with the instance id, label, press time and reason.
//     The senior is told nothing: the row follows the server's state. An entry that has failed
//     while online for more than STUCK_MS (any failure kind, so a sustained 401 counts) is logged
//     as an error once when it crosses the threshold and then every STUCK_LOG_EVERY_MS. Offline
//     time is not counted (a failure's clock moves forward by the time spent offline) while its
//     backoff schedule is kept across a drop.
//  7. Storage: a read that throws is retried on the next call (and logged as an error after
//     several in a row); a stored value that does not parse or is not an array is copied to
//     CORRUPT_KEY, logged as an error, and the queue starts empty and usable.
//  8. clear() (unpair, and again at pairing) drops everything: memory, storage (on the write
//     chain, so a queued write cannot restore it), timer and in-flight sends, and logs what was
//     dropped. A load, write or pass that started before clear() is discarded (generation
//     counter), so entries from one pairing are never sent or shown under another.
//
// The optimistic display (a queued task shows as checked and is not offered again) reads the
// entries; it ends when the entry is removed.
//
// Last modified: 2026-11-09

import AsyncStorage from '@react-native-async-storage/async-storage';

import { BackendError, callMutation, OFFLINE_ERROR_MESSAGE, toBackendError } from '../backend/api';
import { convex } from '../backend/convex';
import { api } from '../backend/convexApi';
import { logger } from '../logging/logger';
import type { DayTask } from './types';
import { withTimeout } from './withTimeout';

/** AsyncStorage key of the persisted queue. */
export const STORAGE_KEY = 'sunny.pendingConfirms.v1';

/** AsyncStorage key a stored value that cannot be parsed is copied to. */
export const CORRUPT_KEY = `${STORAGE_KEY}.corrupt`;

/** Entries older than this (ms since the press) are dropped as expired. */
export const MAX_AGE_MS = 48 * 60 * 60 * 1000;

/** How long (ms) a send may stay unanswered before the pass ends and the entry is kept. */
export const SEND_TIMEOUT_MS = 15_000;

/** A send still unanswered after this long (ms) is abandoned and a fresh one may start. */
export const SEND_MAX_LIFETIME_MS = 2 * 60 * 1000;

/** How long (ms) after a pass that left entries behind the next pass runs by itself. */
export const RETRY_MS = 30_000;

/** Waits (ms) before retrying after the first, second, ... server error; the last repeats. */
export const BACKOFF_MS = [30_000, 60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000];

/** An entry failing while online for longer than this (ms) is logged loudly. */
export const STUCK_MS = 10 * 60 * 1000;

/** After the first stuck log, the next ones follow this far (ms) apart. */
export const STUCK_LOG_EVERY_MS = 60 * 60 * 1000;

/** Reads that failed this many times in a row are logged as an error. */
export const READ_FAILURES_LOUD = 3;

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

/** What the queue needs to know about the connection. */
export interface ConnectionState {
  /** The socket is connected right now. */
  connected: boolean;
  /** The socket was up once and is now down (false on a fresh launch before the first connect). */
  offline: boolean;
}

/** Where the queue learns about the connection, for as long as the app lives. */
export interface ConnectionSource {
  current: () => ConnectionState;
  subscribe: (listener: (state: ConnectionState) => void) => () => void;
}

/** Options of createConfirmQueue. */
export interface QueueOptions {
  send: SendConfirm;
  /** The clock; defaults to Date.now. */
  now?: () => number;
  /**
   * The connection. When given, the queue follows it by itself from its first use: it tracks
   * offline and replays whenever the socket connects, whatever screen is mounted.
   */
  connection?: ConnectionSource;
}

/** What is known about an entry that keeps failing. */
interface Failure {
  attempts: number;
  /** When it first failed while online. */
  since: number;
  /** Do not try again before this time (server errors only). */
  nextAt?: number;
  /** When the stuck error was last logged. */
  lastLoggedAt?: number;
}

/**
 * purpose: Send one entry to the backend as a senior device. Refuses to call while the socket
 *          is down (see the header), and computes the press age immediately before the call.
 * @param entry: (PendingConfirm) The press.
 * @return: (Promise<void>) Resolves when the server applied it.
 * @raises: BackendError status 0 (offline message) when not connected; BackendError status
 *          400 with the server's reason when the server answered "rejected"; BackendError
 *          for any other failure of the call.
 */
export async function sendConfirm(entry: PendingConfirm): Promise<void> {
  if (!convex.connectionState().isWebSocketConnected) {
    throw new BackendError(OFFLINE_ERROR_MESSAGE, 0);
  }
  const result = await callMutation(api.instances.confirmPressedTask, {
    instanceId: entry.instanceId,
    via: 'phone_app',
    pressedAgoMs: Math.max(0, Date.now() - entry.pressedAt),
  });
  if (result.status === 'rejected') throw new BackendError(result.reason, 400);
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
 * purpose: Create a pending-confirm queue over AsyncStorage.
 * @param options: (QueueOptions) The send function and an optional clock.
 * @return: (ConfirmQueue) The queue.
 */
export function createConfirmQueue(options: QueueOptions): ConfirmQueue {
  const now = options.now ?? Date.now;
  let entries: readonly PendingConfirm[] = [];
  let loading: Promise<void> | null = null;
  let loadedOk = false;
  let readFailures = 0;
  let replaying: Promise<void> | null = null;
  let writes: Promise<void> = Promise.resolve();
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let generation = 0;
  let offline = false;
  let adding: PendingConfirm | null = null;
  let addChain: Promise<void> = Promise.resolve();
  let offlineSince: number | null = null;
  let watching = false;
  const inflight = new Map<string, { send: Promise<void>; startedAt: number }>();
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
   * purpose: Write the queue to storage, after earlier writes finished. The snapshot is taken
   *          when the write starts and includes a press still being added, so a write queued
   *          behind a slow one never drops it. Skipped if clear() ran meanwhile.
   * @return: (Promise<void>) Resolves when written; rejects when storage fails or the stored
   *          queue has not been read yet (so stored presses are never overwritten).
   */
  const persist = (): Promise<void> => {
    if (!loadedOk) return Promise.reject(new Error('The stored queue has not been read'));
    const gen = generation;
    const write = writes.then(() => {
      if (gen !== generation) return undefined;
      const all = adding === null ? entries : [...entries, adding];
      return AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(all));
    });
    writes = write.catch(() => undefined);
    return write;
  };

  /**
   * purpose: Log an entry that left the queue without the server applying it.
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
   * purpose: Remove one entry, persist the removal and tell subscribers. Does nothing if
   *          clear() ran since `gen`.
   * @param instanceId: (string) The entry's instance.
   * @param gen: (number) The generation the caller started in.
   * @return: (Promise<void>) Resolves when the removal is stored (a storage failure is logged;
   *          the entry would then be sent again later, which is harmless).
   */
  const remove = async (instanceId: string, gen: number): Promise<void> => {
    if (gen !== generation) return;
    failures.delete(instanceId);
    if (!entries.some((e) => e.instanceId === instanceId)) return;
    setEntries(entries.filter((e) => e.instanceId !== instanceId));
    await persist().catch((error: unknown) =>
      logger.warning('PendingConfirms', 'Could not store the queue', { error: String(error) }),
    );
  };

  /**
   * purpose: Drop entries older than MAX_AGE_MS, logging each as expired.
   * @param gen: (number) The generation the caller started in.
   * @return: (Promise<void>) Resolves when the removals are stored.
   */
  const dropExpired = async (gen: number): Promise<void> => {
    const expired = entries.filter((e) => now() - e.pressedAt > MAX_AGE_MS);
    for (const entry of expired) {
      if (gen !== generation) return;
      await remove(entry.instanceId, gen);
      logDropped(entry, 'expired', 'The press is too old to send.');
    }
  };

  /**
   * purpose: Keep a stored value that cannot be used, so nothing is lost silently.
   * @param raw: (string) The stored text.
   * @return: (Promise<void>) Resolves when copied (a failure is logged).
   */
  const quarantine = async (raw: string): Promise<void> => {
    logger.error('PendingConfirms', 'The stored queue was corrupt; starting empty', {
      length: raw.length,
      copiedTo: CORRUPT_KEY,
    });
    await AsyncStorage.setItem(CORRUPT_KEY, raw).catch((error: unknown) =>
      logger.warning('PendingConfirms', 'Could not copy the corrupt queue', {
        error: String(error),
      }),
    );
  };

  /**
   * purpose: Read the persisted entries once and drop expired ones. Resolves either way. A read
   *          that throws is retried on the next call and nothing is persisted meanwhile; a
   *          value that does not parse (or is not an array) is quarantined and the queue
   *          starts empty. A clear() during the read discards its result.
   * @return: (Promise<void>) Resolves when the attempt ended.
   */
  const load = (): Promise<void> => {
    loading ??= (async () => {
      const gen = generation;
      let raw: string | null;
      try {
        await writes; // a removal or write already queued lands first, so this read is current
        raw = await AsyncStorage.getItem(STORAGE_KEY);
      } catch (error) {
        readFailures += 1;
        const log = readFailures === READ_FAILURES_LOUD ? logger.error : logger.warning;
        log('PendingConfirms', 'Could not read the queue', {
          error: String(error),
          failuresInARow: readFailures,
        });
        if (gen === generation) loading = null;
        return;
      }
      if (gen !== generation) return;
      readFailures = 0;
      let stored: PendingConfirm[] = [];
      if (raw !== null) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch {
          parsed = undefined;
        }
        if (Array.isArray(parsed)) stored = parsed.filter(isEntry);
        else await quarantine(raw);
      }
      if (gen !== generation) return;
      const known = new Set(entries.map((e) => e.instanceId));
      setEntries([...stored.filter((e) => !known.has(e.instanceId)), ...entries]);
      loadedOk = true;
      await dropExpired(gen);
    })();
    watchConnection();
    return loading;
  };

  /**
   * purpose: Store one press, then make it visible. Presses are added one at a time, so each
   *          write snapshot is complete; the entry is not in getEntries (the task does not read
   *          checked) until its write has finished.
   * @param entry: (PendingConfirm) The press.
   * @param gen: (number) The generation when the press was queued; a clear() since then drops it.
   * @return: (Promise<void>) Resolves once stored (or when the instance is already queued).
   * @raises: An error when the stored queue could not be read, the press could not be stored,
   *          or the queue was cleared first.
   */
  const add = async (entry: PendingConfirm, gen: number): Promise<void> => {
    await load();
    if (gen !== generation) throw new Error('The queue was cleared');
    if (!loadedOk) throw new Error('The stored queue could not be read');
    if (entries.some((e) => e.instanceId === entry.instanceId)) return;
    adding = entry;
    try {
      await persist();
    } finally {
      adding = null;
    }
    if (gen === generation) setEntries([...entries, entry]);
  };

  /**
   * purpose: Queue a press, stored before the returned promise resolves.
   * @param entry: (PendingConfirm) The press.
   * @return: (Promise<void>) Resolves once stored; rejects if it could not be stored.
   */
  const enqueue = (entry: PendingConfirm): Promise<void> => {
    const gen = generation;
    const run = addChain.then(() => add(entry, gen));
    addChain = run.catch(() => undefined);
    return run;
  };

  /**
   * purpose: Start a send for an entry, or return the one already running for its instance. A
   *          send still unanswered after SEND_MAX_LIFETIME_MS is abandoned and a fresh one
   *          starts (sendConfirm only calls while the socket is connected, and the server is
   *          idempotent, so whichever lands first records the press and the other changes
   *          nothing). A send that lands after the pass gave up removes its entry.
   * @param entry: (PendingConfirm) The entry.
   * @param gen: (number) The generation the pass started in.
   * @return: (Promise<void>) The send.
   */
  const sendOnce = (entry: PendingConfirm, gen: number): Promise<void> => {
    const running = inflight.get(entry.instanceId);
    if (running !== undefined && now() - running.startedAt <= SEND_MAX_LIFETIME_MS) {
      return running.send;
    }
    const send = options.send(entry);
    inflight.set(entry.instanceId, { send, startedAt: now() });
    const forget = (): void => {
      if (inflight.get(entry.instanceId)?.send === send) inflight.delete(entry.instanceId);
    };
    send.then(() => {
      forget();
      void remove(entry.instanceId, gen);
    }, forget);
    return send;
  };

  /**
   * purpose: Note a failed send: count it, set the backoff for a server error, and log loudly
   *          (once, then hourly) when the entry has been failing online for STUCK_MS.
   * @param entry: (PendingConfirm) The entry.
   * @param error: (unknown) What the send threw.
   * @param kind: (FailureKind) How the failure was classified.
   * @return: (void)
   */
  const noteFailure = (entry: PendingConfirm, error: unknown, kind: FailureKind): void => {
    if (offline) return;
    const t = now();
    const known = failures.get(entry.instanceId) ?? { attempts: 0, since: t };
    const attempts = known.attempts + 1;
    const next: Failure = {
      attempts,
      since: known.since,
      lastLoggedAt: known.lastLoggedAt,
      nextAt:
        kind === 'server_error'
          ? t + BACKOFF_MS[Math.min(attempts - 1, BACKOFF_MS.length - 1)]!
          : undefined,
    };
    const stuck = t - next.since > STUCK_MS;
    if (stuck && (next.lastLoggedAt === undefined || t - next.lastLoggedAt >= STUCK_LOG_EVERY_MS)) {
      next.lastLoggedAt = t;
      logger.error('PendingConfirms', 'A queued Done has failed for over 10 minutes while online', {
        instanceId: entry.instanceId,
        label: entry.label,
        pressedAt: entry.pressedAt,
        attempts,
        error: toBackendError(error).message,
      });
    }
    failures.set(entry.instanceId, next);
  };

  /**
   * purpose: Schedule the next pass: at the earliest backoff end among the entries, or after
   *          RETRY_MS for entries without one. Nothing is scheduled while offline.
   * @param gen: (number) The generation the pass started in.
   * @return: (void)
   */
  const scheduleNext = (gen: number): void => {
    clearTimeout(retryTimer);
    if (entries.length === 0 || offline || gen !== generation) return;
    const t = now();
    const waits = entries.map((e) => {
      const nextAt = failures.get(e.instanceId)?.nextAt;
      return nextAt === undefined ? RETRY_MS : nextAt - t;
    });
    retryTimer = setTimeout(() => void replay(), Math.max(1000, Math.min(...waits)));
  };

  /**
   * purpose: One pass over the live queue, oldest first. Offline and the generation are
   *          re-checked before every send.
   * @return: (Promise<void>) Resolves when every entry was tried or one got no answer.
   */
  const pass = async (): Promise<void> => {
    const gen = generation;
    await load();
    if (!loadedOk || offline || gen !== generation) return;
    await dropExpired(gen);
    const tried = new Set<string>();
    for (;;) {
      if (offline || gen !== generation) return;
      const entry = entries.find((e) => !tried.has(e.instanceId));
      if (entry === undefined) break;
      tried.add(entry.instanceId);
      const waitUntil = failures.get(entry.instanceId)?.nextAt;
      if (waitUntil !== undefined && waitUntil > now()) continue;
      try {
        await withTimeout(sendOnce(entry, gen), SEND_TIMEOUT_MS, 'Network request timed out');
        await remove(entry.instanceId, gen);
      } catch (error) {
        if (gen !== generation) return;
        const kind = classifyFailure(error);
        if (kind === 'permanent') {
          await remove(entry.instanceId, gen);
          logDropped(entry, 'rejected', toBackendError(error).message);
          continue;
        }
        noteFailure(entry, error, kind);
        if (kind === 'no_answer') break;
      }
    }
    scheduleNext(gen);
  };

  /**
   * purpose: Run a pass, or join the one already running (one pass at a time overall).
   * @return: (Promise<void>) Resolves when that pass ends.
   */
  const replay = (): Promise<void> => {
    if (replaying !== null) return replaying;
    const run: Promise<void> = pass().finally(() => {
      if (replaying === run) replaying = null;
    });
    replaying = run;
    return run;
  };

  /**
   * purpose: Record whether the connection is known to be down. Going offline stops the retry
   *          timer. Backoff schedules are kept across a drop; coming back online moves each
   *          failure's start forward by the time spent offline, so offline time never counts
   *          toward the stuck threshold.
   * @param next: (boolean) True when offline.
   * @return: (void)
   */
  const setOffline = (next: boolean): void => {
    if (next === offline) return;
    if (next) {
      offlineSince = now();
      clearTimeout(retryTimer);
    } else if (offlineSince !== null) {
      const away = now() - offlineSince;
      for (const [id, failure] of failures)
        failures.set(id, { ...failure, since: failure.since + away });
      offlineSince = null;
    }
    offline = next;
  };

  /**
   * purpose: Follow the connection source, once, for as long as the app lives: track offline
   *          and replay whenever the socket connects. This is what keeps queued presses
   *          flowing when no screen is mounted (for example during a voice conversation).
   * @return: (void)
   */
  const watchConnection = (): void => {
    const source = options.connection;
    if (watching || source === undefined) return;
    watching = true;
    const apply = (state: ConnectionState): void => {
      setOffline(state.offline);
      if (state.connected) void replay();
    };
    apply(source.current());
    source.subscribe(apply);
  };

  /**
   * purpose: Forget every queued press (the device was unpaired or is pairing), logging what
   *          was dropped. The storage removal is chained after earlier writes.
   * @return: (Promise<void>) Resolves when storage is cleared (a storage failure is logged).
   */
  const clear = async (): Promise<void> => {
    generation += 1;
    clearTimeout(retryTimer);
    inflight.clear();
    failures.clear();
    adding = null;
    offlineSince = null;
    const dropped = entries;
    loading = null;
    loadedOk = false;
    replaying = null;
    readFailures = 0;
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
    const removal = writes.then(() => AsyncStorage.removeItem(STORAGE_KEY));
    writes = removal.catch(() => undefined);
    await removal.catch((error: unknown) =>
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

/**
 * purpose: Reduce the Convex client's connection state to what the queue needs.
 * @param state: (ReturnType<typeof convex.connectionState>) The client's connection state.
 * @return: (ConnectionState) Connected now, and offline (was up once, now down).
 */
function toConnectionState(state: ReturnType<typeof convex.connectionState>): ConnectionState {
  return {
    connected: state.isWebSocketConnected,
    offline: state.hasEverConnected && !state.isWebSocketConnected,
  };
}

/** The app's queue, sending through the real backend and following the Convex connection. */
export const confirmQueue: ConfirmQueue = createConfirmQueue({
  send: sendConfirm,
  connection: {
    current: () => toConnectionState(convex.connectionState()),
    subscribe: (listener) =>
      convex.subscribeToConnectionState((state) => listener(toConnectionState(state))),
  },
});

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
