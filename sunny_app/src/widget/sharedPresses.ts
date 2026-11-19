import { useEffect, useSyncExternalStore } from 'react';
import { AppState } from 'react-native';

import SunnyWidget, { type UnsentPress } from '../../modules/sunny-widget';
import type { PressWatcher } from '../day/pendingConfirms';
import type { PressedEntry } from '../day/pendingEntries';
import { errorMessage } from '../errors';
import { logger } from '../logging/logger';

let unsent: readonly PressedEntry[] = [];
const listeners = new Set<() => void>();

function isUnsentPress(value: unknown): value is UnsentPress {
  if (typeof value !== 'object' || value === null) return false;
  const press = value as Partial<Record<keyof UnsentPress, unknown>>;
  return (
    typeof press.id === 'string' &&
    typeof press.instanceId === 'string' &&
    typeof press.step === 'number' &&
    Number.isInteger(press.step) &&
    typeof press.pressedAt === 'number' &&
    Number.isFinite(press.pressedAt)
  );
}

function toEntry(press: UnsentPress): PressedEntry {
  return {
    instanceId: press.instanceId,
    pressedAt: press.pressedAt,
    pressId: press.id,
    step: press.step,
  };
}

function sameIds(a: readonly PressedEntry[], b: readonly PressedEntry[]): boolean {
  return a.length === b.length && a.every((entry, i) => entry.pressId === b[i]?.pressId);
}

export function readUnsentPresses(): void {
  let raw: unknown;
  try {
    raw = SunnyWidget.unsentPresses();
  } catch (e) {
    logger.warning('Widget', `Could not read the widget's unsent presses: ${errorMessage(e)}`);
    return;
  }
  const next = Array.isArray(raw) ? raw.filter(isUnsentPress).map(toEntry) : [];
  if (sameIds(next, unsent)) return;
  unsent = next;
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

export function useUnsentWidgetPresses(): readonly PressedEntry[] {
  const presses = useSyncExternalStore(subscribe, () => unsent);

  useEffect(() => {
    readUnsentPresses();
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') readUnsentPresses();
    });
    return () => subscription.remove();
  }, []);

  return presses;
}

function tellWidget(what: string, call: () => Promise<void>): void {
  Promise.resolve()
    .then(call)
    .catch((e: unknown) =>
      logger.warning('Widget', `Could not ${what} on the widget: ${errorMessage(e)}`),
    );
}

export const widgetPressMirror: PressWatcher = {
  pressed: (entry) =>
    tellWidget('mark a press', () =>
      SunnyWidget.markPressed(entry.pressId, entry.instanceId, entry.step ?? 0, entry.pressedAt),
    ),
  answered: (entry) =>
    tellWidget('mark a press answered', () => SunnyWidget.answerPress(entry.pressId)),
  withdrawn: (pressId) => tellWidget('withdraw a press', () => SunnyWidget.withdrawPress(pressId)),
};
