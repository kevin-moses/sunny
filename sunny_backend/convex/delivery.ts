// delivery.ts
// Purpose: Delivery of notificationOutbox rows (routing: lib/delivery.ts). The workpool runs
// `deliver` for each inserted row: `begin` re-checks the row and returns the route, the action
// calls APNs or SMS, `record` stores the outcome. Contracts worth knowing:
// - APNs counts a row as sent when any token was accepted; tokens APNs reports unregistered are
//   deleted. A retryable failure is thrown so the workpool retries with backoff; everything
//   else, including a configuration problem returned by the sender, ends the row as failed.
// - Retries exhausted ends the row as failed (onDeliveryComplete). A settled row is never
//   delivered again, so a duplicate job from the sweeper is harmless.
//
// Last modified: 2026-10-29

import { vOnCompleteArgs } from "@convex-dev/workpool";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { internalAction, internalMutation } from "./_generated/server";
import type { ActionCtx, MutationCtx } from "./_generated/server";
import { requeueStuckDigests } from "./digest";
import type { ApnsResult, ApnsSendResult } from "./lib/apnsPayload";
import { MAX_ATTEMPTS, requeueStuckDeliveries, resolveRoute } from "./lib/delivery";
import type { Route } from "./lib/delivery";
import type { SmsResult } from "./lib/twilio";
import { deliveryChannel } from "./lib/validators";

/** The outcome of a delivery run, returned by the action. */
export type DeliveryOutcome = "sent" | "skipped" | "failed" | "settled" | "missing";

/** What `begin` tells the action to do. */
export type BeginResult =
  { kind: "done"; outcome: DeliveryOutcome } | { kind: "send"; route: Route };

/**
 * purpose: Finish a row: set its final state and the time.
 * @param ctx: (MutationCtx) Context.
 * @param row: (Doc<"notificationOutbox">) The row.
 * @param patch: (object) The final state, and the channel (sent) or detail (skipped, failed).
 * @return: (Promise<void>) Resolves when written.
 */
async function settle(
  ctx: MutationCtx,
  row: Doc<"notificationOutbox">,
  patch: Pick<Doc<"notificationOutbox">, "state"> &
    Partial<Pick<Doc<"notificationOutbox">, "channel" | "detail">>,
): Promise<void> {
  await ctx.db.patch(row._id, { ...patch, settledAt: Date.now() });
}

/**
 * purpose: Start a delivery run: stop at once for a missing or settled row, fail a row that
 *          has used up MAX_ATTEMPTS, skip a row with no reachable address, otherwise count the
 *          attempt and return the route.
 * @param outboxId: (Id<"notificationOutbox">) The row.
 * @return: (BeginResult) done with the outcome, or send with the route.
 */
export const begin = internalMutation({
  args: { outboxId: v.id("notificationOutbox") },
  handler: async (ctx, { outboxId }): Promise<BeginResult> => {
    const row = await ctx.db.get(outboxId);
    if (!row) return { kind: "done", outcome: "missing" };
    if (row.state !== "pending") return { kind: "done", outcome: "settled" };
    const attempts = row.attempts ?? 0;
    if (attempts >= MAX_ATTEMPTS) {
      await settle(ctx, row, { state: "failed", detail: row.detail ?? "gave up" });
      return { kind: "done", outcome: "failed" };
    }
    const route = await resolveRoute(ctx, row);
    if (route.kind === "skip") {
      await settle(ctx, row, { state: "skipped", detail: route.reason });
      return { kind: "done", outcome: "skipped" };
    }
    await ctx.db.patch(outboxId, { attempts: attempts + 1 });
    return { kind: "send", route };
  },
});

/**
 * purpose: Record the result of a delivery run. "sent", "skipped" and "failed" settle the row;
 *          "retry" only stores the error for the next run.
 * @param outboxId: (Id<"notificationOutbox">) The row.
 * @param outcome: ("sent" | "retry" | "failed" | "skipped") What happened.
 * @param channel: (DeliveryChannel, optional) The channel a sent row went out on.
 * @param detail: (string, optional) Skip reason or internal error.
 * @return: (null)
 */
