// lib/agentTools.ts
// Purpose: The household agent's custom tools: their definitions (sent to Managed Agents
// by the agent setup script; copied verbatim from supabase/functions/_shared/agent_tools.ts)
// and their execution inside a Convex mutation. Each tool is a thin wrapper over the
// calendar cores (addEventCore, updateEventCore, cancelEventCore, listOccurrencesCore) that
// the caregiver app also uses, so every write goes through the same validation, audit and
// "not in the past" rules, with the actor { kind: "agent" }. The household always comes
// from the caller (the request row), never from the model's input, and the cores refuse
// events of any other household. Bad input and application errors become tool errors the
// model can read and fix; anything else is rethrown.
//
// get_calendar result: a JSON array of occurrences, earliest first, each
// { event_id, title, label, starts_on, start_time, duration_minutes, place, visitor_name,
//   repeat_weekdays (mon..sun names or null), repeat_until, created_via, cancelled,
//   local_date, starts_at, ends_at }.
//
// Last modified: 2026-10-29

import { ConvexError } from "convex/values";
import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { addEventCore, cancelEventCore, listOccurrencesCore, updateEventCore } from "../calendar";
import type { AddEventArgs, EventChanges } from "../calendar";
import type { Actor } from "./access";
import type { AppErrorData } from "./errors";
import type { OccurrenceJson } from "./occurrences";

const WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
const AGENT_ACTOR: Actor = { kind: "agent" };

const EVENT_FIELDS = {
  title: {
    type: "string",
    description: 'What it is, as caregivers would write it, e.g. "Physiotherapy".',
  },
  label: {
    type: "string",
    description:
      'Optional short, calm wording the senior sees on the display, e.g. "Exercises with Dana".',
  },
  date: {
    type: "string",
    description: "Local date, YYYY-MM-DD. For a repeating event, the first date.",
  },
  start_time: { type: "string", description: "Local start time, 24-hour HH:MM." },
  duration_minutes: { type: "integer", description: "Optional length in minutes." },
  place: { type: "string", description: "Optional place or address." },
  visitor_name: {
    type: "string",
    description: "Optional person involved (visitor, driver, doctor).",
  },
  notes: { type: "string", description: "Optional notes for caregivers." },
  repeat_weekdays: {
    type: "array",
    items: { type: "string", enum: WEEKDAYS },
    description: "Optional weekly repeat days. Omit for a one-off event.",
  },
  repeat_until: {
    type: "string",
    description: "Optional last date of a weekly repeat, YYYY-MM-DD.",
  },
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
    description:
      "Cancel an event (all of its occurrences). It disappears from the display and from Google.",
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
 * purpose: Read a required, non-blank string field.
 * @param input: (Record<string, unknown>) Tool input.
 * @param key: (string) Field name.
 * @return: (string) The value.
 * @raises ToolInputError when missing, blank or not a string.
 */
function requireString(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new ToolInputError(`${key} is missing or malformed`);
  }
  return value;
}

/**
 * purpose: Read an optional string field that may be null (null means clear on update).
 * @param value: (unknown) The field's value.
 * @param key: (string) Field name, for the error message.
 * @return: (string | null) The string, or null.
 * @raises ToolInputError for any other type.
 */
function nullableString(value: unknown, key: string): string | null {
  if (value === null || typeof value === "string") return value;
  throw new ToolInputError(`${key} must be a string`);
}

/**
 * purpose: Convert tool-style event fields (snake_case, weekday names) to the calendar
 *          core's camelCase fields (ISO weekday numbers). A null clears a clearable field;
 *          an empty repeat_weekdays list becomes null (one-off). Values are only typed here;
 *          dates, times, lengths and ranges are validated by the core.
 * @param fields: (Record<string, unknown>) title, date, start_time, repeat_weekdays, ...
 * @return: (EventChanges) onDate, startTime, repeatDays (1 = Monday .. 7 = Sunday), ...
 * @raises ToolInputError for an unknown field or a value of the wrong type.
 */
export function toEventChanges(fields: Record<string, unknown>): EventChanges {
  const out: EventChanges = {};
  for (const [key, value] of Object.entries(fields)) {
    switch (key) {
      case "title":
        out.title = requireString(fields, key);
        break;
      case "date":
        out.onDate = requireString(fields, key);
        break;
      case "start_time":
        out.startTime = requireString(fields, key);
        break;
      case "label":
      case "place":
      case "notes":
        out[key] = nullableString(value, key);
        break;
      case "visitor_name":
        out.visitorName = nullableString(value, key);
        break;
      case "repeat_until":
        out.repeatUntil = nullableString(value, key);
        break;
      case "duration_minutes":
        if (value !== null && typeof value !== "number") {
          throw new ToolInputError("duration_minutes must be a whole number");
        }
        out.durationMinutes = value;
        break;
      case "repeat_weekdays":
        if (!Array.isArray(value) || value.some((d) => !WEEKDAYS.includes(String(d)))) {
          throw new ToolInputError("repeat_weekdays must be a list of mon..sun");
        }
        out.repeatDays = value.length ? value.map((d) => WEEKDAYS.indexOf(String(d)) + 1) : null;
        break;
      default:
        throw new ToolInputError(`Unknown field ${key}`);
    }
  }
  return out;
}

