import { vOnCompleteArgs } from "@convex-dev/workpool";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { internalAction, internalMutation } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import { tokensFor } from "./googleGrant";
import type { GrantJob, GrantRow } from "./googleGrant";
import { closeHolds } from "./serviceHolds";
import { findMember } from "./lib/access";
import { errorText } from "./lib/errors";
import { enqueuePush, getLink } from "./lib/calendarSync";
import { GoogleApiError, calendarExists, deleteEvent, upsertEvent } from "./lib/google";
import { buildGoogleEvent, eventSyncPayload, googleEventId } from "./lib/googleEvent";
import type { GoogleCause } from "./lib/googleGrant";
import { holdsGrant, storedGrant } from "./lib/googleTokens";
import { enterGate } from "./lib/serviceHolds";
import type { StoredGrant } from "./lib/googleTokens";

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

function pushOutcome(cause: GoogleCause, e: unknown): PushOutcome {
  switch (cause) {
    case "revoked":
      return "revoked";
    case "unreadable":
    case "forbidden":
      return "failed";
    case "hold":
      return "held";
    case "permanent":
      console.error(`Google push ended without retry: ${errorText(e)}`);
      return "failed";
    case "retry":
      throw e;
  }
}

async function settleError(job: GrantJob, work: Work, e: unknown): Promise<PushOutcome> {
  if (!(e instanceof GoogleApiError && e.gone)) return pushOutcome(await job.settle(e), e);
  let calendarFound: boolean;
  try {
    calendarFound = await calendarExists(await job.tokens.get(), work.calendarId);
  } catch (checkError) {
    return pushOutcome(await job.settle(checkError), checkError);
  }
  if (!calendarFound) {
    await job.lose("error", CALENDAR_MISSING_MESSAGE);
    return "calendar_missing";
  }
  console.error(`Google push: event not found in an existing calendar (${e.message})`);
  return "failed";
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
    const job = await tokensFor(ctx, grantRow(start), start.grant, start.startedAt);
    let pushed: PushOutcome;
    try {
      const { outcome, link } = await job.tokens.withToken((accessToken) =>
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
      const outcome = await settleError(job, start, e);
      const googleAnswered = e instanceof GoogleApiError && outcome !== "held";
      if (start.probe && googleAnswered) await closeHolds(ctx, ["calendar"], start.startedAt);
      return outcome;
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
