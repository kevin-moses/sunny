// sunny_app/src/backend/convex.ts
//
// Purpose: The app's single ConvexReactClient and the status-returning query hook. App.tsx
// hands the client to ConvexProviderWithClerk, which authenticates it with the Clerk session;
// non-React code (voice token, push token, unpair) calls it through api.ts. Unsaved-changes
// warnings are off because the app has no browser window to warn.
//
// Last modified: 2026-10-29

import { ConvexReactClient, useQueries } from 'convex/react';
import { makeUseQueryWithStatus } from 'convex-helpers/react';

import { CONVEX_URL } from '../config';

/** The shared Convex client for queries, mutations and actions. */
export const convex = new ConvexReactClient(CONVEX_URL, { unsavedChangesWarning: false });

/**
 * A query hook that returns { status, data, error } instead of throwing on a query error, and
 * accepts 'skip' as the arguments.
 */
export const useQueryWithStatus = makeUseQueryWithStatus(useQueries);
