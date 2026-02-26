// caregiver-conversations/index.ts
// Purpose: Returns a paginated list of a senior's conversation sessions for a caregiver view.
// Includes computed duration_minutes and the first session_summary (summary + flagged_concerns).
// Query params:
//   senior_id (required UUID)
//   days      (1-90, default 30)
//   limit     (1-100, default 20)
//   offset    (>= 0, default 0)
//
// Auth: MVP bearer UUID / fallback TEST_USER_ID. Phase 3 will verify caregiver_links.
//
// Last modified: 2026-02-26

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { corsHeaders, error, getUserId, success, UUID_REGEX } from "../_shared/response.ts";
import { supabaseAdmin } from "../_shared/supabase.ts";

/**
 * Parses a query param string as a positive integer (>= 1).
 * @param value - raw string from URL search params, or null
 * @param fallback - returned when value is absent or invalid
 * @returns parsed integer or fallback
 */
function parsePositiveInt(value: string | null, fallback: number): number {
  if (value === null) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed) || parsed < 1) return fallback;
  return parsed;
}

/**
 * Parses a query param string as a non-negative integer (>= 0).
 * @param value - raw string from URL search params, or null
 * @param fallback - returned when value is absent or invalid
 * @returns parsed integer or fallback
 */
function parseNonNegativeInt(value: string | null, fallback: number): number {
  if (value === null) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed) || parsed < 0) return fallback;
  return parsed;
}

/**
 * Computes conversation duration in whole minutes.
 * @param startedAt - ISO timestamp string for session start
 * @param endedAt   - ISO timestamp string for session end, or null if in progress
 * @returns duration in minutes, or null if session is incomplete or timestamps are invalid
 */
function durationMinutes(startedAt: string, endedAt: string | null): number | null {
  if (!endedAt) return null;
  const startMs = new Date(startedAt).getTime();
  const endMs = new Date(endedAt).getTime();
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) return null;
  return Math.round((endMs - startMs) / 60000);
}

/**
 * Handles GET /caregiver-conversations requests.
 * Returns a paginated list of a senior's conversations with computed duration and session summary.
 * @param req - incoming Deno Request with ?senior_id, ?days, ?limit, ?offset query params
 * @returns Response containing conversations array and total count, or an error response
 */
serve(async (req: Request) => {
  const started = Date.now();
  const caregiverId = getUserId(req);
  const url = new URL(req.url);

  try {
    if (req.method === "OPTIONS") {
      return new Response("ok", { headers: corsHeaders() });
    }

    if (req.method !== "GET") {
      return error("Method not allowed", "METHOD_NOT_ALLOWED", 405);
    }

    const seniorId = url.searchParams.get("senior_id");
    if (!seniorId || !UUID_REGEX.test(seniorId)) {
      return error("senior_id must be a valid UUID", "INVALID_SENIOR_ID", 400);
    }

    // TODO Phase 3: verify caregiver_links WHERE caregiver_user_id=caregiverId AND senior_user_id=seniorId

    const days = Math.min(parsePositiveInt(url.searchParams.get("days"), 30), 90);
    const limit = Math.min(parsePositiveInt(url.searchParams.get("limit"), 20), 100);
    const offset = parseNonNegativeInt(url.searchParams.get("offset"), 0);

    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

    const { data, error: queryError, count } = await supabaseAdmin
      .from("conversations")
      .select("id,started_at,ended_at,session_summaries(summary,flagged_concerns)", { count: "exact" })
      .eq("user_id", seniorId)
      .gte("started_at", since)
      .order("started_at", { ascending: false })
      .range(offset, offset + limit - 1);

    if (queryError) {
      console.error("caregiver-conversations query failed", queryError);
      return error("Failed to load conversations", "CONVERSATIONS_FETCH_FAILED", 500);
    }

    const conversations = (data ?? []).map((c) => {
      const ss = Array.isArray(c.session_summaries) ? c.session_summaries : [];
      const summary = ss[0] ?? null;
      return {
        id: c.id,
        started_at: c.started_at,
        ended_at: c.ended_at,
        duration_minutes: durationMinutes(c.started_at, c.ended_at),
        summary: summary?.summary ?? null,
        flagged_concerns: summary?.flagged_concerns ?? null,
      };
    });

    return success({ conversations, total: count ?? conversations.length });
  } catch (err) {
    console.error("caregiver-conversations unhandled error", err);
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
