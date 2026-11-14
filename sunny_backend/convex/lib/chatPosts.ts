// lib/chatPosts.ts
// Purpose: Sunny's own posts in the household's one caregiver chat thread (the chatPosts
// table). The only post today is the daily digest: digest.complete calls postDigest in the same
// transaction that stores the digest text and marks it done, so a digest is posted exactly once
// (one per household per local date, the digests rule). recentPosts reads a household's newest
// posts for the chat transcript (agentRequests.transcript), which merges them with the
// caregivers' requests by creation time and decides who may read them (caregivers of any role;
// never a senior device). A post is not an agent request: replying to it is an ordinary message
// to the household agent, which knows the digests through its briefing (lib/agentBriefing.ts).
//
// Last modified: 2026-11-14

import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";

/** A post as the caregiver app sees it. */
export interface ChatPostView {
  id: Id<"chatPosts">;
  householdId: Id<"households">;
  /** What the post is; "digest" is the daily summary. */
  kind: Doc<"chatPosts">["kind"];
  body: string;
  /** The household-local date it is about, "YYYY-MM-DD". */
  localDate: string;
  createdAt: number;
}

/**
 * purpose: Shape a post row for the app.
 * @param row: (Doc<"chatPosts">) The row.
 * @return: (ChatPostView) The view.
 */
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

/**
 * purpose: Post a day's digest in the household's chat thread. Called once per digest, by
 *          digest.complete, in the transaction that marks the digest done.
 * @param ctx: (MutationCtx) Context.
 * @param digest: (Doc<"digests">) The digest being completed.
 * @param text: (string) Its text.
 * @return: (Promise<void>) Resolves when posted.
 */
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

/**
 * purpose: A household's newest posts.
 * @param ctx: (QueryCtx) Context.
 * @param householdId: (Id<"households">) Household.
 * @param limit: (number) How many at most.
 * @return: (Promise<ChatPostView[]>) Posts, newest first.
 */
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
