import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalAction, internalMutation, internalQuery } from "./_generated/server";
import { liveActivityEndMessage, liveActivityUpdateMessage } from "./lib/apnsPayload";
import type { ApnsSendResult } from "./lib/apnsPayload";
import { endActivity, loadActivityView, nextCommand } from "./lib/liveActivity";
import { proofMissed, reshowIfDue } from "./lib/liveActivitySync";
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
    };

export const checkProof = internalMutation({
  args: { activityId: v.id("liveActivities") },
  handler: async (ctx, args): Promise<null> => {
    await proofMissed(ctx, args.activityId, Date.now());
    return null;
  },
});

export const plan = internalQuery({
  args: { activityId: v.id("liveActivities") },
  handler: async (ctx, args): Promise<PushPlan> => {
    const row = await ctx.db.get(args.activityId);
    if (row === null || row.phase.kind !== "live") return { kind: "none" };
    const now = Date.now();
    const nowSeconds = Math.floor(now / 1000);
    const command = nextCommand(row, await loadActivityView(ctx, row, now));
    switch (command.kind) {
      case "none":
        return command;
      case "update":
        return {
          kind: "send",
          token: command.token,
          message: liveActivityUpdateMessage(command, nowSeconds),
          content: command.content,
          ends: null,
        };
      case "end":
        return {
          kind: "send",
          token: command.token,
          message: liveActivityEndMessage(command, row.phase.acceptedAt, nowSeconds),
          content: command.content,
          ends: command.reason,
        };
    }
  },
});

export const settle = internalMutation({
  args: {
    activityId: v.id("liveActivities"),
    token: v.string(),
    content: activityContent,
    ends: v.union(activityEndReason, v.null()),
    outcome: v.union(v.literal("sent"), v.literal("unregistered")),
  },
  handler: async (ctx, args): Promise<null> => {
    const row = await ctx.db.get(args.activityId);
    if (row === null || row.phase.kind !== "live" || row.phase.updateToken !== args.token) {
      return null;
    }
    if (args.outcome === "unregistered") {
      await ctx.db.patch(row._id, {
        phase: { kind: "started", acceptedAt: row.phase.acceptedAt, proof: "proven" },
      });
    } else if (args.ends === null) {
      await ctx.db.patch(row._id, { shown: args.content });
    } else {
      await endActivity(ctx, row, args.ends, Date.now(), args.content);
      if (args.ends === "confirmed") await reshowIfDue(ctx, row.taskInstanceId, row.deviceId);
    }
    return null;
  },
});

export const push = internalAction({
  args: { activityId: v.id("liveActivities") },
  handler: async (ctx, args): Promise<null> => {
    const planned: PushPlan = await ctx.runQuery(internal.liveActivity.plan, args);
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
      console.error(`Live Activity push refused: ${detail}`);
      return null;
    }
    await ctx.runMutation(internal.liveActivity.settle, {
      activityId: args.activityId,
      token: planned.token,
      content: planned.content,
      ends: planned.ends,
      outcome: result.outcome,
    });
    return null;
  },
});
