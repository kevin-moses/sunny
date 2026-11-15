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
// useDoneAction turns a press into a queued confirm (pendingConfirms.ts) with a new random
// press id: the press is stored first, and only then does the screen confirm it, with one line:
// the Undo line "<label> done." (while the phone is offline and the press is still queued,
// worked out at render time: "<label> done. It will be sent when the internet is back."),
// shown with its Undo button for UNDO_MS (30 seconds) after the press itself; after
// that nothing remains and the list shows the task checked. The queue sends the press by
// itself, now or later, with the age of the press. There is no spinner and no timeout on the
// send: the senior's part is done once the press is stored. Storing is raced against
// STORE_TIMEOUT_MS so a hung storage call cannot leave the button silently stuck; on a failure
// or timeout the line says "Sunny could not save that. Please press Done again." and the task
// stays offered and does not read checked (the queue shows a press only once it is stored). If
// a timed-out write finishes later after all, the press is stored, so the Undo line and the
// settle block apply then. A permanent rejection later is only logged by the queue; the senior
// sees nothing and the row follows the server.
//
// Guards: a second press within PRESS_GAP_MS is ignored and presses are ignored while one is
// being stored. After a press the button is withdrawn for SETTLE_MS (the hook returns task
// null) and presses are refused, so a senior who doubts the first tap cannot confirm the next
// task by accident; a result line is shown only under the button of the task it is about (or
// when there is no button). A task that is not due yet (an early target) is not offered again
// until MESSAGE_MS after the press, so a doubting tap cannot chain into an early medication; a
// task that is due is offered after SETTLE_MS. A senior who presses Done again every ~11 s can
// still chain from a due task into an early one (each press is deliberate, and each shows its
// own heading and "Done early" label); the screen cannot prevent that. The server judges a
// replayed press as of the time it was pressed (see confirmPressedTask). A result line lasts
// MESSAGE_MS and is announced to VoiceOver from an effect, after the screen re-rendered without
// the button. After unmount nothing is set, scheduled or announced.
//
// Undo (phone only; the home display has none): only the latest stored press has an offer (a
// new press replaces it), and it lives in memory, so after a restart there is none. Its
// appearance is announced (the line's text, then "Undo"), queued behind any announcement in
// progress. The offer names the press the queue actually holds for the task: enqueue resolves
// with the stored entry, or with the queued press a second press was skipped for. pressUndo
// withdraws the offer at once and queues an undo (toUndo: the tap time, the task's state before
// the press and that press's id) in the same durable queue, which sends it in order after the
// press, with the tap's age. The settle block stays until the undo is stored; then it is
// lifted, so the task, shown open again by applyPending, is offered Done again straight away
// when it is confirmable, and "<label> is not done." is announced (queued) only if the screen
// then shows the task open (shownTasks); nothing new is shown, the Done button coming back is
// the visible feedback. If the undo cannot
// be stored (STORE_TIMEOUT_MS or a storage error) it is logged, the offer comes back while time
// remains and the settle block is entered again; the senior sees no error.
//
// Last modified: 2026-11-14

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

/** Presses closer together than this (ms) count as one. */
export const PRESS_GAP_MS = 700;

/** How long (ms) a result line stays on screen, and how long an early task is held back. */
export const MESSAGE_MS = 10_000;

/** How long (ms) the button stays withdrawn after a press. */
export const SETTLE_MS = 4_000;

/** How long (ms) storing a press may take before the senior is asked to press again. */
export const STORE_TIMEOUT_MS = 4_000;

/** Said when the press could not be stored on the phone. */
export const NOT_STORED_MESSAGE = 'Sunny could not save that. Please press Done again.';

/** Added to the Undo line while the phone is offline and the press is still queued. */
export const OFFLINE_NOTE = ' It will be sent when the internet is back.';

/** How long (ms) after a press its Undo is offered (the server allows 60 s). */
export const UNDO_MS = 30_000;

/** The Undo offer: the pressed task's label and the line to show. */
export interface UndoLineData {
  label: string;
  /** "<label> done.", plus OFFLINE_NOTE while offline and the press is still queued. */
  text: string;
}

/** What useDoneAction returns. */
export interface DoneAction {
  /** The task to offer a Done button for, or null (nothing to confirm, or settling). */
  task: DayTask | null;
  /** The result line to show (only "press again" now), or null. */
  message: string | null;
  /** The Done button was pressed. */
  pressDone: () => void;
  /** The Undo offer of the latest press while it may be undone, or null. */
  undo: UndoLineData | null;
  /** The Undo button was tapped. */
  pressUndo: () => void;
}

/**
 * A stored press: the task as it was when pressed, when, and the queue entry that stands for it
 * (its own, or the queued press it was skipped for), whose press id an Undo names.
 */
interface Pressed {
  task: DayTask;
  pressedAt: number;
  entry: PendingConfirm;
}

