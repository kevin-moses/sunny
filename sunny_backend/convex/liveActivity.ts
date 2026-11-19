import { v } from "convex/values";
import { internalMutation } from "./_generated/server";
import { proofMissed } from "./lib/liveActivitySync";

export const checkProof = internalMutation({
  args: { activityId: v.id("liveActivities") },
  handler: async (ctx, args): Promise<null> => {
    await proofMissed(ctx, args.activityId, Date.now());
    return null;
  },
});
