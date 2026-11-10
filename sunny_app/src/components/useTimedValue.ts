// sunny_app/src/components/useTimedValue.ts
//
// Purpose: A value that shows for a while and then clears itself, shared by the caregiver
// app's undo toast (useUndoToast) and the home display's status line (useStatusMessage).
// show(value) displays it and starts a durationMs timer; showing again replaces the value and
// restarts the timer, so only the latest one is up. dismiss() clears it at once. The timer is
// cleared on unmount, and a show() after unmount (a late server reply) does nothing, so no
// timer is armed. show and dismiss keep their identity between renders (while durationMs is
// unchanged).
//
// Last modified: 2026-11-09

import { useCallback, useEffect, useRef, useState } from 'react';

/** What useTimedValue returns. */
export interface TimedValue<T> {
  /** The value showing; null while none is. */
  value: T | null;
  /** Show a value, replacing any current one and restarting the timer. */
  show: (value: T) => void;
  /** Clear the value now. */
  dismiss: () => void;
}

/**
 * purpose: Hold a value that clears itself durationMs after it was shown.
 * @param durationMs: (number) How long a value stays.
 * @return: (TimedValue<T>) The current value and the show and dismiss actions.
 */
export function useTimedValue<T>(durationMs: number): TimedValue<T> {
  const [value, setValue] = useState<T | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);

  /**
   * purpose: Stop the running timer, if any.
   * @return: (void)
   */
  const clearTimer = useCallback((): void => {
    if (timerRef.current !== null) clearTimeout(timerRef.current);
    timerRef.current = null;
  }, []);

  /**
   * purpose: Clear the value now.
   * @return: (void)
   */
  const dismiss = useCallback((): void => {
    clearTimer();
    setValue(null);
  }, [clearTimer]);

  /**
   * purpose: Show a value, replacing any current one and restarting the timer. Does nothing
   *          once the component has unmounted.
   * @param next: (T) The value.
   * @return: (void)
   */
  const show = useCallback(
    (next: T): void => {
      if (!mountedRef.current) return;
      clearTimer();
      setValue(next);
      timerRef.current = setTimeout(dismiss, durationMs);
    },
    [clearTimer, dismiss, durationMs],
  );

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      clearTimer();
    };
  }, [clearTimer]);

  return { value, show, dismiss };
}
