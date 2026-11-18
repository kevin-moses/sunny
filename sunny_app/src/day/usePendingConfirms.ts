import { useEffect, useSyncExternalStore } from 'react';

import type { ConfirmQueue } from './pendingConfirms';
import type { PendingEntry } from './pendingEntries';

export function usePendingConfirms(queue: ConfirmQueue): readonly PendingEntry[] {
  const entries = useSyncExternalStore(queue.subscribe, queue.getEntries);

  useEffect(() => {
    void queue.replay();
  }, [queue]);

  return entries;
}
