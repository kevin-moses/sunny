import { vOnCompleteArgs } from "@convex-dev/workpool";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { internalAction, internalMutation } from "./_generated/server";
import type { ActionCtx, MutationCtx } from "./_generated/server";
import { recordLostGrant, tokensFor } from "./googleGrant";
import type { GrantRow } from "./googleGrant";
import { closeHolds, openHold } from "./serviceHolds";
import { findMember } from "./lib/access";
import { errorText } from "./lib/errors";
import { enqueuePush, getLink } from "./lib/calendarSync";
import { GoogleApiError, calendarExists, deleteEvent, upsertEvent } from "./lib/google";
import { buildGoogleEvent, eventSyncPayload, googleEventId } from "./lib/googleEvent";
import { googleFailure } from "./lib/googleGrant";
import { holdsGrant, storedGrant } from "./lib/googleTokens";
import { enterGate } from "./lib/serviceHolds";
import type { AccessTokens, StoredGrant } from "./lib/googleTokens";

const CALENDAR_MISSING_MESSAGE = "The Sunny calendar was deleted in Google; reconnect.";
const SYNC_FAILED_MESSAGE = "Some events could not be synced to Google; Sunny will retry.";

const FAILED_RETRY_DELAY_MS = 10 * 60 * 1000;

type PushOutcome =
  | "created"
  | "updated"
  | "deleted"
  | "skipped"
  | "revoked"
  | "calendar_missing"
  | "waiting"
  | "held"
  | "failed";

type BeginResult =
  | { kind: "skip"; reason: string }
  | { kind: "waiting" }
  | {
      kind: "work";
      connectionId: Id<"calendarConnections">;
      calendarId: string;
      grant: StoredGrant;
      event: Doc<"events">;
      household: Doc<"households">;
      externalEventId: string | null;
      startedAt: number;
      probe: boolean;
    };

export const begin = internalMutation({
  args: { syncId: v.id("calendarSyncs") },
  handler: async (ctx, { syncId }): Promise<BeginResult> => {
    const row = await ctx.db.get(syncId);
    if (!row) return { kind: "skip", reason: "sync row removed" };
    const now = Date.now();
    const start = await pushStart(ctx, row, now);
    if (start.kind !== "waiting") {
      await ctx.db.patch(syncId, { state: "running", updatedAt: now });
    }
    return start;
  },
});

async function pushStart(
  ctx: MutationCtx,
  row: Doc<"calendarSyncs">,
  now: number,
): Promise<BeginResult> {
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
  const gate = await enterGate(ctx, ["calendar"], now);
  if (gate === "held") return { kind: "waiting" };
  return {
    kind: "work",
    connectionId: connection._id,
    calendarId: connection.externalCalendarId,
    grant: storedGrant(connection),
    event,
    household,
    externalEventId: link?.externalEventId ?? null,
    startedAt: now,
    probe: gate === "probe",
  };
}

export const recordPush = internalMutation({
  args: {
    connectionId: v.id("calendarConnections"),
    refreshToken: v.string(),
    eventId: v.id("events"),
    link: v.union(
      v.null(),
      v.object({ externalEventId: v.string(), etag: v.optional(v.string()) }),
    ),
  },
  handler: async (ctx, { connectionId, refreshToken, eventId, link }): Promise<null> => {
    if (!holdsGrant(await ctx.db.get(connectionId), refreshToken)) return null;
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

type Work = Extract<BeginResult, { kind: "work" }>;

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

function grantRow(work: Work): GrantRow {
  return { table: "calendarConnections", id: work.connectionId };
}

async function settleError(
  ctx: ActionCtx,
  work: Work,
  tokens: AccessTokens,
  e: unknown,
): Promise<PushOutcome> {
  if (!(e instanceof GoogleApiError && e.gone)) return await settleFailure(ctx, work, e);
  let calendarFound: boolean;
  try {
    calendarFound = await calendarExists(await tokens.get(), work.calendarId);
  } catch (checkError) {
    return await settleFailure(ctx, work, checkError);
  }
  if (!calendarFound) {
    await recordLostGrant(ctx, grantRow(work), work.grant.refreshToken, {
      status: "error",
      error: CALENDAR_MISSING_MESSAGE,
    });
    return "calendar_missing";
  }
  console.error(`Google push: event not found in an existing calendar (${e.message})`);
  return "failed";
}

async function settleFailure(ctx: ActionCtx, work: Work, e: unknown): Promise<PushOutcome> {
  const failure = googleFailure(e, "calendarConnections") ?? { kind: "retry" };
  switch (failure.kind) {
    case "grant":
      await recordLostGrant(ctx, grantRow(work), work.grant.refreshToken, failure);
      return failure.status === "revoked" ? "revoked" : "failed";
    case "hold":
      await openHold(ctx, failure.service, errorText(e), work.startedAt);
      return "held";
    case "permanent":
      console.error(`Google push ended without retry: ${errorText(e)}`);
      return "failed";
    case "retry":
      throw e;
  }
}

export const push = internalAction({
  args: { syncId: v.id("calendarSyncs") },
  handler: async (ctx, { syncId }): Promise<PushOutcome> => {
    const start: BeginResult = await ctx.runMutation(internal.calendarPush.begin, { syncId });
    if (start.kind === "skip") {
      console.log(`Google push skipped: ${start.reason}`);
      return "skipped";
    }
    if (start.kind === "waiting") return "waiting";
    const tokens = await tokensFor(
      ctx,
      { table: "calendarConnections", id: start.connectionId },
      start.grant,
    );
    let pushed: PushOutcome;
    try {
      const { outcome, link } = await tokens.withToken((accessToken) =>
        pushToGoogle(start, accessToken),
      );
      await ctx.runMutation(internal.calendarPush.recordPush, {
        connectionId: start.connectionId,
        refreshToken: start.grant.refreshToken,
        eventId: start.event._id,
        link,
      });
      pushed = outcome;
    } catch (e) {
      return await settleError(ctx, start, tokens, e);
    }
    if (start.probe) await closeHolds(ctx, ["calendar"], start.startedAt);
    return pushed;
  },
});

export const onPushComplete = internalMutation({
  args: vOnCompleteArgs(v.object({ syncId: v.id("calendarSyncs") })),
  handler: async (ctx, { context, result }): Promise<null> => {
    const row = await ctx.db.get(context.syncId);
    if (!row) return null;
    const now = Date.now();
    if (result.kind === "success" && result.returnValue === "waiting") return null;
    if (result.kind === "success" && result.returnValue === "held") {
      await ctx.db.patch(row._id, { state: "queued", updatedAt: now });
      return null;
    }
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
