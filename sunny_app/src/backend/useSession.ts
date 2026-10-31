// sunny_app/src/backend/useSession.ts
//
// Purpose: React hook that tells the app shell what to show, from the Clerk session, Convex auth
// and the households.mine query (decideSession in pairing.ts); nothing is persisted locally.
// The last home seen in this app run (a paired device or a caregiver household) is kept in a ref
// so a transient Convex auth or query failure does not unmount the home screen (or a live
// conversation). The query is skipped until Convex confirms the session, because it answers an
// empty result to a signed-out caller, which must not be mistaken for a removal. While the
// decision is "removed" (a device whose pairing is gone) the hook unpairs the device, retrying
// with a capped backoff until the session is gone; a caregiver is never unpaired. A failing
// query is logged.
//
// Last modified: 2026-10-31

import { useAuth } from '@clerk/expo';
import { useConvexAuth } from 'convex/react';
import { useEffect, useMemo, useRef } from 'react';

import { logger } from '../logging/logger';
import { useQueryWithStatus } from './convex';
import { api } from './convexApi';
import {
  decideSession,
  removalRetryDelay,
  showHome,
  unpair,
  type HomeDecision,
  type SessionDecision,
} from './pairing';

/**
 * purpose: Follow the signed-in account: signed out, a paired senior device, a caregiver in a
 *          household, or a caregiver who still needs to join or create one.
 * @return: (SessionDecision) loading (possibly with a notice), signedOut, paired (with the
 *          device), removed, caregiver (with the household and role) or caregiverOnboarding. A
 *          removed device is already being unpaired by the hook. While loading after a home was
 *          seen, that home is returned instead.
 */
export function useSession(): SessionDecision {
  const clerk = useAuth();
  const convex = useConvexAuth();
  const mine = useQueryWithStatus(api.households.mine, convex.isAuthenticated ? {} : 'skip');
  const queryFailed = mine.status === 'error';

  const decision = useMemo(
    () =>
      decideSession({
        clerkLoaded: clerk.isLoaded,
        clerkSignedIn: clerk.isSignedIn === true,
        convexLoading: convex.isLoading,
        convexAuthenticated: convex.isAuthenticated,
        mine: mine.data,
        queryFailed,
      }),
    [
      clerk.isLoaded,
      clerk.isSignedIn,
      convex.isLoading,
      convex.isAuthenticated,
      mine.data,
      queryFailed,
    ],
  );

  const lastHome = useRef<HomeDecision | null>(null);
  /* eslint-disable react-hooks/refs -- a render-time cache of the last home is the point */
  const { shown, remembered } = showHome(decision, lastHome.current);
  lastHome.current = remembered;
  /* eslint-enable react-hooks/refs */

  useEffect(() => {
    if (queryFailed) logger.warning('Session', `households.mine failed: ${String(mine.error)}`);
  }, [queryFailed, mine.error]);

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

  return shown;
}
