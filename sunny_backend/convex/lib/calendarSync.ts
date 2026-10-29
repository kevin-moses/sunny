// lib/calendarSync.ts
// Purpose: Queueing of Google Calendar pushes, ported from private.queue_calendar_sync,
// queue_event_sync, resync_household_calendars and drop_member_connections. One push sends
// one Sunny event to one caregiver's connection; the workpool "calendarSyncPool" runs it
// with retry and a parallelism cap (calendarPush.ts). This file is the one place the
// calendarSyncs state machine is described. A row exists per (eventId, connectionId) while a
// push is pending, which is what merges repeated edits (the old dedupe_key); every transition
// stamps updatedAt:
//   (no row)  --queueSync-->  queued    insert the row and enqueue the push action
//   queued    --queueSync-->  queued    nothing; the push reads current data when it starts
//   queued    --begin------>  running   calendarPush.begin, before it reads the event
//   running   --queueSync-->  dirty     the event changed after it was read
//   dirty     --queueSync-->  dirty     nothing
//   running   --complete--->  (deleted) push finished
//   dirty     --complete--->  queued    reset and enqueue again
//   running   --failed----->  queued    retries exhausted: once, after a delay (failures = 1)
//   any       --sweeper----->  queued    idle for 15 minutes: enqueue again (a lost job)
// A push for a paused household completes without touching Google; resuming re-pushes
// everything (households.update). Dropping a connection deletes its rows and schedules the
// revocation of its Google grant; a running push finds its row gone and stops.
// Fan-out (backfill after connecting, resync after a household change) never runs inline: it
// is scheduled (calendarFanOut.ts) and works in chunks of at most FAN_OUT_CHUNK syncs, over
// live events that can still occur plus cancelled events that still have a link.
//
// Last modified: 2026-10-29

