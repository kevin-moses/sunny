// caregiver-dashboard/index.ts
// Purpose: Critical-path GET endpoint called on every caregiver app open.
// Returns a structured snapshot of a senior's today activity and 7-day week summary:
//   - senior: name, last_active
//   - today: adherence rows, conversation rows, derived alerts
//   - week: adherence_rate (0-100 integer), conversation_count, avg_session_minutes, flagged_concerns
//
// Three parallel DB queries are issued (users, conversations+session_summaries,
// adherence_log+reminders) and all aggregation is performed in JS.
//
// Auth: MVP bearer UUID / fallback TEST_USER_ID. Phase 3 will verify caregiver_links.
//
// Last modified: 2026-02-26

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { corsHeaders, error, getUserId, success, UUID_REGEX } from "../_shared/response.ts";
import { supabaseAdmin } from "../_shared/supabase.ts";

type Alert = { type: string; message: string; timestamp: string };

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
 * Handles GET /caregiver-dashboard requests.
 * Fetches senior profile, 7-day conversations (with session_summaries), and 7-day adherence log
 * in parallel, then assembles today partitions, derived alerts, and week aggregates.
 * @param req - incoming Deno Request with ?senior_id=uuid query param
 * @returns Response containing senior, today, and week sections or an error response
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

    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

    const [userResult, conversationResult, adherenceResult] = await Promise.all([
      // 1. Senior's name
      supabaseAdmin
        .from("users")
        .select("name")
        .eq("id", seniorId)
        .maybeSingle(),

      // 2. Conversations (7 days) with session summaries as array
      supabaseAdmin
        .from("conversations")
        .select("id,started_at,ended_at,session_summaries(summary,flagged_concerns)")
        .eq("user_id", seniorId)
        .gte("started_at", sevenDaysAgo)
        .order("started_at", { ascending: false }),

      // 3. Adherence log (7 days) with reminder title as single object
      supabaseAdmin
        .from("adherence_log")
        .select("id,scheduled_time,status,confirmed_at,notes,reminders(title)")
        .eq("user_id", seniorId)
        .gte("scheduled_time", sevenDaysAgo)
        .order("scheduled_time", { ascending: false }),
    ]);

    if (userResult.error) {
      console.error("caregiver-dashboard user query failed", userResult.error);
      return error("Failed to load senior profile", "USER_FETCH_FAILED", 500);
    }
    if (!userResult.data) {
      return error("Senior not found", "SENIOR_NOT_FOUND", 404);
    }
    if (conversationResult.error) {
      console.error("caregiver-dashboard conversations query failed", conversationResult.error);
      return error("Failed to load conversations", "CONVERSATIONS_FETCH_FAILED", 500);
    }
    if (adherenceResult.error) {
      console.error("caregiver-dashboard adherence query failed", adherenceResult.error);
      return error("Failed to load adherence log", "ADHERENCE_FETCH_FAILED", 500);
    }

    const userRow = userResult.data;
    const convRows = conversationResult.data ?? [];
    const adherenceRows = adherenceResult.data ?? [];

    // TODO Phase 3: Use the senior's timezone (from users.timezone) instead of UTC midnight
    // so that "today" aligns with the senior's local date rather than the server's UTC date.
    const todayStart = new Date();
    todayStart.setUTCHours(0, 0, 0, 0);
    const todayMs = todayStart.getTime();

    // Normalize session_summaries (returned as array by Supabase FK join)
    const conversations = convRows.map((c) => {
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

    // Normalize reminders (returned as single object by FK join from adherence_log)
    const adherence = adherenceRows.map((a) => {
      const reminder = Array.isArray(a.reminders) ? (a.reminders[0] ?? null) : (a.reminders ?? null);
      return {
        id: a.id,
        scheduled_time: a.scheduled_time,
        status: a.status,
        confirmed_at: a.confirmed_at,
        notes: a.notes,
        reminder_title: reminder?.title ?? null,
      };
    });

    // Today partitions
    const todayAdherence = adherence.filter(
      (a) => new Date(a.scheduled_time).getTime() >= todayMs,
    );
    const todayConversations = conversations.filter(
      (c) => new Date(c.started_at).getTime() >= todayMs,
    );

    // Derived alerts: escalated adherence + flagged_concerns from today's summaries
    const alerts: Alert[] = [];

    for (const a of todayAdherence) {
      if (a.status === "escalated") {
        alerts.push({
          type: "escalation",
          message: a.reminder_title ? `Escalation: ${a.reminder_title}` : "Medication escalation",
          timestamp: a.scheduled_time,
        });
      }
    }

    for (const c of todayConversations) {
      const concerns: string[] = Array.isArray(c.flagged_concerns) ? c.flagged_concerns : [];
      for (const concern of concerns) {
        alerts.push({
          type: "concern",
          message: concern,
          timestamp: c.started_at,
        });
      }
    }

    alerts.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

    // Week aggregation — adherence_rate is an integer in range [0, 100]
    const adherenceStatuses = ["confirmed", "missed", "skipped", "escalated"];
    const denominator = adherence.filter((a) => adherenceStatuses.includes(a.status)).length;
    const confirmed = adherence.filter((a) => a.status === "confirmed").length;
    const adherenceRate = denominator === 0 ? 0 : Math.round((confirmed / denominator) * 100);

    const completedConversations = conversations.filter((c) => c.ended_at !== null);
    const durations = completedConversations
      .map((c) => c.duration_minutes)
      .filter((d): d is number => d !== null);
    const avgSessionMinutes =
      durations.length === 0
        ? null
        : Math.round(durations.reduce((sum, d) => sum + d, 0) / durations.length);

    const allConcerns: string[] = [];
    for (const c of conversations) {
      if (Array.isArray(c.flagged_concerns)) {
        allConcerns.push(...c.flagged_concerns);
      }
    }

    return success({
      senior: {
        id: seniorId,
        name: userRow.name ?? "",
        last_active: conversations[0]?.started_at ?? null,
      },
      today: {
        adherence: todayAdherence,
        conversations: todayConversations,
        alerts,
      },
      week: {
        adherence_rate: adherenceRate,
        conversation_count: completedConversations.length,
        avg_session_minutes: avgSessionMinutes,
        flagged_concerns: [...new Set(allConcerns)],
      },
    });
  } catch (err) {
    console.error("caregiver-dashboard unhandled error", err);
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
