import { v } from "convex/values";
import { internalMutation } from "./_generated/server";

const BACKFILL_PAGE = 200;

export const backfillSenderAddress = internalMutation({
  args: { cursor: v.union(v.null(), v.string()) },
  handler: async (
    ctx,
    { cursor },
  ): Promise<{ backfilled: number; deleted: number; isDone: boolean; continueCursor: string }> => {
    const page = await ctx.db.query("mailEventLinks").paginate({ cursor, numItems: BACKFILL_PAGE });
    let backfilled = 0;
    let deleted = 0;
    for (const link of page.page) {
      if (link.senderAddress !== undefined) continue;
      const senderAddress = (await ctx.db.get(link.mailItemId))?.sender?.address;
      if (senderAddress === undefined) {
        await ctx.db.delete(link._id);
        deleted += 1;
      } else {
        await ctx.db.patch(link._id, { senderAddress });
        backfilled += 1;
      }
    }
    return { backfilled, deleted, isDone: page.isDone, continueCursor: page.continueCursor };
  },
});
