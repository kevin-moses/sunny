import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { corsHeaders, error, getUserId, success } from "../_shared/response.ts";
import { supabaseAdmin } from "../_shared/supabase.ts";

const VALID_TYPES = new Set([
  "medication",
  "appointment",
  "exercise",
  "wellness_checkin",
  "custom",
]);

const VALID_DAYS = new Set(["sun", "mon", "tue", "wed", "thu", "fri", "sat"]);
const TIME_REGEX = /^([01]\d|2[0-3]):[0-5]\d$/;
const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type ReminderInput = {
  type: string;
  title: string;
  description?: string;
  schedule: {
    times: string[];
    days: string[];
  };
};

function validateReminderPayload(payload: unknown): payload is ReminderInput {
  if (!payload || typeof payload !== "object") return false;

  const candidate = payload as Partial<ReminderInput>;
  if (!candidate.type || !VALID_TYPES.has(candidate.type)) return false;
  if (!candidate.title || typeof candidate.title !== "string") return false;

  if (!candidate.schedule || typeof candidate.schedule !== "object") return false;
  const { times, days } = candidate.schedule;

  if (!Array.isArray(times) || times.length === 0 || times.some((t) => typeof t !== "string" || !TIME_REGEX.test(t))) {
    return false;
  }

  if (!Array.isArray(days) || days.length === 0 || days.some((d) => typeof d !== "string" || !VALID_DAYS.has(d.toLowerCase()))) {
    return false;
  }

  return true;
}

serve(async (req: Request) => {
  const started = Date.now();
  const userId = getUserId(req);
  const url = new URL(req.url);

  try {
    if (req.method === "OPTIONS") {
      return new Response("ok", { headers: corsHeaders() });
    }

    if (req.method === "GET") {
      const { data, error: queryError } = await supabaseAdmin
        .from("reminders")
        .select("id,user_id,type,title,description,schedule,timezone,active,last_triggered,created_at")
        .eq("user_id", userId)
        .eq("active", true)
        .order("created_at", { ascending: true });

      if (queryError) {
        console.error("manage-reminders GET failed", queryError);
        return error("Failed to load reminders", "REMINDERS_FETCH_FAILED", 500);
      }

      return success({ reminders: data ?? [] });
    }

    if (req.method === "POST") {
      const body = await req.json().catch(() => null);
      if (!validateReminderPayload(body)) {
        return error(
          "Invalid body. Expected { type, title, description?, schedule: { times: ['HH:MM'], days: ['mon'..'sun'] } }",
          "INVALID_BODY",
          400,
        );
      }

      const { data: userRow, error: userError } = await supabaseAdmin
        .from("users")
        .select("timezone")
        .eq("id", userId)
        .maybeSingle();

      if (userError) {
        console.error("manage-reminders user lookup failed", userError);
        return error("Failed to load user timezone", "USER_FETCH_FAILED", 500);
      }

      if (!userRow) {
        return error("User not found", "USER_NOT_FOUND", 404);
      }

      const normalizedSchedule = {
        times: body.schedule.times,
        days: body.schedule.days.map((d) => d.toLowerCase()),
      };

      const { data: inserted, error: insertError } = await supabaseAdmin
        .from("reminders")
        .insert({
          user_id: userId,
          type: body.type,
          title: body.title,
          description: body.description ?? null,
          schedule: normalizedSchedule,
          timezone: userRow.timezone,
          active: true,
        })
        .select("id,user_id,type,title,description,schedule,timezone,active,last_triggered,created_at")
        .single();

      if (insertError) {
        console.error("manage-reminders POST failed", insertError);
        return error("Failed to create reminder", "REMINDER_CREATE_FAILED", 500);
      }

      return success({ reminder: inserted }, 201);
    }

    if (req.method === "DELETE") {
      const reminderId = url.searchParams.get("reminder_id");
      if (!reminderId || !UUID_REGEX.test(reminderId)) {
        return error("reminder_id must be a valid UUID", "INVALID_REMINDER_ID", 400);
      }

      const { data: ownedReminder, error: ownershipError } = await supabaseAdmin
        .from("reminders")
        .select("id")
        .eq("id", reminderId)
        .eq("user_id", userId)
        .maybeSingle();

      if (ownershipError) {
        console.error("manage-reminders ownership check failed", ownershipError);
        return error("Failed to validate reminder", "REMINDER_VALIDATE_FAILED", 500);
      }

      if (!ownedReminder) {
        return error("Reminder not found", "REMINDER_NOT_FOUND", 404);
      }

      const { error: updateError } = await supabaseAdmin
        .from("reminders")
        .update({ active: false })
        .eq("id", reminderId)
        .eq("user_id", userId);

      if (updateError) {
        console.error("manage-reminders DELETE failed", updateError);
        return error("Failed to delete reminder", "REMINDER_DELETE_FAILED", 500);
      }

      return success({ deleted: true });
    }

    return error("Method not allowed", "METHOD_NOT_ALLOWED", 400);
  } catch (err) {
    console.error("manage-reminders unhandled error", err);
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
