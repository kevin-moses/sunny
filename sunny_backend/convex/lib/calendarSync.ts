import { Workpool } from "@convex-dev/workpool";
import { components, internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { scheduleGrantRevoke } from "./googleTokens";
import { canStillOccur } from "./occurrences";
import { holdGate } from "./serviceHolds";
import type { HoldGate } from "./serviceHolds";
import { localDate } from "./time";

const MAX_PARALLEL_PUSHES = 5;

const PUSH_RETRY = { maxAttempts: 6, initialBackoffMs: 2_000, base: 2 };

export const FAN_OUT_CHUNK = 200;

export const STUCK_AFTER_MS = 15 * 60 * 1000;

const SWEEP_BATCH = 200;

const SWEEP_PUSHES: Record<HoldGate, number> = { free: SWEEP_BATCH, probe: 1, held: 0 };

const calendarPool = new Workpool(components.calendarSyncPool, {
  maxParallelism: MAX_PARALLEL_PUSHES,
  retryActionsByDefault: true,
  defaultRetryBehavior: PUSH_RETRY,
});

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

export async function queueEventSync(ctx: MutationCtx, eventId: Id<"events">): Promise<void> {
  const event = await ctx.db.get(eventId);
  if (!event) return;
  for (const connection of await activeConnections(ctx, event.householdId)) {
    await queueSync(ctx, eventId, connection._id);
  }
}

export interface FanOutArgs {
  householdId: Id<"households">;
  connectionId?: Id<"calendarConnections">;
  cursor: string | null;
}

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

export async function resyncHouseholdCalendars(
  ctx: MutationCtx,
  householdId: Id<"households">,
): Promise<void> {
  await ctx.scheduler.runAfter(0, internal.calendarFanOut.chunk, { householdId, cursor: null });
}

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

export async function requeueStuckSyncs(ctx: MutationCtx, now: number): Promise<number> {
  const pushes = SWEEP_PUSHES[await holdGate(ctx, ["calendar"], now)];
  if (pushes === 0) return 0;
  const stuck = await ctx.db
    .query("calendarSyncs")
    .withIndex("by_updated", (q) => q.lt("updatedAt", now - STUCK_AFTER_MS))
    .take(pushes);
  for (const row of stuck) {
    await ctx.db.patch(row._id, { state: "queued", updatedAt: now });
    await enqueuePush(ctx, row._id);
  }
  return stuck.length;
}

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
  await scheduleGrantRevoke(ctx, connection.refreshToken, connection.accountEmail ?? null);
}

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
