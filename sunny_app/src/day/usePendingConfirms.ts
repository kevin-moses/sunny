// sunny_app/src/day/usePendingConfirms.ts
//
// Purpose: React hook over the pending-confirm queue (pendingConfirms.ts): it loads the stored
// entries when the screen mounts (so a task pressed, or undone, before the app was closed still
// shows that way), starts a replay at launch, and returns the queued entries, oldest first, for
// the optimistic display (applyPending in pendingEntries.ts). Tracking the connection and
// replaying when the socket connects is the queue's own job (it follows the Convex connection),
// not this screen's. Used by the phone's Today screen; the home display can use it unchanged.
//
// Last modified: 2026-11-14

import { useEffect, useSyncExternalStore } from 'react';

import type { ConfirmQueue } from './pendingConfirms';
import type { PendingEntry } from './pendingEntries';

/**
 * purpose: Follow the queue and start it.
 * @param queue: (ConfirmQueue) The queue.
 * @return: (readonly PendingEntry[]) The queued presses and undos, oldest first.
 */
export function usePendingConfirms(queue: ConfirmQueue): readonly PendingEntry[] {
  const entries = useSyncExternalStore(queue.subscribe, queue.getEntries);

  useEffect(() => {
    void queue.replay();
  }, [queue]);

  return entries;
}
