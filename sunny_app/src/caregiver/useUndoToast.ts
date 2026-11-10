// sunny_app/src/caregiver/useUndoToast.ts
//
// Purpose: The state of the "Task completed / Undo" toast: which task it is for and when it goes
// away. show(id) displays the toast for a task and starts a UNDO_TOAST_MS timer; showing it again
// (a newer tick) replaces the task and restarts the timer, so only the latest tick has a toast.
// dismiss() hides it at once. The timer is cleared on unmount, and a show() after unmount (a late server reply) does
// nothing, so no timer is armed. show and dismiss keep their
// identity between renders. The timing is the shared useTimedValue (src/components).
//
// Last modified: 2026-11-09

import { useTimedValue } from '../components/useTimedValue';

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
  const { value, show, dismiss } = useTimedValue<T>(durationMs);
  return { id: value, show, dismiss };
}