export const record = internalMutation({
  args: {
    outboxId: v.id("notificationOutbox"),
    outcome: v.union(
      v.literal("sent"),
      v.literal("retry"),
      v.literal("failed"),
      v.literal("skipped"),
    ),
    channel: v.optional(deliveryChannel),
    detail: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<null> => {
    const row = await ctx.db.get(args.outboxId);
    if (!row || row.state !== "pending") return null;
    if (args.outcome === "retry") {
      await ctx.db.patch(row._id, { detail: args.detail });
    } else {
      await settle(ctx, row, {
        state: args.outcome,
        channel: args.outcome === "sent" ? args.channel : undefined,
        detail: args.outcome === "sent" ? undefined : args.detail,
      });
    }
    return null;
  },
});

/**
 * purpose: A short internal description of an APNs failure for the row's detail.
 * @param results: (ApnsResult[]) Per-token results.
 * @return: (string) E.g. "429 TooManyRequests".
 */
function apnsDetail(results: ApnsResult[]): string {
  const bad = results.find((r) => r.outcome === "failed");
  return bad ? `${bad.status} ${bad.reason ?? "unknown"}` : "no result from APNs";
}

/**
 * purpose: Send a row by APNs and record the result, deleting unregistered tokens.
 * @param ctx: (ActionCtx) Context.
 * @param outboxId: (Id<"notificationOutbox">) The row.
 * @param route: (Route) An apns route.
 * @return: (Promise<DeliveryOutcome>) The outcome.
 * @raises Error for a retryable failure.
 */
async function sendApns(
  ctx: ActionCtx,
  outboxId: Id<"notificationOutbox">,
  route: Extract<Route, { kind: "apns" }>,
): Promise<DeliveryOutcome> {
  const { results, configError }: ApnsSendResult = await ctx.runAction(internal.apns.send, {
    tokens: route.tokens,
    title: route.title,
    body: route.body,
    data: route.data,
  });
  if (configError !== undefined) {
    await ctx.runMutation(internal.delivery.record, {
      outboxId,
      outcome: "failed",
      detail: configError,
    });
    return "failed";
  }
  const dead = results.filter((r) => r.outcome === "unregistered").map((r) => r.token);
  if (dead.length > 0) await ctx.runMutation(internal.apnsTokens.deleteTokens, { tokens: dead });
  if (results.some((r) => r.outcome === "sent")) {
    await ctx.runMutation(internal.delivery.record, { outboxId, outcome: "sent", channel: "apns" });
    return "sent";
  }
  if (results.length > 0 && dead.length === results.length) {
    await ctx.runMutation(internal.delivery.record, {
      outboxId,
      outcome: "skipped",
      detail: "tokens_unregistered",
    });
    return "skipped";
  }
  const detail = apnsDetail(results);
  if (results.some((r) => r.outcome === "failed" && r.retryable)) {
    throw new Error(`APNs delivery failed, will retry: ${detail}`);
  }
  await ctx.runMutation(internal.delivery.record, { outboxId, outcome: "failed", detail });
  return "failed";
}

/**
 * purpose: Send a row by SMS and record the result.
 * @param ctx: (ActionCtx) Context.
 * @param outboxId: (Id<"notificationOutbox">) The row.
 * @param route: (Route) An sms route.
 * @return: (Promise<DeliveryOutcome>) The outcome.
 * @raises Error for a retryable failure.
 */
async function sendSms(
  ctx: ActionCtx,
  outboxId: Id<"notificationOutbox">,
  route: Extract<Route, { kind: "sms" }>,
): Promise<DeliveryOutcome> {
  const result: SmsResult = await ctx.runAction(internal.sms.send, {
    to: route.to,
    body: route.body,
  });
  if (result.ok) {
    await ctx.runMutation(internal.delivery.record, { outboxId, outcome: "sent", channel: "sms" });
    return "sent";
  }
  if (result.retryable) throw new Error(`SMS delivery failed, will retry: ${result.error}`);
  await ctx.runMutation(internal.delivery.record, {
    outboxId,
    outcome: "failed",
    detail: result.error,
  });
  return "failed";
}

/**
 * purpose: Run the route returned by begin, recording an error before rethrowing it so the
 *          workpool retries and the row shows why.
 * @param ctx: (ActionCtx) Context.
 * @param outboxId: (Id<"notificationOutbox">) The row.
 * @param route: (Route) An apns or sms route.
 * @return: (Promise<DeliveryOutcome>) The outcome.
 * @raises The original error when worth retrying.
 */
async function runRoute(
  ctx: ActionCtx,
  outboxId: Id<"notificationOutbox">,
  route: Extract<Route, { kind: "apns" | "sms" }>,
): Promise<DeliveryOutcome> {
  try {
    return route.kind === "apns"
      ? await sendApns(ctx, outboxId, route)
      : await sendSms(ctx, outboxId, route);
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    await ctx.runMutation(internal.delivery.record, { outboxId, outcome: "retry", detail });
    throw e;
  }
}

/**
 * purpose: The workpool action: deliver one outbox row. Throws for errors worth retrying (the
 *          workpool retries with backoff); returns for everything else.
 * @param outboxId: (Id<"notificationOutbox">) The row.
 * @return: (DeliveryOutcome) What happened.
 */
export const deliver = internalAction({
  args: { outboxId: v.id("notificationOutbox") },
  handler: async (ctx, { outboxId }): Promise<DeliveryOutcome> => {
    const start: BeginResult = await ctx.runMutation(internal.delivery.begin, { outboxId });
    if (start.kind === "done") return start.outcome;
    if (start.route.kind === "skip") return "skipped";
    return await runRoute(ctx, outboxId, start.route);
  },
});

/**
 * purpose: Workpool completion handler. A run that failed (retries exhausted) fails a row
 *          that is still pending, with the error as detail. Success and cancellation change
 *          nothing: the action settles its own rows.
 * @param workId: (string) The workpool work id.
 * @param context: ({ outboxId }) The row the run worked for.
 * @param result: (RunResult) success, failed, or canceled.
 * @return: (null)
 */
export const onDeliveryComplete = internalMutation({
  args: vOnCompleteArgs(v.object({ outboxId: v.id("notificationOutbox") })),
  handler: async (ctx, { context, result }): Promise<null> => {
    if (result.kind !== "failed") return null;
    const row = await ctx.db.get(context.outboxId);
    if (!row || row.state !== "pending") return null;
    console.error(`Notification delivery failed: ${result.error}`);
    await settle(ctx, row, { state: "failed", detail: result.error });
    return null;
  },
});

/**
 * purpose: Cron entry: enqueue again the rows and digests pending for 15 minutes or more.
 * @return: (number) Rows and digests re-enqueued.
 */
export const sweepStuck = internalMutation({
  args: {},
  handler: async (ctx): Promise<number> => {
    const now = Date.now();
    return (await requeueStuckDeliveries(ctx, now)) + (await requeueStuckDigests(ctx, now));
  },
});
