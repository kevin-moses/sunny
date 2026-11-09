// sunny_app/src/day/useDoneAction.ts
//
// Purpose: What the senior phone's Done button does. doneTarget picks the one task Done
// confirms: the first due or escalated timed task of the day view (the same rule as the home
// display's Now card, so the phone and the display agree; an upcoming task that the backend
// would accept up to an hour early is not offered). useDoneAction confirms that task by its
// instance id through instances.confirmTaskInstance with via "phone_app", so a press can only
// confirm the task the screen shows (the id is captured at press time, so a target change
// while the call is in flight does not redirect it).
//
// Guards: a second press within PRESS_GAP_MS is ignored (a tremor or a double tap must not
// confirm two tasks) and presses are ignored while a confirm is in flight. After a successful
// confirm the button is withdrawn for SETTLE_MS (the hook returns task null) and the hook
// refuses presses, so a senior who doubts the first tap cannot confirm the next due task by
// accident; only the result line shows, and it never appears under another task's button.
// Offline (isOffline) nothing is sent, because the Convex client would hold the call and
// confirm it later without the senior knowing.
//
// Hung calls: isOffline lags a dropped socket and is false on a fresh launch with no
// connection, so the call can stay pending. It is raced against CONFIRM_TIMEOUT_MS; on timeout
// busy clears and the line reads "Still trying. It is not checked off yet." The call cannot be
// cancelled and the client will still send it when the socket returns. If it then succeeds
// and that timeout line is still the one on screen, the line is replaced by "Checked off:
// <label>" and announced, so the senior is not left believing it was not saved. If the line
// has since been replaced or cleared (a newer press, the clear timer, a new result for another
// task) nothing is shown or announced: the live subscription shows the task checked. If it
// fails late, nothing changes: the timeout line already says it is not checked off. Pressing
// again after a timeout is allowed; the backend returns an already confirmed task unchanged.
//
// After unmount nothing is set, scheduled or announced. Each result line is shown for
// MESSAGE_MS and announced to VoiceOver from an effect, so the announcement fires after the
// screen has re-rendered (with the button gone).
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

/** How long (ms) the button stays withdrawn after a successful confirm. */
export const SETTLE_MS = 4_000;

/** How long (ms) a confirm may stay pending before the senior is told it is still trying. */
export const CONFIRM_TIMEOUT_MS = 8_000;

/** Said instead of sending when the phone is offline. */
export const OFFLINE_DONE_MESSAGE =
  'Not connected, so this could not be saved. It is not checked off yet.';

/** Said when a confirm has not finished within CONFIRM_TIMEOUT_MS. */
export const STILL_TRYING_MESSAGE = 'Still trying. It is not checked off yet.';

/** What useDoneAction returns. */
export interface DoneAction {
  /** The task to offer a Done button for, or null (nothing due, or settling after a confirm). */
  task: DayTask | null;
  /** The result line to show, or null. */
  message: string | null;
  /** A confirm is in flight. */
  busy: boolean;
  /** The Done button was pressed. */
  pressDone: () => void;
}

/** A result line and the task it is about. */
interface Line {
  text: string;
  instanceId: string;
}

/** The outcome of a confirm race. */
type Outcome = 'done' | 'timeout';

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
 * @return: (DoneAction) The task to offer, result line, busy flag and press handler.
 */
export function useDoneAction(target: DayTask | null, isOffline: boolean): DoneAction {
  const [line, setLine] = useState<Line | null>(null);
  const [busy, setBusy] = useState(false);
  const [settling, setSettling] = useState(false);
  const mounted = useRef(true);
  const lastPress = useRef(0);
  const inFlight = useRef(false);
  const settlingRef = useRef(false);
  const timedOutId = useRef<string | null>(null);
  const clearTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const settleTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      clearTimeout(clearTimer.current);
      clearTimeout(settleTimer.current);
    };
  }, []);

  useEffect(() => {
    if (line !== null) AccessibilityInfo.announceForAccessibility(line.text);
  }, [line]);

  /**
   * purpose: Show a result line for MESSAGE_MS (announced by the effect above).
   * @param text: (string) The line.
   * @param instanceId: (string) The task the line is about.
   * @return: (void)
   */
  const show = (text: string, instanceId: string): void => {
    clearTimeout(clearTimer.current);
    timedOutId.current = text === STILL_TRYING_MESSAGE ? instanceId : null;
    setLine({ text, instanceId });
    clearTimer.current = setTimeout(() => {
      timedOutId.current = null;
      setLine(null);
    }, MESSAGE_MS);
  };

  /**
   * purpose: Withdraw the button for SETTLE_MS after a successful confirm.
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
   * purpose: Run the confirm call against the timeout.
   * @param call: (Promise<unknown>) The mutation promise, started by the caller.
   * @return: (Promise<Outcome>) 'done' when the call finished, 'timeout' when it did not in time.
   * @raises: BackendError when the call failed before the timeout.
   */
  const race = async (call: Promise<unknown>): Promise<Outcome> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<Outcome>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), CONFIRM_TIMEOUT_MS);
    });
    try {
      return await Promise.race([call.then((): Outcome => 'done'), timeout]);
    } finally {
      clearTimeout(timer);
    }
  };

  /**
   * purpose: Handle a call that finishes after its timeout: if the senior was told it is not
   *          checked off and that line is still showing, correct it.
   * @param task: (DayTask) The task the call was for.
   * @return: (void)
   */
  const onLateSuccess = (task: DayTask): void => {
    if (mounted.current && timedOutId.current === task.instanceId) {
      show(`Checked off: ${task.displayLabel}`, task.instanceId);
    }
  };

  /**
   * purpose: Confirm one task and show the outcome.
   * @param task: (DayTask) The task on screen when the button was pressed.
   * @return: (Promise<void>) Resolves when the outcome is shown; never rejects.
   */
  const confirm = async (task: DayTask): Promise<void> => {
    inFlight.current = true;
    timedOutId.current = null;
    setBusy(true);
    const call = callMutation(api.instances.confirmTaskInstance, {
      instanceId: task.instanceId,
      via: 'phone_app',
    });
    try {
      const outcome = await race(call);
      if (!mounted.current) return;
      if (outcome === 'done') {
        show(`Checked off: ${task.displayLabel}`, task.instanceId);
        settle();
      } else {
        show(STILL_TRYING_MESSAGE, task.instanceId);
        call.then(
          () => onLateSuccess(task),
          () => undefined,
        );
      }
    } catch (error) {
      if (mounted.current) {
        show(`${toBackendError(error).message} It is not checked off yet.`, task.instanceId);
      }
    } finally {
      inFlight.current = false;
      if (mounted.current) setBusy(false);
    }
  };

  /**
   * purpose: The Done button: confirm the target task unless a press is too close to the
   *          last one, a confirm is running, the button is settling, or the phone is offline.
   * @return: (void)
   */
  const pressDone = (): void => {
    const now = Date.now();
    if (target === null || inFlight.current || settlingRef.current) return;
    if (now - lastPress.current < PRESS_GAP_MS) return;
    lastPress.current = now;
    if (isOffline) {
      show(OFFLINE_DONE_MESSAGE, target.instanceId);
      return;
    }
    void confirm(target);
  };

  // A line belongs to one task: show it under that task's button, or when no button is shown.
  const task = settling ? null : target;
  const message =
    line !== null && (task === null || line.instanceId === task.instanceId) ? line.text : null;

  return { task, message, busy, pressDone };
}
