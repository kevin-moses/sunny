// sunny_app/src/day/usePendingConfirms.ts
//
// Purpose: React hook over the pending-confirm queue (pendingConfirms.ts): it loads the stored
// entries when the screen mounts (so a task pressed before the app was closed still shows as
// checked), starts a replay at launch, and returns the set of instance ids with a queued press
// for the optimistic display. Tracking the connection and replaying when the socket connects
// is the queue's own job (it follows the Convex connection), not this screen's. Used by the
// phone's Today screen; the home display can use it unchanged.
//
// Last modified: 2026-11-09

import { useEffect, useMemo, useSyncExternalStore } from 'react';

import type { ConfirmQueue } from './pendingConfirms';

/**
 * purpose: Follow the queue and start it.
 * @param queue: (ConfirmQueue) The queue.
 * @return: (ReadonlySet<string>) Instance ids with a queued press.
 */
export function usePendingConfirms(queue: ConfirmQueue): ReadonlySet<string> {
  const entries = useSyncExternalStore(queue.subscribe, queue.getEntries);

  useEffect(() => {
    void queue.replay();
  }, [queue]);

  return useMemo(() => new Set(entries.map((e) => e.instanceId)), [entries]);
}
