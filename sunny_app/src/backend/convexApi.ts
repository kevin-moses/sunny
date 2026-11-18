import { anyApi } from 'convex/server';

import type { api as BackendApi } from '../../../sunny_backend/convex/_generated/api';
import type { Id } from '../../../sunny_backend/convex/_generated/dataModel';

export type HouseholdId = Id<'households'>;

export type TaskInstanceId = Id<'taskInstances'>;

export type ProfileEntryId = Id<'lifeProfileEntries'>;

export type TopicId = Id<'sensitiveTopics'>;

export type FactId = Id<'agentMemory'>;

export const api = anyApi as unknown as typeof BackendApi;
