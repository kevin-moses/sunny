// lib/agentTools.ts
// Purpose: The household agent's custom tools: their definitions (sent to Managed Agents by
// scripts/setup_managed_agent.ts; they must match the deployed agent, so re-run that script
// after changing them) and their execution inside a Convex mutation. Each tool is a thin
// wrapper over the calendar cores (addEventCore, updateEventCore, cancelEventCore,
// listOccurrencesCore) that the caregiver app also uses, so every write goes through the same
// validation, audit and "not in the past" rules, with the actor { kind: "agent" }. The
// household always comes from the caller (the request row), never from the model's input, and
// the cores refuse events of any other household. Bad input and application errors become
// tool errors the model can read and fix; anything else is rethrown. A result over
// MAX_TOOL_RESULT_CHARS becomes a tool error asking for a narrower request.
//
// get_calendar result: a JSON array of occurrences, earliest first, each
// { event_id, title, label, starts_on, start_time, duration_minutes, place, visitor_name,
//   repeat_weekdays (mon..sun names or null), repeat_until, created_via, cancelled,
//   local_date, starts_at, ends_at }.
//
// Last modified: 2026-10-29

import type Anthropic from "@anthropic-ai/sdk";
import { ConvexError } from "convex/values";
import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { addEventCore, cancelEventCore, listOccurrencesCore, updateEventCore } from "../calendar";
import type { AddEventArgs, EventChanges } from "../calendar";
import type { Actor } from "./access";
import { appError, type AppErrorData } from "./errors";
import type { OccurrenceJson } from "./occurrences";
import { requireNonBlank } from "./text";
import { WEEKDAY_NAMES } from "./time";

/** Longest tool result sent to the model; larger results become a tool error, never truncated JSON. */
export const MAX_TOOL_RESULT_CHARS = 50_000;

/** Weekday names as the model writes them: mon..sun (index = ISO weekday - 1). */
const WEEKDAYS = WEEKDAY_NAMES.map((name) => name.slice(0, 3).toLowerCase());
/** The actor recorded on every change the agent makes. */
const AGENT_ACTOR: Actor = { kind: "agent" };

/** JSON-schema properties shared by add_event and the `changes` of update_event. */
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
export const AGENT_TOOLS: NonNullable<Anthropic.Beta.Agents.AgentCreateParams["tools"]> = [
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

/**
 * purpose: Read a string field of tool input. Required fields must be non-blank strings;
 *          optional fields may also be null (null means clear on update) or blank.
 * @param value: (unknown) The field's value.
 * @param key: (string) Field name, for the error message.
 * @param optional: (boolean) Whether null is allowed (and blank is kept as is).
 * @return: (string | null) The string (trimmed when required), or null.
 * @raises invalid (an application error the model can read) for anything else.
 */
function stringField(value: unknown, key: string, optional: true): string | null;
function stringField(value: unknown, key: string, optional?: false): string;
function stringField(value: unknown, key: string, optional = false): string | null {
  if (optional && value === null) return null;
  if (typeof value !== "string") {
    throw appError(
      "invalid",
      optional ? `${key} must be a string` : `${key} is missing or malformed`,
    );
  }
  return optional ? value : requireNonBlank(value, key);
}

/**
 * purpose: Convert tool-style event fields (snake_case, weekday names) to the calendar
 *          core's camelCase fields (ISO weekday numbers). A null clears a clearable field;
 *          an empty repeat_weekdays list becomes null (one-off). Values are only typed here;
 *          dates, times, lengths and ranges are validated by the core.
 * @param fields: (Record<string, unknown>) title, date, start_time, repeat_weekdays, ...
 * @return: (EventChanges) onDate, startTime, repeatDays (1 = Monday .. 7 = Sunday), ...
 * @raises invalid for an unknown field or a value of the wrong type.
 */
export function toEventChanges(fields: Record<string, unknown>): EventChanges {
  const out: EventChanges = {};
  for (const [key, value] of Object.entries(fields)) {
    switch (key) {
      case "title":
        out.title = stringField(value, key);
        break;
      case "date":
        out.onDate = stringField(value, key);
        break;
      case "start_time":
        out.startTime = stringField(value, key);
        break;
      case "label":
      case "place":
      case "notes":
        out[key] = stringField(value, key, true);
        break;
      case "visitor_name":
        out.visitorName = stringField(value, key, true);
        break;
      case "repeat_until":
        out.repeatUntil = stringField(value, key, true);
        break;
      case "duration_minutes":
        if (value !== null && !Number.isInteger(value)) {
          throw appError("invalid", "duration_minutes must be a whole number");
        }
        out.durationMinutes = value as number | null;
        break;
      case "repeat_weekdays":
        if (!Array.isArray(value) || value.some((d) => !WEEKDAYS.includes(String(d)))) {
          throw appError("invalid", "repeat_weekdays must be a list of mon..sun");
        }
        out.repeatDays = value.length ? value.map((d) => WEEKDAYS.indexOf(String(d)) + 1) : null;
        break;
      default:
        throw appError("invalid", `Unknown field ${key}`);
    }
  }
  return out;
}

/**
 * purpose: Build the arguments of a new event from add_event input: the mapped fields with
 *          nulls treated as absent, and title, date and start time required.
 * @param input: (Record<string, unknown>) add_event input.
 * @return: (AddEventArgs) Arguments for addEventCore.
 * @raises invalid when a required field is missing or a field is unknown.
 */
function toAddArgs(input: Record<string, unknown>): AddEventArgs {
  const mapped = toEventChanges(input);
  const { title, onDate, startTime } = mapped;
  if (title === undefined || onDate === undefined || startTime === undefined) {
    throw appError("invalid", "title, date and start_time are required");
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
 * @raises invalid when missing or not an id of the events table.
 */
function eventIdOf(ctx: MutationCtx, input: Record<string, unknown>): Id<"events"> {
  const id = ctx.db.normalizeId("events", stringField(input.event_id, "event_id"));
  if (id === null) {
    throw appError(
      "invalid",
      "event_id is not a valid event id; use an event_id from get_calendar",
    );
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
      const from = stringField(input.from_date, "from_date");
      const to = stringField(input.to_date, "to_date");
      return (await listOccurrencesCore(ctx, householdId, from, to)).map(occurrenceForModel);
    }
    case "add_event":
      return await addEventCore(ctx, AGENT_ACTOR, householdId, toAddArgs(input), now);
    case "update_event": {
      const eventId = eventIdOf(ctx, input);
      const changes = input.changes;
      if (!changes || typeof changes !== "object" || Array.isArray(changes)) {
        throw appError("invalid", "changes must be an object");
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
    const text = JSON.stringify(result);
    if (text.length > MAX_TOOL_RESULT_CHARS) {
      return {
        text: `Error: The result is too large (${text.length} characters). Ask for a shorter date range.`,
        isError: true,
      };
    }
    return { text, isError: false };
  } catch (e) {
    if (e instanceof ConvexError) {
      const data = e.data as Partial<AppErrorData> | undefined;
      if (typeof data?.message === "string")
        return { text: `Error: ${data.message}`, isError: true };
    }
    throw e;
  }
}
