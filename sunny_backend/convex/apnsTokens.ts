import { v } from "convex/values";
import { internalMutation } from "./_generated/server";

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