/** The Undo offer state: the press and what was announced when it appeared. */
interface Offer {
  pressed: Pressed;
  spoken: string;
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
 * purpose: Announce to VoiceOver behind whatever it is saying, without interrupting it.
 * @param text: (string) The announcement.
 * @return: (void)
 */
function announceQueued(text: string): void {
  AccessibilityInfo.announceForAccessibilityWithOptions(text, { queue: true });
}

/**
 * purpose: The task Done confirms: the first due or escalated timed task in the day's order;
 *          otherwise the first upcoming timed task that is confirmable now.
 * @param tasks: (DayTask[]) Today's tasks, in the day view's order (after applyPending).
 * @param allowEarly: (boolean) Whether an early (upcoming) task may be offered; false offline.
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
 * @param isOffline: (boolean) The connection to the backend is down (changes the Undo line's
 *        note and whether a send is started now).
 * @param queue: (ConfirmQueue) The queue presses and undos go to.
 * @param shownTasks: (readonly DayTask[]) The tasks as the screen shows them (after
 *        applyPending), to tell whether an undone task is actually shown open before saying so.
 * @return: (DoneAction) The task to offer, the result line and press handler, and the Undo
 *          offer with its handler.
 */
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
  /** The latest stored press; an older press's undo outcome must not touch the screen. */
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

  /**
   * purpose: Set the Undo offer (null withdraws it) and stop its expiry timer.
   * @param pressed: (Pressed | null) The press now offered, or null.
   * @param spoken: (string) What to announce when it appears.
   * @return: (void)
   */
  const setOffer = (pressed: Pressed | null, spoken = ''): void => {
    clearTimeout(undoTimer.current);
    undoRef.current = pressed;
    setOfferState(pressed === null ? null : { pressed, spoken });
  };

  /**
   * purpose: Offer the Undo of a press while UNDO_MS has not passed since the press, and
   *          withdraw it by itself then; a press already older than that withdraws the offer.
   *          The announcement is the line as it reads now (the entry was just stored), then
   *          "Undo".
   * @param pressed: (Pressed) The press.
   * @param now: (number) Epoch ms now.
   * @return: (void)
   */
  const offerUndo = (pressed: Pressed, now: number): void => {
    const left = pressed.pressedAt + UNDO_MS - now;
    const spoken = `${pressed.task.displayLabel} done.${isOffline ? OFFLINE_NOTE : ''} Undo`;
    setOffer(left > 0 ? pressed : null, spoken);
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
   * purpose: Remove the result line now.
   * @return: (void)
   */
  const clearLine = (): void => {
    clearTimeout(clearTimer.current);
    setLine(null);
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
   * purpose: Show that a press is stored: the settle block and the Undo offer, which is the
   *          one line confirming the press (replacing an earlier press's offer and any
   *          press-again line). The offer names the press the queue actually holds for the
   *          task: this press, or the queued press it was skipped for.
   * @param task: (DayTask) The task that was pressed.
   * @param pressedAt: (number) Epoch ms of the press.
   * @param entry: (PendingEntry) What enqueue resolved with.
   * @return: (void)
   */
  const stored = (task: DayTask, pressedAt: number, entry: PendingEntry): void => {
    if (entry.kind === 'undo') return;
    const pressed: Pressed = { task, pressedAt, entry };
    latestStored.current = pressed;
    clearLine();
    enter('settle');
    offerUndo(pressed, Date.now());
  };

  /**
   * purpose: Store the press, show the result and let the queue send it. The task reads
   *          checked only once the press is stored. If storing takes longer than
   *          STORE_TIMEOUT_MS the senior is asked to press again and the same task stays
   *          offered; should the write finish later after all, the press is stored, so the
   *          Undo offer and the settle block apply then.
   * @param task: (DayTask) The task on screen when the button was pressed.
   * @param pressedAt: (number) Epoch ms of the press.
   * @return: (Promise<void>) Resolves when the outcome is shown; never rejects.
   */
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

  /**
   * purpose: Store the Undo of a press and let the queue send it after the press. Once it is
   *          stored (also when a timed-out write lands later) the settle block is lifted, so
   *          the task, shown open again, is offered Done again, any offer that came back is
   *          withdrawn, and "<label> is not done." is announced if the screen then shows the
   *          task open (the effect above). When it cannot be stored in STORE_TIMEOUT_MS it is
   *          logged, the offer comes back while time remains and the settle block is entered
   *          again; the senior is told nothing. Both outcomes apply only while no newer press
   *          was stored.
   * @param pressed: (Pressed) The press being taken back.
   * @param undoneAt: (number) Epoch ms of the Undo tap.
   * @return: (Promise<void>) Resolves when the outcome is handled; never rejects.
   */
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

  /**
   * purpose: The Undo button: withdraw the offer at once and queue the undo; the settle block
   *          stays until the undo is stored (storeUndo). Ignored when nothing may be undone.
   * @return: (void)
   */
  const pressUndo = (): void => {
    const pressed = undoRef.current;
    if (pressed === null) return;
    setOffer(null);
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
  // The offline note shows only while offline and while the press is still queued.
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
