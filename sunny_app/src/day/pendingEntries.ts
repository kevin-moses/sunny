import * as Crypto from 'expo-crypto';

import { isOpen, stepIndex } from './format';
import type { DayTask } from './types';

export interface PendingConfirm {
  kind?: undefined;
  instanceId: DayTask['instanceId'];
  label: string;
  pressedAt: number;
  pressId: string;
  step?: number;
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

export type PressedEntry = Omit<PendingConfirm, 'label'>;

type OverlayEntry = PressedEntry | PendingUndo;

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

export function entryTime(entry: OverlayEntry): number {
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

export function repeatsLatest(latest: PendingEntry, entry: PendingEntry): boolean {
  if (latest.kind === 'undo' || entry.kind === 'undo') return latest.kind === entry.kind;
  return latest.step === entry.step;
}

type Stepped<T> = T & { step: NonNullable<DayTask['step']> };

export function hasStepAfter<T extends Pick<DayTask, 'step'>>(task: T): task is Stepped<T> {
  return task.step !== null && task.step.index < task.step.count - 1;
}

export function pressLabel(task: Pick<DayTask, 'displayLabel' | 'step'>): string {
  return hasStepAfter(task)
    ? `${task.displayLabel}, step ${task.step.index + 1}`
    : task.displayLabel;
}

function withStepIndex(task: DayTask, index: number): DayTask {
  if (task.step === null) return task;
  const text = task.checklistItems[index] ?? task.step.text;
  return { ...task, step: { ...task.step, index, text } };
}

function advanced(task: Stepped<DayTask>): DayTask {
  return { ...withStepIndex(task, task.step.index + 1), snoozed: false, snoozedUntil: null };
}

function pressedOtherStep(task: DayTask, entry: PressedEntry): boolean {
  return entry.step !== undefined && entry.step !== stepIndex(task);
}

export function latestByInstance(
  entries: readonly PendingEntry[],
): ReadonlyMap<string, PendingEntry> {
  return new Map(entries.map((e) => [e.instanceId, e]));
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

export function isPressedEntry(value: unknown): value is PressedEntry {
  if (typeof value !== 'object' || value === null) return false;
  const entry = value as Partial<Record<keyof PendingConfirm, unknown>>;
  return (
    entry.kind === undefined &&
    typeof entry.instanceId === 'string' &&
    typeof entry.pressId === 'string' &&
    isFiniteNumber(entry.pressedAt) &&
    (entry.step === undefined || Number.isInteger(entry.step))
  );
}

export function isEntry(value: unknown): value is PendingEntry {
  if (typeof value !== 'object' || value === null) return false;
  const entry = value as Partial<Record<keyof PendingUndo, unknown>>;
  if (typeof entry.label !== 'string') return false;
  if (isPressedEntry(value)) return true;
  const restore = entry.restore as { state?: unknown; confirmable?: unknown } | undefined;
  return (
    entry.kind === 'undo' &&
    typeof entry.instanceId === 'string' &&
    typeof entry.pressId === 'string' &&
    isFiniteNumber(entry.undoneAt) &&
    typeof restore?.state === 'string' &&
    Object.prototype.hasOwnProperty.call(KNOWN_STATES, restore.state) &&
    typeof restore.confirmable === 'boolean'
  );
}

export function toPending(
  task: Pick<DayTask, 'instanceId' | 'displayLabel' | 'step'>,
  pressedAt: number,
  pressId: string,
): PendingConfirm {
  return {
    instanceId: task.instanceId,
    label: task.displayLabel,
    pressedAt,
    pressId,
    step: stepIndex(task),
  };
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

function replayQueued(task: DayTask, queued: readonly OverlayEntry[]): DayTask {
  let shown = task;
  let confirmPressIds: readonly string[] =
    task.state === 'confirmed' ? (task.confirmPressIds ?? []) : [];
  const appliedSteps: readonly string[] = task.stepPressIds ?? [];
  let lastStepPress = appliedSteps.at(-1) ?? null;
  let beforeLocalPress: DayTask | null = null;
  for (const entry of queued) {
    if (entry.kind === 'undo') {
      if (confirmPressIds.includes(entry.pressId)) {
        shown = beforeLocalPress ?? { ...shown, ...entry.restore };
        confirmPressIds = [];
      } else if (entry.pressId === lastStepPress && isOpen(shown) && shown.step !== null) {
        shown = withStepIndex(shown, shown.step.index - 1);
        lastStepPress = null;
      } else {
        continue;
      }
      beforeLocalPress = null;
    } else if (appliedSteps.includes(entry.pressId)) {
      continue;
    } else if (isOpen(shown)) {
      if (pressedOtherStep(shown, entry)) continue;
      if (hasStepAfter(shown)) {
        shown = advanced(shown);
        lastStepPress = entry.pressId;
      } else {
        beforeLocalPress = shown;
        shown = { ...shown, state: 'confirmed', confirmable: false };
        confirmPressIds = [entry.pressId];
        lastStepPress = null;
      }
    } else if (confirmPressIds.length > 0) {
      confirmPressIds = [...confirmPressIds, entry.pressId];
    }
  }
  return shown;
}

export function overlayEntries(
  own: readonly PendingEntry[],
  elsewhere: readonly PressedEntry[],
): readonly OverlayEntry[] {
  if (elsewhere.length === 0) return own;
  return [...own, ...elsewhere].sort((a, b) => entryTime(a) - entryTime(b));
}

export function applyPending(tasks: DayTask[], entries: readonly OverlayEntry[]): DayTask[] {
  if (entries.length === 0) return tasks;
  const byTask = new Map<string, OverlayEntry[]>();
  for (const entry of entries) {
    byTask.set(entry.instanceId, [...(byTask.get(entry.instanceId) ?? []), entry]);
  }
  return tasks.map((task) => {
    const queued = byTask.get(task.instanceId);
    return queued === undefined ? task : replayQueued(task, queued);
  });
}
