import * as Crypto from 'expo-crypto';

import { isOpen } from './format';
import type { DayTask } from './types';

export interface PendingConfirm {
  kind?: undefined;
  instanceId: DayTask['instanceId'];
  label: string;
  pressedAt: number;
  pressId: string;
}

interface RestoreState {
  state: DayTask['state'];
  confirmable: boolean;
}

export interface PendingUndo {
  kind: 'undo';
  instanceId: DayTask['instanceId'];
  label: string;
  undoneAt: number;
  restore: RestoreState;
  pressId: string;
}

export type PendingEntry = PendingConfirm | PendingUndo;

const KNOWN_STATES: Record<DayTask['state'], true> = {
  upcoming: true,
  due: true,
  escalated: true,
  missed: true,
  confirmed: true,
  resolved: true,
};

export function newPressId(): string {
  return Crypto.randomUUID();
}

export function entryKind(entry: PendingEntry): 'press' | 'undo' {
  return entry.kind ?? 'press';
}

export function entryWhat(entry: PendingEntry): 'Done' | 'Undo' {
  return entryKind(entry) === 'undo' ? 'Undo' : 'Done';
}

export function entryTime(entry: PendingEntry): number {
  return entry.kind === 'undo' ? entry.undoneAt : entry.pressedAt;
}

export function entryKey(entry: PendingEntry): string {
  return `${entryKind(entry)}:${entry.instanceId}:${entryTime(entry)}`;
}

export function describeEntry(entry: PendingEntry): Record<string, unknown> {
  const time =
    entry.kind === 'undo' ? { undoneAt: entry.undoneAt } : { pressedAt: entry.pressedAt };
  return {
    kind: entryKind(entry),
    instanceId: entry.instanceId,
    label: entry.label,
    ...time,
    pressId: entry.pressId,
  };
}

export function latestByInstance(
  entries: readonly PendingEntry[],
): ReadonlyMap<string, PendingEntry> {
  return new Map(entries.map((e) => [e.instanceId, e]));
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

export function isEntry(value: unknown): value is PendingEntry {
  if (typeof value !== 'object' || value === null) return false;
  const entry = value as Partial<PendingConfirm> & Partial<Omit<PendingUndo, 'kind'>>;
  if (typeof entry.instanceId !== 'string' || typeof entry.label !== 'string') return false;
  if (typeof entry.pressId !== 'string') return false;
  const kind = (value as { kind?: unknown }).kind;
  if (kind === undefined) return isFiniteNumber(entry.pressedAt);
  const restore = entry.restore as { state?: unknown; confirmable?: unknown } | undefined;
  return (
    kind === 'undo' &&
    isFiniteNumber(entry.undoneAt) &&
    typeof restore?.state === 'string' &&
    Object.prototype.hasOwnProperty.call(KNOWN_STATES, restore.state) &&
    typeof restore.confirmable === 'boolean'
  );
}

export function toPending(
  task: Pick<DayTask, 'instanceId' | 'displayLabel'>,
  pressedAt: number,
  pressId: string,
): PendingConfirm {
  return { instanceId: task.instanceId, label: task.displayLabel, pressedAt, pressId };
}

export function toUndo(
  task: Pick<DayTask, 'instanceId' | 'displayLabel' | 'state' | 'confirmable'>,
  undoneAt: number,
  pressId: string,
): PendingUndo {
  return {
    kind: 'undo',
    instanceId: task.instanceId,
    label: task.displayLabel,
    undoneAt,
    restore: { state: task.state, confirmable: task.confirmable },
    pressId,
  };
}

function replayQueued(task: DayTask, queued: readonly PendingEntry[]): DayTask {
  let shown = task;
  let confirmPressIds: readonly string[] =
    task.state === 'confirmed' ? (task.confirmPressIds ?? []) : [];
  let beforeLocalConfirm: DayTask | null = null;
  for (const entry of queued) {
    if (entry.kind === 'undo') {
      if (!confirmPressIds.includes(entry.pressId)) continue;
      shown = beforeLocalConfirm ?? { ...shown, ...entry.restore };
      confirmPressIds = [];
      beforeLocalConfirm = null;
    } else if (isOpen(shown)) {
      beforeLocalConfirm = shown;
      shown = { ...shown, state: 'confirmed', confirmable: false };
      confirmPressIds = [entry.pressId];
    } else if (confirmPressIds.length > 0) {
      confirmPressIds = [...confirmPressIds, entry.pressId];
    }
  }
  return shown;
}

export function applyPending(tasks: DayTask[], entries: readonly PendingEntry[]): DayTask[] {
  if (entries.length === 0) return tasks;
  const byTask = new Map<string, PendingEntry[]>();
  for (const entry of entries) {
    byTask.set(entry.instanceId, [...(byTask.get(entry.instanceId) ?? []), entry]);
  }
  return tasks.map((task) => {
    const queued = byTask.get(task.instanceId);
    return queued === undefined ? task : replayQueued(task, queued);
  });
}
