// livekit-token/index.ts
// Purpose: Issues a LiveKit room token to a paired senior device (phone or home display)
// so it can talk to the agent, without exposing the LiveKit API secret.
//
// Auth: requires the caller's Supabase JWT (verified by the Edge gateway). The caller must
//       be a paired device (a row in public.devices); caregivers do not talk to the agent.
//       The room name and participant identity are chosen here, never by the client.
//
// Required secrets (set via `supabase secrets set`):
//   LIVEKIT_API_KEY    -- LiveKit project API key
//   LIVEKIT_API_SECRET -- LiveKit project API secret
//   LIVEKIT_SERVER_URL -- wss://... URL of the LiveKit server
//
// Optional JSON body:
//   trigger        -- 'talk' (default) | 'scheduled_prompt' | 'notification_tap'
//   taskInstanceId -- UUID of the task instance that prompted the session; must belong
//                     to the device's household (checked through RLS)
//
// Participant metadata JSON read by the agent:
//   { household_id, device_id, trigger, task_instance_id? }
//
// Memory-care pivot (2026-10-25): replaced the unauthenticated userId/reminderId body with
// a verified device identity and household-scoped metadata.
//
// Last modified: 2026-10-25

import { AccessToken } from "npm:livekit-server-sdk@2";
import { corsHeaders, error, success, UUID_REGEX } from "../_shared/response.ts";
import { userClient } from "../_shared/supabase.ts";

const TOKEN_TTL_SECONDS = 3600; // 1 hour
const TRIGGERS = new Set(["talk", "scheduled_prompt", "notification_tap"]);

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders() });
  }
  if (req.method !== "POST") {
    return error("Method not allowed", "METHOD_NOT_ALLOWED", 405);
  }

  const apiKey = Deno.env.get("LIVEKIT_API_KEY");
  const apiSecret = Deno.env.get("LIVEKIT_API_SECRET");
  const serverUrl = Deno.env.get("LIVEKIT_SERVER_URL");
  if (!apiKey || !apiSecret || !serverUrl) {
    console.error("livekit-token: missing LIVEKIT_API_KEY, LIVEKIT_API_SECRET, or LIVEKIT_SERVER_URL");
    return error("Token service not configured", "SERVER_MISCONFIGURED", 500);
  }

  let body: { trigger?: string; taskInstanceId?: string } = {};
  try {
    const text = await req.text();
    body = text ? JSON.parse(text) : {};
  } catch {
    return error("Request body must be valid JSON", "INVALID_BODY", 400);
  }

  const trigger = body.trigger ?? "talk";
  if (!TRIGGERS.has(trigger)) {
    return error("Unknown trigger", "INVALID_TRIGGER", 400);
  }
  if (body.taskInstanceId !== undefined && !UUID_REGEX.test(body.taskInstanceId)) {
    return error("taskInstanceId must be a UUID", "INVALID_TASK_INSTANCE", 400);
  }

  const supabase = userClient(req);
  const { data: userData, error: userError } = await supabase.auth.getUser();
  if (userError || !userData.user) {
    return error("Sign in required", "UNAUTHORIZED", 401);
  }

  const { data: device } = await supabase
    .from("devices")
    .select("id, household_id")
    .eq("user_id", userData.user.id)
    .maybeSingle();
  if (!device) {
    return error("This device is not paired with a household", "NOT_PAIRED", 403);
  }

  if (body.taskInstanceId) {
    // RLS only returns instances in the device's own household.
    const { data: instance } = await supabase
      .from("task_instances")
      .select("id")
      .eq("id", body.taskInstanceId)
      .maybeSingle();
    if (!instance) {
      return error("Task instance not found", "TASK_INSTANCE_NOT_FOUND", 404);
    }
  }

  const metadata: Record<string, string> = {
    household_id: device.household_id,
    device_id: device.id,
    trigger,
  };
  if (body.taskInstanceId) metadata.task_instance_id = body.taskInstanceId;

  const roomName = `household-${device.household_id}-${crypto.randomUUID().slice(0, 8)}`;
  const participantName = `device-${device.id}`;
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

  return success({
    serverUrl,
    roomName,
    participantName,
    participantToken: await token.toJwt(),
  });
});
