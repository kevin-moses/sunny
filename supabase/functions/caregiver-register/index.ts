// caregiver-register/index.ts
// Purpose: POST endpoint to register a caregiver for push notifications and link them to a senior.
// Upserts two rows in parallel:
//   - caregiver_devices: stores/refreshes the FCM token for the caregiver's platform
//   - caregiver_links:   creates the caregiver <-> senior relationship (ignored on conflict)
//
// Body: { fcm_token: string, platform: "ios"|"web", senior_id: uuid }
//
// Auth: MVP bearer UUID / fallback TEST_USER_ID. Phase 3 will verify caregiver identity via JWT.
//
// Last modified: 2026-02-26

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { corsHeaders, error, getUserId, success, UUID_REGEX } from "../_shared/response.ts";
import { supabaseAdmin } from "../_shared/supabase.ts";

const VALID_PLATFORMS = new Set(["ios", "web"]);

/**
 * Handles POST /caregiver-register requests.
 * Validates the senior exists, then in parallel upserts the caregiver's FCM token
 * and creates the caregiver<->senior link (ignoreDuplicates on the link so conflicts are silent).
 * @param req - incoming Deno Request with JSON body { fcm_token, platform, senior_id }
 * @returns Response with { registered, caregiver_id, senior_id } or an error response
 */
serve(async (req: Request) => {
  const started = Date.now();
  const caregiverId = getUserId(req);
  const url = new URL(req.url);

  try {
    if (req.method === "OPTIONS") {
      return new Response("ok", { headers: corsHeaders() });
    }

    if (req.method !== "POST") {
      return error("Method not allowed", "METHOD_NOT_ALLOWED", 405);
    }

    const body = await req.json().catch(() => null);
    if (!body || typeof body !== "object") {
      return error("Request body must be JSON", "INVALID_BODY", 400);
    }

    const { fcm_token, platform, senior_id } = body as Record<string, unknown>;

    if (!fcm_token || typeof fcm_token !== "string" || fcm_token.trim() === "") {
      return error("fcm_token is required", "INVALID_FCM_TOKEN", 400);
    }
    if (!platform || typeof platform !== "string" || !VALID_PLATFORMS.has(platform)) {
      return error("platform must be 'ios' or 'web'", "INVALID_PLATFORM", 400);
    }
    if (!senior_id || typeof senior_id !== "string" || !UUID_REGEX.test(senior_id)) {
      return error("senior_id must be a valid UUID", "INVALID_SENIOR_ID", 400);
    }

    // Validate senior exists before creating any rows
    const { data: seniorRow, error: seniorError } = await supabaseAdmin
      .from("users")
      .select("id")
      .eq("id", senior_id)
      .maybeSingle();

    if (seniorError) {
      console.error("caregiver-register senior lookup failed", seniorError);
      return error("Failed to validate senior", "SENIOR_FETCH_FAILED", 500);
    }
    if (!seniorRow) {
      return error("Senior not found", "SENIOR_NOT_FOUND", 404);
    }

    // Two parallel upserts
    const [deviceResult, linkResult] = await Promise.all([
      // Upsert FCM token; always returns a row so .single() is safe
      supabaseAdmin
        .from("caregiver_devices")
        .upsert(
          {
            caregiver_user_id: caregiverId,
            fcm_token: fcm_token.trim(),
            platform,
            updated_at: new Date().toISOString(),
          },
          { onConflict: "caregiver_user_id,platform" },
        )
        .select("id")
        .single(),

      // Create link if not already present; do NOT chain .single() — 0 rows returned on conflict
      supabaseAdmin
        .from("caregiver_links")
        .upsert(
          {
            caregiver_user_id: caregiverId,
            senior_user_id: senior_id,
          },
          { onConflict: "caregiver_user_id,senior_user_id", ignoreDuplicates: true },
        ),
    ]);

    if (deviceResult.error) {
      console.error("caregiver-register device upsert failed", deviceResult.error);
      return error("Failed to register device", "DEVICE_REGISTER_FAILED", 500);
    }
    if (linkResult.error) {
      console.error("caregiver-register link upsert failed", linkResult.error);
      return error("Failed to create caregiver link", "LINK_CREATE_FAILED", 500);
    }

    return success({ registered: true, caregiver_id: caregiverId, senior_id }, 201);
  } catch (err) {
    console.error("caregiver-register unhandled error", err);
    return error("Internal server error", "INTERNAL_ERROR", 500);
  } finally {
    console.log(
      JSON.stringify({
        method: req.method,
        path: url.pathname,
        caregiver_id: caregiverId,
        duration: Date.now() - started,
      }),
    );
  }
});
