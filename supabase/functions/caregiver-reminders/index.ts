// caregiver-reminders/index.ts
// Purpose: CRUD Edge Function for managing a senior's reminders from a caregiver's perspective.
// All operations scope reminders to the senior_user_id (not the caregiver).
//
// GET    ?senior_id                         — list active reminders for the senior
// POST   ?senior_id                         — create a new reminder for the senior
// PUT    ?senior_id&reminder_id             — partially update a reminder owned by the senior
// DELETE ?senior_id&reminder_id             — soft-delete a reminder owned by the senior
//
// Ownership check: reminder.user_id must equal seniorId before any mutation.
// Auth: MVP bearer UUID / fallback TEST_USER_ID. Phase 3 will verify caregiver_links.
//
// Last modified: 2026-02-26

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { corsHeaders, error, getUserId, success, UUID_REGEX } from "../_shared/response.ts";
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

type ReminderInput = {
  type: string;
  title: string;
  description?: string;
  schedule: {
    times: string[];
    days: string[];
  };
};

type ReminderUpdate = {
  type?: string;
  title?: string;
  description?: string;
  schedule?: {
    times: string[];
    days: string[];
  };
};

/**
 * Validates a full reminder creation payload.
 * @param payload - raw parsed JSON from request body
 * @returns true if payload conforms to ReminderInput shape
 */
function validateReminderPayload(payload: unknown): payload is ReminderInput {
  if (!payload || typeof payload !== "object") return false;
  const c = payload as Partial<ReminderInput>;
  if (!c.type || !VALID_TYPES.has(c.type)) return false;
  if (!c.title || typeof c.title !== "string") return false;
  if (!c.schedule || typeof c.schedule !== "object") return false;
  const { times, days } = c.schedule;
  if (!Array.isArray(times) || times.length === 0 || times.some((t) => typeof t !== "string" || !TIME_REGEX.test(t))) {
    return false;
  }
  if (!Array.isArray(days) || days.length === 0 || days.some((d) => typeof d !== "string" || !VALID_DAYS.has(d.toLowerCase()))) {
    return false;
  }
  return true;
}

/**
 * Validates and extracts a partial update object from a PUT request body.
 * At least one valid field must be present.
 * @param payload - raw parsed JSON from request body
 * @returns partial update object, or null if payload is invalid or empty
 */
function validateUpdatePayload(payload: unknown): Partial<ReminderUpdate> | null {
  if (!payload || typeof payload !== "object") return null;
  const c = payload as Record<string, unknown>;
  const update: Partial<ReminderUpdate> = {};

  if (c.type !== undefined) {
    if (typeof c.type !== "string" || !VALID_TYPES.has(c.type)) return null;
    update.type = c.type;
  }
  if (c.title !== undefined) {
    if (typeof c.title !== "string" || c.title.trim() === "") return null;
    update.title = c.title;
  }
  if (c.description !== undefined) {
    if (typeof c.description !== "string") return null;
    update.description = c.description;
  }
  if (c.schedule !== undefined) {
    if (!c.schedule || typeof c.schedule !== "object") return null;
    const s = c.schedule as Record<string, unknown>;
    const { times, days } = s;
    if (!Array.isArray(times) || times.length === 0 || times.some((t) => typeof t !== "string" || !TIME_REGEX.test(t))) {
      return null;
    }
    if (!Array.isArray(days) || days.length === 0 || days.some((d) => typeof d !== "string" || !VALID_DAYS.has(d.toLowerCase()))) {
      return null;
    }
    update.schedule = {
      times,
      days: days.map((d) => d.toLowerCase()),
    };
  }

  if (Object.keys(update).length === 0) return null;
  return update;
}

const REMINDER_SELECT =
  "id,user_id,type,title,description,schedule,timezone,active,last_triggered,created_at";

/**
 * Handles GET/POST/PUT/DELETE /caregiver-reminders requests.
 * All operations are scoped to the senior identified by the ?senior_id query param.
 * GET    — lists active reminders for the senior.
 * POST   — creates a new reminder owned by the senior.
 * PUT    — partially updates a reminder, verifying ownership against seniorId first.
 * DELETE — soft-deletes a reminder (sets active=false), verifying ownership first.
 * @param req - incoming Deno Request
 * @returns Response with reminder data or an error response
 */