import { Workpool } from "@convex-dev/workpool";
import { components, internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { localDate } from "./time";

/** Pushes that may run at the same time across all households. */
const MAX_PARALLEL_PUSHES = 5;

/** Retries of a push that failed with a retryable error: 6 attempts, 2s, 4s, 8s, ... */
const PUSH_RETRY = { maxAttempts: 6, initialBackoffMs: 2_000, base: 2 };

/** The most syncs one fan-out mutation queues. */
export const FAN_OUT_CHUNK = 200;

/** A row idle this long (ms) is assumed lost and enqueued again by the sweeper. */
export const STUCK_AFTER_MS = 15 * 60 * 1000;

/** Rows the sweeper re-enqueues per run. */
const SWEEP_BATCH = 200;

/** The pool that runs Google pushes. */
const calendarPool = new Workpool(components.calendarSyncPool, {
  maxParallelism: MAX_PARALLEL_PUSHES,
  retryActionsByDefault: true,
  defaultRetryBehavior: PUSH_RETRY,
});

/**
 * purpose: Enqueue the push action for a calendarSyncs row.
 * @param ctx: (MutationCtx) Context.
 * @param syncId: (Id<"calendarSyncs">) The row the push works for.
 * @param runAfterMs: (number | undefined) Delay before the push may start.
 * @return: (Promise<void>) Resolves when enqueued.
 */
export async function enqueuePush(
  ctx: MutationCtx,
  syncId: Id<"calendarSyncs">,
  runAfterMs?: number,
): Promise<void> {
  const timing = runAfterMs === undefined ? {} : { runAfter: runAfterMs };
  await calendarPool.enqueueAction(
    ctx,
    internal.calendarPush.push,
    { syncId },
    { onComplete: internal.calendarPush.onPushComplete, context: { syncId }, ...timing },
  );
}

/**
 * purpose: The link between an event and a connection's Google event, if any.
 * @param ctx: (QueryCtx) Context.
 * @param eventId: (Id<"events">) Event.
 * @param connectionId: (Id<"calendarConnections">) Connection.
 * @return: (Promise<Doc<"calendarEventLinks"> | null>) The link, or null.
 */
export async function getLink(
  ctx: QueryCtx,
  eventId: Id<"events">,
  connectionId: Id<"calendarConnections">,
): Promise<Doc<"calendarEventLinks"> | null> {
  return await ctx.db
    .query("calendarEventLinks")
    .withIndex("by_event_connection", (q) =>
      q.eq("eventId", eventId).eq("connectionId", connectionId),
    )
    .unique();
}

/**
 * purpose: Queue a push of one event to one connection, keeping at most one row per key (see
 *          the state machine in the file header).
 * @param ctx: (MutationCtx) Context.
 * @param eventId: (Id<"events">) Event.
 * @param connectionId: (Id<"calendarConnections">) Connection.
 * @return: (Promise<void>) Resolves when queued.
 */
async function queueSync(
  ctx: MutationCtx,
  eventId: Id<"events">,
  connectionId: Id<"calendarConnections">,
): Promise<void> {
  const row = await ctx.db
    .query("calendarSyncs")
    .withIndex("by_event_connection", (q) =>
      q.eq("eventId", eventId).eq("connectionId", connectionId),
    )
    .unique();
  if (row === null) {
    const syncId = await ctx.db.insert("calendarSyncs", {
      eventId,
      connectionId,
      state: "queued",
      updatedAt: Date.now(),
    });
    await enqueuePush(ctx, syncId);
  } else if (row.state === "running") {
    await ctx.db.patch(row._id, { state: "dirty", updatedAt: Date.now() });
  }
}

/**
 * purpose: A household's active Google connections.
 * @param ctx: (QueryCtx) Context.
 * @param householdId: (Id<"households">) Household.
 * @return: (Promise<Doc<"calendarConnections">[]>) Connections whose status is active.
 */
async function activeConnections(
  ctx: QueryCtx,
  householdId: Id<"households">,
): Promise<Doc<"calendarConnections">[]> {
  return await ctx.db
    .query("calendarConnections")
    .withIndex("by_household_status", (q) =>
      q.eq("householdId", householdId).eq("status", "active"),
    )
    .collect();
}

/**
 * purpose: Queue a push of a changed event to every active connection of its household
 *          (the port of queue_event_sync). Callers skip it when nothing changed.
 * @param ctx: (MutationCtx) Context.
 * @param eventId: (Id<"events">) The event that was added, changed or cancelled.
 * @return: (Promise<void>) Resolves when queued.
 */
export async function queueEventSync(ctx: MutationCtx, eventId: Id<"events">): Promise<void> {
  const event = await ctx.db.get(eventId);
  if (!event) return;
  for (const connection of await activeConnections(ctx, event.householdId)) {
    await queueSync(ctx, eventId, connection._id);
  }
}

/**
 * purpose: Whether a live event can still have an occurrence from a local date on: a one-off
 *          that starts on or after it, or a repeat that has not ended before it.
 * @param event: (Doc<"events">) A live event.
 * @param today: (string) The household's local date, "YYYY-MM-DD".
 * @return: (boolean) True when it is worth keeping in Google.
 */
function canStillOccur(event: Doc<"events">, today: string): boolean {
  if (event.repeatDays === undefined) return event.startsOn >= today;
  return event.repeatUntil === undefined || event.repeatUntil >= today;
}

/** Arguments of one fan-out chunk. */
export interface FanOutArgs {
  householdId: Id<"households">;
  /** Push only to this connection (a backfill); absent = all active connections (a resync). */
  connectionId?: Id<"calendarConnections">;
  /** Pagination cursor of the household's events; null for the first chunk. */
  cursor: string | null;
}

/**
 * purpose: Queue one chunk of a fan-out: a page of the household's events, sized so that at
 *          most FAN_OUT_CHUNK syncs are queued. Live events are queued if they can still
 *          occur; cancelled events only for connections they are still linked to. When
 *          more events remain the next chunk is scheduled, so no transaction grows with the
 *          calendar.
 * @param ctx: (MutationCtx) Context.
 * @param args: (FanOutArgs) Household, optional single connection, and cursor.
 * @return: (Promise<{ queued: number; next: string | null }>) Syncs queued by this chunk and
 *          the cursor of the next chunk, or null when done.
 */
export async function fanOutChunk(
  ctx: MutationCtx,
  args: FanOutArgs,
): Promise<{ queued: number; next: string | null }> {
  const household = await ctx.db.get(args.householdId);
  if (!household) return { queued: 0, next: null };
  let connections = await activeConnections(ctx, args.householdId);
  if (args.connectionId !== undefined) {
    connections = connections.filter((c) => c._id === args.connectionId);
  }
  if (connections.length === 0) return { queued: 0, next: null };

  const today = localDate(Date.now(), household.timezone);
  const page = await ctx.db
    .query("events")
    .withIndex("by_household", (q) => q.eq("householdId", args.householdId))
    .paginate({
      cursor: args.cursor,
      numItems: Math.max(1, Math.floor(FAN_OUT_CHUNK / connections.length)),
    });
  let queued = 0;
  for (const event of page.page) {
    const cancelled = event.deletedAt !== undefined;
    if (!cancelled && !canStillOccur(event, today)) continue;
    for (const connection of connections) {
      if (cancelled && !(await getLink(ctx, event._id, connection._id))) continue;
      await queueSync(ctx, event._id, connection._id);
      queued += 1;
    }
  }
  const next = page.isDone ? null : page.continueCursor;
  if (next !== null) {
    await ctx.scheduler.runAfter(0, internal.calendarFanOut.chunk, { ...args, cursor: next });
  }
  return { queued, next };
}

/**
 * purpose: Schedule a re-push of the household's events to all its active connections (the
 *          port of resync_household_calendars). Used when the timezone, event notice time or
 *          senior's name changes, and when a paused household resumes. Not run inline.
 * @param ctx: (MutationCtx) Context.
 * @param householdId: (Id<"households">) Household.
 * @return: (Promise<void>) Resolves when scheduled.
 */
export async function resyncHouseholdCalendars(
  ctx: MutationCtx,
  householdId: Id<"households">,
): Promise<void> {
  await ctx.scheduler.runAfter(0, internal.calendarFanOut.chunk, { householdId, cursor: null });
}

/**
 * purpose: Schedule a push of the household's events to one new or reconnected connection
 *          (the backfill of save_calendar_connection). Not run inline.
 * @param ctx: (MutationCtx) Context.
 * @param connection: (Doc<"calendarConnections">) The connection.
 * @return: (Promise<void>) Resolves when scheduled.
 */
export async function queueConnectionBackfill(
  ctx: MutationCtx,
  connection: Doc<"calendarConnections">,
): Promise<void> {
  await ctx.scheduler.runAfter(0, internal.calendarFanOut.chunk, {
    householdId: connection.householdId,
    connectionId: connection._id,
    cursor: null,
  });
}

/**
 * purpose: Enqueue again the rows that have not changed for STUCK_AFTER_MS (the push job was
 *          lost or its action died). A duplicate push is harmless: Google writes are
 *          idempotent and the second completion finds the row gone.
 * @param ctx: (MutationCtx) Context.
 * @param now: (number) Epoch ms.
 * @return: (Promise<number>) Rows re-enqueued (at most one batch per run).
 */
export async function requeueStuckSyncs(ctx: MutationCtx, now: number): Promise<number> {
  const stuck = await ctx.db
    .query("calendarSyncs")
    .withIndex("by_updated", (q) => q.lt("updatedAt", now - STUCK_AFTER_MS))
    .take(SWEEP_BATCH);
  for (const row of stuck) {
    await ctx.db.patch(row._id, { state: "queued", updatedAt: now });
    await enqueuePush(ctx, row._id);
  }
  return stuck.length;
}

/**
 * purpose: Delete a connection's event links (not the connection itself).
 * @param ctx: (MutationCtx) Context.
 * @param connectionId: (Id<"calendarConnections">) Connection.
 * @return: (Promise<void>) Resolves when deleted.
 */
export async function deleteLinks(
  ctx: MutationCtx,
  connectionId: Id<"calendarConnections">,
): Promise<void> {
  const links = await ctx.db
    .query("calendarEventLinks")
    .withIndex("by_connection", (q) => q.eq("connectionId", connectionId))
    .collect();
  for (const link of links) await ctx.db.delete(link._id);
}

/**
 * purpose: Schedule the revocation of a Google grant: an action decrypts the stored refresh
 *          token and asks Google to revoke it (best effort).
 * @param ctx: (MutationCtx) Context.
 * @param encryptedRefreshToken: (string) The refresh token box of a connection being dropped
 *        or replaced.
 * @return: (Promise<void>) Resolves when scheduled.
 */
export async function scheduleGrantRevoke(
  ctx: MutationCtx,
  encryptedRefreshToken: string,
): Promise<void> {
  await ctx.scheduler.runAfter(0, internal.googleCalendar.revokeGrant, {
    refreshToken: encryptedRefreshToken,
  });
}

/**
 * purpose: Delete a connection with its stored tokens, event links and pending syncs, and
 *          schedule revoking its Google grant. The Google calendar is left as it is. Every
 *          connection removal goes through here.
 * @param ctx: (MutationCtx) Context.
 * @param connectionId: (Id<"calendarConnections">) Connection.
 * @return: (Promise<void>) Resolves when deleted.
 */
export async function dropConnection(
  ctx: MutationCtx,
  connectionId: Id<"calendarConnections">,
): Promise<void> {
  const connection = await ctx.db.get(connectionId);
  if (!connection) return;
  await deleteLinks(ctx, connectionId);
  const syncs = await ctx.db
    .query("calendarSyncs")
    .withIndex("by_connection", (q) => q.eq("connectionId", connectionId))
    .collect();
  for (const sync of syncs) await ctx.db.delete(sync._id);
  await ctx.db.delete(connectionId);
  await scheduleGrantRevoke(ctx, connection.refreshToken);
}

/**
 * purpose: Drop a removed caregiver's connections in a household (the port of
 *          drop_member_connections), so their calendar stops receiving its events.
 * @param ctx: (MutationCtx) Context.
 * @param householdId: (Id<"households">) Household.
 * @param userId: (string) The removed caregiver's user id.
 * @return: (Promise<void>) Resolves when dropped.
 */
export async function dropMemberConnections(
  ctx: MutationCtx,
  householdId: Id<"households">,
  userId: string,
): Promise<void> {
  const connections = await ctx.db
    .query("calendarConnections")
    .withIndex("by_household_user", (q) => q.eq("householdId", householdId).eq("userId", userId))
    .collect();
  for (const connection of connections) await dropConnection(ctx, connection._id);
}
