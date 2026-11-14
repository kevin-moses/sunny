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
// again, and only offer anything while the cached day is still today's (dayIsCurrent): offline
// across midnight the last day stays on screen, and a press meant for this morning must not
// confirm last night's task. The early step is skipped while the socket is down (allowEarly
// false), because the `confirmable` flag comes from that same stale day view.
//
// useDoneAction turns a press into a queued confirm (pendingConfirms.ts): the press is stored
// first, and only then does the screen show "Checked off: <label>" (with a note that it will be
// sent when the internet is back, when offline); the queue sends it by itself, now or later,
// with the age of the press. There is no spinner and no timeout on the send: the senior's part
// is done once the press is stored. Storing is raced against STORE_TIMEOUT_MS so a hung
// storage call cannot leave the button silently stuck; on a failure or timeout the line says
// "Sunny could not save that. Please press Done again." and the task stays offered and does not
// read checked (the queue shows a press only once it is stored). If a timed-out write finishes
// later after all, the press is stored, so the result line and the settle block apply then. A permanent rejection later is only
// logged by the queue; the senior sees nothing and the row follows the server.
//
// Guards: a second press within PRESS_GAP_MS is ignored and presses are ignored while one is
// being stored. After a press the button is withdrawn for SETTLE_MS (the hook returns task
// null) and presses are refused, so a senior who doubts the first tap cannot confirm the next
// task by accident; only the result line shows, and a line is shown only under the button of
// the task it is about (or when there is no button). A task that is not due yet (an early
// target) is not offered again until MESSAGE_MS after the press, when the "Checked off" line
// has finished, so a doubting tap cannot chain into an early medication; a task that is due is
// offered after SETTLE_MS. A senior who presses Done again every ~11 s can still chain from a
// due task into an early one (each press is deliberate, and each shows its own heading and
// "Done early" label); the screen cannot prevent that. The server judges a
// replayed press as of the time it was pressed (see confirmPressedTask). Each line lasts MESSAGE_MS and is announced to VoiceOver from an
// effect, after the screen re-rendered without the button. After unmount nothing is set,
// scheduled or announced.
//
// Undo (phone only; the home display has none): once a press is stored, the hook offers an
// Undo for that press (undoLabel, the task's label) until UNDO_MS after the press itself. Only
// the latest press has one: a new press replaces it. The offer lives in memory, so after a
// restart there is none. Its appearance is announced, queued behind the "Checked off" line.
// pressUndo withdraws the offer, clears the result line and the settle block at once (so the
// task, shown open again by applyPending, is offered Done again straight away when it is
// confirmable) and queues an undo (toUndo, stamped with the tap time and the task's state
// before the press) in the same durable queue, which sends it in order after the press, with
// the tap's age. If the undo cannot be stored (STORE_TIMEOUT_MS or a storage error) it is
// logged and the offer comes back while time remains; the senior sees no error.
//
// Last modified: 2026-11-14

import { useEffect, useRef, useState } from 'react';
import { AccessibilityInfo } from 'react-native';

import { logger } from '../logging/logger';
import { isAnytime, isDue } from './format';
import { currentLocalDate } from './localDate';
import { toPending, toUndo, type ConfirmQueue } from './pendingConfirms';
import type { DayTask, DayViewData } from './types';
import { withTimeout } from './withTimeout';

/** Presses closer together than this (ms) count as one. */
export const PRESS_GAP_MS = 700;

/** How long (ms) a result stays on screen. */
export const MESSAGE_MS = 10_000;

/** How long (ms) the button stays withdrawn after a press. */
export const SETTLE_MS = 4_000;

/** How long (ms) storing a press may take before the senior is asked to press again. */
export const STORE_TIMEOUT_MS = 4_000;

/** Said when the press could not be stored on the phone. */
export const NOT_STORED_MESSAGE = 'Sunny could not save that. Please press Done again.';

/** How long (ms) after a press its Undo is offered (the server allows 60 s). */
export const UNDO_MS = 30_000;

/** What useDoneAction returns. */
export interface DoneAction {
  /** The task to offer a Done button for, or null (nothing to confirm, or settling). */
  task: DayTask | null;
  /** The result line to show, or null. */
  message: string | null;
  /** The Done button was pressed. */
  pressDone: () => void;
  /** The label of the task whose latest press may be undone now, or null. */
  undoLabel: string | null;
  /** The Undo button was tapped. */
  pressUndo: () => void;
}

