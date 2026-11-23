import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { AccessibilityInfo } from 'react-native';

import { logger } from '../logging/logger';
import { isAnytime, isDue, isOpen, stepIndex } from './format';
import { currentLocalDate } from './localDate';
import { PressNotSaved, type LoggedPress, type PressStore } from './pressLog';
import { hasStepAfter, pressLabel, withStepIndex } from './pressOverlay';
import type { DayTask, DayViewData } from './types';
import { withTimeout } from './withTimeout';

export const PRESS_GAP_MS = 700;

export const MESSAGE_MS = 10_000;

export const SETTLE_MS = 4_000;

export const STORE_TIMEOUT_MS = 4_000;

export const NOT_STORED_MESSAGE = 'Sunny could not save that. Please press Done again.';

export const NOT_PAIRED_MESSAGE = 'Please ask a family member to connect this phone again.';

export const OFFLINE_NOTE = ' It will be sent when the internet is back.';

export const UNDO_MS = 30_000;

export interface UndoLineData {
  label: string;
  text: string;
  pressedAt: number;
}

export interface DoneAction {
  task: DayTask | null;
  message: string | null;
  pressDone: () => void;
  undo: UndoLineData | null;
  pressUndo: () => void;
}

interface Pressed {
  press: LoggedPress;
  label: string;
  stepFollows: boolean;
}

type Block = 'none' | 'settle' | 'held' | 'early';

interface Phase {
  block: Block;
  undoOpen: boolean;
  changesAt: number | null;
}

interface Line {
  text: string;
  instanceId: string;
}

const AT_REST: Phase = { block: 'none', undoOpen: false, changesAt: null };

