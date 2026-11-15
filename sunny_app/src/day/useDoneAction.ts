import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { AccessibilityInfo } from 'react-native';

import { logger } from '../logging/logger';
import { isAnytime, isDue, isOpen } from './format';
import { currentLocalDate } from './localDate';
import type { ConfirmQueue } from './pendingConfirms';
import {
  newPressId,
  toPending,
  toUndo,
  type PendingConfirm,
  type PendingEntry,
} from './pendingEntries';
import type { DayTask, DayViewData } from './types';
import { withTimeout } from './withTimeout';

export const PRESS_GAP_MS = 700;

export const MESSAGE_MS = 10_000;

export const SETTLE_MS = 4_000;

export const STORE_TIMEOUT_MS = 4_000;

export const NOT_STORED_MESSAGE = 'Sunny could not save that. Please press Done again.';

export const OFFLINE_NOTE = ' It will be sent when the internet is back.';

export const UNDO_MS = 30_000;

export interface UndoLineData {
  label: string;
  text: string;
}

export interface DoneAction {
  task: DayTask | null;
  message: string | null;
  pressDone: () => void;
  undo: UndoLineData | null;
  pressUndo: () => void;
}

interface Pressed {
  task: DayTask;
  pressedAt: number;
  entry: PendingConfirm;
}

interface Offer {
  pressed: Pressed;
  spoken: string;
}

type Block = 'none' | 'settle' | 'early';

interface Line {
  text: string;
  instanceId: string;
}

function announceQueued(text: string): void {
  AccessibilityInfo.announceForAccessibilityWithOptions(text, { queue: true });
}

export function doneTarget(tasks: DayTask[], allowEarly = true): DayTask | null {
  const due = tasks.find(isDue);
  if (due !== undefined || !allowEarly) return due ?? null;
  return tasks.find((t) => t.state === 'upcoming' && t.confirmable && !isAnytime(t)) ?? null;
}

export function dayIsCurrent(
  day: Pick<DayViewData, 'localDate' | 'timezone'>,
  now: number,
): boolean {
  const today = currentLocalDate(day.timezone, now);
  return today === null || today === day.localDate;
}

export const STALE_DAY_MESSAGE = "Waiting for today's list to load.";

