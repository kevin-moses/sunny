// delivery.ts
// Purpose: Delivery of notificationOutbox rows (queueing and routing: lib/delivery.ts). The
// workpool "deliveryPool" runs `deliver` for a row as soon as it is inserted. `begin` re-checks
// the row in one transaction (still unsettled, not past MAX_ATTEMPTS, recipient still in the
// household, content still current) and either finishes it as skipped or returns the route;
// `deliver` calls APNs or SMS; `record` stores the outcome. Contracts worth knowing:
// - APNs: a token APNs reports unregistered is deleted. The row is sent when at least one token
//   was accepted (no resend to the others). Otherwise a retryable failure is thrown so the
//   workpool retries with backoff; all tokens unregistered finishes the row as skipped; any
//   other failure is final.
// - SMS: { ok: false, retryable: true } is thrown for a retry; { ok: false, retryable: false }
//   is a final failure.
// - A configuration error ("... is not configured") is recorded and thrown as the workpool's
//   NonRetryableError: no retries, the row is failed for good (a later sweeper run does not
//   resurrect it).
// - Retries exhausted marks the row failed (onDeliveryComplete). Nothing in this file throws
//   for a row that is already settled, so a duplicate job from the sweeper is harmless.
// - lastError holds provider detail and is never returned to clients.
//
// Last modified: 2026-10-29

import { NonRetryableError, vOnCompleteArgs } from "@convex-dev/workpool";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { internalAction, internalMutation } from "./_generated/server";
import type { ActionCtx, MutationCtx } from "./_generated/server";
import type { ApnsResult } from "./apns";
import { ConfigError } from "./lib/errors";
import { MAX_ATTEMPTS, requeueStuckDeliveries, resolveRoute } from "./lib/delivery";
import type { Route } from "./lib/delivery";
import { deliveryChannel } from "./lib/validators";
import type { DeliveryChannel } from "./lib/validators";
import type { SmsResult } from "./sms";

/** The outcome of a delivery run, returned by the action. */
export type DeliveryOutcome = "sent" | "skipped" | "failed" | "settled" | "missing";

/** What `begin` tells the action to do. */
export type BeginResult =
  { kind: "done"; outcome: DeliveryOutcome } | { kind: "send"; route: Route };

/**
 * purpose: Mark a row finished (sent, skipped or failed for good).
 * @param ctx: (MutationCtx) Context.
 * @param row: (Doc<"notificationOutbox">) The row.
 * @param patch: (object) The outcome fields to write; settledAt is added.
 * @return: (Promise<void>) Resolves when written.
 */
async function settle(
  ctx: MutationCtx,
  row: Doc<"notificationOutbox">,
  patch: Partial<Doc<"notificationOutbox">>,
): Promise<void> {
  await ctx.db.patch(row._id, { ...patch, settledAt: Date.now() });
}

/**
 * purpose: Start a delivery run: stop at once for a missing or settled row, give up on a row
 *          that has used up MAX_ATTEMPTS, finish a row with no reachable address as skipped,
 *          otherwise count the attempt and return the route.
 * @param outboxId: (Id<"notificationOutbox">) The row.
 * @return: (BeginResult) done with the outcome, or send with the route.
 */
export const begin = internalMutation({
  args: { outboxId: v.id("notificationOutbox") },
  handler: async (ctx, { outboxId }): Promise<BeginResult> => {
    const row = await ctx.db.get(outboxId);
    if (!row) return { kind: "done", outcome: "missing" };
    if (row.settledAt !== undefined) return { kind: "done", outcome: "settled" };
    const attempts = row.attempts ?? 0;
    if (attempts >= MAX_ATTEMPTS) {
      await settle(ctx, row, { failedAt: Date.now(), lastError: row.lastError ?? "gave up" });
      return { kind: "done", outcome: "failed" };
    }
    const route = await resolveRoute(ctx, row);
    if (route.kind === "skip") {
      await settle(ctx, row, { channel: "none", skippedReason: route.reason });
      return { kind: "done", outcome: "skipped" };
    }
    await ctx.db.patch(outboxId, { attempts: attempts + 1, channel: route.kind });
    return { kind: "send", route };
  },
});

