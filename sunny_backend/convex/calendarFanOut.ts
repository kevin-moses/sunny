// calendarFanOut.ts
// Purpose: The scheduled entry points of Google Calendar queueing that must not run inside
// the caller's transaction: `chunk` queues one bounded batch of pushes for a household
// (after connecting, or after a household change; each chunk schedules the next until the
// events are done, see lib/calendarSync.ts) and `sweepStuckSyncs` (cron, every 10 minutes)
// re-enqueues sync rows that have not changed for 15 minutes.
//
// Last modified: 2026-10-29

import { v } from "convex/values";
import { internalMutation } from "./_generated/server";
import { fanOutChunk, requeueStuckSyncs } from "./lib/calendarSync";

/**
 * purpose: Queue one chunk of a fan-out and schedule the next when more events remain.
 * @param householdId: (Id<"households">) Household whose events are pushed.
 * @param connectionId: (Id<"calendarConnections">, optional) Push only to this connection.
 * @param cursor: (string | null) Pagination cursor; null for the first chunk.
 * @return: ({ queued: number; next: string | null }) Syncs queued and the next cursor.
 */
export const chunk = internalMutation({
  args: {
    householdId: v.id("households"),
    connectionId: v.optional(v.id("calendarConnections")),
    cursor: v.union(v.null(), v.string()),
  },
  handler: async (ctx, args): Promise<{ queued: number; next: string | null }> => {
    return await fanOutChunk(ctx, args);
  },
});

/**
 * purpose: Cron entry: enqueue again the sync rows idle for 15 minutes or more.
 * @return: (number) Rows re-enqueued.
 */
export const sweepStuckSyncs = internalMutation({
  args: {},
  handler: async (ctx): Promise<number> => {
    return await requeueStuckSyncs(ctx, Date.now());
  },
});
