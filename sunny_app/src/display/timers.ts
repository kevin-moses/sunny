// sunny_app/src/display/timers.ts
//
// Purpose: Two small hooks the home display's timing logic is built from, so each timer is
// one line and none can forget its cleanup:
// - useLatest: a ref that always holds the latest value, for callbacks that run later (a
//   timer, a promise) and must see current props without restarting anything.
// - useTimeout: runs a callback once after `ms`, while `ms` is not null. The timer restarts
//   when `ms` or `key` changes and is cleared on unmount; the callback is read when it fires,
//   so a new callback identity never restarts it.
//
// Last modified: 2026-11-09

import { useEffect, useRef } from 'react';
import type { RefObject } from 'react';

/**
 * purpose: A ref that always holds the latest value (updated after every render).
 * @param value: (T) The value.
 * @return: (RefObject<T>) The ref; read it only outside rendering.
 */
export function useLatest<T>(value: T): RefObject<T> {
  const ref = useRef(value);
  useEffect(() => {
    ref.current = value;
  });
  return ref;
}

/**
 * purpose: Run a callback once after a delay, restarting when the delay or the key changes.
 * @param callback: (() => void) What to run; the latest one is called.
 * @param ms: (number | null) The delay, or null for no timer.
 * @param key: (unknown) Anything whose change restarts the timer (optional).
 * @return: (void)
 */
export function useTimeout(callback: () => void, ms: number | null, key?: unknown): void {
  const latest = useLatest(callback);
  useEffect(() => {
    if (ms === null) return undefined;
    const timer = setTimeout(() => latest.current(), ms);
    return () => clearTimeout(timer);
  }, [ms, key, latest]);
}