/** A stored press that may still be undone: the task as it was when pressed, and when. */
interface Pressed {
  task: DayTask;
  pressedAt: number;
}

/**
 * What a stored press withdraws: 'settle' hides the button for SETTLE_MS, 'early' then hides
 * only a task that is not due yet until MESSAGE_MS after the press.
 */
type Block = 'none' | 'settle' | 'early';

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
export function doneTarget(tasks: DayTask[], allowEarly = true): DayTask | null {
  const due = tasks.find(isDue);
  if (due !== undefined || !allowEarly) return due ?? null;
  return tasks.find((t) => t.state === 'upcoming' && t.confirmable && !isAnytime(t)) ?? null;
}

/**
 * purpose: Whether a day view is still today's. While the phone is offline the last day stays
 *          on screen, so after a night offline it is yesterday's and its cards (a due or early
 *          task) must not be offered: a press meant for this morning would confirm last
 *          night's task.
 * @param day: (Pick<DayViewData, 'localDate' | 'timezone'>) The cached day view.
 * @param now: (number) Epoch ms.
 * @return: (boolean) False only when the household's current date differs from the day's.
 *          True when the date cannot be worked out (so a missing Intl never blocks Done).
 */
export function dayIsCurrent(
  day: Pick<DayViewData, 'localDate' | 'timezone'>,
  now: number,
): boolean {
  const today = currentLocalDate(day.timezone, now);
  return today === null || today === day.localDate;
}

/** Said in place of the Done card while the cached day is not today's. */
export const STALE_DAY_MESSAGE = "Waiting for today's list to load.";

/**
 * purpose: Wire the Done button to the pending-confirm queue.
 * @param target: (DayTask | null) The task Done confirms (doneTarget), or null.
 * @param isOffline: (boolean) The connection to the backend is down (only changes the wording
 *        and whether a send is started now).
 * @param queue: (ConfirmQueue) The queue presses and undos go to.
 * @return: (DoneAction) The task to offer, result line and press handler, and the Undo offer
 *          with its handler.
 */
