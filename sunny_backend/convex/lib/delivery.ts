// lib/delivery.ts
// Purpose: Queueing and routing of notification delivery. Every outbox row is inserted through
// insertNotification, which also enqueues the delivery action (delivery.ts) on the workpool
// "deliveryPool" (modest parallelism, retries with backoff for retryable failures). This file
// is the one place the routing table lives:
//   recipientDeviceId -> APNs to every push token of the device's user (data carries
//                        task_instance_id when the row has a task instance)
//   recipientUserId   -> SMS to the member's verified phone; title and body become one short
//                        text, and a caregiver_alert gets "Reply 1 if you're on it." appended
//   neither           -> skipped ("no_recipient")
// A row with no reachable address is finished, not retried: skippedReason says why
// (no_push_tokens, no_verified_phone, device_removed, recipient_left, instance_gone,
// instance_closed, no_recipient). Membership and the device are re-checked at send time, so a
// recipient who left the household never gets a row delivered. A prompt or alert for an
// instance that was confirmed (or, for a prompt, is no longer open) while the row waited is
// skipped as stale. Rows are settled (settledAt) when sent, skipped or failed for good; the
// sweeper (requeueStuckDeliveries, from the cron) enqueues rows left unsettled for 15 minutes,
// at most MAX_ATTEMPTS delivery runs per row.
//
// Last modified: 2026-10-29

import { Workpool } from "@convex-dev/workpool";
import { components, internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";

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

/** A row unsettled this long (ms) is assumed lost and enqueued again by the sweeper. */
export const STUCK_AFTER_MS = 15 * 60 * 1000;

/** Rows (and digests) the sweeper re-enqueues per run. */
const SWEEP_BATCH = 100;

/** Delivery runs after which a row is given up on, so the sweeper never loops on one. */
export const MAX_ATTEMPTS = 12;

/** The longest SMS body sent (Twilio accepts 1600 characters). */
const SMS_MAX_CHARS = 1_500;

/** Appended to a caregiver_alert SMS: the reply the inbound SMS handler understands. */
export const CAREGIVER_ALERT_SUFFIX = "Reply 1 if you're on it.";

/** The fields of an outbox row the caller provides; delivery bookkeeping starts empty. */
export type NewNotification = Omit<
  Doc<"notificationOutbox">,
  | "_id"
  | "_creationTime"
  | "sentAt"
  | "channel"
  | "attempts"
  | "lastError"
  | "skippedReason"
  | "failedAt"
  | "settledAt"
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
  | { kind: "sms"; to: string; body: string }
  | { kind: "skip"; reason: string };

/**
 * purpose: Insert an outbox row and enqueue its delivery. Every code path that notifies
 *          someone goes through here.
 * @param ctx: (MutationCtx) Context.
 * @param row: (NewNotification) The row to insert.
 * @return: (Promise<Id<"notificationOutbox">>) The new row.
 */
export async function insertNotification(
  ctx: MutationCtx,
  row: NewNotification,
): Promise<Id<"notificationOutbox">> {
  const outboxId = await ctx.db.insert("notificationOutbox", row);
  await queueDelivery(ctx, outboxId);
  return outboxId;
}

/**
 * purpose: Enqueue the delivery action for an existing outbox row.
 * @param ctx: (MutationCtx) Context.
 * @param outboxId: (Id<"notificationOutbox">) The row.
 * @return: (Promise<void>) Resolves when enqueued.
 */
export async function queueDelivery(
  ctx: MutationCtx,
  outboxId: Id<"notificationOutbox">,
): Promise<void> {
  await deliveryPool.enqueueAction(
    ctx,
    internal.delivery.deliver,
    { outboxId },
    { onComplete: internal.delivery.onDeliveryComplete, context: { outboxId } },
  );
}

/**
 * purpose: Enqueue the compose-and-send action for a digests row.
 * @param ctx: (MutationCtx) Context.
 * @param digestId: (Id<"digests">) The row.
 * @return: (Promise<void>) Resolves when enqueued.
 */
export async function enqueueDigest(ctx: MutationCtx, digestId: Id<"digests">): Promise<void> {
  await deliveryPool.enqueueAction(
    ctx,
    internal.digest.compose,
    { digestId },
    { onComplete: internal.digest.onComposeComplete, context: { digestId } },
  );
}

/**
 * purpose: The SMS text of a row: title and body on separate lines, the reply hint for a
 *          caregiver alert, capped at SMS_MAX_CHARS.
 * @param row: (Doc<"notificationOutbox">) The row.
 * @return: (string) The text.
 */
export function smsText(row: Doc<"notificationOutbox">): string {
  const isAlert = row.kind === "caregiver_alert";
  // The app wording "Tap to claim it." means nothing in a text; the reply hint replaces it.
  const body = isAlert ? row.body.replace(/\s*Tap to claim it\.?/i, "").trim() : row.body;
  const parts = [row.title, body];
  if (isAlert) parts.push(CAREGIVER_ALERT_SUFFIX);
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
    .collect();
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
  if (member.phone === undefined || member.phoneVerifiedAt === undefined) {
    return { kind: "skip", reason: "no_verified_phone" };
  }
  return { kind: "sms", to: member.phone, body: smsText(row) };
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
 * purpose: Enqueue again the outbox rows and pending digests that have stayed unsettled for
 *          STUCK_AFTER_MS (the job was lost or its action died). A duplicate run is harmless:
 *          a settled row ends at once, and delivery runs are capped by MAX_ATTEMPTS.
 * @param ctx: (MutationCtx) Context.
 * @param now: (number) Epoch ms.
 * @return: (Promise<number>) Rows and digests re-enqueued (at most one batch of each).
 */
export async function requeueStuckDeliveries(ctx: MutationCtx, now: number): Promise<number> {
  const cutoff = now - STUCK_AFTER_MS;
  const rows = await ctx.db
    .query("notificationOutbox")
    .withIndex("by_settled", (q) => q.eq("settledAt", undefined).lt("_creationTime", cutoff))
    .take(SWEEP_BATCH);
  for (const row of rows) await queueDelivery(ctx, row._id);
  const digests = await ctx.db
    .query("digests")
    .withIndex("by_status", (q) => q.eq("status", "pending").lt("_creationTime", cutoff))
    .take(SWEEP_BATCH);
  for (const digest of digests) await enqueueDigest(ctx, digest._id);
  return rows.length + digests.length;
}
