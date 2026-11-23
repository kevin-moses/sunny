import { isAnytime, isOpen, stepIndex } from './format';
import { localClockTime } from './localDate';
import type { LoggedAnswer, LoggedPress } from './pressLog';
import type { DayTask } from './types';

interface PressEntry {
  kind: 'press';
  pressId: string;
  instanceId: string;
  step: number;
  pressedAt: number;
}

interface UndoEntry {
  kind: 'undo';
  pressId: string;
  instanceId: string;
  pressedAt: number;
  undoneAt: number;
}

export type OverlayEntry = PressEntry | UndoEntry;

type Stepped<T> = T & { step: NonNullable<DayTask['step']> };

export function hasStepAfter<T extends Pick<DayTask, 'step'>>(task: T): task is Stepped<T> {
  return task.step !== null && task.step.index < task.step.count - 1;
}

export function pressLabel(task: Pick<DayTask, 'displayLabel' | 'step'>): string {
  return hasStepAfter(task)
    ? `${task.displayLabel}, step ${task.step.index + 1}`
    : task.displayLabel;
}

export function withStepIndex(task: DayTask, index: number): DayTask {
  if (task.step === null) return task;
  const text = task.checklistItems[index] ?? task.step.text;
  return { ...task, step: { ...task.step, index, text } };
}

function advanced(task: Stepped<DayTask>): DayTask {
  return { ...withStepIndex(task, task.step.index + 1), snoozed: false, snoozedUntil: null };
}

function pressedBeforeItsTime(task: DayTask, pressedAt: number, timezone: string): boolean {
  if (isAnytime(task) || task.carriedOver) return false;
  const clock = localClockTime(timezone, pressedAt);
  return clock !== null && clock < task.scheduledTime;
}

function reopened(task: DayTask, pressedAt: number, timezone: string): DayTask {
  const state = pressedBeforeItsTime(task, pressedAt, timezone) ? 'upcoming' : 'due';
  return { ...task, state, confirmable: true };
}

function aheadOfDay(answer: LoggedAnswer | undefined, answeredPresses: number): boolean {
  if (answer === undefined) return true;
  return (
    answer.applied &&
    answer.answeredPresses !== undefined &&
    answer.answeredPresses > answeredPresses
  );
}

function entryTime(entry: OverlayEntry): number {
  return entry.kind === 'undo' ? Math.max(entry.undoneAt, entry.pressedAt) : entry.pressedAt;
}

export function overlayEntries(
  log: readonly LoggedPress[],
  answeredPresses: number,
): readonly OverlayEntry[] {
  const entries: OverlayEntry[] = [];
  for (const { pressId, instanceId, step, pressedAt, answer, undo } of log) {
    if (aheadOfDay(answer, answeredPresses)) {
      entries.push({ kind: 'press', pressId, instanceId, step, pressedAt });
    }
    if (undo !== undefined && aheadOfDay(undo.answer, answeredPresses)) {
      entries.push({ kind: 'undo', pressId, instanceId, pressedAt, undoneAt: undo.undoneAt });
    }
  }
  return entries
    .map((entry, order) => ({ entry, order }))
    .sort((a, b) => entryTime(a.entry) - entryTime(b.entry) || a.order - b.order)
    .map(({ entry }) => entry);
}

function replayPressed(task: DayTask, pressed: readonly OverlayEntry[], timezone: string): DayTask {
  let shown = task;
  let confirmPressIds: readonly string[] =
    task.state === 'confirmed' ? (task.confirmPressIds ?? []) : [];
  const appliedSteps: readonly string[] = task.stepPressIds ?? [];
  let lastStepPress = appliedSteps.at(-1) ?? null;
  let beforeLocalPress: DayTask | null = null;
  for (const entry of pressed) {
    if (entry.kind === 'undo') {
      if (confirmPressIds.includes(entry.pressId)) {
        shown = beforeLocalPress ?? reopened(shown, entry.pressedAt, timezone);
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
      if (entry.step !== stepIndex(shown)) continue;
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

export function applyPresses(
  tasks: DayTask[],
  entries: readonly OverlayEntry[],
  timezone: string,
): DayTask[] {
  if (entries.length === 0) return tasks;
  const byTask = new Map<string, OverlayEntry[]>();
  for (const entry of entries) {
    byTask.set(entry.instanceId, [...(byTask.get(entry.instanceId) ?? []), entry]);
  }
  return tasks.map((task) => {
    const pressed = byTask.get(task.instanceId);
    return pressed === undefined ? task : replayPressed(task, pressed, timezone);
  });
}
