// sunny_app/src/day/pendingEntries.ts
//
// Purpose: What the pending-confirm queue (pendingConfirms.ts) holds and how the screen reads
// it, kept apart from the queue engine. Two kinds of entry: a Done press (PendingConfirm; no
// kind field is ever written for a press, and an entry without a kind, or with kind "press", is
// read as a press) and an Undo tap (PendingUndo, kind "undo"). Each press gets a random press id
// when it is made (newPressId, at least 96 bits from the platform CSPRNG); the undo stores the id
// of the press it takes back, so the server can order an undo and a later Done by id rather
// than by estimated times. Entries stored before ids existed have none and are sent without
// one. An undo also keeps `restore`, the state and confirmable flag the task had before the
// press, to show the task open again while the undo waits.
//
// Here: the entry types; the builders (toPending, toUndo); the helpers every reader shares
// (entryKind, entryWhat, entryTime, entryKey, describeEntry, latestByInstance); the stored-value
// check (isEntry, which also checks an undo's restore state against the known states); and the
// optimistic display (applyPending: after an undo the task reads open only when the undo takes
// back the confirmation the server shows, which for an undo with an id means its press id is in
// the day entry's confirmPressIds).
//
// Last modified: 2026-11-14

import * as Crypto from 'expo-crypto';

import type { DayTask } from './types';

/** One Done press waiting for the server. */
export interface PendingConfirm {
  /** Never written for a press; "press" is accepted when reading. */
  kind?: 'press';
  /** The task instance the senior confirmed. */
  instanceId: DayTask['instanceId'];
  /** The task's label, for logs. */
  label: string;
  /** When the senior pressed Done (epoch ms, this device's clock). */
  pressedAt: number;
  /** The press's random id; absent on presses stored before ids existed. */
  pressId?: string;
}

/** What a task looked like before the press an undo takes back. */
interface RestoreState {
  state: DayTask['state'];
  confirmable: boolean;
}

/** One Undo tap (the phone's "Morning pills done. Undo") waiting for the server. */
export interface PendingUndo {
  kind: 'undo';
  /** The task instance whose press the senior took back. */
  instanceId: DayTask['instanceId'];
  /** The task's label, for logs. */
  label: string;
  /** When the senior tapped Undo (epoch ms, this device's clock). */
  undoneAt: number;
  /** The task's state before the press, shown while the undo waits. */
  restore: RestoreState;
  /** The id of the press this undo takes back; absent when that press had none. */
  pressId?: string;
}

/** Anything the queue holds. */
export type PendingEntry = PendingConfirm | PendingUndo;

/** Every instance state, to check a stored restore state against. */
const KNOWN_STATES: Record<DayTask['state'], true> = {
  upcoming: true,
  due: true,
  escalated: true,
  missed: true,
  confirmed: true,
  resolved: true,
};

/**
 * purpose: A new random press id: a v4 UUID from the platform CSPRNG (122 random bits), which
 *          is 36 characters of hex digits and "-", inside the server's 16 to 64 safe characters.
 * @return: (string) The id.
 */
export function newPressId(): string {
  return Crypto.randomUUID();
}

/**
 * purpose: An entry's kind, reading an entry without one as a press.
 * @param entry: (PendingEntry) The entry.
 * @return: ('press' | 'undo') The kind.
 */
export function entryKind(entry: PendingEntry): 'press' | 'undo' {
  return entry.kind ?? 'press';
}

/**
 * purpose: The word log lines use for an entry's kind.
 * @param entry: (PendingEntry) The entry.
 * @return: ('Done' | 'Undo') "Done" for a press, "Undo" for an undo.
 */
export function entryWhat(entry: PendingEntry): 'Done' | 'Undo' {
  return entryKind(entry) === 'undo' ? 'Undo' : 'Done';
}

/**
 * purpose: When an entry was made: a press's pressedAt, an undo's undoneAt.
 * @param entry: (PendingEntry) The entry.
 * @return: (number) Epoch ms on this device's clock.
 */
export function entryTime(entry: PendingEntry): number {
  return entry.kind === 'undo' ? entry.undoneAt : entry.pressedAt;
}

/**
 * purpose: An entry's identity in the queue: its kind, instance and time, so a press, an undo
 *          and a second press of one task are three entries.
 * @param entry: (PendingEntry) The entry.
 * @return: (string) The key.
 */
export function entryKey(entry: PendingEntry): string {
  return `${entryKind(entry)}:${entry.instanceId}:${entryTime(entry)}`;
}

/**
 * purpose: The fields a log line names an entry by (never its restore state).
 * @param entry: (PendingEntry) The entry.
 * @return: (Record<string, unknown>) kind, instance id, label, pressedAt or undoneAt, and the
 *          press id when there is one.
 */
export function describeEntry(entry: PendingEntry): Record<string, unknown> {
  const time =
    entry.kind === 'undo' ? { undoneAt: entry.undoneAt } : { pressedAt: entry.pressedAt };
  return {
    kind: entryKind(entry),
    instanceId: entry.instanceId,
    label: entry.label,
    ...time,
    ...(entry.pressId === undefined ? {} : { pressId: entry.pressId }),
  };
}

/**
 * purpose: The latest queued entry of each task.
 * @param entries: (readonly PendingEntry[]) The queue, oldest first.
 * @return: (ReadonlyMap<string, PendingEntry>) Instance id to its newest entry.
 */
export function latestByInstance(
  entries: readonly PendingEntry[],
): ReadonlyMap<string, PendingEntry> {
  return new Map(entries.map((e) => [e.instanceId, e]));
}

/**
 * purpose: Whether a value is a finite number.
 * @param value: (unknown) The value.
 * @return: (boolean) True for a finite number.
 */
