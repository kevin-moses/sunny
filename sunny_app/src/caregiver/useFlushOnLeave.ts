// sunny_app/src/caregiver/useFlushOnLeave.ts
//
// Purpose: Run a "flush" callback (for example saving a draft) when the screen is about to be
// lost: when the app leaves the foreground (inactive or background) and when the component
// unmounts. The latest callback is always the one called, so callers need not keep it stable.
//
// Last modified: 2026-11-01

import { useEffect, useRef } from 'react';
import { AppState } from 'react-native';

/**
 * purpose: Call flush when the app goes to the background or inactive, and on unmount.
 * @param flush: (() => void) What to run; it should do nothing when there is nothing to flush.
 * @return: (void)
 */
export function useFlushOnLeave(flush: () => void): void {
  const flushRef = useRef(flush);

  useEffect(() => {
    flushRef.current = flush;
  });

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      if (state !== 'active') flushRef.current();
    });
    return () => {
      subscription.remove();
      flushRef.current();
    };
  }, []);
}
