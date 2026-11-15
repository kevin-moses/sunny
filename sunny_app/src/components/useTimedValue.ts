import { useCallback, useEffect, useRef, useState } from 'react';

export interface TimedValue<T> {
  value: T | null;
  show: (value: T) => void;
  dismiss: () => void;
}

export function useTimedValue<T>(durationMs: number): TimedValue<T> {
  const [value, setValue] = useState<T | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);

  const clearTimer = useCallback((): void => {
    if (timerRef.current !== null) clearTimeout(timerRef.current);
    timerRef.current = null;
  }, []);

  const dismiss = useCallback((): void => {
    clearTimer();
    setValue(null);
  }, [clearTimer]);

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
