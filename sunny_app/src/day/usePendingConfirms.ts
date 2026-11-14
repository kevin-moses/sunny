// sunny_app/src/day/usePendingConfirms.ts
//
// Purpose: React hook over the pending-confirm queue (pendingConfirms.ts): it loads the stored
// entries when the screen mounts (so a task pressed, or undone, before the app was closed still
// shows that way), starts a replay at launch, and returns each task's latest queued entry (a
// press or an undo) for the optimistic display (applyPending). Tracking the connection and
// replaying when the socket connects is the queue's own job (it follows the Convex connection),
// not this screen's. Used by the phone's Today screen; the home display can use it unchanged.
//
// Last modified: 2026-11-14

import { useEffect, useMemo, useSyncExternalStore } from 'react';

import { latestByInstance, type ConfirmQueue, type PendingEntry } from './pendingConfirms';

/**
 * purpose: Follow the queue and start it.
 * @param queue: (ConfirmQueue) The queue.
 * @return: (ReadonlyMap<string, PendingEntry>) Instance id to its latest queued entry.
 */
export function usePendingConfirms(queue: ConfirmQueue): ReadonlyMap<string, PendingEntry> {
  const entries = useSyncExternalStore(queue.subscribe, queue.getEntries);

  useEffect(() => {
    void queue.replay();
  }, [queue]);

  return useMemo(() => latestByInstance(entries), [entries]);
}
