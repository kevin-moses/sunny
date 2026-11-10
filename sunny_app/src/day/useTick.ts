// sunny_app/src/day/useTick.ts
//
// Purpose: A clock that makes a screen re-render on a fixed interval while it is mounted, so
// time-based checks (for example whether the cached day is still today) keep running when no
// new data arrives, as when the phone is offline.
//
// Last modified: 2026-11-09

import { useEffect, useState } from 'react';

/**
 * purpose: Re-render the caller every `ms` milliseconds.
 * @param ms: (number) The interval in milliseconds.
 * @return: (number) The current time (epoch ms) as of the last tick.
 */
export function useTick(ms: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(timer);
  }, [ms]);
  return now;
}