serve(async (req: Request) => {
  const started = Date.now();
  const caregiverId = getUserId(req);
  const url = new URL(req.url);

  try {
    if (req.method === "OPTIONS") {
      return new Response("ok", { headers: corsHeaders() });
    }

    const seniorId = url.searchParams.get("senior_id");
    if (!seniorId || !UUID_REGEX.test(seniorId)) {
      return error("senior_id must be a valid UUID", "INVALID_SENIOR_ID", 400);
    }

    // TODO Phase 3: verify caregiver_links WHERE caregiver_user_id=caregiverId AND senior_user_id=seniorId

    if (req.method === "GET") {
      const { data, error: queryError } = await supabaseAdmin
        .from("reminders")
        .select(REMINDER_SELECT)
        .eq("user_id", seniorId)
        .eq("active", true)
        .order("created_at", { ascending: true });

      if (queryError) {
        console.error("caregiver-reminders GET failed", queryError);
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
        .eq("id", seniorId)
        .maybeSingle();

      if (userError) {
        console.error("caregiver-reminders senior lookup failed", userError);
        return error("Failed to load senior timezone", "USER_FETCH_FAILED", 500);
      }
      if (!userRow) {
        return error("Senior not found", "SENIOR_NOT_FOUND", 404);
      }

      const normalizedSchedule = {
        times: body.schedule.times,
        days: body.schedule.days.map((d) => d.toLowerCase()),
      };

      const { data: inserted, error: insertError } = await supabaseAdmin
        .from("reminders")
        .insert({
          user_id: seniorId,
          type: body.type,
          title: body.title,
          description: body.description ?? null,
          schedule: normalizedSchedule,
          timezone: userRow.timezone,
          active: true,
        })
        .select(REMINDER_SELECT)
        .single();

      if (insertError) {
        console.error("caregiver-reminders POST failed", insertError);
        return error("Failed to create reminder", "REMINDER_CREATE_FAILED", 500);
      }

      return success({ reminder: inserted }, 201);
    }

    if (req.method === "PUT") {
      const reminderId = url.searchParams.get("reminder_id");
      if (!reminderId || !UUID_REGEX.test(reminderId)) {
        return error("reminder_id must be a valid UUID", "INVALID_REMINDER_ID", 400);
      }

      const body = await req.json().catch(() => null);
      const update = validateUpdatePayload(body);
      if (!update) {
        return error(
          "Invalid body. Provide at least one of: type, title, description, schedule.",
          "INVALID_BODY",
          400,
        );
      }

      const { data: ownedReminder, error: ownershipError } = await supabaseAdmin
        .from("reminders")
        .select("id")
        .eq("id", reminderId)
        .eq("user_id", seniorId)
        .maybeSingle();

      if (ownershipError) {
        console.error("caregiver-reminders ownership check failed", ownershipError);
        return error("Failed to validate reminder", "REMINDER_VALIDATE_FAILED", 500);
      }
      if (!ownedReminder) {
        return error("Reminder not found", "REMINDER_NOT_FOUND", 404);
      }

      const { data: updated, error: updateError } = await supabaseAdmin
        .from("reminders")
        .update(update)
        .eq("id", reminderId)
        .eq("user_id", seniorId)
        .select(REMINDER_SELECT)
        .single();

      if (updateError) {
        console.error("caregiver-reminders PUT failed", updateError);
        return error("Failed to update reminder", "REMINDER_UPDATE_FAILED", 500);
      }

      return success({ reminder: updated });
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
        .eq("user_id", seniorId)
        .maybeSingle();

      if (ownershipError) {
        console.error("caregiver-reminders ownership check failed", ownershipError);
        return error("Failed to validate reminder", "REMINDER_VALIDATE_FAILED", 500);
      }
      if (!ownedReminder) {
        return error("Reminder not found", "REMINDER_NOT_FOUND", 404);
      }

      const { error: updateError } = await supabaseAdmin
        .from("reminders")
        .update({ active: false })
        .eq("id", reminderId)
        .eq("user_id", seniorId);

      if (updateError) {
        console.error("caregiver-reminders DELETE failed", updateError);
        return error("Failed to delete reminder", "REMINDER_DELETE_FAILED", 500);
      }

      return success({ deleted: true });
    }

    return error("Method not allowed", "METHOD_NOT_ALLOWED", 405);
  } catch (err) {
    console.error("caregiver-reminders unhandled error", err);
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
