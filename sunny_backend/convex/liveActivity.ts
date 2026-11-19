import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalAction, internalMutation } from "./_generated/server";
import {
  liveActivityEndMessage,
  liveActivityUpdateMessage,
  refusedThisToken,
} from "./lib/apnsPayload";
import type { ApnsSendResult } from "./lib/apnsPayload";
import { endActivity, loadActivityView, nextCommand, nextPushTimestamp } from "./lib/liveActivity";
import { endTokenlessIfOver, proofMissed, reshowIfDue } from "./lib/liveActivitySync";
import { activityContent, activityEndReason } from "./lib/validators";
import type { ActivityContent, ActivityEndReason, ApnsMessage } from "./lib/validators";

export type PushPlan =
  | { kind: "none" }
  | {
      kind: "send";
      token: string;
      message: ApnsMessage;
      content: ActivityContent;
      ends: ActivityEndReason | null;
      timestamp: number;
    };

export const checkProof = internalMutation({
  args: { activityId: v.id("liveActivities") },
  handler: async (ctx, args): Promise<null> => {
    await proofMissed(ctx, args.activityId, Date.now());
    return null;
  },
});

export const plan = internalMutation({
  args: { activityId: v.id("liveActivities") },
  handler: async (ctx, args): Promise<PushPlan> => {
    const row = await ctx.db.get(args.activityId);
    if (row === null || row.phase.kind !== "live") return { kind: "none" };
    const now = Date.now();
    const command = nextCommand(row, await loadActivityView(ctx, row, now));
    if (command.kind === "none") return command;
    const timestamp = nextPushTimestamp(row, now);
    await ctx.db.patch(row._id, { pushTimestamp: timestamp });
    const sent = {
      kind: "send" as const,
      token: command.token,
      content: command.content,
      timestamp,
    };
    if (command.kind === "update") {
      return { ...sent, message: liveActivityUpdateMessage(command, timestamp), ends: null };
    }
    return {
      ...sent,
      message: liveActivityEndMessage(command, row.phase.acceptedAt, timestamp),
      ends: command.reason,
    };
  },
});

export const settle = internalMutation({
  args: {
    activityId: v.id("liveActivities"),
    token: v.string(),
    content: activityContent,
    ends: v.union(activityEndReason, v.null()),
    timestamp: v.number(),
    outcome: v.union(v.literal("sent"), v.literal("token_unusable")),
  },
  handler: async (ctx, args): Promise<null> => {
    const row = await ctx.db.get(args.activityId);
    if (row === null || row.phase.kind !== "live" || row.phase.updateToken !== args.token) {
      return null;
    }
    if (args.outcome === "token_unusable") {
      const tokenless = {
        kind: "started" as const,
        acceptedAt: row.phase.acceptedAt,
        proof: "proven" as const,
      };
      await ctx.db.patch(row._id, { phase: tokenless });
      await endTokenlessIfOver(ctx, { ...row, phase: tokenless }, Date.now());
      return null;
    }
    if (args.ends !== null) {
      await endActivity(ctx, row, args.ends, Date.now(), args.content);
      if (args.ends === "confirmed") await reshowIfDue(ctx, row.taskInstanceId, row.deviceId);
      return null;
    }
    const newestSent = args.timestamp === row.pushTimestamp;
    if (newestSent) await ctx.db.patch(row._id, { shown: args.content });
    return null;
  },
});

export const push = internalAction({
  args: { activityId: v.id("liveActivities") },
  handler: async (ctx, args): Promise<null> => {
    const planned: PushPlan = await ctx.runMutation(internal.liveActivity.plan, args);
    if (planned.kind === "none") return null;
    const { results, configError }: ApnsSendResult = await ctx.runAction(internal.apns.send, {
      sends: [{ token: planned.token, message: planned.message }],
    });
    if (configError !== undefined) {
      console.warn(`Live Activity push not sent (${configError})`);
      return null;
    }
    const result = results[0];
    if (result === undefined) throw new Error("Live Activity push got no result from APNs");
    if (result.outcome === "failed") {
      const detail = `${result.status} ${result.reason ?? "unknown"}`;
      if (result.retryable) throw new Error(`Live Activity push failed, will retry: ${detail}`);
      if (!refusedThisToken(result)) {
        console.error(`Live Activity push refused for a fault not in its token, kept: ${detail}`);
        return null;
      }
      console.error(`Live Activity push refused, so its update token is dropped: ${detail}`);
    }
    await ctx.runMutation(internal.liveActivity.settle, {
      activityId: args.activityId,
      token: planned.token,
      content: planned.content,
      ends: planned.ends,
      timestamp: planned.timestamp,
      outcome: result.outcome === "sent" ? "sent" : "token_unusable",
    });
    return null;
  },
});
