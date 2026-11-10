// sunny_app/src/day/usePendingConfirms.ts
//
// Purpose: React hook over the pending-confirm queue (pendingConfirms.ts): it loads the stored
// entries when the screen mounts (so a task pressed before the app was closed still shows as
// checked), tells the queue whether the connection is down, starts a replay on launch and each
// time the offline flag or the socket's connected flag changes (the connected flag matters on a
// fresh launch: isOffline stays false until the first connect, so a press queued before it
// would otherwise wait for the retry timer), and returns the set of instance ids with a queued
// press for the optimistic display. Used by the phone's Today screen; the home display can use
// it unchanged.
//
// Last modified: 2026-11-09

import { useEffect, useMemo, useSyncExternalStore } from 'react';

import type { ConfirmQueue } from './pendingConfirms';

/**
 * purpose: Follow the queue and keep it draining.
 * @param queue: (ConfirmQueue) The queue.
 * @param isOffline: (boolean) The connection to the backend is down (it was up once and the
 *        socket dropped); a replay starts at mount and each time this becomes false.
 * @param isConnected: (boolean) The socket is connected right now; a replay starts each time
 *        this becomes true (defaults to not offline).
 * @return: (ReadonlySet<string>) Instance ids with a queued press.
 */
export function usePendingConfirms(
  queue: ConfirmQueue,
  isOffline: boolean,
  isConnected: boolean = !isOffline,
): ReadonlySet<string> {
  const entries = useSyncExternalStore(queue.subscribe, queue.getEntries);

  useEffect(() => {
    void queue.load();
  }, [queue]);

  useEffect(() => {
    queue.setOffline(isOffline);
    if (!isOffline) void queue.replay();
  }, [queue, isOffline, isConnected]);

  return useMemo(() => new Set(entries.map((e) => e.instanceId)), [entries]);
}
