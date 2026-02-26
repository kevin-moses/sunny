// session-start/index.ts
// Purpose: Agent callback Edge Function that opens a new conversation session.
// Called by the Python agent (sunny_agent) at the start of each user interaction.
// Accepts service-role-key auth — NOT called directly by the iOS app.
//
// POST body: { user_id, trigger, reminder_id?, adherence_log_id? }
// Response:  { conversation_id, reminder_context: { type, title, description } | null }
//
// Last modified: 2026-02-26

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { corsHeaders, error, success, UUID_REGEX } from "../_shared/response.ts";
import { supabaseAdmin } from "../_shared/supabase.ts";

const VALID_TRIGGERS = new Set(["app_open", "notification_tap", "watch_tap"]);

type SessionStartBody = {
  user_id: string;
  trigger: string;
  reminder_id?: string;
  adherence_log_id?: string;
};

type ReminderContext = {
  type: string;
  title: string;
  description: string | null;
} | null;

/**
 * Validates the POST body for session-start.
 * @param body - raw parsed JSON from request
 * @returns true if body matches SessionStartBody shape
 */
function validateSessionStartBody(body: unknown): body is SessionStartBody {
  if (!body || typeof body !== "object") return false;
  const b = body as Partial<SessionStartBody>;

  if (!b.user_id || !UUID_REGEX.test(b.user_id)) return false;
  if (!b.trigger || !VALID_TRIGGERS.has(b.trigger)) return false;
  if (b.reminder_id !== undefined && !UUID_REGEX.test(b.reminder_id)) return false;
  if (b.adherence_log_id !== undefined && !UUID_REGEX.test(b.adherence_log_id)) return false;

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
    if (!validateSessionStartBody(body)) {
      return error(
        "Invalid body. Expected { user_id: uuid, trigger: 'app_open'|'notification_tap'|'watch_tap', reminder_id?: uuid, adherence_log_id?: uuid }",
        "INVALID_BODY",
        400,
      );
    }

    const { user_id, trigger, reminder_id, adherence_log_id } = body;

    // 1. Create conversation row
    const { data: conversation, error: insertError } = await supabaseAdmin
      .from("conversations")
      .insert({
        user_id,
        status: "active",
        trigger,
        reminder_id: reminder_id ?? null,
        adherence_log_id: adherence_log_id ?? null,
      })
      .select("id")
      .single();

    if (insertError || !conversation) {
      console.error("session-start conversation insert failed", insertError);
      return error("Failed to create conversation", "CONVERSATION_CREATE_FAILED", 500);
    }

    const conversation_id = conversation.id;
    if (!conversation_id) {
      console.error("session-start conversation insert returned no id");
      return error("Failed to create conversation", "CONVERSATION_CREATE_FAILED", 500);
    }

    // 2. Optionally fetch reminder context
    let reminder_context: ReminderContext = null;
    if (reminder_id) {
      const { data: reminderRow, error: reminderError } = await supabaseAdmin
        .from("reminders")
        .select("type,title,description")
        .eq("id", reminder_id)
        .maybeSingle();

      if (reminderError) {
        // Non-fatal: conversation is already created; warn and continue
        console.warn("session-start reminder fetch failed", reminderError);
      } else if (reminderRow) {
        reminder_context = {
          type: reminderRow.type as string,
          title: reminderRow.title as string,
          description: (reminderRow.description as string | null) ?? null,
        };
      }
      // reminderRow === null means reminder was deleted — reminder_context stays null
    }

    return success({ conversation_id, reminder_context }, 201);
  } catch (err) {
    console.error("session-start unhandled error", err);
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
