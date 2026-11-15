import { ConvexReactClient, useQueries } from 'convex/react';
import { makeUseQueryWithStatus } from 'convex-helpers/react';

import { CONVEX_URL } from '../config';

export const convex = new ConvexReactClient(CONVEX_URL, { unsavedChangesWarning: false });

export const useQueryWithStatus = makeUseQueryWithStatus(useQueries);
