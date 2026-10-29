// _shared/agent_tools.ts
// Purpose: The household agent's custom tools: their definitions (sent to Managed Agents
// by supabase/scripts/setup_managed_agent.ts) and their execution (called by jobs-run when
// the agent uses a tool). Each tool is a thin wrapper over the calendar RPCs that the
// caregiver app and voice also use, so every write goes through the same checks. The
// household always comes from the job row, never from the model's input, and the RPCs
// refuse events of any other household.
//
// Last modified: 2026-10-27

import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { RpcError, rpc } from "./admin.ts";

const WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

const EVENT_FIELDS = {
  title: { type: "string", description: "What it is, as caregivers would write it, e.g. \"Physiotherapy\"." },
  label: {
    type: "string",
    description: "Optional short, calm wording the senior sees on the display, e.g. \"Exercises with Dana\".",
  },
  date: { type: "string", description: "Local date, YYYY-MM-DD. For a repeating event, the first date." },
  start_time: { type: "string", description: "Local start time, 24-hour HH:MM." },
  duration_minutes: { type: "integer", description: "Optional length in minutes." },
  place: { type: "string", description: "Optional place or address." },
  visitor_name: { type: "string", description: "Optional person involved (visitor, driver, doctor)." },
  notes: { type: "string", description: "Optional notes for caregivers." },
  repeat_weekdays: {
    type: "array",
    items: { type: "string", enum: WEEKDAYS },
    description: "Optional weekly repeat days. Omit for a one-off event.",
  },
  repeat_until: { type: "string", description: "Optional last date of a weekly repeat, YYYY-MM-DD." },
};

/** Custom tool definitions for the Managed Agents agent config. */
export const AGENT_TOOLS = [
  {
    type: "custom",
    name: "get_calendar",
    description:
      "List the household's calendar events (each occurrence, earliest first) between two local dates, at most 92 days apart. Use it to check for clashes and to find an event's id before changing or cancelling it.",
    input_schema: {
      type: "object",
      properties: {
        from_date: { type: "string", description: "First local date, YYYY-MM-DD." },
        to_date: { type: "string", description: "Last local date, YYYY-MM-DD." },
      },
      required: ["from_date", "to_date"],
    },
  },
  {
    type: "custom",
    name: "add_event",
    description:
      "Add an appointment, visit or other event to the senior's calendar. Times are the household's local time. It appears on the senior's display and in caregivers' Google calendars, and caregivers are notified on the morning of the event.",
    input_schema: {
      type: "object",
      properties: EVENT_FIELDS,
      required: ["title", "date", "start_time"],
    },
  },
  {
    type: "custom",
    name: "update_event",
    description:
      "Change an existing event. Send only the fields that change. To make a repeating event one-off, send repeat_weekdays as an empty list.",
    input_schema: {
      type: "object",
      properties: {
        event_id: { type: "string", description: "The event_id from get_calendar." },
        changes: { type: "object", properties: EVENT_FIELDS },
      },
      required: ["event_id", "changes"],
    },
  },
  {
    type: "custom",
    name: "cancel_event",
    description: "Cancel an event (all of its occurrences). It disappears from the display and from Google.",
    input_schema: {
      type: "object",
      properties: { event_id: { type: "string", description: "The event_id from get_calendar." } },
      required: ["event_id"],
    },
  },
];

/** Bad tool input; the message goes back to the model so it can fix the call. */
class ToolInputError extends Error {}

/**
 * purpose: Read a required string field.
 * @param input: (Record<string, unknown>) Tool input.
 * @param key: (string) Field name.
 * @param re: (RegExp | undefined) Optional format check.
 * @return: (string) The value.
 */
function str(input: Record<string, unknown>, key: string, re?: RegExp): string {
  const value = input[key];
  if (typeof value !== "string" || !value.trim() || (re && !re.test(value))) {
    throw new ToolInputError(`${key} is missing or malformed`);
  }
  return value;
}

/**
 * purpose: Convert tool-style event fields to the RPC's field names and types.
 * @param fields: (Record<string, unknown>) title, date, start_time, repeat_weekdays, ...
 * @return: (Record<string, unknown>) on_date, start_time, repeat_days (ISO numbers), ...
 */
export function toEventChanges(fields: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    switch (key) {
      case "date":
        out.on_date = str(fields, "date", DATE_RE);
        break;
      case "start_time":
        out.start_time = str(fields, "start_time", TIME_RE);
        break;
      case "repeat_until":
        out.repeat_until = value === null ? null : str(fields, "repeat_until", DATE_RE);
        break;
      case "repeat_weekdays": {
        if (!Array.isArray(value) || value.some((d) => !WEEKDAYS.includes(String(d)))) {
          throw new ToolInputError("repeat_weekdays must be a list of mon..sun");
        }
        out.repeat_days = value.length ? value.map((d) => WEEKDAYS.indexOf(String(d)) + 1) : null;
        break;
      }
      case "title":
      case "label":
      case "place":
      case "visitor_name":
      case "notes":
      case "duration_minutes":
        out[key] = value;
        break;
      default:
        throw new ToolInputError(`Unknown field ${key}`);
    }
  }
  return out;
}

/**
 * purpose: Run one custom tool call for a household.
 * @param client: (SupabaseClient) Service-role client.
 * @param householdId: (string) Household from the job row (never from the model).
 * @param name: (string) Tool name.
 * @param input: (Record<string, unknown>) Tool input from the model.
 * @return: (Promise<{text: string, isError: boolean}>) Result text for the model.
 */
export async function executeTool(
  client: SupabaseClient,
  householdId: string,
  name: string,
  input: Record<string, unknown>,
): Promise<{ text: string; isError: boolean }> {
  try {
    let result: unknown;
    switch (name) {
      case "get_calendar":
        result = await rpc(client, "list_events", {
          p_household_id: householdId,
          p_from: str(input, "from_date", DATE_RE),
          p_to: str(input, "to_date", DATE_RE),
        });
        break;
      case "add_event": {
        const f = toEventChanges(input);
        result = await rpc(client, "add_event", {
          p_household_id: householdId,
          p_title: str(input, "title"),
          p_on_date: str(input, "date", DATE_RE),
          p_start_time: str(input, "start_time", TIME_RE),
          p_duration_minutes: f.duration_minutes ?? null,
          p_place: f.place ?? null,
          p_notes: f.notes ?? null,
          p_visitor_name: f.visitor_name ?? null,
          p_label: f.label ?? null,
          p_repeat_days: f.repeat_days ?? null,
          p_repeat_until: f.repeat_until ?? null,
        });
        break;
      }
      case "update_event": {
        const changes = input.changes;
        if (!changes || typeof changes !== "object") throw new ToolInputError("changes must be an object");
        result = await rpc(client, "update_event", {
          p_event_id: str(input, "event_id"),
          p_changes: toEventChanges(changes as Record<string, unknown>),
          p_household_id: householdId,
        });
        break;
      }
      case "cancel_event":
        result = await rpc(client, "cancel_event", {
          p_event_id: str(input, "event_id"),
          p_household_id: householdId,
        });
        break;
      default:
        return { text: `Unknown tool ${name}`, isError: true };
    }
    return { text: JSON.stringify(result), isError: false };
  } catch (e) {
    if (e instanceof ToolInputError || e instanceof RpcError) return { text: `Error: ${e.message}`, isError: true };
    throw e;
  }
}