function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * purpose: Whether a persisted value is a usable entry.
 * @param value: (unknown) A parsed JSON element.
 * @return: (boolean) True for an object with a string id, string label, an optional string
 *          press id, that is either a press (kind absent or "press", finite pressedAt) or an
 *          undo (kind "undo", finite undoneAt, restore with a known state and a boolean
 *          confirmable).
 */
export function isEntry(value: unknown): value is PendingEntry {
  if (typeof value !== 'object' || value === null) return false;
  const entry = value as Partial<PendingConfirm> & Partial<Omit<PendingUndo, 'kind'>>;
  if (typeof entry.instanceId !== 'string' || typeof entry.label !== 'string') return false;
  if (entry.pressId !== undefined && typeof entry.pressId !== 'string') return false;
  const kind = (value as { kind?: unknown }).kind;
  if (kind === undefined || kind === 'press') return isFiniteNumber(entry.pressedAt);
  const restore = entry.restore as { state?: unknown; confirmable?: unknown } | undefined;
  return (
    kind === 'undo' &&
    isFiniteNumber(entry.undoneAt) &&
    typeof restore?.state === 'string' &&
    Object.prototype.hasOwnProperty.call(KNOWN_STATES, restore.state) &&
    typeof restore.confirmable === 'boolean'
  );
}

/**
 * purpose: The press of a task, as an entry.
 * @param task: (Pick<DayTask, 'instanceId' | 'displayLabel'>) The task.
 * @param pressedAt: (number) Epoch ms of the press.
 * @param pressId: (string) The press's id (newPressId).
 * @return: (PendingConfirm) The entry.
 */
export function toPending(
  task: Pick<DayTask, 'instanceId' | 'displayLabel'>,
  pressedAt: number,
  pressId: string,
): PendingConfirm {
  return { instanceId: task.instanceId, label: task.displayLabel, pressedAt, pressId };
}

/**
 * purpose: The Undo of a press, as an entry. It keeps the state and confirmable flag the task
 *          had when it was pressed, so the task can be shown open again while the undo waits,
 *          and the id of the press it takes back (when that press has one).
 * @param task: (Pick<DayTask, 'instanceId' | 'displayLabel' | 'state' | 'confirmable'>) The
 *        task as it was when Done was pressed.
 * @param undoneAt: (number) Epoch ms of the Undo tap.
 * @param pressId: (string | undefined) The id of the press being taken back; undefined for a
 *        press stored before ids existed.
 * @return: (PendingUndo) The entry.
 */
export function toUndo(
  task: Pick<DayTask, 'instanceId' | 'displayLabel' | 'state' | 'confirmable'>,
  undoneAt: number,
  pressId: string | undefined,
): PendingUndo {
  const undo: PendingUndo = {
    kind: 'undo',
    instanceId: task.instanceId,
    label: task.displayLabel,
    undoneAt,
    restore: { state: task.state, confirmable: task.confirmable },
  };
  return pressId === undefined ? undo : { ...undo, pressId };
}

/**
 * purpose: Whether an undo would take back the confirmation the server shows: the server shows
 *          the task confirmed, no press of the task is still queued ahead of the undo (so the
 *          confirm is not still the phone's own unsent press, and a "confirmed" seen then came
 *          from another surface), and, for an undo that names its press, that press id is one
 *          of the confirmation's confirmPressIds (otherwise the confirm is someone else's, for
 *          example the wall display's with the phone's Done landing on it as a no-op, and the
 *          server will answer too_late). An undo without an id (stored before ids existed)
 *          keeps the first two conditions only.
 * @param task: (DayTask) The task as the server shows it.
 * @param queued: (readonly PendingEntry[]) The task's queued entries, oldest first, ending with
 *        the undo.
 * @param undo: (PendingUndo) The task's latest entry.
 * @return: (boolean) True when the task should be shown as it was before the press.
 */
function undoTakesBack(task: DayTask, queued: readonly PendingEntry[], undo: PendingUndo): boolean {
  if (task.state !== 'confirmed') return false;
  if (queued.some((e) => entryKind(e) === 'press')) return false;
  return undo.pressId === undefined || (task.confirmPressIds ?? []).includes(undo.pressId);
}

/**
 * purpose: Show each task as its queued entries say, until the server catches up. When the
 *          latest entry is a press, the task reads confirmed and the Done card does not offer
 *          it again. When it is an undo, the task gets back the state and confirmable flag it
 *          had before the press only when the undo takes back the confirmation the server
 *          shows (undoTakesBack); otherwise it is left as the server says, so a medication
 *          done on another surface is never shown open with a Done button.
 * @param tasks: (DayTask[]) The day view's tasks.
 * @param entries: (readonly PendingEntry[]) The queue, oldest first.
 * @return: (DayTask[]) The tasks as they should be shown (the same array when nothing is queued).
 */
export function applyPending(tasks: DayTask[], entries: readonly PendingEntry[]): DayTask[] {
  if (entries.length === 0) return tasks;
  const byTask = new Map<string, PendingEntry[]>();
  for (const entry of entries) {
    byTask.set(entry.instanceId, [...(byTask.get(entry.instanceId) ?? []), entry]);
  }
  return tasks.map((task) => {
    const queued = byTask.get(task.instanceId);
    const latest = queued?.at(-1);
    if (queued === undefined || latest === undefined) return task;
    if (latest.kind === 'undo') {
      return undoTakesBack(task, queued, latest) ? { ...task, ...latest.restore } : task;
    }
    return task.state !== 'confirmed' && task.state !== 'resolved'
      ? { ...task, state: 'confirmed', confirmable: false }
      : task;
  });
}
