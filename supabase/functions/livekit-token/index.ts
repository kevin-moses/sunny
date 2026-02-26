// livekit-token/index.ts
// Purpose: Generates a LiveKit access token for a participant joining a room.
// Called by the iOS app at session start to obtain a signed JWT and server URL
// without exposing the LiveKit API secret to the client.
//
// Auth: No JWT required — the token IS the auth mechanism. The server keeps the
//       LiveKit API secret; the client only receives the short-lived room token.
//
// Required secrets (set via `supabase secrets set`):
//   LIVEKIT_API_KEY    -- LiveKit project API key
//   LIVEKIT_API_SECRET -- LiveKit project API secret
//   LIVEKIT_SERVER_URL -- wss://... URL of the LiveKit server
//
// Last modified: 2026-02-24

import { AccessToken } from "npm:livekit-server-sdk@2";
import { corsHeaders, error, success } from "../_shared/response.ts";

const TOKEN_TTL_SECONDS = 3600; // 1 hour

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

  let body: { roomName?: string; participantName?: string; userId?: string };
  try {
    body = await req.json();
  } catch {
    return error("Request body must be valid JSON", "INVALID_BODY", 400);
  }

  const { roomName, participantName, userId } = body;

  if (!roomName || typeof roomName !== "string") {
    return error("roomName is required", "MISSING_ROOM_NAME", 400);
  }
  if (!participantName || typeof participantName !== "string") {
    return error("participantName is required", "MISSING_PARTICIPANT_NAME", 400);
  }

  // Embed userId in participant metadata so the agent can resolve the user
  const metadata = userId ? JSON.stringify({ user_id: userId }) : undefined;

  const token = new AccessToken(apiKey, apiSecret, {
    identity: participantName,
    ttl: TOKEN_TTL_SECONDS,
    metadata,
  });

  token.addGrant({
    room: roomName,
    roomJoin: true,
    canPublish: true,
    canSubscribe: true,
    canPublishData: true,
  });

  const participantToken = await token.toJwt();

  return success({
    serverUrl,
    roomName,
    participantName,
    participantToken,
  });
});
