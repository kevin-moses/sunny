// caregiver-settings/index.ts
// Purpose: GET/PUT endpoint for a caregiver's notification preferences for a given senior.
//
// GET ?senior_id  — returns the caregiver_links row; responds with defaults and linked=false
//                   if no link exists yet (caregiver has not registered for this senior).
// PUT             — body { senior_id, notify_escalations?, notify_daily_summary? }
//                   validates senior exists, then upserts the caregiver_links row;
//                   at least one boolean field required.
//
// Auth: MVP bearer UUID / fallback TEST_USER_ID. Phase 3 will verify caregiver_links.
//
// Last modified: 2026-02-26

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { corsHeaders, error, getUserId, success, UUID_REGEX } from "../_shared/response.ts";
import { supabaseAdmin } from "../_shared/supabase.ts";

const LINK_SELECT = "id,caregiver_user_id,senior_user_id,relationship,notify_escalations,notify_daily_summary,created_at";

/**
 * Handles GET/PUT /caregiver-settings requests.
 * GET returns the current notification preferences for this caregiver+senior pair,
 * or safe defaults with linked=false if no link exists yet.
 * PUT validates the senior exists, then upserts the caregiver_links row with the
 * provided boolean preferences. At least one preference field is required.
 * @param req - incoming Deno Request
 * @returns Response with notification preference fields or an error response
 */
serve(async (req: Request) => {
  const started = Date.now();
  const caregiverId = getUserId(req);
  const url = new URL(req.url);

  try {
    if (req.method === "OPTIONS") {
      return new Response("ok", { headers: corsHeaders() });
    }

    if (req.method === "GET") {
      const seniorId = url.searchParams.get("senior_id");
      if (!seniorId || !UUID_REGEX.test(seniorId)) {
        return error("senior_id must be a valid UUID", "INVALID_SENIOR_ID", 400);
      }

      // TODO Phase 3: verify caregiver_links WHERE caregiver_user_id=caregiverId AND senior_user_id=seniorId

      const { data: link, error: queryError } = await supabaseAdmin
        .from("caregiver_links")
        .select(LINK_SELECT)
        .eq("caregiver_user_id", caregiverId)
        .eq("senior_user_id", seniorId)
        .maybeSingle();

      if (queryError) {
        console.error("caregiver-settings GET failed", queryError);
        return error("Failed to load settings", "SETTINGS_FETCH_FAILED", 500);
      }

      if (!link) {
        // Return defaults with linked=false; no 404 — client can proceed to PUT to register
        return success({
          linked: false,
          notify_escalations: true,
          notify_daily_summary: true,
        });
      }

      return success({ linked: true, ...link });
    }

    if (req.method === "PUT") {
      const body = await req.json().catch(() => null);
      if (!body || typeof body !== "object") {
        return error("Request body must be JSON", "INVALID_BODY", 400);
      }

      const { senior_id, notify_escalations, notify_daily_summary } = body as Record<string, unknown>;

      if (!senior_id || typeof senior_id !== "string" || !UUID_REGEX.test(senior_id)) {
        return error("senior_id must be a valid UUID", "INVALID_SENIOR_ID", 400);
      }

      // At least one boolean preference required
      const hasEscalations = notify_escalations !== undefined;
      const hasSummary = notify_daily_summary !== undefined;
      if (!hasEscalations && !hasSummary) {
        return error(
          "Provide at least one of: notify_escalations, notify_daily_summary",
          "INVALID_BODY",
          400,
        );
      }
      if (hasEscalations && typeof notify_escalations !== "boolean") {
        return error("notify_escalations must be a boolean", "INVALID_BODY", 400);
      }
      if (hasSummary && typeof notify_daily_summary !== "boolean") {
        return error("notify_daily_summary must be a boolean", "INVALID_BODY", 400);
      }

      // Validate senior exists before upserting — prevents FK violation turning into a
      // confusing 500 when the senior_user_id FK constraint on caregiver_links rejects the row.
      const { data: seniorRow, error: seniorError } = await supabaseAdmin
        .from("users")
        .select("id")
        .eq("id", senior_id)
        .maybeSingle();

      if (seniorError) {
        console.error("caregiver-settings senior lookup failed", seniorError);
        return error("Failed to validate senior", "SENIOR_FETCH_FAILED", 500);
      }
      if (!seniorRow) {
        return error("Senior not found", "SENIOR_NOT_FOUND", 404);
      }

      // TODO Phase 3: verify caregiver_links WHERE caregiver_user_id=caregiverId AND senior_user_id=senior_id

      const upsertData: {
        caregiver_user_id: string;
        senior_user_id: string;
        notify_escalations?: boolean;
        notify_daily_summary?: boolean;
      } = {
        caregiver_user_id: caregiverId,
        senior_user_id: senior_id,
      };
      if (hasEscalations) upsertData.notify_escalations = notify_escalations as boolean;
      if (hasSummary) upsertData.notify_daily_summary = notify_daily_summary as boolean;

      const { data: updated, error: upsertError } = await supabaseAdmin
        .from("caregiver_links")
        .upsert(upsertData, { onConflict: "caregiver_user_id,senior_user_id" })
        .select(LINK_SELECT)
        .single();

      if (upsertError) {
        console.error("caregiver-settings PUT failed", upsertError);
        return error("Failed to update settings", "SETTINGS_UPDATE_FAILED", 500);
      }

      return success({ linked: true, ...updated });
    }

    return error("Method not allowed", "METHOD_NOT_ALLOWED", 405);
  } catch (err) {
    console.error("caregiver-settings unhandled error", err);
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
