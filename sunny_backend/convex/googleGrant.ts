import { v } from "convex/values";
import type { Infer } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import { internalMutation } from "./_generated/server";
import type { ActionCtx, MutationCtx } from "./_generated/server";
import { postMailbox } from "./lib/chatPosts";
import { pushToCaregivers } from "./lib/delivery";
import type { GrantStatus } from "./lib/googleGrant";
import { AccessTokens, holdsGrant } from "./lib/googleTokens";
import type { StoredGrant } from "./lib/googleTokens";

const MAX_STORED_ERROR = 2000;

const grantRow = v.union(
  v.object({ table: v.literal("mailboxes"), id: v.id("mailboxes") }),
  v.object({ table: v.literal("calendarConnections"), id: v.id("calendarConnections") }),
);

export type GrantRow = Infer<typeof grantRow>;

async function tellMailboxLost(ctx: MutationCtx, mailbox: Doc<"mailboxes">): Promise<void> {
  const household = await ctx.db.get(mailbox.householdId);
  if (!household) return;
  const body = `Sunny can no longer read ${mailbox.accountEmail}. Reconnect Gmail to keep mail coming in.`;
  await postMailbox(ctx, household, body, Date.now());
  await pushToCaregivers(ctx, household, {
    kind: "mail_escalation",
    title: `Reconnect Gmail for ${household.seniorPreferredName}`,
    body,
    payload: { mailboxId: mailbox._id },
  });
}

export const saveToken = internalMutation({
  args: {
    row: grantRow,
    refreshToken: v.string(),
    accessToken: v.string(),
    expiresAt: v.number(),
  },
  handler: async (ctx, { row, refreshToken, accessToken, expiresAt }): Promise<null> => {
    if (holdsGrant(await ctx.db.get(row.id), refreshToken)) {
      await ctx.db.patch(row.id, { accessToken, accessTokenExpiresAt: expiresAt });
    }
    return null;
  },
});

export const markGrant = internalMutation({
  args: {
    row: grantRow,
    refreshToken: v.string(),
    status: v.union(v.literal("revoked"), v.literal("error")),
    error: v.string(),
  },
  handler: async (ctx, { row, refreshToken, status, error }): Promise<null> => {
    const held = await ctx.db.get(row.id);
    if (!holdsGrant(held, refreshToken) || held.status !== "active") return null;
    await ctx.db.patch(row.id, {
      status,
      error: error.slice(0, MAX_STORED_ERROR),
      accessToken: undefined,
      accessTokenExpiresAt: undefined,
    });
    if (row.table === "mailboxes") {
      const mailbox = await ctx.db.get(row.id);
      if (mailbox) await tellMailboxLost(ctx, mailbox);
    }
    return null;
  },
});

export async function tokensFor(
  ctx: ActionCtx,
  row: GrantRow,
  grant: StoredGrant,
): Promise<AccessTokens> {
  return await new AccessTokens(grant, async (accessToken, expiresAt) => {
    await ctx.runMutation(internal.googleGrant.saveToken, {
      row,
      refreshToken: grant.refreshToken,
      accessToken,
      expiresAt,
    });
  }).load();
}

export async function recordLostGrant(
  ctx: ActionCtx,
  row: GrantRow,
  refreshToken: string,
  lost: { status: GrantStatus; error: string },
): Promise<void> {
  await ctx.runMutation(internal.googleGrant.markGrant, {
    row,
    refreshToken,
    status: lost.status,
    error: lost.error,
  });
}
