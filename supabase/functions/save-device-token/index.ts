// save-device-token/index.ts
// Purpose: Upserts an FCM or APNs device token for the authenticated user.
// Called by the iOS app after receiving or refreshing a push notification token.
// Uses ON CONFLICT (user_id, platform) so re-registration is always safe.
//
// Last modified: 2026-02-24

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { corsHeaders, error, getUserId, success } from "../_shared/response.ts";
import { supabaseAdmin } from "../_shared/supabase.ts";

type SaveTokenBody = {
  token: string;
  platform: "ios" | "web";
};

function isValidBody(body: unknown): body is SaveTokenBody {
  if (!body || typeof body !== "object") return false;
  const candidate = body as Partial<SaveTokenBody>;
  return (
    typeof candidate.token === "string" &&
    candidate.token.trim().length > 0 &&
    (candidate.platform === "ios" || candidate.platform === "web")
  );
}

serve(async (req: Request) => {
  const started = Date.now();
  const userId = getUserId(req);
  const url = new URL(req.url);

  try {
    if (req.method === "OPTIONS") {
      return new Response("ok", { headers: corsHeaders() });
    }

    if (req.method !== "POST") {
      return error("Method not allowed", "METHOD_NOT_ALLOWED", 405);
    }

    const body = await req.json().catch(() => null);
    if (!isValidBody(body)) {
      return error("Invalid body. Expected { token: string, platform: 'ios'|'web' }", "INVALID_BODY", 400);
    }

    const { error: upsertError } = await supabaseAdmin
      .from("device_tokens")
      .upsert(
        {
          user_id: userId,
          token: body.token.trim(),
          platform: body.platform,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "user_id,platform" },
      );

    if (upsertError) {
      console.error("save-device-token upsert failed", upsertError);
      return error("Failed to save device token", "DEVICE_TOKEN_SAVE_FAILED", 500);
    }

    return success({ saved: true });
  } catch (err) {
    console.error("save-device-token unhandled error", err);
    return error("Internal server error", "INTERNAL_ERROR", 500);
  } finally {
    console.log(
      JSON.stringify({
        method: req.method,
        path: url.pathname,
        user_id: userId,
        duration: Date.now() - started,
      }),
    );
  }
});
