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
import { tokensFor } from "./googleGrant";
import {
  EDITOR_ROLES,
  loadHousehold,
  requireCaregiverAccount,
  requireCaregiverMember,
  requireCaregiverReader,
  requireEditor,
  SYSTEM_ACTOR,
} from "./lib/access";
import { audit } from "./lib/audit";
import { postMailbox } from "./lib/chatPosts";
import { appError, errorText } from "./lib/errors";
import { getProfile, listHistory, listRecent } from "./lib/gmailApi";
import type { GoogleGrant } from "./lib/google";
import { googleAccount, holdsGrant, scheduleGrantRevoke, storedGrant } from "./lib/googleTokens";
import type { AccessTokens, StoredGrant } from "./lib/googleTokens";
import { mailFailure } from "./lib/mailFailure";
import { TRIAGE_PICKUP_MS, enqueueTriage, jobInPool, mailPool } from "./lib/mailPool";
import { oauthPage } from "./lib/oauthFlow";
import type { FlowOwner } from "./lib/oauthFlow";
import { encryptSecret } from "./lib/secretBox";
import type { MailSender } from "./lib/mailTypes";
import { DAY_MS } from "./lib/time";
import type { MailboxStatus, MailEffectRecord, MailItemState, VerdictKind } from "./lib/validators";

const BACKFILL_WINDOW_MS = 7 * DAY_MS;
const BACKFILL_MAX_MESSAGES = 50;
const POLL_MAX_HISTORY_PAGES = 3;
const POLL_MAX_IDS = 100;
const POLL_ALL_PAGE = 100;
const DEFAULT_RECENT_MAIL = 20;
const MAX_RECENT_MAIL = 100;

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

interface MailItemView {
  id: Id<"mailItems">;
  state: MailItemState;
  sender: MailSender | null;
  subject: string | null;
  receivedAt: number | null;
  verdict: VerdictKind | null;
  effects: MailEffectRecord[];
}

interface PollStart {
  kind: "poll";
  householdId: Id<"households">;
  historyId: string;
  lastPolledAt: number | null;
  grant: StoredGrant;
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
    const itemId = await ctx.db.insert("mailItems", {
      householdId,
      account,
      gmailId,
      state: "queued",
      attempt: 0,
      leaseUntil: Date.now() + TRIAGE_PICKUP_MS,
    });
    await enqueueTriage(ctx, itemId);
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
    await requireCaregiverMember(ctx, args.householdId, args.userId, EDITOR_ROLES);
    const accountEmail = googleAccount(args.accountEmail);
    const fields = {
      connectedBy: args.userId,
      accountEmail,
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
        await scheduleGrantRevoke(ctx, existing.refreshToken, existing.accountEmail);
      }
      mailboxId = existing._id;
    } else {
      mailboxId = await ctx.db.insert("mailboxes", { householdId: args.householdId, ...fields });
    }
    await insertUnseen(ctx, args.householdId, accountEmail, args.ids);
    const household = await loadHousehold(ctx, args.householdId);
    await postMailbox(ctx, household, `Sunny now reads ${accountEmail}.`, Date.now());
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
      grant: storedGrant(mailbox),
    };
  },
});