/**
 * purpose: Record the result of a delivery run. "sent" settles with sentAt; "failed" settles
 *          with failedAt; "skipped" settles with a reason and channel none; "retry" only
 *          stores the error for the next run.
 * @param outboxId: (Id<"notificationOutbox">) The row.
 * @param outcome: ("sent" | "retry" | "failed" | "skipped") What happened.
 * @param channel: (DeliveryChannel) The channel used.
 * @param error: (string, optional) Internal error detail.
 * @param reason: (string, optional) Skip reason.
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
    channel: deliveryChannel,
    error: v.optional(v.string()),
    reason: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<null> => {
    const row = await ctx.db.get(args.outboxId);
    if (!row || row.settledAt !== undefined) return null;
    const now = Date.now();
    if (args.outcome === "sent") {
      await settle(ctx, row, { channel: args.channel, sentAt: now, lastError: undefined });
    } else if (args.outcome === "failed") {
      await settle(ctx, row, { channel: args.channel, failedAt: now, lastError: args.error });
    } else if (args.outcome === "skipped") {
      await settle(ctx, row, { channel: "none", skippedReason: args.reason });
    } else {
      await ctx.db.patch(row._id, { lastError: args.error });
    }
    return null;
  },
});

/**
 * purpose: Whether an error is a permanent configuration problem (a ConfigError, or the
 *          "... is not configured" error the senders throw), which retrying cannot fix.
 * @param e: (unknown) The caught value.
 * @return: (boolean) True for a configuration error.
 */
function isConfigError(e: unknown): boolean {
  return e instanceof ConfigError || (e instanceof Error && /not configured/i.test(e.message));
}

/**
 * purpose: A short internal description of an APNs failure for lastError.
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
  const results: ApnsResult[] = await ctx.runAction(internal.apns.send, {
    tokens: route.tokens,
    title: route.title,
    body: route.body,
    data: route.data,
  });
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
      channel: "none",
      reason: "tokens_unregistered",
    });
    return "skipped";
  }
  const error = apnsDetail(results);
  if (results.some((r) => r.outcome === "failed" && r.retryable)) {
    throw new Error(`APNs delivery failed, will retry: ${error}`);
  }
  await ctx.runMutation(internal.delivery.record, {
    outboxId,
    outcome: "failed",
    channel: "apns",
    error,
  });
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
  if (result.retryable) {
    throw new Error(`SMS delivery failed, will retry: ${result.error}`);
  }
  await ctx.runMutation(internal.delivery.record, {
    outboxId,
    outcome: "failed",
    channel: "sms",
    error: result.error,
  });
  return "failed";
}

/**
 * purpose: Run the route returned by begin, turning configuration errors into the workpool's
 *          non-retryable error and recording other unexpected errors before rethrowing them.
 * @param ctx: (ActionCtx) Context.
 * @param outboxId: (Id<"notificationOutbox">) The row.
 * @param route: (Route) An apns or sms route.
 * @return: (Promise<DeliveryOutcome>) The outcome.
 * @raises NonRetryableError for configuration; the original error when worth retrying.
 */
async function runRoute(
  ctx: ActionCtx,
  outboxId: Id<"notificationOutbox">,
  route: Extract<Route, { kind: "apns" | "sms" }>,
): Promise<DeliveryOutcome> {
  const channel: DeliveryChannel = route.kind;
  try {
    return route.kind === "apns"
      ? await sendApns(ctx, outboxId, route)
      : await sendSms(ctx, outboxId, route);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (isConfigError(e)) {
      await ctx.runMutation(internal.delivery.record, {
        outboxId,
        outcome: "failed",
        channel,
        error: message,
      });
      throw new NonRetryableError(message, { cause: e });
    }
    await ctx.runMutation(internal.delivery.record, {
      outboxId,
      outcome: "retry",
      channel,
      error: message,
    });
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
 * purpose: Workpool completion handler. A run that failed (retries exhausted, or a
 *          non-retryable error) settles the row as failed with the error, unless the action
 *          already settled it. Success and cancellation change nothing: the action settles
 *          its own rows.
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
    if (!row || row.settledAt !== undefined) return null;
    console.error(`Notification delivery failed: ${result.error}`);
    await settle(ctx, row, { failedAt: Date.now(), lastError: result.error });
    return null;
  },
});

/**
 * purpose: Cron entry: enqueue again the rows and digests unsettled for 15 minutes or more.
 * @return: (number) Rows and digests re-enqueued.
 */
export const sweepStuck = internalMutation({
  args: {},
  handler: async (ctx): Promise<number> => {
    return await requeueStuckDeliveries(ctx, Date.now());
  },
});
