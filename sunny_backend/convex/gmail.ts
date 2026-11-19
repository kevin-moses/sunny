import { NonRetryableError, vOnCompleteArgs } from "@convex-dev/workpool";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import {
  internalAction,
  internalMutation,
  internalQuery,
  mutation,
  query,
} from "./_generated/server";
import type { ActionCtx, MutationCtx } from "./_generated/server";
import {
  EDITOR_ROLES,
  findMember,
  requireCaregiverAccount,
  requireCaregiverMember,
  SYSTEM_ACTOR,
} from "./lib/access";
import { audit } from "./lib/audit";
import { ConfigError, appError } from "./lib/errors";
import { getProfile, listHistory, listRecent } from "./lib/gmailApi";
import { GMAIL_SCOPE, GoogleAccessRevoked, GoogleApiError, revokeRefreshToken } from "./lib/google";
import type { GoogleGrant } from "./lib/google";
import { AccessTokens, scheduleGrantRevoke } from "./lib/googleTokens";
import { mailPool } from "./lib/mailPool";
import { oauthPage } from "./lib/oauthFlow";
import { SecretUnreadable, encryptSecret } from "./lib/secretBox";
import { DAY_MS } from "./lib/time";
import type { MailboxStatus } from "./lib/validators";
import type { FlowOwner } from "./googleOauth";

const BACKFILL_WINDOW_MS = 7 * DAY_MS;
const BACKFILL_MAX_MESSAGES = 50;
const POLL_MAX_HISTORY_PAGES = 3;
const POLL_MAX_IDS = 100;
const POLL_ALL_PAGE = 100;

const REVOKED_MESSAGE = "Google access was revoked; reconnect the senior's Gmail.";
const UNREADABLE_MESSAGE = "Reconnect Gmail: Sunny could not read the saved Google sign-in.";
const FORBIDDEN_MESSAGE = "Google denied Sunny access to the mailbox; reconnect Gmail.";
const POLL_FAILED_MESSAGE = "Sunny could not check the mailbox; it will try again.";

type PollOutcome = "skipped" | "polled" | "recovered" | "revoked" | "failed";

interface MailboxView {
  id: Id<"mailboxes">;
  accountEmail: string;
  status: MailboxStatus;
  error: string | null;
  lastPolledAt: number | null;
  lastError: string | null;
}

interface PollStart {
  kind: "poll";
  householdId: Id<"households">;
  historyId: string;
  lastPolledAt: number | null;
  refreshToken: string;
  accessToken: string | null;
  accessTokenExpiresAt: number | null;
}

type PollContext = PollStart | { kind: "skip"; reason: string };

interface Gathered {
  ids: string[];
  lastHistoryId: string;
  recovered: boolean;
}

async function insertUnseen(
  ctx: MutationCtx,
  householdId: Id<"households">,
  account: string,
  gmailIds: string[],
): Promise<number> {
  let inserted = 0;
  for (const gmailId of new Set(gmailIds)) {
    const existing = await ctx.db
      .query("mailItems")
      .withIndex("by_household_account_gmail", (q) =>
        q.eq("householdId", householdId).eq("account", account).eq("gmailId", gmailId),
      )
      .unique();
    if (existing) continue;
    await ctx.db.insert("mailItems", {
      householdId,
      account,
      gmailId,
      state: "queued",
      attempt: 0,
    });
    inserted += 1;
  }
  return inserted;
}