export const recordNew = internalMutation({
  args: {
    mailboxId: v.id("mailboxes"),
    refreshToken: v.string(),
    ids: v.array(v.string()),
    expectedHistoryId: v.string(),
    lastHistoryId: v.string(),
  },
  handler: async (
    ctx,
    { mailboxId, refreshToken, ids, expectedHistoryId, lastHistoryId },
  ): Promise<{ inserted: number; moved: boolean }> => {
    const mailbox = await ctx.db.get(mailboxId);
    if (!holdsGrant(mailbox, refreshToken) || mailbox.status !== "active") {
      return { inserted: 0, moved: false };
    }
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
  let lastHistoryId: string | null = null;
  let pageToken: string | undefined;
  for (let page = 0; page < POLL_MAX_HISTORY_PAGES; page += 1) {
    const result = await tokens.withToken((token) =>
      listHistory(token, start.historyId, pageToken),
    );
    if (result === "expired") return await recoverRecent(tokens, start.lastPolledAt);
    for (const id of result.ids) ids.add(id);
    lastHistoryId = result.lastHistoryId ?? lastHistoryId;
    if (result.next === null || ids.size >= POLL_MAX_IDS) break;
    pageToken = result.next;
  }
  if (lastHistoryId === null) return await recoverRecent(tokens, start.lastPolledAt);
  return { ids: [...ids], lastHistoryId, recovered: false };
}

async function settlePollError(
  ctx: ActionCtx,
  mailboxId: Id<"mailboxes">,
  refreshToken: string,
  e: unknown,
): Promise<PollOutcome> {
  const failure = await mailFailure(ctx, mailboxId, refreshToken, e);
  switch (failure.kind) {
    case "grant":
      return failure.status === "revoked" ? "revoked" : "failed";
    case "hold":
      throw new NonRetryableError(errorText(e), { cause: e });
    case "permanent":
      console.error(`Gmail poll ended without retry: ${errorText(e)}`);
      return "failed";
    case "retry":
      throw e;
  }
}

export const poll = internalAction({
  args: { mailboxId: v.id("mailboxes") },
  handler: async (ctx, { mailboxId }): Promise<PollOutcome> => {
    const start: PollContext = await ctx.runQuery(internal.gmail.pollContext, { mailboxId });
    if (start.kind === "skip") {
      console.log(`Gmail poll skipped: ${start.reason}`);
      return "skipped";
    }
    const tokens = await tokensFor(ctx, { table: "mailboxes", id: mailboxId }, start.grant);
    try {
      const found = await gather(tokens, start);
      await ctx.runMutation(internal.gmail.recordNew, {
        mailboxId,
        refreshToken: start.grant.refreshToken,
        ids: found.ids,
        expectedHistoryId: start.historyId,
        lastHistoryId: found.lastHistoryId,
      });
      return found.recovered ? "recovered" : "polled";
    } catch (e) {
      return await settlePollError(ctx, mailboxId, start.grant.refreshToken, e);
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
      if (await jobInPool(ctx, mailbox.pollJobId)) continue;
      const pollJobId = await mailPool.enqueueAction(
        ctx,
        internal.gmail.poll,
        { mailboxId: mailbox._id },
        {
          onComplete: internal.gmail.onPollComplete,
          context: { mailboxId: mailbox._id },
        },
      );
      await ctx.db.patch(mailbox._id, { pollJobId });
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

export const recentMail = query({
  args: { householdId: v.id("households"), limit: v.optional(v.number()) },
  handler: async (ctx, { householdId, limit }): Promise<MailItemView[]> => {
    await requireCaregiverReader(ctx, householdId);
    const count = Math.min(Math.max(Math.floor(limit ?? DEFAULT_RECENT_MAIL), 1), MAX_RECENT_MAIL);
    const rows = await ctx.db
      .query("mailItems")
      .withIndex("by_household_received", (q) => q.eq("householdId", householdId))
      .order("desc")
      .take(count);
    return rows.map((row) => ({
      id: row._id,
      state: row.state,
      sender: row.sender ?? null,
      subject: row.subject ?? null,
      receivedAt: row.receivedAt ?? null,
      verdict: row.verdict ?? null,
      effects: row.effects ?? [],
    }));
  },
});

export const disconnect = mutation({
  args: { mailboxId: v.id("mailboxes") },
  handler: async (ctx, { mailboxId }): Promise<null> => {
    const mailbox = await ctx.db.get(mailboxId);
    if (!mailbox) throw appError("not_found", "Mailbox not found");
    const { userId } = await requireEditor(ctx, mailbox.householdId);
    await audit(ctx, {
      householdId: mailbox.householdId,
      actor: SYSTEM_ACTOR,
      action: "disconnect",
      entity: "mailbox",
      entityId: mailboxId,
      detail: { userId },
    });
    await ctx.db.delete(mailboxId);
    await scheduleGrantRevoke(ctx, mailbox.refreshToken, mailbox.accountEmail);
    return null;
  },
});
