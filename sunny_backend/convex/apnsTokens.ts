// apnsTokens.ts
// Purpose: Database side of the APNs sender. apns.ts is a "use node" file and so cannot hold
// mutations; this module deletes push tokens that APNs reported as unregistered.
// Exports: deleteTokens (internalMutation).
//
// Last modified: 2026-10-29

import { v } from "convex/values";
import { internalMutation } from "./_generated/server";

/**
 * purpose: Delete pushTokens rows for the given device tokens (unknown tokens are ignored).
 * @param tokens: (string[]) Device tokens APNs reported as unregistered.
 * @return: (number) Number of rows deleted.
 */
export const deleteTokens = internalMutation({
  args: { tokens: v.array(v.string()) },
  handler: async (ctx, args): Promise<number> => {
    let deleted = 0;
    for (const token of new Set(args.tokens)) {
      const rows = await ctx.db
        .query("pushTokens")
        .withIndex("by_token", (q) => q.eq("token", token))
        .collect();
      for (const row of rows) {
        await ctx.db.delete(row._id);
        deleted += 1;
      }
    }
    return deleted;
  },
});
