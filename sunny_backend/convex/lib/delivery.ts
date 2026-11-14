// lib/delivery.ts
// Purpose: Queueing and routing of notification delivery. Every outbox row is inserted through
// insertNotification, which enqueues delivery.deliver on the workpool "deliveryPool".
// Routing: a device recipient gets APNs to every push token of its user. A member recipient
// gets APNs when that user has at least one push token (the caregiver app is installed with
// notifications on), otherwise an SMS at the verified phone exactly as before (title and body
// on separate lines; a caregiver_alert for a member who can claim ends with the reply hint). A
// member's APNs route also carries that SMS as smsFallback (null without a verified phone):
// delivery.ts sends it for the same row when APNs is not configured or accepted no token with
// nothing worth retrying (every token unregistered, or refused for good), and, when the push
// retries run out, textAfterPushGaveUp marks the row "gave_up" and enqueues it again so
// memberRoute texts it. A caregiver who would have been texted before push existed is never
// left with nothing; `channel` records sms when the text delivered it. Every push carries data
// notification_id, kind, household_id and, with an instance, task_instance_id, and the
// interruption level and category of lib/apnsPayload pushStyle. A push's title is
// payload.pushTitle when the row has one (the digest: "<name>'s day", while its SMS keeps
// "Sunny: <name>'s day"), else the title.
// Membership, device and content are re-checked at send time; a row with no reachable address
// or stale content is skipped, with the reason in `detail`. A row a run started less than 5
// minutes ago is leased: the sweeper leaves it alone. Every run counts against the row's
// MAX_ATTEMPTS, the text after a push gave up included: a row that reaches the bound is failed
// by delivery.begin, not texted.
// Reachability (isReachableMember, reachableMembers): a caregiver can be reached when they have
// a verified phone or at least one push token; lib/voiceRouting and the digest queue rows only
// for reachable caregivers.
// SMS_KIND_POLICY says, per kind, whether a timed-out text is retried (caregiver_alert and
// agent_flag) and whether a newer text of that kind means a "1" reply answers it rather than an
// older task alert (agent_flag and family_message; sms.ts).
//
// Last modified: 2026-11-14

