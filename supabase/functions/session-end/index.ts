// session-end/index.ts
// Purpose: Agent callback Edge Function that closes a conversation session.
// Called by the Python agent (sunny_agent) at the end of each user interaction.
// Accepts service-role-key auth — NOT called directly by the iOS app.
//
// POST body: { conversation_id, summary, sentiment?, topics?, extracted_facts?,
//              flagged_concerns?, wellness_data? }
// Response:  { session_id }
//
// extracted_facts failures are warn-only — facts are preserved in
// session_summaries.extracted_facts for replay even if upsert_user_fact RPCs fail.
//
// Last modified: 2026-02-26

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { corsHeaders, error, success, UUID_REGEX } from "../_shared/response.ts";
import { supabaseAdmin } from "../_shared/supabase.ts";

const VALID_FACT_CATEGORIES = new Set([
  "medication",
  "health",
  "preference",
  "personal",
  "device",
]);

type ExtractedFact = {
  category: string;
  key: string;
  value: string;
};

// Minimum required fields validated at runtime; additional keys pass through
// since the DB column is jsonb and the agent may extend this shape over time.
type WellnessData = {
  mood_score: number;
  topics_discussed: string[];
  [key: string]: unknown;
};

type SessionEndBody = {
  conversation_id: string;
  summary: string;
  sentiment?: string;
  topics?: string[];
  extracted_facts?: ExtractedFact[];
  flagged_concerns?: string[];
  wellness_data?: WellnessData;
};

/**
 * Validates a single extracted fact entry.
 * @param f - candidate fact object
 * @returns true if f has valid category, key, and value
 */
function isValidFact(f: unknown): f is ExtractedFact {
  if (!f || typeof f !== "object") return false;
  const candidate = f as Partial<ExtractedFact>;
  return (
    typeof candidate.category === "string" &&
    VALID_FACT_CATEGORIES.has(candidate.category) &&
    typeof candidate.key === "string" &&
    candidate.key.length > 0 &&
    typeof candidate.value === "string"
  );
}

/**
 * Validates the POST body for session-end.
 * @param body - raw parsed JSON from request
 * @returns true if body matches SessionEndBody shape
 */
function validateSessionEndBody(body: unknown): body is SessionEndBody {
  if (!body || typeof body !== "object") return false;
  const b = body as Partial<SessionEndBody>;

  if (!b.conversation_id || !UUID_REGEX.test(b.conversation_id)) return false;
  if (!b.summary || typeof b.summary !== "string" || b.summary.trim().length === 0) return false;

  if (b.topics !== undefined) {
    if (!Array.isArray(b.topics) || b.topics.some((t) => typeof t !== "string")) return false;
  }

  if (b.extracted_facts !== undefined) {
    if (!Array.isArray(b.extracted_facts) || b.extracted_facts.some((f) => !isValidFact(f))) {
      return false;
    }
  }

  if (b.flagged_concerns !== undefined) {
    if (!Array.isArray(b.flagged_concerns) || b.flagged_concerns.some((c) => typeof c !== "string")) {
      return false;
    }
  }

  if (b.wellness_data !== undefined) {
    const wd = b.wellness_data;
    if (
      !wd ||
      typeof wd !== "object" ||
      typeof wd.mood_score !== "number" ||
      !Array.isArray(wd.topics_discussed)
    ) {
      return false;
    }
  }

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
    if (!validateSessionEndBody(body)) {
      return error(
        "Invalid body. Expected { conversation_id: uuid, summary: string, sentiment?: string, topics?: string[], extracted_facts?: [{category, key, value}], flagged_concerns?: string[], wellness_data?: { mood_score: number, topics_discussed: string[] } }",
        "INVALID_BODY",
        400,
      );
    }

    const {
      conversation_id,
      summary,
      sentiment,
      topics,
      extracted_facts,
      flagged_concerns,
      wellness_data,
    } = body;

    // 1. Fetch conversation to get user_id
    const { data: conversation, error: fetchError } = await supabaseAdmin
      .from("conversations")
      .select("id,user_id")
      .eq("id", conversation_id)
      .maybeSingle();

    if (fetchError) {
      console.error("session-end conversation fetch failed", fetchError);
      return error("Failed to fetch conversation", "CONVERSATION_FETCH_FAILED", 500);
    }
    if (!conversation) {
      return error("Conversation not found", "CONVERSATION_NOT_FOUND", 404);
    }

    const user_id = conversation.user_id;
    if (!user_id) {
      console.error("session-end conversation has no user_id", conversation_id);
      return error("Conversation has no associated user", "INTERNAL_ERROR", 500);
    }

    // 2. Close the conversation
    const { error: updateError } = await supabaseAdmin
      .from("conversations")
      .update({
        ended_at: new Date().toISOString(),
        status: "completed",
        summary,
        sentiment: sentiment ?? null,
        topics: topics ?? null,
      })
      .eq("id", conversation_id);

    if (updateError) {
      console.error("session-end conversation update failed", updateError);
      return error("Failed to update conversation", "CONVERSATION_UPDATE_FAILED", 500);
    }

    // 3. Upsert session_summaries
    const { data: sessionSummary, error: summaryError } = await supabaseAdmin
      .from("session_summaries")
      .upsert(
        {
          conversation_id,
          summary,
          extracted_facts: extracted_facts ?? null,
          flagged_concerns: flagged_concerns ?? null,
          wellness_data: wellness_data ?? null,
        },
        { onConflict: "conversation_id" },
      )
      .select("id")
      .single();

    if (summaryError || !sessionSummary) {
      console.error("session-end session_summaries upsert failed", summaryError);
      return error("Failed to upsert session summary", "SESSION_SUMMARY_UPSERT_FAILED", 500);
    }

    // 4. Fire upsert_user_fact RPCs — warn-only on failure
    if (extracted_facts && extracted_facts.length > 0) {
      const factResults = await Promise.allSettled(
        extracted_facts.map((f) =>
          supabaseAdmin.rpc("upsert_user_fact", {
            p_user_id: user_id,
            p_category: f.category,
            p_key: f.key,
            p_value: f.value,
            p_conversation_id: conversation_id,
          })
        ),
      );

      const failedFacts = factResults.filter((r) => r.status === "rejected");
      if (failedFacts.length > 0) {
        console.warn(
          `session-end upsert_user_fact partial failure: ${failedFacts.length}/${extracted_facts.length} facts failed. ` +
          "Facts are preserved in session_summaries.extracted_facts for replay.",
          failedFacts,
        );
      }
    }

    return success({ session_id: sessionSummary.id as string });
  } catch (err) {
    console.error("session-end unhandled error", err);
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
