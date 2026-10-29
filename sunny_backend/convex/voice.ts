// convex/voice.ts
// Purpose: The LiveKit room token for a senior device, replacing the livekit-token Edge
// Function. The public action livekitToken requires a paired device (a devices row for the
// signed-in user), optionally checks that the task instance that prompted the session
// belongs to the device's household, and mints a one-hour LiveKit access token. Room name
// and participant identity are chosen here, never by the client. The participant metadata is
// read by the Python voice agent, so its keys are snake_case and exact:
//   { household_id, device_id, trigger, task_instance_id? }
// That metadata is the only place the agent learns the household from (see agent.ts).
//
// Env: LIVEKIT_API_KEY, LIVEKIT_API_SECRET, LIVEKIT_SERVER_URL (missing -> error).
//
// Last modified: 2026-10-29

import { AccessToken } from "livekit-server-sdk";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { action, internalQuery } from "./_generated/server";
import { findDevice } from "./lib/access";
import { appError } from "./lib/errors";

const TOKEN_TTL_SECONDS = 3600;
const ROOM_SUFFIX_BYTES = 4;

/** Why a session started. */
const trigger = v.union(
  v.literal("talk"),
  v.literal("scheduled_prompt"),
  v.literal("notification_tap"),
);

/** What livekitToken returns to the app. */
export interface LivekitTokenResult {
  serverUrl: string;
  roomName: string;
  participantName: string;
  participantToken: string;
}

/**
 * purpose: Resolve the calling user to its paired device and check the optional task instance.
 *          Internal: livekitToken calls it with the identity's subject.
 * @param userId: (string) Clerk user id of the caller.
 * @param taskInstanceId: (Id<"taskInstances">, optional) Instance that prompted the session.
 * @return: ({householdId, deviceId}) The device's household and id.
 * @raises forbidden when the user has no devices row; not_found when the instance is missing
 *         or belongs to another household.
 */
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

/**
 * purpose: Four random bytes as 8 lower-case hex characters, for the room name.
 * @return: (string) Eight hex characters.
 */
function randomHex(): string {
  const bytes = new Uint8Array(ROOM_SUFFIX_BYTES);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * purpose: Read the LiveKit settings from the environment.
 * @return: ({apiKey, apiSecret, serverUrl}) The settings.
 * @raises Error when any is missing.
 */
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

/**
 * purpose: Mint a LiveKit access token for a paired senior device so it can talk to the voice
 *          agent. Only paired devices (not caregivers) may call it.
 * @param trigger: ("talk" | "scheduled_prompt" | "notification_tap", optional) Why the session
 *        starts; default "talk".
 * @param taskInstanceId: (Id<"taskInstances">, optional) Instance that prompted the session;
 *        must belong to the device's household.
 * @return: (LivekitTokenResult) { serverUrl, roomName, participantName, participantToken }.
 */
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
