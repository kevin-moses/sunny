import { Workpool } from "@convex-dev/workpool";
import { components, internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { findMember, verifiedPhone } from "./access";
import { pushStyle } from "./apnsPayload";
import type { PushRecipient, PushStyle } from "./apnsPayload";
import type { NotificationKind } from "./validators";

const MAX_PARALLEL_DELIVERIES = 10;

const DELIVERY_RETRY = { maxAttempts: 5, initialBackoffMs: 2_000, base: 2 };

export const deliveryPool = new Workpool(components.deliveryPool, {
  maxParallelism: MAX_PARALLEL_DELIVERIES,
  retryActionsByDefault: true,
  defaultRetryBehavior: DELIVERY_RETRY,
});

export const STUCK_AFTER_MS = 15 * 60 * 1000;

const LEASE_MS = 5 * 60 * 1000;

export const SWEEP_BATCH = 100;

export const MAX_ATTEMPTS = 12;

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

const SMS_MAX_CHARS = 1_500;

const CAREGIVER_ALERT_SUFFIX = "Reply 1 if you're on it.";

export type NewNotification = Omit<
  Doc<"notificationOutbox">,
  "_id" | "_creationTime" | "state" | "channel" | "settledAt" | "attempts" | "detail"
>;

export type SmsRoute = { kind: "sms"; to: string; body: string; retryOnTimeout: boolean };

export type ApnsRoute = {
  kind: "apns";
  tokens: string[];
  title: string;
  body: string;
  data: Record<string, string>;
  style: PushStyle;
  smsFallback: SmsRoute | null;
};

export type Route = ApnsRoute | SmsRoute | { kind: "skip"; reason: string };

export type SendRoute = Exclude<Route, { kind: "skip" }>;

export async function insertNotification(
  ctx: MutationCtx,
  row: NewNotification,
): Promise<Id<"notificationOutbox">> {
  const outboxId = await ctx.db.insert("notificationOutbox", { ...row, state: "pending" });
  await queueDelivery(ctx, outboxId);
  return outboxId;
}

async function queueDelivery(ctx: MutationCtx, outboxId: Id<"notificationOutbox">): Promise<void> {
  await deliveryPool.enqueueAction(
    ctx,
    internal.delivery.deliver,
    { outboxId },
    { onComplete: internal.delivery.onDeliveryComplete, context: { outboxId } },
  );
}

function smsText(row: Doc<"notificationOutbox">, canClaim: boolean): string {
  const parts = [row.title, row.body];
  if (row.kind === "caregiver_alert" && canClaim) parts.push(CAREGIVER_ALERT_SUFFIX);
  return parts
    .filter((p) => p.length > 0)
    .join("\n")
    .slice(0, SMS_MAX_CHARS);
}

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

const MAX_TOKENS_PER_USER = 20;

async function userPushTokens(ctx: QueryCtx, userId: string): Promise<string[]> {
  const rows = await ctx.db
    .query("pushTokens")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .take(MAX_TOKENS_PER_USER);
  return rows.map((r) => r.token);
}

function pushData(row: Doc<"notificationOutbox">): Record<string, string> {
  const data: Record<string, string> = {
    notification_id: row._id,
    kind: row.kind,
    household_id: row.householdId,
  };
  if (row.taskInstanceId !== undefined) data["task_instance_id"] = row.taskInstanceId;
  return data;
}

function pushTitle(row: Doc<"notificationOutbox">): string {
  const custom: unknown = row.payload["pushTitle"];
  return typeof custom === "string" && custom !== "" ? custom : row.title;
}

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

export async function resolveRoute(ctx: QueryCtx, row: Doc<"notificationOutbox">): Promise<Route> {
  const stale = await staleReason(ctx, row);
  if (stale !== null) return { kind: "skip", reason: stale };
  if (row.recipientDeviceId !== undefined)
    return await deviceRoute(ctx, row, row.recipientDeviceId);
  if (row.recipientUserId !== undefined) return await memberRoute(ctx, row, row.recipientUserId);
  return { kind: "skip", reason: "no_recipient" };
}

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
