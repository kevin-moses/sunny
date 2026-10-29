// calendarPush.ts
// Purpose: The push of one Sunny event to one caregiver's Google calendar, ported from
// jobs-run/calendar.ts (calendar_sync_event). The workpool runs `push` for a calendarSyncs row
// (queueing and the row's state machine: lib/calendarSync.ts). `begin` marks the row running
// and reads everything the push needs in one transaction, so an edit after it sets the row
// dirty; `push` calls Google; `recordPush` stores the link; `onPushComplete` finishes the row.
// Contracts worth knowing:
// - A paused household, an inactive connection, a caregiver who left, or a missing event ends
//   the push without touching Google (reason logged). Resuming a household re-pushes
//   everything (households.update).
// - The access token is cached encrypted on the connection and refreshed only when missing,
//   within 60 s of expiry, or after a 401 (then one retry), so a backfill refreshes about once.
// - Revoked access marks the connection revoked. A calendar Google confirms is gone, a
//   permanent 403, or credentials Sunny can no longer decrypt mark it in error. One event's
//   404 does not disable the connection. Other non-retryable Google errors end quietly with a
//   logged reason. A permanent configuration error (missing env var) is a workpool
//   NonRetryableError: no retries. Anything else is thrown so the workpool retries.
// - When retries run out, the connection gets a caregiver-safe lastError and the row is tried
//   once more after a delay; the next success clears the error. Google event ids derive from
//   Sunny's, so a retried create replaces the event instead of duplicating it.
//
// Last modified: 2026-10-29

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

/** Caregiver-readable reasons stored on a connection. */
const REVOKED_MESSAGE = "Google access was revoked; reconnect Google Calendar.";
const CALENDAR_MISSING_MESSAGE = "The Sunny calendar was deleted in Google; reconnect.";
const UNREADABLE_MESSAGE =
  "Reconnect Google Calendar: Sunny could not read the saved Google sign-in.";
const FORBIDDEN_MESSAGE =
  "Google denied Sunny access to the Sunny calendar; reconnect Google Calendar.";
const SYNC_FAILED_MESSAGE = "Some events could not be synced to Google; Sunny will retry.";

/** How long to wait before the one extra attempt after a push failed all its retries. */
const FAILED_RETRY_DELAY_MS = 10 * 60 * 1000;

/** Refresh an access token this long before it expires. */
const TOKEN_EXPIRY_MARGIN_MS = 60_000;

/** What a push did, for logs and tests. */
type PushOutcome =
  "created" | "updated" | "deleted" | "skipped" | "revoked" | "calendar_missing" | "failed";

/** What `begin` found: nothing to do, or everything the push needs. */
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

/**
 * purpose: Mark a sync row running and gather what the push needs. Skips (without error)
 *          when the row, connection, member, household or event is gone, the connection is
 *          not active, the connection and event belong to different households, or the
 *          household is paused.
 * @param syncId: (Id<"calendarSyncs">) The row.
 * @return: (BeginResult) skip with a reason, or the work to do.
 */
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

/**
 * purpose: Record the result of a push: store the event link and lastSyncedAt, or remove the
 *          link after a delete. Does nothing when the connection has been dropped.
 * @param connectionId: (Id<"calendarConnections">) Connection.
 * @param eventId: (Id<"events">) Event.
 * @param link: ({ externalEventId, etag } | null) The Google event, or null after a delete.
 * @return: (null)
 */
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

/**
 * purpose: Store a refreshed access token (encrypted) on the connection for later pushes.
 *          Does nothing when the connection has been dropped.
 * @param connectionId: (Id<"calendarConnections">) Connection.
 * @param accessToken: (string) The encrypted access token.
 * @param expiresAt: (number) Epoch ms the token expires.
 * @return: (null)
 */
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

/**
 * purpose: Mark a connection revoked or in error so the caregiver can reconnect. Also clears
 *          the cached access token.
 * @param connectionId: (Id<"calendarConnections">) Connection.
 * @param status: ("revoked" | "error") New status.
 * @param error: (string) Caregiver-readable reason.
 * @return: (null)
 */
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

/** Work: the "work" variant of BeginResult, i.e. the connection, event and household to push. */
type Work = Extract<BeginResult, { kind: "work" }>;

