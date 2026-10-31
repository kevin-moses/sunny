// sunny_app/src/backend/useSession.ts
//
// Purpose: React hook that tells the app shell what to show, from the Clerk session, Convex auth
// and the households.mine and households.accountKind queries (decideSession in pairing.ts);
// nothing is persisted locally. The last home seen in this app run (a paired device or a
// caregiver household) is kept in memory so a transient Convex auth or query failure does not
// unmount the home screen (or a live conversation). Both queries are skipped until Convex
// confirms the session, because they answer an empty list or null to a signed-out caller,
// which must not be mistaken for a removal. While the decision is "removed" (a device whose
// pairing is gone) the hook unpairs the device, retrying with a capped backoff until the
// session is gone; a caregiver is never unpaired. A failing query is logged.
//
// Last modified: 2026-10-30

import { useAuth } from '@clerk/expo';
import { useConvexAuth } from 'convex/react';
import { useEffect, useMemo, useState } from 'react';

import { logger } from '../logging/logger';
import { useQueryWithStatus } from './convex';
import { api } from './convexApi';
import {
  decideSession,
  rememberHome,
  removalRetryDelay,
  unpair,
  type HomeDecision,
  type SessionDecision,
} from './pairing';

/**
 * purpose: Follow the signed-in account: signed out, a paired senior device, a caregiver in a
 *          household, or a caregiver who still needs to join or create one.
 * @return: (SessionDecision) loading (possibly with a notice), signedOut, paired (with the
 *          device), removed, caregiver (with the household and role) or caregiverOnboarding. A
 *          removed device is already being unpaired by the hook.
 */
export function useSession(): SessionDecision {
  const clerk = useAuth();
  const convex = useConvexAuth();
  const queryArgs = convex.isAuthenticated ? {} : 'skip';
  const mine = useQueryWithStatus(api.households.mine, queryArgs);
  const kind = useQueryWithStatus(api.households.accountKind, queryArgs);
  const [lastHome, setLastHome] = useState<HomeDecision | null>(null);
  const mineFailed = mine.status === 'error';
  const accountKindFailed = kind.status === 'error';

  const decision = useMemo(
    () =>
      decideSession({
        clerkLoaded: clerk.isLoaded,
        clerkSignedIn: clerk.isSignedIn === true,
        convexLoading: convex.isLoading,
        convexAuthenticated: convex.isAuthenticated,
        mine: mine.data,
        mineFailed,
        accountKind: kind.data,
        accountKindFailed,
        lastHome,
      }),
    [
      clerk.isLoaded,
      clerk.isSignedIn,
      convex.isLoading,
      convex.isAuthenticated,
      mine.data,
      mineFailed,
      kind.data,
      accountKindFailed,
      lastHome,
    ],
  );

  // Remember the home while rendering (React's "adjust state when a value changes" pattern).
  const remembered = rememberHome(decision, lastHome);
  if (remembered !== lastHome) setLastHome(remembered);

  useEffect(() => {
    if (mineFailed) logger.warning('Session', `households.mine failed: ${String(mine.error)}`);
  }, [mineFailed, mine.error]);

  useEffect(() => {
    if (accountKindFailed) {
      logger.warning('Session', `households.accountKind failed: ${String(kind.error)}`);
    }
  }, [accountKindFailed, kind.error]);

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
