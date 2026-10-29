// sunny_app/src/backend/usePairing.ts
//
// Purpose: React hook that tells the app shell whether this device is paired, from the Clerk
// session, Convex auth and the households.mine query (decidePairing in pairing.ts); nothing is
// persisted locally. The last paired device seen in this app run is kept in memory so a
// transient Convex auth or query failure does not unmount the home screen (or a live
// conversation). The households.mine query is skipped until Convex confirms the session,
// because it answers an empty list to a signed-out caller, which must not be mistaken for a
// removal. While the decision is "removed" the hook unpairs the device, retrying with a capped
// backoff until the session is gone. A failing mine query is logged.
//
// Last modified: 2026-10-29

import { useAuth } from '@clerk/expo';
import { useConvexAuth } from 'convex/react';
import { useEffect, useMemo, useState } from 'react';

import { logger } from '../logging/logger';
import { useQueryWithStatus } from './convex';
import { api } from './convexApi';
import {
  decidePairing,
  rememberDevice,
  removalRetryDelay,
  unpair,
  type PairedDevice,
  type PairingDecision,
} from './pairing';

/**
 * purpose: Follow this device's pairing.
 * @return: (PairingDecision) loading (possibly with a notice), unpaired, paired (with the
 *          device) or removed. A removed device is already being unpaired by the hook.
 */
export function usePairing(): PairingDecision {
  const clerk = useAuth();
  const convex = useConvexAuth();
  const mine = useQueryWithStatus(api.households.mine, convex.isAuthenticated ? {} : 'skip');
  const [lastDevice, setLastDevice] = useState<PairedDevice | null>(null);
  const mineFailed = mine.status === 'error';

  const decision = useMemo(
    () =>
      decidePairing({
        clerkLoaded: clerk.isLoaded,
        clerkSignedIn: clerk.isSignedIn === true,
        convexLoading: convex.isLoading,
        convexAuthenticated: convex.isAuthenticated,
        mine: mine.data,
        mineFailed,
        lastDevice,
      }),
    [
      clerk.isLoaded,
      clerk.isSignedIn,
      convex.isLoading,
      convex.isAuthenticated,
      mine.data,
      mineFailed,
      lastDevice,
    ],
  );

  // Remember the device while rendering (React's "adjust state when a value changes" pattern).
  const remembered = rememberDevice(decision, lastDevice);
  if (remembered !== lastDevice) setLastDevice(remembered);

  useEffect(() => {
    if (mineFailed) logger.warning('Pairing', `households.mine failed: ${String(mine.error)}`);
  }, [mineFailed, mine.error]);

  const removed = decision.state === 'removed';
  useEffect(() => {
    if (!removed) return;
    let attempt = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let active = true;
    const run = (): void => {
      void unpair().then(() => {
        if (active) timer = setTimeout(run, removalRetryDelay(attempt++));
      });
    };
    run();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [removed]);

  return decision;
}