/**
 * purpose: Build the arguments of a new event from add_event input: the mapped fields with
 *          nulls treated as absent, and title, date and start time required.
 * @param input: (Record<string, unknown>) add_event input.
 * @return: (AddEventArgs) Arguments for addEventCore.
 * @raises ToolInputError when a required field is missing or a field is unknown.
 */
function toAddArgs(input: Record<string, unknown>): AddEventArgs {
  const mapped = toEventChanges(input);
  const { title, onDate, startTime } = mapped;
  if (title === undefined || onDate === undefined || startTime === undefined) {
    throw new ToolInputError("title, date and start_time are required");
  }
  const present = Object.fromEntries(
    Object.entries(mapped).filter(([, value]) => value !== null && value !== undefined),
  );
  return { ...present, title, onDate, startTime };
}

/**
 * purpose: Read and validate an event_id from tool input as an event id.
 * @param ctx: (MutationCtx) Context (to normalize the id).
 * @param input: (Record<string, unknown>) Tool input.
 * @return: (Id<"events">) The event id.
 * @raises ToolInputError when missing or not an id of the events table.
 */
function eventIdOf(ctx: MutationCtx, input: Record<string, unknown>): Id<"events"> {
  const id = ctx.db.normalizeId("events", requireString(input, "event_id"));
  if (id === null) {
    throw new ToolInputError("event_id is not a valid event id; use an event_id from get_calendar");
  }
  return id;
}

/**
 * purpose: Present an occurrence the way the model reads it: snake_case field names that
 *          match the other tools, event_id first, weekday names instead of ISO numbers, and
 *          the occurrence's local date and start time.
 * @param o: (OccurrenceJson) One occurrence.
 * @return: (Record<string, unknown>) JSON-ready item.
 */
function occurrenceForModel(o: OccurrenceJson): Record<string, unknown> {
  return {
    event_id: o.eventId,
    title: o.title,
    label: o.label,
    starts_on: o.startsOn,
    start_time: o.startTime,
    duration_minutes: o.durationMinutes,
    place: o.place,
    visitor_name: o.visitorName,
    notes: o.notes,
    repeat_weekdays: o.repeatDays && o.repeatDays.map((d) => WEEKDAYS[d - 1]),
    repeat_until: o.repeatUntil,
    created_via: o.createdVia,
    cancelled: o.cancelled,
    local_date: o.localDate,
    starts_at: o.startsAt,
    ends_at: o.endsAt,
  };
}

/**
 * purpose: Run the named tool and return its raw result.
 * @param ctx: (MutationCtx) Context.
 * @param householdId: (Id<"households">) Household of the request (never from the model).
 * @param name: (string) Tool name.
 * @param input: (Record<string, unknown>) Tool input from the model.
 * @param now: (number) Epoch ms the calendar's "not in the past" rules are checked against.
 * @return: (Promise<unknown | undefined>) The result, or undefined for an unknown tool.
 */
async function runTool(
  ctx: MutationCtx,
  householdId: Id<"households">,
  name: string,
  input: Record<string, unknown>,
  now: number,
): Promise<unknown> {
  switch (name) {
    case "get_calendar": {
      const from = requireString(input, "from_date");
      const to = requireString(input, "to_date");
      return (await listOccurrencesCore(ctx, householdId, from, to)).map(occurrenceForModel);
    }
    case "add_event":
      return await addEventCore(ctx, AGENT_ACTOR, householdId, toAddArgs(input), now);
    case "update_event": {
      const eventId = eventIdOf(ctx, input);
      const changes = input.changes;
      if (!changes || typeof changes !== "object" || Array.isArray(changes)) {
        throw new ToolInputError("changes must be an object");
      }
      return await updateEventCore(
        ctx,
        AGENT_ACTOR,
        householdId,
        eventId,
        toEventChanges(changes as Record<string, unknown>),
        now,
      );
    }
    case "cancel_event":
      return await cancelEventCore(ctx, AGENT_ACTOR, householdId, eventIdOf(ctx, input), now);
    default:
      return undefined;
  }
}

/**
 * purpose: Run one custom tool call for a household.
 * @param ctx: (MutationCtx) Context.
 * @param householdId: (Id<"households">) Household from the request row (never the model).
 * @param name: (string) Tool name.
 * @param input: (Record<string, unknown>) Tool input from the model.
 * @param now: (number) Epoch ms used by the calendar's time rules.
 * @return: (Promise<{text: string, isError: boolean}>) Result text for the model. Bad input
 *          and application errors give isError true with "Error: <message>"; other errors
 *          are rethrown.
 */
export async function executeAgentTool(
  ctx: MutationCtx,
  householdId: Id<"households">,
  name: string,
  input: Record<string, unknown>,
  now: number,
): Promise<{ text: string; isError: boolean }> {
  try {
    const result = await runTool(ctx, householdId, name, input, now);
    if (result === undefined) return { text: `Unknown tool ${name}`, isError: true };
    return { text: JSON.stringify(result), isError: false };
  } catch (e) {
    if (e instanceof ToolInputError) return { text: `Error: ${e.message}`, isError: true };
    if (e instanceof ConvexError) {
      const data = e.data as Partial<AppErrorData> | undefined;
      if (typeof data?.message === "string")
        return { text: `Error: ${data.message}`, isError: true };
    }
    throw e;
  }
}
