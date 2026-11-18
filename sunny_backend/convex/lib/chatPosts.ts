import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";

export interface ChatPostView {
  id: Id<"chatPosts">;
  householdId: Id<"households">;
  kind: Doc<"chatPosts">["kind"];
  body: string;
  localDate: string;
  createdAt: number;
}

function toPostView(row: Doc<"chatPosts">): ChatPostView {
  return {
    id: row._id,
    householdId: row.householdId,
    kind: row.kind,
    body: row.body,
    localDate: row.localDate,
    createdAt: row._creationTime,
  };
}

export async function postDigest(
  ctx: MutationCtx,
  digest: Doc<"digests">,
  text: string,
): Promise<void> {
  await ctx.db.insert("chatPosts", {
    householdId: digest.householdId,
    kind: "digest",
    body: text,
    localDate: digest.localDate,
    digestId: digest._id,
  });
}

export async function recentPosts(
  ctx: QueryCtx,
  householdId: Id<"households">,
  limit: number,
): Promise<ChatPostView[]> {
  const rows = await ctx.db
    .query("chatPosts")
    .withIndex("by_household", (q) => q.eq("householdId", householdId))
    .order("desc")
    .take(limit);
  return rows.map(toPostView);
}
