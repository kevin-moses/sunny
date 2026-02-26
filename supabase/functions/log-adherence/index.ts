// log-adherence/index.ts
// Purpose: Agent callback Edge Function that records a medication adherence outcome.
// Called by the Python agent (sunny_agent) after the user responds to a reminder.
// Accepts service-role-key auth — NOT called directly by the iOS app.
//
// POST body: { adherence_log_id, status: 'confirmed'|'skipped'|'missed', notes? }
// Response:  { updated: true }
//
// NOTE: 'escalated' is a valid DB status but is NOT accepted here. Only the
// escalation scheduler sets that value. Accepting it here would bypass escalation logic.
//
// Last modified: 2026-02-26

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { corsHeaders, error, success, UUID_REGEX } from "../_shared/response.ts";
import { supabaseAdmin } from "../_shared/supabase.ts";

// 'escalated' intentionally excluded — set only by escalation scheduler
const VALID_STATUSES = new Set(["confirmed", "skipped", "missed"]);

type LogAdherenceBody = {
  adherence_log_id: string;
  status: string;
  notes?: string;
};

/**
 * Validates the POST body for log-adherence.
 * @param body - raw parsed JSON from request
 * @returns true if body matches LogAdherenceBody shape
 */
function validateLogAdherenceBody(body: unknown): body is LogAdherenceBody {
  if (!body || typeof body !== "object") return false;
  const b = body as Partial<LogAdherenceBody>;

  if (!b.adherence_log_id || !UUID_REGEX.test(b.adherence_log_id)) return false;
  if (!b.status || !VALID_STATUSES.has(b.status)) return false;
  if (b.notes !== undefined && typeof b.notes !== "string") return false;

  return true;
}

serve(async (req: Request) => {
  const started = Date.now();
  const url = new URL(req.url);

  try {
    if (req.method === "OPTIONS") {
      return new Response("ok", { headers: corsHeaders() });
    }

    // Service-role-key auth — must match exactly
    const authHeader = req.headers.get("Authorization") ?? "";
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
    if (!authHeader || authHeader !== `Bearer ${serviceKey}`) {
      return error("Unauthorized", "UNAUTHORIZED", 401);
    }

    if (req.method !== "POST") {
      return error("Method not allowed", "METHOD_NOT_ALLOWED", 405);
    }

    const body = await req.json().catch(() => null);
    if (!validateLogAdherenceBody(body)) {
      return error(
        "Invalid body. Expected { adherence_log_id: uuid, status: 'confirmed'|'skipped'|'missed', notes?: string }",
        "INVALID_BODY",
        400,
      );
    }

    const { adherence_log_id, status, notes } = body;

    // 1. Verify row exists before updating — prevents silent no-op on typo'd ID
    const { data: existingRow, error: fetchError } = await supabaseAdmin
      .from("adherence_log")
      .select("id")
      .eq("id", adherence_log_id)
      .maybeSingle();

    if (fetchError) {
      console.error("log-adherence row fetch failed", fetchError);
      return error("Failed to fetch adherence log", "ADHERENCE_FETCH_FAILED", 500);
    }
    if (!existingRow) {
      return error("Adherence log not found", "ADHERENCE_LOG_NOT_FOUND", 404);
    }

    // 2. Build update payload — add confirmed_at only when confirming
    const updatePayload: Record<string, unknown> = {
      status,
      notes: notes ?? null,
    };
    if (status === "confirmed") {
      updatePayload.confirmed_at = new Date().toISOString();
    }

    const { error: updateError } = await supabaseAdmin
      .from("adherence_log")
      .update(updatePayload)
      .eq("id", adherence_log_id);

    if (updateError) {
      console.error("log-adherence update failed", updateError);
      return error("Failed to update adherence log", "ADHERENCE_UPDATE_FAILED", 500);
    }

    return success({ updated: true });
  } catch (err) {
    console.error("log-adherence unhandled error", err);
    return error("Internal server error", "INTERNAL_ERROR", 500);
  } finally {
    console.log(
      JSON.stringify({
        method: req.method,
        path: url.pathname,
        duration: Date.now() - started,
      }),
    );
  }
});