export function useDoneAction(
  target: DayTask | null,
  isOffline: boolean,
  queue: ConfirmQueue,
  shownTasks: readonly DayTask[],
): DoneAction {
  const [line, setLine] = useState<Line | null>(null);
  const [block, setBlock] = useState<Block>('none');
  const entries = useSyncExternalStore(queue.subscribe, queue.getEntries);
  const mounted = useRef(true);
  const lastPress = useRef(0);
  const storing = useRef(false);
  const blockRef = useRef<Block>('none');
  const clearTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const blockTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [offer, setOfferState] = useState<Offer | null>(null);
  const undoRef = useRef<Pressed | null>(null);
  const undoTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const latestStored = useRef<Pressed | null>(null);
  const [undone, setUndone] = useState<Pressed | null>(null);
  const announcedUndone = useRef<Pressed | null>(null);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      clearTimeout(clearTimer.current);
      clearTimeout(blockTimer.current);
      clearTimeout(undoTimer.current);
    };
  }, []);

  useEffect(() => {
    if (line !== null) AccessibilityInfo.announceForAccessibility(line.text);
  }, [line]);

  useEffect(() => {
    if (offer !== null) announceQueued(offer.spoken);
  }, [offer]);

  useEffect(() => {
    if (undone === null || announcedUndone.current === undone) return;
    announcedUndone.current = undone;
    const shown = shownTasks.find((t) => t.instanceId === undone.task.instanceId);
    if (shown !== undefined && isOpen(shown)) {
      announceQueued(`${undone.task.displayLabel} is not done.`);
    }
  }, [undone, shownTasks]);

  const setOffer = (pressed: Pressed | null, spoken = ''): void => {
    clearTimeout(undoTimer.current);
    undoRef.current = pressed;
    setOfferState(pressed === null ? null : { pressed, spoken });
  };

  const offerUndo = (pressed: Pressed, now: number): void => {
    const left = pressed.pressedAt + UNDO_MS - now;
    const spoken = `${pressed.task.displayLabel} done.${isOffline ? OFFLINE_NOTE : ''} Undo`;
    setOffer(left > 0 ? pressed : null, spoken);
    if (left > 0) undoTimer.current = setTimeout(() => setOffer(null), left);
  };

  const show = (text: string, instanceId: string): void => {
    clearTimeout(clearTimer.current);
    setLine({ text, instanceId });
    clearTimer.current = setTimeout(() => setLine(null), MESSAGE_MS);
  };

  const clearLine = (): void => {
    clearTimeout(clearTimer.current);
    setLine(null);
  };

  const enter = (next: Block): void => {
    clearTimeout(blockTimer.current);
    blockRef.current = next;
    setBlock(next);
    if (next === 'settle') blockTimer.current = setTimeout(() => enter('early'), SETTLE_MS);
    if (next === 'early')
      blockTimer.current = setTimeout(() => enter('none'), MESSAGE_MS - SETTLE_MS);
  };

  const stored = (task: DayTask, pressedAt: number, entry: PendingEntry): void => {
    if (entry.kind === 'undo') return;
    const pressed: Pressed = { task, pressedAt, entry };
    latestStored.current = pressed;
    clearLine();
    enter('settle');
    offerUndo(pressed, Date.now());
  };

  const store = async (task: DayTask, pressedAt: number): Promise<void> => {
    storing.current = true;
    const write = queue.enqueue(toPending(task, pressedAt, newPressId()));
    try {
      const entry = await withTimeout(write, STORE_TIMEOUT_MS, 'Storing the press took too long');
      if (!isOffline) void queue.replay();
      if (mounted.current) stored(task, pressedAt, entry);
    } catch {
      if (mounted.current) show(NOT_STORED_MESSAGE, task.instanceId);
      write.then(
        (entry) => {
          if (!isOffline) void queue.replay();
          if (mounted.current) stored(task, pressedAt, entry);
        },
        () => undefined,
      );
    } finally {
      storing.current = false;
    }
  };

  const storeUndo = async (pressed: Pressed, undoneAt: number): Promise<void> => {
    const write = queue.enqueue(toUndo(pressed.task, undoneAt, pressed.entry.pressId));
    write.then(
      () => {
        if (!isOffline) void queue.replay();
        if (!mounted.current || latestStored.current !== pressed) return;
        if (undoRef.current === pressed) setOffer(null);
        enter('none');
        setUndone(pressed);
      },
      () => undefined,
    );
    try {
      await withTimeout(write, STORE_TIMEOUT_MS, 'Storing the undo took too long');
    } catch (error) {
      logger.warning('DoneAction', 'Could not store an Undo', {
        instanceId: pressed.task.instanceId,
        error: String(error),
      });
      if (!mounted.current || latestStored.current !== pressed) return;
      offerUndo(pressed, Date.now());
      enter('settle');
    }
  };

  const pressUndo = (): void => {
    const pressed = undoRef.current;
    if (pressed === null) return;
    setOffer(null);
    void storeUndo(pressed, Date.now());
  };

  const pressDone = (): void => {
    const now = Date.now();
    if (target === null || storing.current || blockRef.current === 'settle') return;
    if (blockRef.current === 'early' && target.state === 'upcoming') return;
    if (now - lastPress.current < PRESS_GAP_MS) return;
    lastPress.current = now;
    void store(target, now);
  };

  const hidden = block === 'settle' || (block === 'early' && target?.state === 'upcoming');
  const task = hidden ? null : target;
  const message =
    line !== null && (task === null || line.instanceId === task.instanceId) ? line.text : null;
  const unsent = offer !== null && isOffline && entries.includes(offer.pressed.entry);
  const undo =
    offer === null
      ? null
      : {
          label: offer.pressed.task.displayLabel,
          text: `${offer.pressed.task.displayLabel} done.${unsent ? OFFLINE_NOTE : ''}`,
        };

  return { task, message, pressDone, undo, pressUndo };
}
