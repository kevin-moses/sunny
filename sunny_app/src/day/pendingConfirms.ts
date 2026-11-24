import AsyncStorage from '@react-native-async-storage/async-storage';

import { BackendError, callMutation, OFFLINE_ERROR_MESSAGE, toBackendError } from '../backend/api';
import { convex } from '../backend/convex';
import { api } from '../backend/convexApi';
import { logger } from '../logging/logger';
import {
  describeEntry,
  entryKey,
  entryTime,
  entryWhat,
  isEntry,
  latestByInstance,
  repeatsLatest,
  type PendingConfirm,
  type PendingEntry,
} from './pendingEntries';
import { withTimeout } from './withTimeout';

export const STORAGE_KEY = 'sunny.pendingConfirms.v1';

export const CORRUPT_KEY = `${STORAGE_KEY}.corrupt`;

export const MAX_AGE_MS = 48 * 60 * 60 * 1000;

export const SEND_TIMEOUT_MS = 15_000;

export const SEND_MAX_LIFETIME_MS = 2 * 60 * 1000;

export const RETRY_MS = 30_000;

export const BACKOFF_MS = [30_000, 60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000];

export const STUCK_MS = 10 * 60 * 1000;

export const STUCK_LOG_EVERY_MS = 60 * 60 * 1000;

export const READ_FAILURES_LOUD = 3;

export type SendConfirm = (entry: PendingEntry) => Promise<void>;

export type FailureKind = 'permanent' | 'no_answer' | 'server_error';

export interface PressWatcher {
  pressed: (entry: PendingConfirm) => void;
  answered: (entry: PendingConfirm) => void;
  withdrawn: (pressId: string) => void;
}

export interface ConfirmQueue {
  load: () => Promise<void>;
  enqueue: (entry: PendingEntry) => Promise<PendingEntry>;
  replay: () => Promise<void>;
  setOffline: (offline: boolean) => void;
  clear: () => Promise<void>;
  getEntries: () => readonly PendingEntry[];
  subscribe: (listener: () => void) => () => void;
  watchPresses: (watcher: PressWatcher) => () => void;
}

export interface ConnectionState {
  connected: boolean;
  offline: boolean;
}

export interface ConnectionSource {
  current: () => ConnectionState;
  subscribe: (listener: (state: ConnectionState) => void) => () => void;
}

export interface QueueOptions {
  send: SendConfirm;
  now?: () => number;
  connection?: ConnectionSource;
}

interface Failure {
  attempts: number;
  since: number;
  nextAt?: number;
  lastLoggedAt?: number;
}

export async function sendConfirm(entry: PendingEntry): Promise<void> {
  if (!convex.connectionState().isWebSocketConnected) {
    throw new BackendError(OFFLINE_ERROR_MESSAGE, 0);
  }
  if (entry.kind === 'undo') {
    const undone = await callMutation(api.instances.undoPressedTask, {
      instanceId: entry.instanceId,
      undoneAgoMs: Math.max(0, Date.now() - entry.undoneAt),
      pressId: entry.pressId,
    });
    if (undone.status === 'too_late') {
      logger.info(
        'PendingConfirms',
        'An Undo came too late; the task stays done',
        describeEntry(entry),
      );
    }
    return;
  }
  const result = await callMutation(api.instances.confirmPressedTask, {
    instanceId: entry.instanceId,
    via: 'phone_app',
    pressedAgoMs: Math.max(0, Date.now() - entry.pressedAt),
    pressId: entry.pressId,
    ...(entry.step === undefined ? {} : { step: entry.step }),
  });
  if (result.status === 'rejected') throw new BackendError(result.reason, 400);
}

export function classifyFailure(error: unknown): FailureKind {
  const { status, message } = toBackendError(error);
  if (status === 401 || status === 429) return 'no_answer';
  if (status === 0) return message === OFFLINE_ERROR_MESSAGE ? 'no_answer' : 'server_error';
  return 'permanent';
}

