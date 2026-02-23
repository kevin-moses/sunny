import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { corsHeaders, error, getUserId, success } from "../_shared/response.ts";
import { supabaseAdmin } from "../_shared/supabase.ts";

function parsePositiveInt(value: string | null, fallback: number): number {
  if (value === null) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed) || parsed < 0) return fallback;
  return parsed;
}

function durationMinutes(startedAt: string, endedAt: string | null): number | null {
  if (!endedAt) return null;
  const startMs = new Date(startedAt).getTime();
  const endMs = new Date(endedAt).getTime();

  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) {
    return null;
  }

  return Math.round((endMs - startMs) / 60000);
}

serve(async (req: Request) => {
  const started = Date.now();
  const userId = getUserId(req);
  const url = new URL(req.url);

  try {
    if (req.method === "OPTIONS") {
      return new Response("ok", { headers: corsHeaders() });
    }

    if (req.method !== "GET") {
      return error("Method not allowed", "METHOD_NOT_ALLOWED", 400);
    }

    const limit = parsePositiveInt(url.searchParams.get("limit"), 20);
    const offset = parsePositiveInt(url.searchParams.get("offset"), 0);

    const { data, error: queryError, count } = await supabaseAdmin
      .from("conversations")
      .select("id,user_id,started_at,ended_at,summary,sentiment,topics,status", { count: "exact" })
      .eq("user_id", userId)
      .order("started_at", { ascending: false })
      .range(offset, offset + Math.max(limit, 1) - 1);

    if (queryError) {
      console.error("get-conversations query failed", queryError);
      return error("Failed to load conversations", "CONVERSATIONS_FETCH_FAILED", 500);
    }

    const conversations = (data ?? []).map((conversation) => ({
      ...conversation,
      duration_minutes: durationMinutes(conversation.started_at, conversation.ended_at),
    }));

    return success({
      conversations,
      total: count ?? conversations.length,
    });
  } catch (err) {
    console.error("get-conversations unhandled error", err);
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
