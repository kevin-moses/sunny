// calendarPush.ts
// Purpose: The push of one Sunny event to one caregiver's Google calendar, ported from
// jobs-run/calendar.ts (calendar_sync_event). The workpool (lib/calendarSync.ts) runs
// `push` for a calendarSyncs row with retry and backoff. Steps:
//   1. `begin` (mutation) marks the row running, then checks the connection is active and
//      its caregiver is still a member of the household, and reads the event and household
//      in the same transaction. An edit made after this point sets the row's dirty flag.
//      A paused household (backgroundPaused) defers instead: the push returns "paused" and
//      onPushComplete re-enqueues it after PAUSE_RECHECK_MS rather than dropping it.
//   2. `push` (action) decrypts the refresh token, builds the Google event
//      (eventSyncPayload, buildGoogleEvent) and upserts it, or deletes it when the event is
//      cancelled, using googleEventId (or the linked id). Access tokens are cached for the
//      lifetime of the action only; a 401 refreshes the token once and retries.
//   3. `recordPush` (mutation) stores the link and lastSyncedAt (or removes the link).
// Revoked access marks the connection revoked, a deleted Sunny calendar marks it in error,
// non-retryable Google errors end quietly with a logged reason, and any other error is
// thrown so the workpool retries. `onPushComplete` finishes the row: dirty -> push again,
// otherwise delete it. Google event ids derive from Sunny's, so a retried create replaces
// the event instead of duplicating it.
//
// Last modified: 2026-10-29

import { vOnCompleteArgs } from "@convex-dev/workpool";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { internalAction, internalMutation } from "./_generated/server";
import { findMember } from "./lib/access";
import { enqueuePush } from "./lib/calendarSync";
import {
  GoogleAccessRevoked,
  GoogleApiError,
  deleteEvent,
  refreshAccessToken,
  upsertEvent,
} from "./lib/google";
import { buildGoogleEvent, eventSyncPayload, googleEventId } from "./lib/googleEvent";
import { decryptSecret } from "./lib/secretBox";

/** How long a push waits before checking again while the household is paused. */
export const PAUSE_RECHECK_MS = 5 * 60 * 1000;

/** Caregiver-readable reasons stored on a connection. */
export const REVOKED_MESSAGE = "Google access was revoked; reconnect Google Calendar.";
export const CALENDAR_MISSING_MESSAGE = "The Sunny calendar was deleted in Google; reconnect.";

/** Keep a cached access token this long before its expiry. */
const TOKEN_EXPIRY_MARGIN_MS = 60_000;

/** What a push did; `paused` tells onPushComplete to try again later. */
export interface PushResult {
  outcome:
    | "created"
    | "updated"
    | "deleted"
    | "skipped"
    | "paused"
    | "revoked"
    | "calendar_missing"
    | "failed";
  reason?: string;
}

/** What `begin` found: nothing to do, or everything the push needs. */
export type BeginResult =
  | { kind: "skip"; reason: string }
  | { kind: "paused" }
  | {
      kind: "work";
      connectionId: Id<"calendarConnections">;
      calendarId: string;
      refreshToken: string;
      event: Doc<"events">;
      household: Doc<"households">;
      externalEventId: string | null;
    };

/**
 * purpose: Mark a sync row running and gather what the push needs. Skips (without error)
 *          when the row, connection, member, household or event is gone, when the
 *          connection is not active, or when the connection and event belong to different
 *          households; defers when the household is paused.
 * @param syncId: (Id<"calendarSyncs">) The row.
 * @return: (BeginResult) skip, paused, or the work to do.
 */
