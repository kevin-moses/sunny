import { AccessToken } from "livekit-server-sdk";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { action, internalQuery } from "./_generated/server";
import { findDevice } from "./lib/access";
import { appError } from "./lib/errors";

const TOKEN_TTL_SECONDS = 3600;
const ROOM_SUFFIX_BYTES = 4;

const trigger = v.union(
  v.literal("talk"),
  v.literal("scheduled_prompt"),
  v.literal("notification_tap"),
);

export interface LivekitTokenResult {
  serverUrl: string;
  roomName: string;
  participantName: string;
  participantToken: string;
}

export const resolveDevice = internalQuery({
  args: { userId: v.string(), taskInstanceId: v.optional(v.id("taskInstances")) },
  handler: async (
    ctx,
    args,
  ): Promise<{ householdId: Id<"households">; deviceId: Id<"devices"> }> => {
    const device = await findDevice(ctx, args.userId);
    if (!device) throw appError("forbidden", "This device is not paired with a household");
    if (args.taskInstanceId !== undefined) {
      const instance = await ctx.db.get(args.taskInstanceId);
      if (!instance || instance.householdId !== device.householdId) {
        throw appError("not_found", "Task instance not found");
      }
    }
    return { householdId: device.householdId, deviceId: device._id };
  },
});

function randomHex(): string {
  const bytes = new Uint8Array(ROOM_SUFFIX_BYTES);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function livekitEnv(): { apiKey: string; apiSecret: string; serverUrl: string } {
  const apiKey = process.env.LIVEKIT_API_KEY;
  const apiSecret = process.env.LIVEKIT_API_SECRET;
  const serverUrl = process.env.LIVEKIT_SERVER_URL;
  if (!apiKey || !apiSecret || !serverUrl) {
    throw new Error(
      "LiveKit is not configured: set LIVEKIT_API_KEY, LIVEKIT_API_SECRET, LIVEKIT_SERVER_URL",
    );
  }
  return { apiKey, apiSecret, serverUrl };
}

export const livekitToken = action({
  args: { trigger: v.optional(trigger), taskInstanceId: v.optional(v.id("taskInstances")) },
  handler: async (ctx, args): Promise<LivekitTokenResult> => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw appError("unauthenticated", "Sign in first");
    const { householdId, deviceId } = await ctx.runQuery(internal.voice.resolveDevice, {
      userId: identity.subject,
      taskInstanceId: args.taskInstanceId,
    });
    const { apiKey, apiSecret, serverUrl } = livekitEnv();

    const metadata: Record<string, string> = {
      household_id: householdId,
      device_id: deviceId,
      trigger: args.trigger ?? "talk",
    };
    if (args.taskInstanceId !== undefined) metadata.task_instance_id = args.taskInstanceId;

    const roomName = `household-${householdId}-${randomHex()}`;
    const participantName = `device-${deviceId}`;
    const token = new AccessToken(apiKey, apiSecret, {
      identity: participantName,
      ttl: TOKEN_TTL_SECONDS,
      metadata: JSON.stringify(metadata),
    });
    token.addGrant({
      room: roomName,
      roomJoin: true,
      canPublish: true,
      canSubscribe: true,
      canPublishData: true,
    });
    return { serverUrl, roomName, participantName, participantToken: await token.toJwt() };
  },
});