function blocks(block: Block, target: DayTask | null): boolean {
  return (
    block === 'settle' || block === 'held' || (block === 'early' && target?.state === 'upcoming')
  );
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

export function lastPressed(
  log: readonly LoggedPress[],
  tasks: readonly DayTask[],
): Pressed | null {
  const press = log.at(-1);
  if (press === undefined || press.undo !== undefined) return null;
  const task = tasks.find((t) => t.instanceId === press.instanceId);
  if (task === undefined) return null;
  const atPress = withStepIndex(task, press.step);
  return { press, label: pressLabel(atPress), stepFollows: hasStepAfter(atPress) };
}

export function phaseAfter(pressed: Pressed | null, now: number): Phase {
  if (pressed === null) return AT_REST;
  const { pressedAt } = pressed.press;
  const age = now - pressedAt;
  if (age >= UNDO_MS) return AT_REST;
  const undoEnds = pressedAt + UNDO_MS;
  if (!pressed.stepFollows) return { block: 'held', undoOpen: true, changesAt: undoEnds };
  if (age < SETTLE_MS) return { block: 'settle', undoOpen: true, changesAt: pressedAt + SETTLE_MS };
  if (age < MESSAGE_MS)
    return { block: 'early', undoOpen: true, changesAt: pressedAt + MESSAGE_MS };
  return { block: 'none', undoOpen: true, changesAt: undoEnds };
}

export function useDoneAction(
  target: DayTask | null,
  isOffline: boolean,
  presses: PressStore,
  shownTasks: readonly DayTask[],
): DoneAction {
  const seen = useSyncExternalStore(presses.subscribe, presses.getSeen);
  const [tickedAt, setTickedAt] = useState(0);
  const [line, setLine] = useState<Line | null>(null);
  const [undoing, setUndoing] = useState<string | null>(null);
  const [undone, setUndone] = useState<Pressed | null>(null);
  const mounted = useRef(true);
  const lastPress = useRef(0);
  const storing = useRef(false);
  const undoInFlight = useRef<string | null>(null);
  const clearTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const announcedOffer = useRef<string | null>(null);
  const announcedUndone = useRef<Pressed | null>(null);
  const latest = useRef({ target, shownTasks });

  const pressed = useMemo(() => lastPressed(seen.presses, shownTasks), [seen, shownTasks]);
  const phase = phaseAfter(pressed, Math.max(seen.at, tickedAt));
  const offered = phase.undoOpen && pressed !== null && undoing !== pressed.press.pressId;
  const unsent = isOffline && pressed?.press.answer === undefined;

  useEffect(() => {
    latest.current = { target, shownTasks };
  });

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      clearTimeout(clearTimer.current);
    };
  }, []);

  useEffect(() => {
    if (phase.changesAt === null) return;
    const wait = Math.max(0, phase.changesAt - Date.now());
    const timer = setTimeout(() => setTickedAt(Date.now()), wait);
    return () => clearTimeout(timer);
  }, [phase.changesAt]);

  useEffect(() => {
    if (line !== null) AccessibilityInfo.announceForAccessibility(line.text);
  }, [line]);

  useEffect(() => {
    if (!offered || pressed === null || announcedOffer.current === pressed.press.pressId) return;
    announcedOffer.current = pressed.press.pressId;
    announceQueued(`${pressed.label} done.${unsent ? OFFLINE_NOTE : ''} Undo`);
  }, [offered, pressed, unsent]);

  useEffect(() => {
    if (undone === null || announcedUndone.current === undone) return;
    announcedUndone.current = undone;
    const shown = shownTasks.find((t) => t.instanceId === undone.press.instanceId);
    if (shown !== undefined && isOpen(shown)) announceQueued(`${undone.label} is not done.`);
  }, [undone, shownTasks]);

  const show = (text: string, instanceId: string): void => {
    clearTimeout(clearTimer.current);
    setLine({ text, instanceId });
    clearTimer.current = setTimeout(() => setLine(null), MESSAGE_MS);
  };

  const clearLine = (): void => {
    clearTimeout(clearTimer.current);
    setLine(null);
  };

  const notStored = (task: DayTask, error: unknown): void => {
    const unpaired = error instanceof PressNotSaved && error.noCredentials;
    show(unpaired ? NOT_PAIRED_MESSAGE : NOT_STORED_MESSAGE, task.instanceId);
  };

  const store = async (task: DayTask): Promise<void> => {
    storing.current = true;
    const write = presses.storePress(task.instanceId, stepIndex(task));
    const stored = (): void => {
      if (mounted.current) clearLine();
    };
    try {
      await withTimeout(write, STORE_TIMEOUT_MS, 'Storing the press took too long');
      stored();
    } catch (error) {
      if (mounted.current) notStored(task, error);
      write.then(stored, () => undefined);
    } finally {
      storing.current = false;
    }
  };

  const storeUndo = async (taken: Pressed): Promise<void> => {
    const { pressId } = taken.press;
    const write = presses.storeUndo(pressId);
    write.then(
      () => {
        if (mounted.current) setUndone(taken);
      },
      () => undefined,
    );
    try {
      await withTimeout(write, STORE_TIMEOUT_MS, 'Storing the undo took too long');
    } catch (error) {
      logger.warning('DoneAction', 'Could not store an Undo', {
        instanceId: taken.press.instanceId,
        error: String(error),
      });
    } finally {
      undoInFlight.current = null;
      if (mounted.current) setUndoing(null);
    }
  };

  const pressUndo = (): void => {
    const current = lastPressed(presses.getSeen().presses, latest.current.shownTasks);
    if (current === null || !phaseAfter(current, Date.now()).undoOpen) return;
    if (undoInFlight.current !== null) return;
    undoInFlight.current = current.press.pressId;
    setUndoing(current.press.pressId);
    void storeUndo(current);
  };

  const pressDone = (): void => {
    const pressedNow = Date.now();
    const current = latest.current;
    const blockNow = phaseAfter(
      lastPressed(presses.getSeen().presses, current.shownTasks),
      pressedNow,
    ).block;
    if (current.target === null || storing.current || blocks(blockNow, current.target)) return;
    if (pressedNow - lastPress.current < PRESS_GAP_MS) return;
    lastPress.current = pressedNow;
    void store(current.target);
  };

  const task = blocks(phase.block, target) ? null : target;
  const message =
    line !== null && (task === null || line.instanceId === task.instanceId) ? line.text : null;
  const undo =
    offered && pressed !== null
      ? {
          label: pressed.label,
          text: `${pressed.label} done.${unsent ? OFFLINE_NOTE : ''}`,
          pressedAt: pressed.press.pressedAt,
        }
      : null;

  return { task, message, pressDone, undo, pressUndo };
}