export const begin = internalMutation({
  args: { syncId: v.id("calendarSyncs") },
  handler: async (ctx, { syncId }): Promise<BeginResult> => {
    const row = await ctx.db.get(syncId);
    if (!row) return { kind: "skip", reason: "sync row removed" };
    await ctx.db.patch(syncId, { state: "running" });
    const connection = await ctx.db.get(row.connectionId);
    if (!connection || connection.status !== "active") {
      return { kind: "skip", reason: "connection not active" };
    }
    if (connection.householdId !== row.householdId) {
      return { kind: "skip", reason: "connection does not belong to the sync's household" };
    }
    if (!(await findMember(ctx, connection.householdId, connection.userId))) {
      return { kind: "skip", reason: "caregiver is no longer a member" };
    }
    const household = await ctx.db.get(row.householdId);
    if (!household) return { kind: "skip", reason: "household not found" };
    if (household.backgroundPaused) return { kind: "paused" };
    const event = await ctx.db.get(row.eventId);
    if (!event || event.householdId !== row.householdId) {
      return { kind: "skip", reason: "event not found" };
    }
    const link = await ctx.db
      .query("calendarEventLinks")
      .withIndex("by_event_connection", (q) =>
        q.eq("eventId", event._id).eq("connectionId", connection._id),
      )
      .unique();
    return {
      kind: "work",
      connectionId: connection._id,
      calendarId: connection.externalCalendarId,
      refreshToken: connection.refreshToken,
      event,
      household,
      externalEventId: link?.externalEventId ?? null,
    };
  },
});

/**
 * purpose: Record the result of a push: store the event link and lastSyncedAt, or remove
 *          the link after a delete. Does nothing when the connection has been dropped.
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
    const connection = await ctx.db.get(connectionId);
    if (!connection) return null;
    const existing = await ctx.db
      .query("calendarEventLinks")
      .withIndex("by_event_connection", (q) =>
        q.eq("eventId", eventId).eq("connectionId", connectionId),
      )
      .unique();
    const now = Date.now();
    if (link === null) {
      if (existing) await ctx.db.delete(existing._id);
      return null;
    }
    const fields = { externalEventId: link.externalEventId, etag: link.etag, syncedAt: now };
    if (existing) await ctx.db.patch(existing._id, fields);
    else await ctx.db.insert("calendarEventLinks", { eventId, connectionId, ...fields });
    await ctx.db.patch(connectionId, { lastSyncedAt: now });
    return null;
  },
});

/**
 * purpose: Mark a connection revoked or in error so the caregiver can reconnect.
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
      await ctx.db.patch(connectionId, { status, error: error.slice(0, 2000) });
    }
    return null;
  },
});

/** Access tokens for one connection, cached for the lifetime of one action. */
class AccessTokens {
  private cached: { accessToken: string; expiresAt: number } | null = null;

  /**
   * purpose: Build a token holder.
   * @param refreshToken: (string) The decrypted OAuth refresh token.
   */
  constructor(private readonly refreshToken: string) {}

  /**
   * purpose: A usable access token, refreshed when missing or about to expire.
   * @return: (Promise<string>) Access token.
   * @raises GoogleAccessRevoked when the caregiver revoked access.
   */
  async get(): Promise<string> {
    if (this.cached && this.cached.expiresAt - TOKEN_EXPIRY_MARGIN_MS > Date.now()) {
      return this.cached.accessToken;
    }
    this.cached = await refreshAccessToken(this.refreshToken);
    return this.cached.accessToken;
  }

  /**
   * purpose: Forget the cached token (Google rejected it).
   */
  invalidate(): void {
    this.cached = null;
  }
}

/** The part of a "work" result the Google call needs. */
type Work = Extract<BeginResult, { kind: "work" }>;

/**
 * purpose: Write one event to Google, or delete it when cancelled.
 * @param work: (Work) The connection, event and household.
 * @param accessToken: (string) OAuth access token.
 * @return: (Promise<{ result: PushResult; link: object | null }>) What happened and the
 *          link to record (null after a delete).
 */
async function pushToGoogle(
  work: Work,
  accessToken: string,
): Promise<{ result: PushResult; link: { externalEventId: string; etag?: string } | null }> {
  const payload = eventSyncPayload(work.event, work.household);
  const googleId = googleEventId(work.event._id);
  if (payload.cancelled) {
    await deleteEvent(accessToken, work.calendarId, work.externalEventId ?? googleId);
    return { result: { outcome: "deleted" }, link: null };
  }
  const saved = await upsertEvent(
    accessToken,
    work.calendarId,
    googleId,
    buildGoogleEvent(payload),
  );
  return {
    result: { outcome: saved.created ? "created" : "updated" },
    link: { externalEventId: saved.id, etag: saved.etag },
  };
}

