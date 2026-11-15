import { v } from "convex/values";
import { internalMutation } from "./_generated/server";
import { fanOutChunk, requeueStuckSyncs } from "./lib/calendarSync";

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

export const sweepStuckSyncs = internalMutation({
  args: {},
  handler: async (ctx): Promise<number> => {
    return await requeueStuckSyncs(ctx, Date.now());
  },
});
