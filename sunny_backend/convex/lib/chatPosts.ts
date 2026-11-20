import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { loadHousehold } from "./access";
import { mailHeader, type MailHeader } from "./mailProse";
import { localDate } from "./time";

export interface ChatPostView {
  id: Id<"chatPosts">;
  householdId: Id<"households">;
  kind: Doc<"chatPosts">["kind"];
  body: string;
  localDate: string;
  createdAt: number;
  mailHeader: MailHeader | null;
}

export function itemHeader(item: Doc<"mailItems">, timezone: string): MailHeader | null {
  const { sender, subject, receivedAt } = item;
  if (sender === undefined || subject === undefined || receivedAt === undefined) return null;
  return mailHeader({ sender, subject, receivedAt, timezone });
}

async function postHeader(
  ctx: QueryCtx,
  row: Doc<"chatPosts">,
  timezone: string,
): Promise<MailHeader | null> {
  if (row.kind !== "mail") return null;
  const item = await ctx.db.get(row.mailItemId);
  return item === null ? null : itemHeader(item, timezone);
}

async function toPostView(
  ctx: QueryCtx,
  row: Doc<"chatPosts">,
  timezone: string,
): Promise<ChatPostView> {
  return {
    id: row._id,
    householdId: row.householdId,
    kind: row.kind,
    body: row.body,
    localDate: row.localDate,
    createdAt: row._creationTime,
    mailHeader: await postHeader(ctx, row, timezone),
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
  mailItemId: Id<"mailItems">,
  body: string,
  now: number,
): Promise<void> {
  await ctx.db.insert("chatPosts", {
    householdId: household._id,
    kind: "mail",
    body,
    localDate: localDate(now, household.timezone),
    mailItemId,
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
  const { timezone } = await loadHousehold(ctx, householdId);
  const rows = await ctx.db
    .query("chatPosts")
    .withIndex("by_household", (q) => q.eq("householdId", householdId))
    .order("desc")
    .take(limit);
  return await Promise.all(rows.map((row) => toPostView(ctx, row, timezone)));
}
