// lib/delivery.ts
// Purpose: Queueing and routing of notification delivery. Every outbox row is inserted through
// insertNotification, which enqueues delivery.deliver on the workpool "deliveryPool".
// Routing: a device recipient gets APNs to every push token of its user; a member recipient
// gets an SMS at the verified phone (title and body on separate lines; a caregiver_alert for a
// member who can claim ends with the reply hint). Membership, device and content are re-checked
// at send time; a row with no reachable address or stale content is skipped, with the reason in
// `detail`. A row a run started less than 5 minutes ago is leased: the sweeper leaves it alone.
//
// Last modified: 2026-10-29

import { Workpool } from "@convex-dev/workpool";
import { components, internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { verifiedPhone } from "./access";

/** Deliveries that may run at the same time across all households. */
const MAX_PARALLEL_DELIVERIES = 10;

/** Retries of a delivery that failed with a retryable error: 5 attempts, 2s, 4s, 8s, ... */
const DELIVERY_RETRY = { maxAttempts: 5, initialBackoffMs: 2_000, base: 2 };

/** The pool that runs deliveries and digest composition. */
export const deliveryPool = new Workpool(components.deliveryPool, {
  maxParallelism: MAX_PARALLEL_DELIVERIES,
  retryActionsByDefault: true,
  defaultRetryBehavior: DELIVERY_RETRY,
});

/** A row pending this long (ms) is assumed lost and enqueued again by the sweeper. */
export const STUCK_AFTER_MS = 15 * 60 * 1000;

/** A row whose run started this recently (ms) is leased, and the sweeper skips it. */
const LEASE_MS = 5 * 60 * 1000;

/** Rows the sweeper re-enqueues per run. */
export const SWEEP_BATCH = 100;

/** Delivery runs after which a row is given up on, so the sweeper never loops on one. */
export const MAX_ATTEMPTS = 12;

/** The longest SMS body sent (Twilio accepts 1600 characters). */
const SMS_MAX_CHARS = 1_500;

/** Appended to a caregiver_alert SMS: the reply the inbound SMS handler understands. */
const CAREGIVER_ALERT_SUFFIX = "Reply 1 if you're on it.";

/** The fields of an outbox row the caller provides; delivery bookkeeping starts empty. */
export type NewNotification = Omit<
  Doc<"notificationOutbox">,
  "_id" | "_creationTime" | "state" | "channel" | "settledAt" | "attempts" | "detail"
>;

/** Where to send an outbox row, decided at send time. */
export type Route =
  | {
      kind: "apns";
      tokens: string[];
      title: string;
      body: string;
      data: Record<string, string>;
    }
  | { kind: "sms"; to: string; body: string; retryOnTimeout: boolean }
  | { kind: "skip"; reason: string };

/** A route that sends something. */
export type SendRoute = Exclude<Route, { kind: "skip" }>;

/**
 * purpose: Insert a pending outbox row and enqueue its delivery. Every code path that
 *          notifies someone goes through here.
 * @param ctx: (MutationCtx) Context.
 * @param row: (NewNotification) The row to insert.
 * @return: (Promise<Id<"notificationOutbox">>) The new row.
 */
export async function insertNotification(
  ctx: MutationCtx,
  row: NewNotification,
): Promise<Id<"notificationOutbox">> {
  const outboxId = await ctx.db.insert("notificationOutbox", { ...row, state: "pending" });
  await queueDelivery(ctx, outboxId);
  return outboxId;
}

/**
 * purpose: Enqueue the delivery action for an existing outbox row.
 * @param ctx: (MutationCtx) Context.
 * @param outboxId: (Id<"notificationOutbox">) The row.
 * @return: (Promise<void>) Resolves when enqueued.
 */
async function queueDelivery(ctx: MutationCtx, outboxId: Id<"notificationOutbox">): Promise<void> {
  await deliveryPool.enqueueAction(
    ctx,
    internal.delivery.deliver,
    { outboxId },
    { onComplete: internal.delivery.onDeliveryComplete, context: { outboxId } },
  );
}

/**
 * purpose: The SMS text of a row: title and body on separate lines, the reply hint for a
 *          caregiver alert to someone who can claim it, capped at SMS_MAX_CHARS.
 * @param row: (Doc<"notificationOutbox">) The row.
 * @param canClaim: (boolean) Whether the recipient may claim tasks (viewers may not).
 * @return: (string) The text.
 */
function smsText(row: Doc<"notificationOutbox">, canClaim: boolean): string {
  const parts = [row.title, row.body];
  if (row.kind === "caregiver_alert" && canClaim) parts.push(CAREGIVER_ALERT_SUFFIX);
  return parts
    .filter((p) => p.length > 0)
    .join("\n")
    .slice(0, SMS_MAX_CHARS);
}

/**
 * purpose: Why a row's content is stale, if it is: its task instance is gone, a senior prompt
 *          is for an instance that is no longer open, or a caregiver alert is for one that was
 *          confirmed or resolved while the row waited.
 * @param ctx: (QueryCtx) Context.
 * @param row: (Doc<"notificationOutbox">) The row.
 * @return: (Promise<string | null>) The skip reason, or null when the row is still current.
 */
async function staleReason(ctx: QueryCtx, row: Doc<"notificationOutbox">): Promise<string | null> {
  if (row.taskInstanceId === undefined) return null;
  const instance = await ctx.db.get(row.taskInstanceId);
  if (!instance) return "instance_gone";
  const done = instance.state === "confirmed" || instance.state === "resolved";
  if (row.kind === "caregiver_alert" && done) return "instance_closed";
  if (row.kind === "senior_prompt" && instance.state !== "due" && instance.state !== "escalated") {
    return "instance_closed";
  }
  return null;
}

/** Push tokens read per device user. */
const MAX_TOKENS_PER_USER = 20;

/**
 * purpose: The APNs route of a device-addressed row.
 * @param ctx: (QueryCtx) Context.
 * @param row: (Doc<"notificationOutbox">) The row.
 * @param deviceId: (Id<"devices">) The recipient device.
 * @return: (Promise<Route>) apns, or a skip when the device is gone or has no tokens.
 */
async function deviceRoute(
  ctx: QueryCtx,
  row: Doc<"notificationOutbox">,
  deviceId: Id<"devices">,
): Promise<Route> {
  const device = await ctx.db.get(deviceId);
  if (!device || device.householdId !== row.householdId) {
    return { kind: "skip", reason: "device_removed" };
  }
  const tokens = await ctx.db
    .query("pushTokens")
    .withIndex("by_user", (q) => q.eq("userId", device.userId))
    .take(MAX_TOKENS_PER_USER);
  if (tokens.length === 0) return { kind: "skip", reason: "no_push_tokens" };
  const data: Record<string, string> = { notification_id: row._id, kind: row.kind };
  if (row.taskInstanceId !== undefined) data["task_instance_id"] = row.taskInstanceId;
  return {
    kind: "apns",
    tokens: tokens.map((t) => t.token),
    title: row.title,
    body: row.body,
    data,
  };
}

/**
 * purpose: The SMS route of a member-addressed row.
 * @param ctx: (QueryCtx) Context.
 * @param row: (Doc<"notificationOutbox">) The row.
 * @param userId: (string) The recipient member's user id.
 * @return: (Promise<Route>) sms, or a skip when the member left or has no verified phone.
 */
async function memberRoute(
  ctx: QueryCtx,
  row: Doc<"notificationOutbox">,
  userId: string,
): Promise<Route> {
  const member = await ctx.db
    .query("householdMembers")
    .withIndex("by_household_user", (q) =>
      q.eq("householdId", row.householdId).eq("userId", userId),
    )
    .unique();
  if (!member) return { kind: "skip", reason: "recipient_left" };
  const to = verifiedPhone(member);
  if (to === undefined) return { kind: "skip", reason: "no_verified_phone" };
  // A timed-out text may still have been delivered; only an alert is worth a possible repeat.
  return {
    kind: "sms",
    to,
    body: smsText(row, member.role !== "viewer"),
    retryOnTimeout: row.kind === "caregiver_alert",
  };
}

/**
 * purpose: Decide where a row goes right now, re-checking staleness, the device and the
 *          membership at send time.
 * @param ctx: (QueryCtx) Context.
 * @param row: (Doc<"notificationOutbox">) The row.
 * @return: (Promise<Route>) The route, or a skip with the reason.
 */
export async function resolveRoute(ctx: QueryCtx, row: Doc<"notificationOutbox">): Promise<Route> {
  const stale = await staleReason(ctx, row);
  if (stale !== null) return { kind: "skip", reason: stale };
  if (row.recipientDeviceId !== undefined)
    return await deviceRoute(ctx, row, row.recipientDeviceId);
  if (row.recipientUserId !== undefined) return await memberRoute(ctx, row, row.recipientUserId);
  return { kind: "skip", reason: "no_recipient" };
}

/**
 * purpose: Enqueue again the outbox rows left pending for STUCK_AFTER_MS (the job was lost or
 *          its action died, or a configuration problem held them) unless a run started within
 *          LEASE_MS. A duplicate run is harmless: a settled row ends at once, and
 *          delivery runs are capped by MAX_ATTEMPTS.
 * @param ctx: (MutationCtx) Context.
 * @param now: (number) Epoch ms.
 * @return: (Promise<number>) Rows re-enqueued (at most SWEEP_BATCH per run).
 */
export async function requeueStuckDeliveries(ctx: MutationCtx, now: number): Promise<number> {
  const rows = await ctx.db
    .query("notificationOutbox")
    .withIndex("by_state", (q) =>
      q.eq("state", "pending").lt("_creationTime", now - STUCK_AFTER_MS),
    )
    .take(SWEEP_BATCH);
  const idle = rows.filter((r) => (r.attemptStartedAt ?? 0) <= now - LEASE_MS);
  for (const row of idle) await queueDelivery(ctx, row._id);
  return idle.length;
}
