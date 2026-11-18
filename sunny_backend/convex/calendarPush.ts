import { NonRetryableError, vOnCompleteArgs } from "@convex-dev/workpool";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { internalAction, internalMutation } from "./_generated/server";
import type { ActionCtx } from "./_generated/server";
import { findMember } from "./lib/access";
import { ConfigError } from "./lib/errors";
import { enqueuePush, getLink } from "./lib/calendarSync";
import {
  GoogleAccessRevoked,
  GoogleApiError,
  calendarExists,
  deleteEvent,
  refreshAccessToken,
  upsertEvent,
} from "./lib/google";
import { buildGoogleEvent, eventSyncPayload, googleEventId } from "./lib/googleEvent";
import { SecretUnreadable, decryptSecret, encryptSecret } from "./lib/secretBox";

const REVOKED_MESSAGE = "Google access was revoked; reconnect Google Calendar.";
const CALENDAR_MISSING_MESSAGE = "The Sunny calendar was deleted in Google; reconnect.";
const UNREADABLE_MESSAGE =
  "Reconnect Google Calendar: Sunny could not read the saved Google sign-in.";
const FORBIDDEN_MESSAGE =
  "Google denied Sunny access to the Sunny calendar; reconnect Google Calendar.";
const SYNC_FAILED_MESSAGE = "Some events could not be synced to Google; Sunny will retry.";

const FAILED_RETRY_DELAY_MS = 10 * 60 * 1000;

const TOKEN_EXPIRY_MARGIN_MS = 60_000;

type PushOutcome =
  "created" | "updated" | "deleted" | "skipped" | "revoked" | "calendar_missing" | "failed";

type BeginResult =
  | { kind: "skip"; reason: string }
  | {
      kind: "work";
      connectionId: Id<"calendarConnections">;
      calendarId: string;
      refreshToken: string;
      accessToken: string | null;
      accessTokenExpiresAt: number | null;
      event: Doc<"events">;
      household: Doc<"households">;
      externalEventId: string | null;
    };

export const begin = internalMutation({
  args: { syncId: v.id("calendarSyncs") },
  handler: async (ctx, { syncId }): Promise<BeginResult> => {
    const row = await ctx.db.get(syncId);
    if (!row) return { kind: "skip", reason: "sync row removed" };
    await ctx.db.patch(syncId, { state: "running", updatedAt: Date.now() });
    const connection = await ctx.db.get(row.connectionId);
    if (!connection || connection.status !== "active") {
      return { kind: "skip", reason: "connection not active" };
    }
    if (!(await findMember(ctx, connection.householdId, connection.userId))) {
      return { kind: "skip", reason: "caregiver is no longer a member" };
    }
    const [household, event, link] = await Promise.all([
      ctx.db.get(connection.householdId),
      ctx.db.get(row.eventId),
      getLink(ctx, row.eventId, connection._id),
    ]);
    if (!household) return { kind: "skip", reason: "household not found" };
    if (household.backgroundPaused) return { kind: "skip", reason: "household paused" };
    if (!event || event.householdId !== connection.householdId) {
      return { kind: "skip", reason: "event not found" };
    }
    return {
      kind: "work",
      connectionId: connection._id,
      calendarId: connection.externalCalendarId,
      refreshToken: connection.refreshToken,
      accessToken: connection.accessToken ?? null,
      accessTokenExpiresAt: connection.accessTokenExpiresAt ?? null,
      event,
      household,
      externalEventId: link?.externalEventId ?? null,
    };
  },
});

export const recordPush = internalMutation({
  args: {
    connectionId: v.id("calendarConnections"),
    eventId: v.id("events"),
    link: v.union(
      v.null(),
      v.object({ externalEventId: v.string(), etag: v.optional(v.string()) }),
    ),
  },
  handler: async (ctx, { connectionId, eventId, link }): Promise<null> => {
    if (!(await ctx.db.get(connectionId))) return null;
    const existing = await getLink(ctx, eventId, connectionId);
    if (link === null) {
      if (existing) await ctx.db.delete(existing._id);
      return null;
    }
    const now = Date.now();
    const fields = { externalEventId: link.externalEventId, etag: link.etag, syncedAt: now };
    if (existing) await ctx.db.patch(existing._id, fields);
    else await ctx.db.insert("calendarEventLinks", { eventId, connectionId, ...fields });
    await ctx.db.patch(connectionId, { lastSyncedAt: now, lastError: undefined });
    return null;
  },
});

export const saveAccessToken = internalMutation({
  args: {
    connectionId: v.id("calendarConnections"),
    accessToken: v.string(),
    expiresAt: v.number(),
  },
  handler: async (ctx, { connectionId, accessToken, expiresAt }): Promise<null> => {
    if (await ctx.db.get(connectionId)) {
      await ctx.db.patch(connectionId, { accessToken, accessTokenExpiresAt: expiresAt });
    }
    return null;
  },
});

export const markConnection = internalMutation({
  args: {
    connectionId: v.id("calendarConnections"),
    status: v.union(v.literal("revoked"), v.literal("error")),
    error: v.string(),
  },
  handler: async (ctx, { connectionId, status, error }): Promise<null> => {
    if (await ctx.db.get(connectionId)) {
      await ctx.db.patch(connectionId, {
        status,
        error: error.slice(0, 2000),
        accessToken: undefined,
        accessTokenExpiresAt: undefined,
      });
    }
    return null;
  },
});