import { Workpool } from "@convex-dev/workpool";
import { components, internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { findMember, verifiedPhone } from "./access";
import { pushStyle } from "./apnsPayload";
import type { PushRecipient, PushStyle } from "./apnsPayload";
import type { NotificationKind } from "./validators";

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

/**
 * How the SMS path treats each kind of text. retryOnTimeout: a text that timed out may still
 * have been delivered, so it is retried only when a possible repeat is worth it (an alert).
 * hidesOlderAlert: a caregiver's "1" after such a text answers it, so it claims nothing.
 */
export const SMS_KIND_POLICY: Record<
  NotificationKind,
  { retryOnTimeout: boolean; hidesOlderAlert: boolean }
> = {
  senior_prompt: { retryOnTimeout: false, hidesOlderAlert: false },
  caregiver_alert: { retryOnTimeout: true, hidesOlderAlert: false },
  event_notice: { retryOnTimeout: false, hidesOlderAlert: false },
  digest: { retryOnTimeout: false, hidesOlderAlert: false },
  agent_flag: { retryOnTimeout: true, hidesOlderAlert: true },
  family_message: { retryOnTimeout: false, hidesOlderAlert: true },
};

/** The longest SMS body sent (Twilio accepts 1600 characters). */
const SMS_MAX_CHARS = 1_500;

/** Appended to a caregiver_alert SMS: the reply the inbound SMS handler understands. */
const CAREGIVER_ALERT_SUFFIX = "Reply 1 if you're on it.";

/** The fields of an outbox row the caller provides; delivery bookkeeping starts empty. */
export type NewNotification = Omit<
  Doc<"notificationOutbox">,
  "_id" | "_creationTime" | "state" | "channel" | "settledAt" | "attempts" | "detail"
>;

/** An SMS to send. */
export type SmsRoute = { kind: "sms"; to: string; body: string; retryOnTimeout: boolean };

/** A push to send, with the text to send instead when no token takes it (members only). */
export type ApnsRoute = {
  kind: "apns";
  tokens: string[];
  title: string;
  body: string;
  data: Record<string, string>;
  style: PushStyle;
  smsFallback: SmsRoute | null;
};

/** Where to send an outbox row, decided at send time. */
export type Route = ApnsRoute | SmsRoute | { kind: "skip"; reason: string };

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

/** Push tokens read per user. */
const MAX_TOKENS_PER_USER = 20;

/**
 * purpose: A user's push tokens, at most MAX_TOKENS_PER_USER.
 * @param ctx: (QueryCtx) Context.
 * @param userId: (string) The device's or caregiver's user id.
 * @return: (Promise<string[]>) The raw APNs tokens; empty when there are none.
 */
async function userPushTokens(ctx: QueryCtx, userId: string): Promise<string[]> {
  const rows = await ctx.db
    .query("pushTokens")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .take(MAX_TOKENS_PER_USER);
  return rows.map((r) => r.token);
}

/**
 * purpose: The custom keys every push of a row carries, beside aps.
 * @param row: (Doc<"notificationOutbox">) The row.
 * @return: (Record<string, string>) notification_id, kind, household_id, and task_instance_id
 *          when the row is about an instance.
 */
function pushData(row: Doc<"notificationOutbox">): Record<string, string> {
  const data: Record<string, string> = {
    notification_id: row._id,
    kind: row.kind,
    household_id: row.householdId,
  };
  if (row.taskInstanceId !== undefined) data["task_instance_id"] = row.taskInstanceId;
  return data;
}

/**
 * purpose: The title of a row's push: payload.pushTitle when it is a non-empty string (the
 *          digest's "<name>'s day"), else the row's title (which its SMS uses).
 * @param row: (Doc<"notificationOutbox">) The row.
 * @return: (string) The push title.
 */
function pushTitle(row: Doc<"notificationOutbox">): string {
  const custom: unknown = row.payload["pushTitle"];
  return typeof custom === "string" && custom !== "" ? custom : row.title;
}

/**
 * purpose: The APNs route of a row for some tokens.
 * @param row: (Doc<"notificationOutbox">) The row.
 * @param tokens: (string[]) The recipient's tokens (at least one).
 * @param recipient: (PushRecipient) A device, or a caregiver and whether they may claim.
 * @param smsFallback: (SmsRoute | null) The text to send instead when no token takes the push.
 * @return: (ApnsRoute) The route.
 */
function apnsRoute(
  row: Doc<"notificationOutbox">,
  tokens: string[],
  recipient: PushRecipient,
  smsFallback: SmsRoute | null,
): ApnsRoute {
  return {
    kind: "apns",
    tokens,
    title: pushTitle(row),
    body: row.body,
    data: pushData(row),
    style: pushStyle(row.kind, recipient),
    smsFallback,
  };
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
  const tokens = await userPushTokens(ctx, device.userId);
  if (tokens.length === 0) return { kind: "skip", reason: "no_push_tokens" };
  return apnsRoute(row, tokens, { kind: "device" }, null);
}

/**
 * purpose: The SMS route of a row for a member, unchanged from before push existed for
 *          caregivers: the verified phone and the text with the claim hint when they may claim.
 * @param row: (Doc<"notificationOutbox">) The row.
 * @param member: (Doc<"householdMembers">) The recipient.
 * @return: (SmsRoute | null) The route, or null without a verified phone.
 */
function smsRoute(
  row: Doc<"notificationOutbox">,
  member: Doc<"householdMembers">,
): SmsRoute | null {
  const to = verifiedPhone(member);
  if (to === undefined) return null;
  return {
    kind: "sms",
    to,
    body: smsText(row, member.role !== "viewer"),
    retryOnTimeout: SMS_KIND_POLICY[row.kind].retryOnTimeout,
  };
}

/**
 * purpose: The route of a member-addressed row: APNs when the member's user has a push token
 *          (with their SMS as the fallback), else SMS at the verified phone. A row whose push
 *          retries ran out (pushState "gave_up") goes by SMS.
 * @param ctx: (QueryCtx) Context.
 * @param row: (Doc<"notificationOutbox">) The row.
 * @param userId: (string) The recipient member's user id.
 * @return: (Promise<Route>) apns or sms, or a skip when the member left or has neither a push
 *          token nor a verified phone.
 */
async function memberRoute(
  ctx: QueryCtx,
  row: Doc<"notificationOutbox">,
  userId: string,
): Promise<Route> {
  const member = await findMember(ctx, row.householdId, userId);
  if (!member) return { kind: "skip", reason: "recipient_left" };
  const sms = smsRoute(row, member);
  const tokens = row.pushState === "gave_up" ? [] : await userPushTokens(ctx, userId);
  if (tokens.length > 0) {
    const recipient = { kind: "caregiver" as const, canClaim: member.role !== "viewer" };
    return apnsRoute(row, tokens, recipient, sms);
  }
  return sms ?? { kind: "skip", reason: "no_verified_phone" };
}

/**
 * purpose: Whether a caregiver can be reached: a verified phone, or at least one push token.
 * @param ctx: (QueryCtx) Context.
 * @param member: (Doc<"householdMembers">) The caregiver.
 * @return: (Promise<boolean>) True when a notification row for them has a route.
 */
export async function isReachableMember(
  ctx: QueryCtx,
  member: Doc<"householdMembers">,
): Promise<boolean> {
  if (verifiedPhone(member) !== undefined) return true;
  const token = await ctx.db
    .query("pushTokens")
    .withIndex("by_user", (q) => q.eq("userId", member.userId))
    .first();
  return token !== null;
}

/**
 * purpose: The caregivers among some members who can be reached (isReachableMember).
 * @param ctx: (QueryCtx) Context.
 * @param members: (Doc<"householdMembers">[]) Members.
 * @return: (Promise<Doc<"householdMembers">[]>) The reachable ones, in the same order.
 */
export async function reachableMembers(
  ctx: QueryCtx,
  members: Doc<"householdMembers">[],
): Promise<Doc<"householdMembers">[]> {
  const reachable: Doc<"householdMembers">[] = [];
  for (const member of members) {
    if (await isReachableMember(ctx, member)) reachable.push(member);
  }
  return reachable;
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
 * purpose: When the workpool's retries of a caregiver's push ran out (the row is marked
 *          pushState "retrying") and the caregiver has a verified phone, mark the row "gave_up"
 *          and enqueue it once more, so it is texted (memberRoute) instead of failing. Runs at
 *          most once per row: a row already "gave_up" is left to fail as usual.
 * @param ctx: (MutationCtx) Context.
 * @param row: (Doc<"notificationOutbox">) A pending row whose delivery run failed for good.
 * @param error: (string) The run's error, kept in detail.
 * @return: (Promise<boolean>) True when the row was enqueued to be texted.
 */
export async function textAfterPushGaveUp(
  ctx: MutationCtx,
  row: Doc<"notificationOutbox">,
  error: string,
): Promise<boolean> {
  if (row.pushState !== "retrying" || row.recipientUserId === undefined) return false;
  const member = await findMember(ctx, row.householdId, row.recipientUserId);
  if (!member || verifiedPhone(member) === undefined) return false;
  await ctx.db.patch(row._id, { pushState: "gave_up", detail: `push gave up: ${error}` });
  await queueDelivery(ctx, row._id);
  return true;
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
