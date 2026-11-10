// sunny_app/src/backend/convexApi.ts
//
// Purpose: The typed reference to the Convex backend's public functions. At runtime it is
// Convex's `anyApi` proxy (a function reference is just its "module:function" name, so Metro
// never bundles or resolves any backend file). At type level it is cast to the backend's
// generated `api` type, imported with `import type`, which TypeScript erases at build time.
// Argument and return types therefore follow the backend automatically
// (FunctionReturnType / FunctionArgs), with no codegen step in the app. Run
// `npx convex dev` (or codegen) in sunny_backend to refresh `_generated/api.d.ts` after the
// backend's functions change. Also exports the document id types the app passes back (household,
// task instance, and the About tab's life profile entry, sensitive topic and memory fact).
//
// Last modified: 2026-11-09

import { anyApi } from 'convex/server';

import type { api as BackendApi } from '../../../sunny_backend/convex/_generated/api';
import type { Id } from '../../../sunny_backend/convex/_generated/dataModel';

/** The id of a household document. */
export type HouseholdId = Id<'households'>;

/** The id of a task instance document. */
export type TaskInstanceId = Id<'taskInstances'>;

/** The id of a life profile entry. */
export type ProfileEntryId = Id<'lifeProfileEntries'>;

/** The id of a sensitive topic. */
export type TopicId = Id<'sensitiveTopics'>;

/** The id of an agent memory fact. */
export type FactId = Id<'agentMemory'>;

/** The backend's public functions, for example api.calendar.dayView. */
export const api = anyApi as unknown as typeof BackendApi;
