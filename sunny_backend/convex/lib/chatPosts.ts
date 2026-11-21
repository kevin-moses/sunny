import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { recordedHeader } from "./mailFacts";
import { displayHeader } from "./mailProse";
import type { DisplayHeader } from "./mailTypes";
import { localDate } from "./time";

export interface ChatPostView {
  id: Id<"chatPosts">;
  householdId: Id<"households">;
  kind: Doc<"chatPosts">["kind"];
  body: string;
  localDate: string;
  createdAt: number;
  mailHeader: DisplayHeader | null;
}

function toPostView(row: Doc<"chatPosts">): ChatPostView {
  return {
    id: row._id,
    householdId: row.householdId,
    kind: row.kind,
    body: row.body,
    localDate: row.localDate,
    createdAt: row._creationTime,
    mailHeader: row.kind === "mail" ? (row.mailHeader ?? null) : null,
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

export async function postMail(
  ctx: MutationCtx,
  household: Doc<"households">,
  item: Doc<"mailItems">,
  body: string,
  now: number,
): Promise<Id<"chatPosts">> {
  const header = recordedHeader(item);
  return await ctx.db.insert("chatPosts", {
    householdId: household._id,
    kind: "mail",
    body,
    localDate: localDate(now, household.timezone),
    mailItemId: item._id,
    ...(header === null
      ? {}
      : { mailHeader: displayHeader({ ...header, timezone: household.timezone }) }),
  });
}

export async function postMailbox(
  ctx: MutationCtx,
  household: Doc<"households">,
  body: string,
  now: number,
): Promise<void> {
  await ctx.db.insert("chatPosts", {
    householdId: household._id,
    kind: "mailbox",
    body,
    localDate: localDate(now, household.timezone),
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