export const saveMailbox = internalMutation({
  args: {
    householdId: v.id("households"),
    userId: v.string(),
    accountEmail: v.string(),
    refreshToken: v.string(),
    historyId: v.string(),
    ids: v.array(v.string()),
  },
  handler: async (ctx, args): Promise<Id<"mailboxes">> => {
    const member = await requireCaregiverMember(ctx, args.householdId, args.userId);
    if (!EDITOR_ROLES.includes(member.role)) {
      throw appError("forbidden", "Only a primary caregiver or member can connect the mailbox");
    }
    const fields = {
      connectedBy: args.userId,
      accountEmail: args.accountEmail,
      refreshToken: args.refreshToken,
      accessToken: undefined,
      accessTokenExpiresAt: undefined,
      status: "active" as const,
      error: undefined,
      historyId: args.historyId,
      lastPolledAt: Date.now(),
      lastError: undefined,
    };
    const existing = await ctx.db
      .query("mailboxes")
      .withIndex("by_household", (q) => q.eq("householdId", args.householdId))
      .unique();
    let mailboxId: Id<"mailboxes">;
    if (existing) {
      await ctx.db.patch(existing._id, fields);
      if (existing.refreshToken !== args.refreshToken) {
        await scheduleGrantRevoke(ctx, existing.refreshToken);
      }
      mailboxId = existing._id;
    } else {
      mailboxId = await ctx.db.insert("mailboxes", { householdId: args.householdId, ...fields });
    }
    await insertUnseen(ctx, args.householdId, args.accountEmail, args.ids);
    await audit(ctx, {
      householdId: args.householdId,
      actor: SYSTEM_ACTOR,
      action: "connect",
      entity: "mailbox",
      entityId: mailboxId,
      detail: { userId: args.userId },
    });
    return mailboxId;
  },
});

export async function finishMailbox(
  ctx: ActionCtx,
  flow: FlowOwner,
  tokens: GoogleGrant,
): Promise<Response> {
  if (!tokens.scopes.includes(GMAIL_SCOPE)) {
    await revokeRefreshToken(tokens.refreshToken);
    return oauthPage(
      "Permission needed",
      "Sunny needs permission to read the mailbox. Start again and allow it.",
      400,
    );
  }
  const profile = await getProfile(tokens.accessToken);
  const ids = await listRecent(
    tokens.accessToken,
    Date.now() - BACKFILL_WINDOW_MS,
    BACKFILL_MAX_MESSAGES,
  );
  await ctx.runMutation(internal.gmail.saveMailbox, {
    ...flow,
    accountEmail: profile.email,
    refreshToken: await encryptSecret(tokens.refreshToken),
    historyId: profile.historyId,
    ids,
  });
  return oauthPage(
    "Gmail connected",
    `Sunny will now read ${profile.email} for appointments and news. You can close this page.`,
  );
}

export const pollContext = internalQuery({
  args: { mailboxId: v.id("mailboxes") },
  handler: async (ctx, { mailboxId }): Promise<PollContext> => {
    const mailbox = await ctx.db.get(mailboxId);
    if (!mailbox || mailbox.status !== "active") return { kind: "skip", reason: "not active" };
    const household = await ctx.db.get(mailbox.householdId);
    if (!household) return { kind: "skip", reason: "household not found" };
    if (household.backgroundPaused) return { kind: "skip", reason: "household paused" };
    return {
      kind: "poll",
      householdId: mailbox.householdId,
      historyId: mailbox.historyId,
      lastPolledAt: mailbox.lastPolledAt ?? null,
      refreshToken: mailbox.refreshToken,
      accessToken: mailbox.accessToken ?? null,
      accessTokenExpiresAt: mailbox.accessTokenExpiresAt ?? null,
    };
  },
});

export const saveMailboxToken = internalMutation({
  args: { mailboxId: v.id("mailboxes"), accessToken: v.string(), expiresAt: v.number() },
  handler: async (ctx, { mailboxId, accessToken, expiresAt }): Promise<null> => {
    if (await ctx.db.get(mailboxId)) {
      await ctx.db.patch(mailboxId, { accessToken, accessTokenExpiresAt: expiresAt });
    }
    return null;
  },
});

