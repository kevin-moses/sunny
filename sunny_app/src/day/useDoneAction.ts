// sunny_app/src/day/useDoneAction.ts
//
// Purpose: What the senior phone's Done button does, written so the home display can adopt the
// same rule. doneTarget picks the one task Done confirms:
//   1. the first due or escalated timed task in the day's order (due always wins), otherwise
//   2. the first upcoming timed task the backend says may be confirmed now (its `confirmable`
//      flag, computed by the same helper as the confirm mutation: up to 60 minutes before its
//      window starts), otherwise
//   3. nothing (anytime and missed tasks are never offered; the list still shows them).
// Callers pass the day's tasks after applyPending, so a task with a queued press is not offered
// again.
//
// useDoneAction turns a press into a queued confirm (pendingConfirms.ts): the press is stored
// first, and only then does the screen show "Checked off: <label>" (with a note that it will be
// sent when the internet is back, when offline); the queue sends it by itself, now or later,
// with the time of the press. There is no spinner and no timeout here: the senior's part is
// done once the press is stored. If the press cannot be stored, the line says so and the task
// stays offered. A permanent rejection later (the queue reports it) shows a calm line and the
// task shows as open again.
//
// Guards: a second press within PRESS_GAP_MS is ignored and presses are ignored while one is
// being stored. After a press the button is withdrawn for SETTLE_MS (the hook returns task
// null) and presses are refused, so a senior who doubts the first tap cannot confirm the next
// task by accident; only the result line shows, and a line is shown only under the button of
// the task it is about (or when there is no button). Each line lasts MESSAGE_MS and is
// announced to VoiceOver from an effect, after the screen re-rendered without the button.
// After unmount nothing is set, scheduled or announced.
//
// Last modified: 2026-11-09

import { useEffect, useRef, useState } from 'react';
import { AccessibilityInfo } from 'react-native';

import { isAnytime, isDue } from './format';
import { toPending, type ConfirmQueue } from './pendingConfirms';
import type { DayTask } from './types';

/** Presses closer together than this (ms) count as one. */
export const PRESS_GAP_MS = 700;

/** How long (ms) a result stays on screen. */
export const MESSAGE_MS = 10_000;

/** How long (ms) the button stays withdrawn after a press. */
export const SETTLE_MS = 4_000;

/** Said when the press could not be stored on the phone. */
export const NOT_STORED_MESSAGE = 'Sunny could not save that. Please press Done again.';

/** What useDoneAction returns. */
export interface DoneAction {
  /** The task to offer a Done button for, or null (nothing to confirm, or settling). */
  task: DayTask | null;
  /** The result line to show, or null. */
  message: string | null;
  /** The Done button was pressed. */
  pressDone: () => void;
}

/** A result line and the task it is about. */
interface Line {
  text: string;
  instanceId: string;
}

/**
 * purpose: The task Done confirms: the first due or escalated timed task in the day's order;
 *          otherwise the first upcoming timed task that is confirmable now.
 * @param tasks: (DayTask[]) Today's tasks, in the day view's order (after applyPending).
 * @return: (DayTask | null) The task, or null when there is nothing to confirm.
 */
export function doneTarget(tasks: DayTask[]): DayTask | null {
  const due = tasks.find(isDue);
  if (due !== undefined) return due;
  return tasks.find((t) => t.state === 'upcoming' && t.confirmable && !isAnytime(t)) ?? null;
}

/**
 * purpose: Wire the Done button to the pending-confirm queue.
 * @param target: (DayTask | null) The task Done confirms (doneTarget), or null.
 * @param isOffline: (boolean) The connection to the backend is down (only changes the wording
 *        and whether a send is started now).
 * @param queue: (ConfirmQueue) The queue presses go to.
 * @return: (DoneAction) The task to offer, result line and press handler.
 */
export function useDoneAction(
  target: DayTask | null,
  isOffline: boolean,
  queue: ConfirmQueue,
): DoneAction {
  const [line, setLine] = useState<Line | null>(null);
  const [settling, setSettling] = useState(false);
  const mounted = useRef(true);
  const lastPress = useRef(0);
  const storing = useRef(false);
  const settlingRef = useRef(false);
  const clearTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const settleTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  /**
   * purpose: Show a result line for MESSAGE_MS (announced by the effect below).
   * @param text: (string) The line.
   * @param instanceId: (string) The task the line is about.
   * @return: (void)
   */
  const show = (text: string, instanceId: string): void => {
    clearTimeout(clearTimer.current);
    setLine({ text, instanceId });
    clearTimer.current = setTimeout(() => setLine(null), MESSAGE_MS);
  };

  useEffect(() => {
    mounted.current = true;
    const stopListening = queue.onRejection(({ entry }) => {
      if (mounted.current) {
        show(`${entry.label} could not be saved. It is still on your list.`, entry.instanceId);
      }
    });
    return () => {
      mounted.current = false;
      stopListening();
      clearTimeout(clearTimer.current);
      clearTimeout(settleTimer.current);
    };
  }, [queue]);

  useEffect(() => {
    if (line !== null) AccessibilityInfo.announceForAccessibility(line.text);
  }, [line]);

  /**
   * purpose: Withdraw the button for SETTLE_MS.
   * @return: (void)
   */
  const settle = (): void => {
    clearTimeout(settleTimer.current);
    settlingRef.current = true;
    setSettling(true);
    settleTimer.current = setTimeout(() => {
      settlingRef.current = false;
      setSettling(false);
    }, SETTLE_MS);
  };

  /**
   * purpose: Store the press, show the result and let the queue send it.
   * @param task: (DayTask) The task on screen when the button was pressed.
   * @param pressedAt: (number) Epoch ms of the press.
   * @return: (Promise<void>) Resolves when the outcome is shown; never rejects.
   */
  const store = async (task: DayTask, pressedAt: number): Promise<void> => {
    storing.current = true;
    try {
      await queue.enqueue(toPending(task, pressedAt));
      if (!isOffline) void queue.replay();
      if (!mounted.current) return;
      const sent = isOffline ? ' It will be sent when the internet is back.' : '';
      show(`Checked off: ${task.displayLabel}.${sent}`, task.instanceId);
      settle();
    } catch {
      if (mounted.current) show(NOT_STORED_MESSAGE, task.instanceId);
    } finally {
      storing.current = false;
    }
  };

  /**
   * purpose: The Done button: queue a confirm for the target unless a press is too close to
   *          the last one, one is being stored, or the button is settling.
   * @return: (void)
   */
  const pressDone = (): void => {
    const now = Date.now();
    if (target === null || storing.current || settlingRef.current) return;
    if (now - lastPress.current < PRESS_GAP_MS) return;
    lastPress.current = now;
    void store(target, now);
  };

  // A line belongs to one task: show it under that task's button, or when no button is shown.
  const task = settling ? null : target;
  const message =
    line !== null && (task === null || line.instanceId === task.instanceId) ? line.text : null;

  return { task, message, pressDone };
}