type Work = Extract<BeginResult, { kind: "work" }>;

interface AccessToken {
  accessToken: string;
  expiresAt: number;
}

class AccessTokens {
  private current: AccessToken | null = null;

  constructor(
    private readonly work: Work,
    private readonly save: (encrypted: string, expiresAt: number) => Promise<void>,
  ) {}

  async load(): Promise<AccessTokens> {
    const { accessToken, accessTokenExpiresAt } = this.work;
    if (accessToken !== null && accessTokenExpiresAt !== null) {
      try {
        this.current = {
          accessToken: await decryptSecret(accessToken),
          expiresAt: accessTokenExpiresAt,
        };
      } catch {
        this.current = null;
      }
    }
    return this;
  }

  async get(): Promise<string> {
    if (this.current && this.current.expiresAt - TOKEN_EXPIRY_MARGIN_MS > Date.now()) {
      return this.current.accessToken;
    }
    this.current = await refreshAccessToken(await decryptSecret(this.work.refreshToken));
    await this.save(await encryptSecret(this.current.accessToken), this.current.expiresAt);
    return this.current.accessToken;
  }

  invalidate(): void {
    this.current = null;
  }
}

async function pushToGoogle(
  work: Work,
  accessToken: string,
): Promise<{ outcome: PushOutcome; link: { externalEventId: string; etag?: string } | null }> {
  const payload = eventSyncPayload(work.event, work.household);
  const googleId = googleEventId(work.event._id);
  if (payload.cancelled) {
    await deleteEvent(accessToken, work.calendarId, work.externalEventId ?? googleId);
    return { outcome: "deleted", link: null };
  }
  const saved = await upsertEvent(
    accessToken,
    work.calendarId,
    googleId,
    buildGoogleEvent(payload),
  );
  return {
    outcome: saved.created ? "created" : "updated",
    link: { externalEventId: saved.id, etag: saved.etag },
  };
}

async function pushWithRefresh(
  work: Work,
  tokens: AccessTokens,
): Promise<{ outcome: PushOutcome; link: { externalEventId: string; etag?: string } | null }> {
  try {
    return await pushToGoogle(work, await tokens.get());
  } catch (e) {
    if (!(e instanceof GoogleApiError && e.status === 401)) throw e;
    tokens.invalidate();
    return await pushToGoogle(work, await tokens.get());
  }
}

async function settleError(
  ctx: ActionCtx,
  work: Work,
  tokens: AccessTokens,
  e: unknown,
): Promise<PushOutcome> {
  const mark = async (status: "revoked" | "error", error: string): Promise<void> => {
    await ctx.runMutation(internal.calendarPush.markConnection, {
      connectionId: work.connectionId,
      status,
      error,
    });
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
  if (e instanceof GoogleApiError && e.gone) {
    if (!(await calendarExists(await tokens.get(), work.calendarId))) {
      await mark("error", CALENDAR_MISSING_MESSAGE);
      return "calendar_missing";
    }
    console.error(`Google push: event not found in an existing calendar (${e.message})`);
    return "failed";
  }
  if (e instanceof GoogleApiError && e.status === 403 && !e.retryable) {
    await mark("error", FORBIDDEN_MESSAGE);
    return "failed";
  }
  if (e instanceof GoogleApiError && !e.retryable && e.status !== 401) {
    console.error(`Google push ended without retry (${e.status}): ${e.message}`);
    return "failed";
  }
  throw e;
}

export const push = internalAction({
  args: { syncId: v.id("calendarSyncs") },
  handler: async (ctx, { syncId }): Promise<PushOutcome> => {
    const start: BeginResult = await ctx.runMutation(internal.calendarPush.begin, { syncId });
    if (start.kind === "skip") {
      console.log(`Google push skipped: ${start.reason}`);
      return "skipped";
    }
    const tokens = await new AccessTokens(start, async (accessToken, expiresAt) => {
      await ctx.runMutation(internal.calendarPush.saveAccessToken, {
        connectionId: start.connectionId,
        accessToken,
        expiresAt,
      });
    }).load();
    try {
      const { outcome, link } = await pushWithRefresh(start, tokens);
      await ctx.runMutation(internal.calendarPush.recordPush, {
        connectionId: start.connectionId,
        eventId: start.event._id,
        link,
      });
      return outcome;
    } catch (e) {
      return await settleError(ctx, start, tokens, e);
    }
  },
});

export const onPushComplete = internalMutation({
  args: vOnCompleteArgs(v.object({ syncId: v.id("calendarSyncs") })),
  handler: async (ctx, { context, result }): Promise<null> => {
    const row = await ctx.db.get(context.syncId);
    if (!row) return null;
    const now = Date.now();
    if (result.kind === "failed") {
      console.error(`Google push failed: ${result.error}`);
      if (await ctx.db.get(row.connectionId)) {
        await ctx.db.patch(row.connectionId, { lastError: SYNC_FAILED_MESSAGE });
      }
      if ((row.failures ?? 0) < 1) {
        await ctx.db.patch(row._id, { state: "queued", failures: 1, updatedAt: now });
        await enqueuePush(ctx, row._id, FAILED_RETRY_DELAY_MS);
        return null;
      }
    }
    if (row.state === "dirty") {
      await ctx.db.patch(row._id, { state: "queued", failures: undefined, updatedAt: now });
      await enqueuePush(ctx, row._id);
    } else {
      await ctx.db.delete(row._id);
    }
    return null;
  },
});