export function createConfirmQueue(options: QueueOptions): ConfirmQueue {
  const now = options.now ?? Date.now;
  let entries: readonly PendingEntry[] = [];
  let loading: Promise<void> | null = null;
  let loadedOk = false;
  let readFailures = 0;
  let replaying: Promise<void> | null = null;
  let writes: Promise<void> = Promise.resolve();
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let generation = 0;
  let offline = false;
  let adding: PendingEntry | null = null;
  let addChain: Promise<void> = Promise.resolve();
  let offlineSince: number | null = null;
  let watching = false;
  const inflight = new Map<string, { send: Promise<void>; startedAt: number }>();
  const failures = new Map<string, Failure>();
  const listeners = new Set<() => void>();
  const watchers = new Set<PressWatcher>();

  const tell = (event: (watcher: PressWatcher) => void): void => watchers.forEach(event);

  const livePresses = (): PendingConfirm[] => {
    const undone = new Set(entries.flatMap((e) => (e.kind === 'undo' ? [e.pressId] : [])));
    return entries.filter((e): e is PendingConfirm => e.kind !== 'undo' && !undone.has(e.pressId));
  };

  const settled = (entry: PendingEntry): void => {
    if (entry.kind !== 'undo' && livePresses().includes(entry)) tell((w) => w.answered(entry));
  };

  const setEntries = (next: readonly PendingEntry[]): void => {
    entries = next;
    listeners.forEach((listener) => listener());
  };

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

  const logDropped = (
    entry: PendingEntry,
    reason: 'rejected' | 'expired',
    detail: string,
  ): void => {
    logger.error('PendingConfirms', `Dropped a queued ${entryWhat(entry)} (${reason})`, {
      ...describeEntry(entry),
      reason,
      detail,
    });
  };

  const remove = async (key: string, gen: number): Promise<void> => {
    if (gen !== generation) return;
    failures.delete(key);
    if (!entries.some((e) => entryKey(e) === key)) return;
    setEntries(entries.filter((e) => entryKey(e) !== key));
    await persist().catch((error: unknown) =>
      logger.warning('PendingConfirms', 'Could not store the queue', { error: String(error) }),
    );
  };

  const dropExpired = async (gen: number): Promise<void> => {
    const expired = entries.filter((e) => now() - entryTime(e) > MAX_AGE_MS);
    for (const entry of expired) {
      if (gen !== generation) return;
      await remove(entryKey(entry), gen);
      if (entry.kind !== 'undo') tell((w) => w.withdrawn(entry.pressId));
      logDropped(entry, 'expired', 'The entry is too old to send.');
    }
  };

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

  const load = (): Promise<void> => {
    loading ??= (async () => {
      const gen = generation;
      let raw: string | null;
      try {
        await writes;
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
      let stored: PendingEntry[] = [];
      if (raw !== null) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch {
          parsed = undefined;
        }
        if (Array.isArray(parsed)) {
          stored = parsed.filter(isEntry);
          const dropped = parsed.length - stored.length;
          if (dropped > 0) {
            logger.warning('PendingConfirms', 'Ignored stored items that are not entries', {
              count: dropped,
            });
          }
        } else {
          await quarantine(raw);
        }
      }
      if (gen !== generation) return;
      const known = new Set(entries.map(entryKey));
      setEntries([...stored.filter((e) => !known.has(entryKey(e))), ...entries]);
      loadedOk = true;
      const live = livePresses();
      tell((w) => live.forEach(w.pressed));
      await dropExpired(gen);
    })();
    watchConnection();
    return loading;
  };

  const add = async (entry: PendingEntry, gen: number): Promise<PendingEntry> => {
    await load();
    if (gen !== generation) throw new Error('The queue was cleared');
    if (!loadedOk) throw new Error('The stored queue could not be read');
    const latest = latestByInstance(entries).get(entry.instanceId);
    if (latest !== undefined && repeatsLatest(latest, entry)) return latest;
    adding = entry;
    try {
      await persist();
    } finally {
      adding = null;
    }
    if (gen !== generation) return entry;
    setEntries([...entries, entry]);
    if (entry.kind === 'undo') {
      const { pressId } = entry;
      tell((w) => w.withdrawn(pressId));
    } else {
      tell((w) => w.pressed(entry));
    }
    return entry;
  };

  const enqueue = (entry: PendingEntry): Promise<PendingEntry> => {
    const gen = generation;
    const run = addChain.then(() => add(entry, gen));
    addChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  const sendOnce = (entry: PendingEntry, gen: number): Promise<void> => {
    const key = entryKey(entry);
    const running = inflight.get(key);
    if (running !== undefined && now() - running.startedAt <= SEND_MAX_LIFETIME_MS) {
      return running.send;
    }
    const send = options.send(entry);
    inflight.set(key, { send, startedAt: now() });
    const forget = (): void => {
      if (inflight.get(key)?.send === send) inflight.delete(key);
    };
    send.then(() => {
      forget();
      settled(entry);
      void remove(key, gen);
    }, forget);
    return send;
  };

  const noteFailure = (entry: PendingEntry, error: unknown, kind: FailureKind): void => {
    if (offline) return;
    const t = now();
    const key = entryKey(entry);
    const known = failures.get(key) ?? { attempts: 0, since: t };
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
      logger.error(
        'PendingConfirms',
        `A queued ${entryWhat(entry)} has failed for over 10 minutes while online`,
        { ...describeEntry(entry), attempts, error: toBackendError(error).message },
      );
    }
    failures.set(key, next);
  };

  const scheduleNext = (gen: number): void => {
    clearTimeout(retryTimer);
    if (entries.length === 0 || offline || gen !== generation) return;
    const t = now();
    const waits = entries.map((e) => {
      const nextAt = failures.get(entryKey(e))?.nextAt;
      return nextAt === undefined ? RETRY_MS : nextAt - t;
    });
    retryTimer = setTimeout(() => void replay(), Math.max(1000, Math.min(...waits)));
  };

  const pass = async (): Promise<void> => {
    const gen = generation;
    await load();
    if (!loadedOk || offline || gen !== generation) return;
    await dropExpired(gen);
    const tried = new Set<string>();
    const held = new Set<string>();
    for (;;) {
      if (offline || gen !== generation) return;
      const entry = entries.find((e) => !tried.has(entryKey(e)));
      if (entry === undefined) break;
      const key = entryKey(entry);
      tried.add(key);
      if (held.has(entry.instanceId)) continue;
      const waitUntil = failures.get(key)?.nextAt;
      if (waitUntil !== undefined && waitUntil > now()) {
        held.add(entry.instanceId);
        continue;
      }
      try {
        await withTimeout(sendOnce(entry, gen), SEND_TIMEOUT_MS, 'Network request timed out');
        await remove(key, gen);
      } catch (error) {
        if (gen !== generation) return;
        const kind = classifyFailure(error);
        if (kind === 'permanent') {
          settled(entry);
          await remove(key, gen);
          logDropped(entry, 'rejected', toBackendError(error).message);
          continue;
        }
        noteFailure(entry, error, kind);
        held.add(entry.instanceId);
        if (kind === 'no_answer') break;
      }
    }
    scheduleNext(gen);
  };

  const replay = (): Promise<void> => {
    if (replaying !== null) return replaying;
    const run: Promise<void> = pass().finally(() => {
      if (replaying === run) replaying = null;
    });
    replaying = run;
    return run;
  };

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
      logger.error('PendingConfirms', 'Dropped queued Done presses and Undos on unpair', {
        count: dropped.length,
        entries: dropped.map(describeEntry),
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
    watchPresses: (watcher) => {
      watchers.add(watcher);
      livePresses().forEach(watcher.pressed);
      return () => void watchers.delete(watcher);
    },
  };
}

function toConnectionState(state: ReturnType<typeof convex.connectionState>): ConnectionState {
  return {
    connected: state.isWebSocketConnected,
    offline: state.hasEverConnected && !state.isWebSocketConnected,
  };
}

export const confirmQueue: ConfirmQueue = createConfirmQueue({
  send: sendConfirm,
  connection: {
    current: () => toConnectionState(convex.connectionState()),
    subscribe: (listener) =>
      convex.subscribeToConnectionState((state) => listener(toConnectionState(state))),
  },
});
