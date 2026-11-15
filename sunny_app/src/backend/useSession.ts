import { useAuth } from '@clerk/expo';
import { useConvexAuth } from 'convex/react';
import { useEffect, useMemo } from 'react';

import { useLastDefined } from '../components/useLastDefined';

import { logger } from '../logging/logger';
import { useQueryWithStatus } from './convex';
import { api } from './convexApi';
import { decideSession, homeOf, removalRetryDelay, unpair, type SessionDecision } from './pairing';

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

  return useLastDefined(homeOf(decision)) ?? decision;
}
