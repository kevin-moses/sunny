// sunny_app/src/day/useDoneAction.ts
//
// Purpose: What the senior phone's Done button does. doneTarget picks the one task Done
// confirms: the first due or escalated timed task of the day view (the same rule as the home
// display's Now card, so the phone and the display agree; an upcoming task that the backend
// would accept up to an hour early is not offered). useDoneAction confirms that task by its
// instance id through instances.confirmTaskInstance with via "phone_app", so a press can only
// confirm the task the screen shows. A second press within PRESS_GAP_MS is ignored (a tremor or
// a double tap must not confirm two tasks) and presses are ignored while a confirm is in
// flight. Each outcome is a short plain message, shown for MESSAGE_MS and announced to
// VoiceOver. While the phone is offline nothing is sent and the message says so: the Convex
// client would otherwise hold the call and confirm the task later without the senior knowing.
// A failure leaves the task unconfirmed; there is no offline queue.
//
// Last modified: 2026-11-09

import { useEffect, useRef, useState } from 'react';
import { AccessibilityInfo } from 'react-native';

import { callMutation, toBackendError } from '../backend/api';
import { api } from '../backend/convexApi';
import { isDue } from './format';
import type { DayTask } from './types';

/** Presses closer together than this (ms) count as one. */
export const PRESS_GAP_MS = 700;

/** How long (ms) a result stays on screen. */
export const MESSAGE_MS = 10_000;

/** Said instead of sending when the phone is offline. */
export const OFFLINE_DONE_MESSAGE =
  'Not connected, so this could not be saved. It is not checked off yet.';

/** What useDoneAction returns. */
export interface DoneAction {
  /** The result line to show, or null. */
  message: string | null;
  /** A confirm is in flight. */
  busy: boolean;
  /** The Done button was pressed. */
  pressDone: () => void;
}

/**
 * purpose: The task Done confirms: the first due or escalated timed task in the day's order.
 * @param tasks: (DayTask[]) Today's tasks, in the day view's order.
 * @return: (DayTask | null) The task, or null when nothing is due.
 */
export function doneTarget(tasks: DayTask[]): DayTask | null {
  return tasks.find(isDue) ?? null;
}

/**
 * purpose: Wire the Done button to the backend.
 * @param target: (DayTask | null) The task Done confirms (doneTarget), or null.
 * @param isOffline: (boolean) The connection to the backend is down.
 * @return: (DoneAction) The result line, busy flag and press handler.
 */
export function useDoneAction(target: DayTask | null, isOffline: boolean): DoneAction {
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const lastPress = useRef(0);
  const inFlight = useRef(false);
  const clearTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => () => clearTimeout(clearTimer.current), []);

  /**
   * purpose: Show a result line for MESSAGE_MS and announce it.
   * @param text: (string) The line.
   * @return: (void)
   */
  const show = (text: string): void => {
    clearTimeout(clearTimer.current);
    setMessage(text);
    AccessibilityInfo.announceForAccessibility(text);
    clearTimer.current = setTimeout(() => setMessage(null), MESSAGE_MS);
  };

  /**
   * purpose: Confirm one task and show the outcome.
   * @param task: (DayTask) The task on screen.
   * @return: (Promise<void>) Resolves when the outcome is shown; never rejects.
   */
  const confirm = async (task: DayTask): Promise<void> => {
    inFlight.current = true;
    setBusy(true);
    try {
      await callMutation(api.instances.confirmTaskInstance, {
        instanceId: task.instanceId,
        via: 'phone_app',
      });
      show(`Checked off: ${task.displayLabel}`);
    } catch (error) {
      show(`${toBackendError(error).message} It is not checked off yet.`);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  /**
   * purpose: The Done button: confirm the target task unless a press is too close to the
   *          last one, a confirm is running, or the phone is offline.
   * @return: (void)
   */
  const pressDone = (): void => {
    const now = Date.now();
    if (target === null || inFlight.current || now - lastPress.current < PRESS_GAP_MS) return;
    lastPress.current = now;
    if (isOffline) {
      show(OFFLINE_DONE_MESSAGE);
      return;
    }
    void confirm(target);
  };

  return { message, busy, pressDone };
}
