import { vOnCompleteArgs } from "@convex-dev/workpool";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { internalAction, internalMutation } from "./_generated/server";
import type { ActionCtx, MutationCtx } from "./_generated/server";
import { requeueStuckDigests } from "./digest";
import {
  alertMessage,
  apnsAnswer,
  dropsToken,
  providerFault,
  refusedTokens,
  resultDetail,
  seconds,
} from "./lib/apnsPayload";
import type { ApnsResult, ApnsSendResult } from "./lib/apnsPayload";
import {
  MAX_ATTEMPTS,
  fallbackAfterPushGaveUp,
  requeueStuckDeliveries,
  resolveRoute,
} from "./lib/delivery";
import type { ApnsRoute, LiveActivityRoute, SendRoute, SmsRoute } from "./lib/delivery";
import { closeStart, markStarted } from "./lib/liveActivity";
import { sendSmsFromEnv } from "./lib/twilio";
import { deliveryChannel } from "./lib/validators";

export type DeliveryOutcome = "sent" | "skipped" | "failed" | "config" | "settled" | "missing";

export type BeginResult =
  { kind: "done"; outcome: DeliveryOutcome } | { kind: "send"; route: SendRoute };

async function settle(
  ctx: MutationCtx,
  row: Doc<"notificationOutbox">,
  patch: Pick<Doc<"notificationOutbox">, "state"> &
    Partial<Pick<Doc<"notificationOutbox">, "channel" | "detail">>,
): Promise<void> {
  const now = Date.now();
  await ctx.db.patch(row._id, { ...patch, settledAt: now });
  if (patch.channel === "live_activity") await markStarted(ctx, row, now);
  else await closeStart(ctx, row, now);
}

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
    const route = await resolveRoute(ctx, row, Date.now());
    if (route.kind === "skip") {
      await settle(ctx, row, { state: "skipped", detail: route.reason });
      return { kind: "done", outcome: "skipped" };
    }
    await ctx.db.patch(outboxId, { attempts: attempts + 1, attemptStartedAt: Date.now() });
    return { kind: "send", route };
  },
});

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
    pushFailed: v.optional(v.boolean()),
  },
  handler: async (ctx, args): Promise<null> => {
    const row = await ctx.db.get(args.outboxId);
    if (!row || row.state !== "pending") return null;
    if (args.outcome === "retry") {
      const pushState =
        row.pushState === "gave_up" ? "gave_up" : args.pushFailed ? "retrying" : undefined;
      await ctx.db.patch(row._id, { detail: args.detail, pushState });
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

function apnsDetail(results: ApnsResult[]): string {
  const bad = results.find((r) => r.outcome === "failed");
  return bad ? resultDetail(bad) : "no result from APNs";
}

async function sendApns(
  ctx: ActionCtx,
  outboxId: Id<"notificationOutbox">,
  route: ApnsRoute,
): Promise<DeliveryOutcome | SmsRoute> {
  const message = alertMessage(
    route.title,
    route.body,
    route.data,
    route.style,
    seconds(Date.now()),
  );
  const { results, configError }: ApnsSendResult = await ctx.runAction(internal.apns.send, {
    sends: route.tokens.map((token) => ({ token, message })),
  });
  const dead = refusedTokens(results, "alert");
  if (dead.length > 0) await ctx.runMutation(internal.apnsTokens.deleteTokens, { tokens: dead });
  if (results.some((r) => r.outcome === "sent")) {
    await ctx.runMutation(internal.delivery.record, { outboxId, outcome: "sent", channel: "apns" });
    return "sent";
  }
  const fault = configError ?? providerFault(results);
  if (fault !== undefined) {
    if (route.smsFallback !== null) {
      console.warn(`Push not sent (${fault}); sending the text instead`);
      return route.smsFallback;
    }
    await ctx.runMutation(internal.delivery.record, { outboxId, outcome: "retry", detail: fault });
    return "config";
  }
  const retryable = results.some((r) => apnsAnswer(r) === "retry");
  if (!retryable && route.smsFallback !== null) {
    const why = dead.length === results.length ? "tokens unregistered" : apnsDetail(results);
    console.warn(`Push not delivered (${why}); sending the text instead`);
    return route.smsFallback;
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
  if (retryable) {
    throw new Error(`APNs delivery failed, will retry: ${detail}`);
  }
  await ctx.runMutation(internal.delivery.record, { outboxId, outcome: "failed", detail });
  return "failed";
}

async function sendStart(
  ctx: ActionCtx,
  outboxId: Id<"notificationOutbox">,
  route: LiveActivityRoute,
): Promise<DeliveryOutcome | ApnsRoute> {
  const { results, configError }: ApnsSendResult = await ctx.runAction(internal.apns.send, {
    sends: [{ token: route.token, message: route.message }],
  });
  const fault = configError ?? providerFault(results);
  if (fault !== undefined) {
    await ctx.runMutation(internal.delivery.record, { outboxId, outcome: "retry", detail: fault });
    return "config";
  }
  const result = results[0];
  if (result?.outcome === "sent") {
    await ctx.runMutation(internal.delivery.record, {
      outboxId,
      outcome: "sent",
      channel: "live_activity",
    });
    return "sent";
  }
  const detail = apnsDetail(results);
  if (result === undefined || apnsAnswer(result) === "retry") {
    throw new Error(`Live Activity start failed, will retry: ${detail}`);
  }
  const unregistered = dropsToken(result, "liveActivityStart");
  if (unregistered) {
    await ctx.runMutation(internal.phonePush.dropToken, {
      deviceId: route.deviceId,
      field: "liveActivityStart",
      token: route.token,
    });
  }
  if (route.alertFallback !== null) {
    const why = unregistered ? "start token refused" : detail;
    console.warn(`Live Activity not started (${why}); sending the notification instead`);
    return route.alertFallback;
  }
  await ctx.runMutation(internal.delivery.record, {
    outboxId,
    outcome: unregistered ? "skipped" : "failed",
    detail: unregistered ? "start_token_unregistered" : detail,
  });
  return unregistered ? "skipped" : "failed";
}

async function sendSms(
  ctx: ActionCtx,
  outboxId: Id<"notificationOutbox">,
  route: SmsRoute,
): Promise<DeliveryOutcome> {
  const result = await sendSmsFromEnv(route.to, route.body);
  if (result.ok) {
    await ctx.runMutation(internal.delivery.record, { outboxId, outcome: "sent", channel: "sms" });
    return "sent";
  }
  if (result.config) {
    await ctx.runMutation(internal.delivery.record, {
      outboxId,
      outcome: "retry",
      detail: result.error,
    });
    return "config";
  }
  if (result.retryable && (!result.timedOut || route.retryOnTimeout)) {
    throw new Error(`SMS delivery failed, will retry: ${result.error}`);
  }
  const detail = result.timedOut
    ? `${result.error}; not retried, the text may have been delivered`
    : result.error;
  await ctx.runMutation(internal.delivery.record, { outboxId, outcome: "failed", detail });
  return "failed";
}

async function attempt<T>(
  ctx: ActionCtx,
  outboxId: Id<"notificationOutbox">,
  pushWithFallback: boolean,
  step: () => Promise<T>,
): Promise<T> {
  try {
    return await step();
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    await ctx.runMutation(internal.delivery.record, {
      outboxId,
      outcome: "retry",
      detail,
      pushFailed: pushWithFallback,
    });
    throw e;
  }
}

async function runRoute(
  ctx: ActionCtx,
  outboxId: Id<"notificationOutbox">,
  route: SendRoute,
): Promise<DeliveryOutcome> {
  const next =
    route.kind === "live_activity"
      ? await attempt(ctx, outboxId, route.alertFallback !== null, () =>
          sendStart(ctx, outboxId, route),
        )
      : route;
  if (typeof next === "string") return next;
  const text =
    next.kind === "sms"
      ? next
      : await attempt(ctx, outboxId, next.smsFallback !== null, () =>
          sendApns(ctx, outboxId, next),
        );
  if (typeof text === "string") return text;
  return await attempt(ctx, outboxId, false, () => sendSms(ctx, outboxId, text));
}

export const deliver = internalAction({
  args: { outboxId: v.id("notificationOutbox") },
  handler: async (ctx, { outboxId }): Promise<DeliveryOutcome> => {
    const start: BeginResult = await ctx.runMutation(internal.delivery.begin, { outboxId });
    if (start.kind === "done") return start.outcome;
    return await runRoute(ctx, outboxId, start.route);
  },
});

export const onDeliveryComplete = internalMutation({
  args: vOnCompleteArgs(v.object({ outboxId: v.id("notificationOutbox") })),
  handler: async (ctx, { context, result }): Promise<null> => {
    if (result.kind !== "failed") return null;
    const row = await ctx.db.get(context.outboxId);
    if (!row || row.state !== "pending") return null;
    if (await fallbackAfterPushGaveUp(ctx, row, result.error)) return null;
    console.error(`Notification delivery failed: ${result.error}`);
    await settle(ctx, row, { state: "failed", detail: result.error });
    return null;
  },
});

export const sweepStuck = internalMutation({
  args: {},
  handler: async (ctx): Promise<number> => {
    const now = Date.now();
    return (await requeueStuckDeliveries(ctx, now)) + (await requeueStuckDigests(ctx, now));
  },
});