export const markMailbox = internalMutation({
  args: {
    mailboxId: v.id("mailboxes"),
    status: v.union(v.literal("revoked"), v.literal("error")),
    error: v.string(),
  },
  handler: async (ctx, { mailboxId, status, error }): Promise<null> => {
    if (await ctx.db.get(mailboxId)) {
      await ctx.db.patch(mailboxId, {
        status,
        error: error.slice(0, 2000),
        accessToken: undefined,
        accessTokenExpiresAt: undefined,
      });
    }
    return null;
  },
});

export const recordNew = internalMutation({
  args: {
    mailboxId: v.id("mailboxes"),
    ids: v.array(v.string()),
    expectedHistoryId: v.string(),
    lastHistoryId: v.string(),
  },
  handler: async (
    ctx,
    { mailboxId, ids, expectedHistoryId, lastHistoryId },
  ): Promise<{ inserted: number; moved: boolean }> => {
    const mailbox = await ctx.db.get(mailboxId);
    if (!mailbox || mailbox.status !== "active") return { inserted: 0, moved: false };
    const inserted = await insertUnseen(ctx, mailbox.householdId, mailbox.accountEmail, ids);
    const moved = mailbox.historyId === expectedHistoryId;
    await ctx.db.patch(mailboxId, {
      lastPolledAt: Date.now(),
      lastError: undefined,
      ...(moved ? { historyId: lastHistoryId } : {}),
    });
    return { inserted, moved };
  },
});

async function recoverRecent(tokens: AccessTokens, lastPolledAt: number | null): Promise<Gathered> {
  const profile = await tokens.withToken(getProfile);
  const since = Math.max(lastPolledAt ?? 0, Date.now() - BACKFILL_WINDOW_MS);
  const ids = await tokens.withToken((token) => listRecent(token, since, POLL_MAX_IDS));
  return { ids, lastHistoryId: profile.historyId, recovered: true };
}

async function gather(tokens: AccessTokens, start: PollStart): Promise<Gathered> {
  const ids = new Set<string>();
  let lastHistoryId = start.historyId;
  let pageToken: string | undefined;
  for (let page = 0; page < POLL_MAX_HISTORY_PAGES; page += 1) {
    const result = await tokens.withToken((token) =>
      listHistory(token, start.historyId, pageToken),
    );
    if (result === "expired") return await recoverRecent(tokens, start.lastPolledAt);
    for (const id of result.ids) ids.add(id);
    lastHistoryId = result.lastHistoryId;
    if (result.next === null || ids.size >= POLL_MAX_IDS) break;
    pageToken = result.next;
  }
  return { ids: [...ids], lastHistoryId, recovered: false };
}

async function settlePollError(
  ctx: ActionCtx,
  mailboxId: Id<"mailboxes">,
  e: unknown,
): Promise<PollOutcome> {
  const mark = async (status: "revoked" | "error", error: string): Promise<void> => {
    await ctx.runMutation(internal.gmail.markMailbox, { mailboxId, status, error });
  };
  if (e instanceof ConfigError) throw new NonRetryableError(e.message, { cause: e });
  if (e instanceof SecretUnreadable) {
    await mark("error", UNREADABLE_MESSAGE);
    return "failed";
  }
  if (e instanceof GoogleAccessRevoked) {
    await mark("revoked", REVOKED_MESSAGE);
    return "revoked";
  }
  if (e instanceof GoogleApiError && e.status === 403 && !e.retryable) {
    await mark("error", FORBIDDEN_MESSAGE);
    return "failed";
  }
  if (e instanceof GoogleApiError && !e.retryable && e.status !== 401) {
    console.error(`Gmail poll ended without retry (${e.status}): ${e.message}`);
    return "failed";
  }
  throw e;
}