export function useDoneAction(
  target: DayTask | null,
  isOffline: boolean,
  queue: ConfirmQueue,
): DoneAction {
  const [line, setLine] = useState<Line | null>(null);
  const [block, setBlock] = useState<Block>('none');
  const mounted = useRef(true);
  const lastPress = useRef(0);
  const storing = useRef(false);
  const blockRef = useRef<Block>('none');
  const clearTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const blockTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [undoable, setUndoable] = useState<Pressed | null>(null);
  const undoRef = useRef<Pressed | null>(null);
  const undoTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

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
    if (undoable === null) return;
    AccessibilityInfo.announceForAccessibilityWithOptions(
      `${undoable.task.displayLabel} done. Undo`,
      { queue: true },
    );
  }, [undoable]);

  /**
   * purpose: Set the Undo offer (null withdraws it) and stop its expiry timer.
   * @param pressed: (Pressed | null) The press now offered, or null.
   * @return: (void)
   */
  const setOffer = (pressed: Pressed | null): void => {
    clearTimeout(undoTimer.current);
    undoRef.current = pressed;
    setUndoable(pressed);
  };

  /**
   * purpose: Offer the Undo of a press while UNDO_MS has not passed since the press, and
   *          withdraw it by itself then; a press already older than that withdraws the offer.
   * @param pressed: (Pressed) The press.
   * @param now: (number) Epoch ms now.
   * @return: (void)
   */
  const offerUndo = (pressed: Pressed, now: number): void => {
    const left = pressed.pressedAt + UNDO_MS - now;
    setOffer(left > 0 ? pressed : null);
    if (left > 0) undoTimer.current = setTimeout(() => setOffer(null), left);
  };

  /**
   * purpose: Show a result line for MESSAGE_MS (announced by the effect above).
   * @param text: (string) The line.
   * @param instanceId: (string) The task the line is about.
   * @return: (void)
   */
  const show = (text: string, instanceId: string): void => {
    clearTimeout(clearTimer.current);
    setLine({ text, instanceId });
    clearTimer.current = setTimeout(() => setLine(null), MESSAGE_MS);
  };

  /**
   * purpose: Move to a blocking phase and schedule the next one.
   * @param next: (Block) The phase to enter.
   * @return: (void)
   */
  const enter = (next: Block): void => {
    clearTimeout(blockTimer.current);
    blockRef.current = next;
    setBlock(next);
    if (next === 'settle') blockTimer.current = setTimeout(() => enter('early'), SETTLE_MS);
    if (next === 'early')
      blockTimer.current = setTimeout(() => enter('none'), MESSAGE_MS - SETTLE_MS);
  };

  /**
   * purpose: Show that a press is stored: the result line, the settle block, and the Undo
   *          offer (replacing an earlier press's offer).
   * @param task: (DayTask) The task that was pressed.
   * @param pressedAt: (number) Epoch ms of the press.
   * @return: (void)
   */
  const stored = (task: DayTask, pressedAt: number): void => {
    const sent = isOffline ? ' It will be sent when the internet is back.' : '';
    show(`Checked off: ${task.displayLabel}.${sent}`, task.instanceId);
    enter('settle');
    offerUndo({ task, pressedAt }, Date.now());
  };

  /**
   * purpose: Store the press, show the result and let the queue send it. The task reads
   *          checked only once the press is stored. If storing takes longer than
   *          STORE_TIMEOUT_MS the senior is asked to press again and the same task stays
   *          offered; should the write finish later after all, the press is stored, so the
   *          result line and the settle block apply then.
   * @param task: (DayTask) The task on screen when the button was pressed.
   * @param pressedAt: (number) Epoch ms of the press.
   * @return: (Promise<void>) Resolves when the outcome is shown; never rejects.
   */
  const store = async (task: DayTask, pressedAt: number): Promise<void> => {
    storing.current = true;
    const write = queue.enqueue(toPending(task, pressedAt));
    try {
      await withTimeout(write, STORE_TIMEOUT_MS, 'Storing the press took too long');
      if (!isOffline) void queue.replay();
      if (mounted.current) stored(task, pressedAt);
    } catch {
      if (mounted.current) show(NOT_STORED_MESSAGE, task.instanceId);
      write.then(
        () => {
          if (!isOffline) void queue.replay();
          if (mounted.current) stored(task, pressedAt);
        },
        () => undefined,
      );
    } finally {
      storing.current = false;
    }
  };

  /**
   * purpose: Store the Undo of a press and let the queue send it after the press. When it
   *          cannot be stored in STORE_TIMEOUT_MS it is logged and the offer comes back (while
   *          time remains and no newer press replaced it); the senior is told nothing. Should a
   *          timed-out write finish later after all, that offer is withdrawn again.
   * @param pressed: (Pressed) The press being taken back.
   * @param undoneAt: (number) Epoch ms of the Undo tap.
   * @return: (Promise<void>) Resolves when the outcome is handled; never rejects.
   */
  const storeUndo = async (pressed: Pressed, undoneAt: number): Promise<void> => {
    const write = queue.enqueue(toUndo(pressed.task, undoneAt));
    write.then(
      () => {
        if (!isOffline) void queue.replay();
        if (mounted.current && undoRef.current === pressed) setOffer(null);
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
      if (mounted.current && undoRef.current === null) offerUndo(pressed, Date.now());
    }
  };

  /**
   * purpose: The Undo button: withdraw the offer, the result line and the settle block at once
   *          (so the task, shown open again, is offered Done again straight away) and queue
   *          the undo. Ignored when nothing may be undone.
   * @return: (void)
   */
  const pressUndo = (): void => {
    const pressed = undoRef.current;
    if (pressed === null) return;
    setOffer(null);
    clearTimeout(clearTimer.current);
    setLine(null);
    enter('none');
    void storeUndo(pressed, Date.now());
  };

  /**
   * purpose: The Done button: queue a confirm for the target unless a press is too close to
   *          the last one, one is being stored, or the button is settling.
   * @return: (void)
   */
  const pressDone = (): void => {
    const now = Date.now();
    if (target === null || storing.current || blockRef.current === 'settle') return;
    if (blockRef.current === 'early' && target.state === 'upcoming') return;
    if (now - lastPress.current < PRESS_GAP_MS) return;
    lastPress.current = now;
    void store(target, now);
  };

  // A line belongs to one task: show it under that task's button, or when no button is shown.
  const hidden = block === 'settle' || (block === 'early' && target?.state === 'upcoming');
  const task = hidden ? null : target;
  const message =
    line !== null && (task === null || line.instanceId === task.instanceId) ? line.text : null;

  return {
    task,
    message,
    pressDone,
    undoLabel: undoable?.task.displayLabel ?? null,
    pressUndo,
  };
}