/** AccessToken: a usable access token (accessToken) and its expiry (expiresAt, epoch ms). */
interface AccessToken {
  accessToken: string;
  expiresAt: number;
}

/**
 * purpose: Access tokens for one connection: the stored one while valid, else a refresh that is
 *          stored for later pushes.
 * @param work: (Work) The connection's stored tokens.
 * @param save: (Function) Persists a refreshed token (encrypted) with its expiry.
 */
class AccessTokens {
  private current: AccessToken | null = null;

  /**
   * purpose: Build a token holder.
   * @param work: (Work) The connection's stored tokens.
   * @param save: (Function) Persists a refreshed token (encrypted) with its expiry.
   */
  constructor(
    private readonly work: Work,
    private readonly save: (encrypted: string, expiresAt: number) => Promise<void>,
  ) {}

  /**
   * purpose: Load the stored access token, if there is one that can be decrypted.
   * @return: (Promise<AccessTokens>) This holder.
   */
  async load(): Promise<AccessTokens> {
    const { accessToken, accessTokenExpiresAt } = this.work;
    if (accessToken !== null && accessTokenExpiresAt !== null) {
      try {
        this.current = {
          accessToken: await decryptSecret(accessToken),
          expiresAt: accessTokenExpiresAt,
        };
      } catch {
        this.current = null; // e.g. the key changed: refresh instead
      }
    }
    return this;
  }

  /**
   * purpose: A usable access token, refreshed and stored when missing or within 60 s of expiry.
   * @return: (Promise<string>) Access token.
   * @raises GoogleAccessRevoked when the caregiver revoked access.
   */
  async get(): Promise<string> {
    if (this.current && this.current.expiresAt - TOKEN_EXPIRY_MARGIN_MS > Date.now()) {
      return this.current.accessToken;
    }
    this.current = await refreshAccessToken(await decryptSecret(this.work.refreshToken));
    await this.save(await encryptSecret(this.current.accessToken), this.current.expiresAt);
    return this.current.accessToken;
  }

  /**
   * purpose: Forget the current token (Google rejected it) so the next get refreshes.
   */
  invalidate(): void {
    this.current = null;
  }
}

/**
 * purpose: Write one event to Google, or delete it when cancelled.
 * @param work: (Work) The connection, event and household.
 * @param accessToken: (string) OAuth access token.
 * @return: (Promise<object>) The outcome and the link to record (null after a delete).
 */
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

/**
 * purpose: Run pushToGoogle, refreshing the access token once when Google answers 401.
 * @param work: (Work) The work to do.
 * @param tokens: (AccessTokens) Tokens for this connection.
 * @return: (Promise<{ outcome: PushOutcome; link: object | null }>) See pushToGoogle.
 */
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

/**
 * purpose: Handle an error from a push attempt: record what it means for the connection and
 *          return the outcome, or rethrow when the workpool should retry.
 * @param ctx: (ActionCtx) Action context.
 * @param work: (Work) The work being pushed.
 * @param tokens: (AccessTokens) Tokens for this connection.
 * @param e: (unknown) The error.
 * @return: (Promise<PushOutcome>) The outcome when the error is final.
 * @raises NonRetryableError for a configuration error; the original error when retryable.
 */
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
    // A 404 may be one event, not the calendar: only a missing calendar disables the connection.
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

/**
 * purpose: The workpool action: push one event to one connection's Google calendar. Throws
 *          for errors worth retrying (the workpool retries with backoff); returns for
 *          everything else.
 * @param syncId: (Id<"calendarSyncs">) The row to work for.
 * @return: (PushOutcome) What happened.
 */
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

/**
 * purpose: Workpool completion handler. A row marked dirty while running is reset to queued
 *          and pushed again. A failed run (retries exhausted, or a non-retryable error)
 *          records a caregiver-safe lastError on the connection and is tried once more after
 *          FAILED_RETRY_DELAY_MS, then dropped unless the event changed meanwhile. Anything
 *          else deletes the row, including a canceled run.
 * @param workId: (string) The workpool work id.
 * @param context: ({ syncId }) The row the push worked for.
 * @param result: (RunResult) success, failed, or canceled.
 * @return: (null)
 */
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