/**
 * purpose: Run pushToGoogle, refreshing the access token once when Google answers 401.
 * @param work: (Work) The work to do.
 * @param tokens: (AccessTokens) Tokens for this action.
 * @return: (Promise<{ result, link }>) See pushToGoogle.
 */
async function pushWithRefresh(work: Work, tokens: AccessTokens) {
  try {
    return await pushToGoogle(work, await tokens.get());
  } catch (e) {
    if (!(e instanceof GoogleApiError && e.status === 401)) throw e;
    tokens.invalidate();
    return await pushToGoogle(work, await tokens.get());
  }
}

/**
 * purpose: The workpool action: push one event to one connection's Google calendar. Throws
 *          for errors worth retrying (the workpool retries with backoff); returns for
 *          everything else.
 * @param syncId: (Id<"calendarSyncs">) The row to work for.
 * @return: (PushResult) What happened; outcome "paused" asks for a later retry.
 */
export const push = internalAction({
  args: { syncId: v.id("calendarSyncs") },
  handler: async (ctx, { syncId }): Promise<PushResult> => {
    const start: BeginResult = await ctx.runMutation(internal.calendarPush.begin, { syncId });
    if (start.kind === "paused") return { outcome: "paused" };
    if (start.kind === "skip") return { outcome: "skipped", reason: start.reason };

    const tokens = new AccessTokens(await decryptSecret(start.refreshToken));
    try {
      const { result, link } = await pushWithRefresh(start, tokens);
      await ctx.runMutation(internal.calendarPush.recordPush, {
        connectionId: start.connectionId,
        eventId: start.event._id,
        link,
      });
      return result;
    } catch (e) {
      if (e instanceof GoogleAccessRevoked) {
        await ctx.runMutation(internal.calendarPush.markConnection, {
          connectionId: start.connectionId,
          status: "revoked",
          error: REVOKED_MESSAGE,
        });
        return { outcome: "revoked" };
      }
      if (e instanceof GoogleApiError && e.gone) {
        await ctx.runMutation(internal.calendarPush.markConnection, {
          connectionId: start.connectionId,
          status: "error",
          error: CALENDAR_MISSING_MESSAGE,
        });
        return { outcome: "calendar_missing" };
      }
      if (e instanceof GoogleApiError && !e.retryable && e.status !== 401 && e.status !== 403) {
        console.error(`Google push ended without retry (${e.status}): ${e.message}`);
        return { outcome: "failed", reason: e.message };
      }
      throw e;
    }
  },
});

/**
 * purpose: Workpool completion handler. A paused household re-enqueues the push after
 *          PAUSE_RECHECK_MS; a row marked dirty while running is reset to queued and
 *          pushed again; otherwise the row is deleted. Failed (retries exhausted) and
 *          canceled results are logged and finished the same way.
 * @param workId: (string) The workpool work id.
 * @param context: ({ syncId }) The row the push worked for.
 * @param result: (RunResult) success with the PushResult, failed, or canceled.
 * @return: (null)
 */
export const onPushComplete = internalMutation({
  args: vOnCompleteArgs(v.object({ syncId: v.id("calendarSyncs") })),
  handler: async (ctx, { context, result }): Promise<null> => {
    const row = await ctx.db.get(context.syncId);
    if (!row) return null;
    if (result.kind === "failed") console.error(`Google push failed: ${result.error}`);
    const paused =
      result.kind === "success" && (result.returnValue as PushResult | null)?.outcome === "paused";
    if (paused) {
      await ctx.db.patch(row._id, { state: "queued", dirty: false });
      await enqueuePush(ctx, row._id, PAUSE_RECHECK_MS);
    } else if (row.dirty) {
      await ctx.db.patch(row._id, { state: "queued", dirty: false });
      await enqueuePush(ctx, row._id);
    } else {
      await ctx.db.delete(row._id);
    }
    return null;
  },
});