export const poll = internalAction({
  args: { mailboxId: v.id("mailboxes") },
  handler: async (ctx, { mailboxId }): Promise<PollOutcome> => {
    const start: PollContext = await ctx.runQuery(internal.gmail.pollContext, { mailboxId });
    if (start.kind === "skip") {
      console.log(`Gmail poll skipped: ${start.reason}`);
      return "skipped";
    }
    const tokens = await new AccessTokens(start, async (accessToken, expiresAt) => {
      await ctx.runMutation(internal.gmail.saveMailboxToken, { mailboxId, accessToken, expiresAt });
    }).load();
    try {
      const found = await gather(tokens, start);
      await ctx.runMutation(internal.gmail.recordNew, {
        mailboxId,
        ids: found.ids,
        expectedHistoryId: start.historyId,
        lastHistoryId: found.lastHistoryId,
      });
      return found.recovered ? "recovered" : "polled";
    } catch (e) {
      return await settlePollError(ctx, mailboxId, e);
    }
  },
});

export const onPollComplete = internalMutation({
  args: vOnCompleteArgs(v.object({ mailboxId: v.id("mailboxes") })),
  handler: async (ctx, { context, result }): Promise<null> => {
    if (result.kind !== "failed") return null;
    console.error(`Gmail poll failed: ${result.error}`);
    if (await ctx.db.get(context.mailboxId)) {
      await ctx.db.patch(context.mailboxId, { lastError: POLL_FAILED_MESSAGE });
    }
    return null;
  },
});

export const pollAll = internalMutation({
  args: { cursor: v.optional(v.union(v.null(), v.string())) },
  handler: async (ctx, { cursor }): Promise<number> => {
    const page = await ctx.db
      .query("mailboxes")
      .withIndex("by_status", (q) => q.eq("status", "active"))
      .paginate({ cursor: cursor ?? null, numItems: POLL_ALL_PAGE });
    let queued = 0;
    for (const mailbox of page.page) {
      const household = await ctx.db.get(mailbox.householdId);
      if (!household || household.backgroundPaused) continue;
      await mailPool.enqueueAction(
        ctx,
        internal.gmail.poll,
        { mailboxId: mailbox._id },
        {
          onComplete: internal.gmail.onPollComplete,
          context: { mailboxId: mailbox._id },
        },
      );
      queued += 1;
    }
    if (!page.isDone) {
      await ctx.scheduler.runAfter(0, internal.gmail.pollAll, { cursor: page.continueCursor });
    }
    return queued;
  },
});

export const mailboxStatus = query({
  args: { householdId: v.id("households") },
  handler: async (ctx, { householdId }): Promise<MailboxView | null> => {
    const userId = await requireCaregiverAccount(ctx);
    await requireCaregiverMember(ctx, householdId, userId);
    const mailbox: Doc<"mailboxes"> | null = await ctx.db
      .query("mailboxes")
      .withIndex("by_household", (q) => q.eq("householdId", householdId))
      .unique();
    if (!mailbox) return null;
    return {
      id: mailbox._id,
      accountEmail: mailbox.accountEmail,
      status: mailbox.status,
      error: mailbox.error ?? null,
      lastPolledAt: mailbox.lastPolledAt ?? null,
      lastError: mailbox.lastError ?? null,
    };
  },
});

export const disconnect = mutation({
  args: { mailboxId: v.id("mailboxes") },
  handler: async (ctx, { mailboxId }): Promise<null> => {
    const userId = await requireCaregiverAccount(ctx);
    const mailbox = await ctx.db.get(mailboxId);
    const member = mailbox ? await findMember(ctx, mailbox.householdId, userId) : null;
    if (!mailbox || !member) throw appError("not_found", "Mailbox not found");
    if (!EDITOR_ROLES.includes(member.role)) {
      throw appError("forbidden", "Only a primary caregiver or member can disconnect the mailbox");
    }
    await audit(ctx, {
      householdId: mailbox.householdId,
      actor: SYSTEM_ACTOR,
      action: "disconnect",
      entity: "mailbox",
      entityId: mailboxId,
      detail: { userId },
    });
    await ctx.db.delete(mailboxId);
    await scheduleGrantRevoke(ctx, mailbox.refreshToken);
    return null;
  },
});
