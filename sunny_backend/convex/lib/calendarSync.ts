// lib/calendarSync.ts
// Purpose: Queueing of Google Calendar pushes, ported from private.queue_calendar_sync,
// queue_event_sync, resync_household_calendars and drop_member_connections. One push is the
// work of sending one Sunny event to one caregiver's connection. The calendarSyncs table
// holds at most one row per (eventId, connectionId), which is what merges repeated edits
// (the old dedupe_key). State machine of a row:
//   (no row)  --queueSync--> queued      insert the row and enqueue the push action
//   queued    --queueSync--> queued      nothing; the push reads current data when it starts
//   queued    --push begins-> running    calendarPush.begin marks it before reading the event
//   running   --queueSync--> running     dirty = true: the event changed after it was read
//   running   --complete-->  (deleted)   when not dirty
//   running   --complete-->  queued      when dirty: dirty = false and the push is enqueued again
//   running   --complete-->  queued      when the household was paused: re-enqueued after a delay
// The workpool (component "calendarSyncPool") runs the action with retry and backoff and
// caps how many pushes run at once. Rows are removed when their connection is dropped.
//
// Last modified: 2026-10-29

import { Workpool } from "@convex-dev/workpool";
import { components, internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { liveEvents } from "./occurrences";

/** Pushes that may run at the same time across all households. */
const MAX_PARALLEL_PUSHES = 5;

/** Retries of a push that failed with a retryable error: 6 attempts, 2s, 4s, 8s, ... */
const PUSH_RETRY = { maxAttempts: 6, initialBackoffMs: 2_000, base: 2 };

/** The pool that runs Google pushes. */
export const calendarPool = new Workpool(components.calendarSyncPool, {
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
 * purpose: Queue a push of one event to one connection, keeping at most one row per key:
 *          none -> insert queued and enqueue; queued -> nothing; running -> mark dirty.
 * @param ctx: (MutationCtx) Context.
 * @param householdId: (Id<"households">) The event's household.
 * @param eventId: (Id<"events">) Event.
 * @param connectionId: (Id<"calendarConnections">) Connection.
 * @return: (Promise<void>) Resolves when queued.
 */
export async function queueSync(
  ctx: MutationCtx,
  householdId: Id<"households">,
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
      householdId,
      eventId,
      connectionId,
      state: "queued",
      dirty: false,
    });
    await enqueuePush(ctx, syncId);
  } else if (row.state === "running" && !row.dirty) {
    await ctx.db.patch(row._id, { dirty: true });
  }
}

/**
 * purpose: A household's active Google connections.
 * @param ctx: (MutationCtx) Context.
 * @param householdId: (Id<"households">) Household.
 * @return: (Promise<Doc<"calendarConnections">[]>) Connections whose status is active.
 */
async function activeConnections(
  ctx: MutationCtx,
  householdId: Id<"households">,
): Promise<Doc<"calendarConnections">[]> {
  const all = await ctx.db
    .query("calendarConnections")
    .withIndex("by_household", (q) => q.eq("householdId", householdId))
    .collect();
  return all.filter((c) => c.status === "active");
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
    await queueSync(ctx, event.householdId, eventId, connection._id);
  }
}

/**
 * purpose: Re-push every live event to every active connection (the port of
 *          resync_household_calendars). The timezone, event notice time and senior's name
 *          shape every Google event.
 * @param ctx: (MutationCtx) Context.
 * @param householdId: (Id<"households">) Household.
 * @return: (Promise<void>) Resolves when queued.
 */
export async function resyncHouseholdCalendars(
  ctx: MutationCtx,
  householdId: Id<"households">,
): Promise<void> {
  const connections = await activeConnections(ctx, householdId);
  if (connections.length === 0) return;
  for (const event of await liveEvents(ctx, householdId)) {
    for (const connection of connections) {
      await queueSync(ctx, householdId, event._id, connection._id);
    }
  }
}

/**
 * purpose: Queue a push of every live event, and of cancelled events still linked to the
 *          connection, to one connection (the backfill of save_calendar_connection).
 * @param ctx: (MutationCtx) Context.
 * @param connection: (Doc<"calendarConnections">) The connection.
 * @return: (Promise<void>) Resolves when queued.
 */
export async function queueConnectionBackfill(
  ctx: MutationCtx,
  connection: Doc<"calendarConnections">,
): Promise<void> {
  const events = await ctx.db
    .query("events")
    .withIndex("by_household", (q) => q.eq("householdId", connection.householdId))
    .collect();
  for (const event of events) {
    if (event.deletedAt !== undefined) {
      const link = await ctx.db
        .query("calendarEventLinks")
        .withIndex("by_event_connection", (q) =>
          q.eq("eventId", event._id).eq("connectionId", connection._id),
        )
        .unique();
      if (link === null) continue;
    }
    await queueSync(ctx, connection.householdId, event._id, connection._id);
  }
}

/**
 * purpose: Delete a connection's event links and pending sync rows (not the connection
 *          itself). A push already running for a deleted row finds it gone and stops.
 * @param ctx: (MutationCtx) Context.
 * @param connectionId: (Id<"calendarConnections">) Connection.
 * @return: (Promise<void>) Resolves when deleted.
 */
export async function deleteConnectionLinksAndSyncs(
  ctx: MutationCtx,
  connectionId: Id<"calendarConnections">,
): Promise<void> {
  const links = await ctx.db
    .query("calendarEventLinks")
    .withIndex("by_connection", (q) => q.eq("connectionId", connectionId))
    .collect();
  for (const link of links) await ctx.db.delete(link._id);
  const syncs = await ctx.db
    .query("calendarSyncs")
    .withIndex("by_connection", (q) => q.eq("connectionId", connectionId))
    .collect();
  for (const sync of syncs) await ctx.db.delete(sync._id);
}

/**
 * purpose: Delete a connection with its links and pending syncs (the refresh token goes
 *          with the row). The Google calendar is left as it is.
 * @param ctx: (MutationCtx) Context.
 * @param connectionId: (Id<"calendarConnections">) Connection.
 * @return: (Promise<void>) Resolves when deleted.
 */
export async function dropConnection(
  ctx: MutationCtx,
  connectionId: Id<"calendarConnections">,
): Promise<void> {
  await deleteConnectionLinksAndSyncs(ctx, connectionId);
  await ctx.db.delete(connectionId);
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
