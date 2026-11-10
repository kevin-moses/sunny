// sunny_app/src/day/usePendingConfirms.ts
//
// Purpose: React hook over the pending-confirm queue (pendingConfirms.ts): it loads the stored
// entries when the screen mounts (so a task pressed before the app was closed still shows as
// checked), starts a replay on launch and whenever the connection returns, and returns the set
// of instance ids with a queued press for the optimistic display. Used by the phone's Today
// screen; the home display can use it unchanged.
//
// Last modified: 2026-11-09

import { useEffect, useMemo, useSyncExternalStore } from 'react';

import type { ConfirmQueue } from './pendingConfirms';

/**
 * purpose: Follow the queue and keep it draining.
 * @param queue: (ConfirmQueue) The queue.
 * @param isOffline: (boolean) The connection to the backend is down; a replay starts at mount
 *        and each time this becomes false.
 * @return: (ReadonlySet<string>) Instance ids with a queued press.
 */
export function usePendingConfirms(queue: ConfirmQueue, isOffline: boolean): ReadonlySet<string> {
  const entries = useSyncExternalStore(queue.subscribe, queue.getEntries);

  useEffect(() => {
    void queue.load();
  }, [queue]);

  useEffect(() => {
    if (!isOffline) void queue.replay();
  }, [queue, isOffline]);

  return useMemo(() => new Set(entries.map((e) => e.instanceId)), [entries]);
}
