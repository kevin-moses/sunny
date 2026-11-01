// sunny_app/src/caregiver/useUndoToast.ts
//
// Purpose: The state of the "Task completed / Undo" toast: which task it is for and when it goes
// away. show(id) displays the toast for a task and starts a UNDO_TOAST_MS timer; showing it again
// (a newer tick) replaces the task and restarts the timer, so only the latest tick has a toast.
// dismiss() hides it at once. The timer is cleared on unmount. show and dismiss keep their
// identity between renders.
//
// Last modified: 2026-11-01

import { useCallback, useEffect, useRef, useState } from 'react';

/** How long (milliseconds) the toast stays up. */
export const UNDO_TOAST_MS = 5000;

/** What useUndoToast returns. */
export interface UndoToast<T> {
  /** The task the toast is for; null while no toast is showing. */
  id: T | null;
  /** Show the toast for a task, replacing any current one and restarting the timer. */
  show: (id: T) => void;
  /** Hide the toast now. */
  dismiss: () => void;
}

/**
 * purpose: Track the undo toast and its timer.
 * @param durationMs: (number, optional) How long the toast stays; UNDO_TOAST_MS by default.
 * @return: (UndoToast<T>) The current task id and the show and dismiss actions.
 */
export function useUndoToast<T>(durationMs: number = UNDO_TOAST_MS): UndoToast<T> {
  const [id, setId] = useState<T | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  /**
   * purpose: Stop the running timer, if any.
   * @return: (void)
   */
  const clearTimer = useCallback((): void => {
    if (timerRef.current !== null) clearTimeout(timerRef.current);
    timerRef.current = null;
  }, []);

  /**
   * purpose: Hide the toast now.
   * @return: (void)
   */
  const dismiss = useCallback((): void => {
    clearTimer();
    setId(null);
  }, [clearTimer]);

  /**
   * purpose: Show the toast for a task, replacing any current one and restarting the timer.
   * @param next: (T) The task the toast is for.
   * @return: (void)
   */
  const show = useCallback(
    (next: T): void => {
      clearTimer();
      setId(next);
      timerRef.current = setTimeout(dismiss, durationMs);
    },
    [clearTimer, dismiss, durationMs],
  );

  useEffect(() => clearTimer, [clearTimer]);

  return { id, show, dismiss };
}
