// apnsTokens.ts
// STUB: Part A replaces this file at merge. Token cleanup for the APNs sender, kept apart from
// apns.ts because a "use node" file can only export actions:
//   internal.apnsTokens.deleteTokens({ tokens }) deletes push tokens APNs reported as
//   unregistered and returns the number deleted.
//
// Last modified: 2026-10-29

import { v } from "convex/values";
import { internalMutation } from "./_generated/server";

/**
 * purpose: STUB of the token cleanup: delete the given push tokens.
 * @param tokens: (string[]) Tokens APNs reported as unregistered.
 * @return: (number) Rows deleted.
 */
export const deleteTokens = internalMutation({
  args: { tokens: v.array(v.string()) },
  handler: async (ctx, { tokens }): Promise<number> => {
    let deleted = 0;
    for (const token of tokens) {
      const rows = await ctx.db
        .query("pushTokens")
        .withIndex("by_token", (q) => q.eq("token", token))
        .collect();
      for (const row of rows) await ctx.db.delete(row._id);
      deleted += rows.length;
    }
    return deleted;
  },
});
