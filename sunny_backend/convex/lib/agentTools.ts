// lib/agentTools.ts
// Purpose: The household agent's custom tools: their definitions (sent to Managed Agents by
// scripts/setup_managed_agent.ts; they must match the deployed agent, so re-run that script
// after changing them) and their execution inside a Convex mutation. Calendar tools
// (get_calendar, add_event, update_event, cancel_event) are thin wrappers over the calendar
// cores (addEventCore, updateEventCore, cancelEventCore, listOccurrencesCore); task tools
// (get_tasks, add_task, update_task, stop_task) wrap the task cores in tasks.ts
// (listTasksCore, createTaskCore, updateTaskCore). These are the cores the caregiver app also
// uses, so every write goes through the same validation, audit and resync rules, with the
// audit actor { kind: "agent" }. The household and the requesting caregiver always come from
// the caller (the request row), never from the model's input, and the cores refuse events
// and tasks of any other household. A task the agent adds is recorded as created by that
// caregiver (createdByKind "caregiver", createdBy = requestedBy). The agent can stop a task
// (active false, history kept) but never hard delete one. Bad input and application errors
// become tool errors the model can read and fix; anything else is rethrown. A result over
// MAX_TOOL_RESULT_CHARS becomes a tool error asking for a narrower request.
//
// get_calendar result: a JSON array of occurrences, earliest first, each
// { event_id, title, label, starts_on, start_time, duration_minutes, place, visitor_name,
//   repeat_weekdays (mon..sun names or null), repeat_until, created_via, cancelled,
//   local_date, starts_at, ends_at }.
// get_tasks result: a JSON array of tasks in creation order, each { task_id, type, title,
//   display_label, spoken_prompt, times (HH:MM), repeat_weekdays (mon..sun names or null =
//   every day), once_on, starts_on, ends_on, window_minutes, pill_description,
//   checklist_items, as_needed_max_per_day, as_needed_min_hours, active }; stopped tasks only
//   with include_stopped. add_task, update_task and stop_task return the task in that shape.
//
// Last modified: 2026-11-01

import type Anthropic from "@anthropic-ai/sdk";
import { ConvexError } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { addEventCore, cancelEventCore, listOccurrencesCore, updateEventCore } from "../calendar";
import type { AddEventArgs, EventChanges } from "../calendar";
import { createTaskCore, listTasksCore, updateTaskCore } from "../tasks";
import type { CreateTaskArgs, TaskChanges } from "../tasks";
import type { Actor } from "./access";
import { appError, type AppErrorData } from "./errors";
import type { OccurrenceJson } from "./occurrences";
import { requireNonBlank } from "./text";
import type { TaskType } from "./validators";
import { WEEKDAY_NAMES } from "./time";

/** Longest tool result sent to the model; larger results become a tool error, never truncated JSON. */
export const MAX_TOOL_RESULT_CHARS = 50_000;

/** Weekday names as the model writes them: mon..sun (index = ISO weekday - 1). */
const WEEKDAYS = WEEKDAY_NAMES.map((name) => name.slice(0, 3).toLowerCase());
/** Task types, as the model writes them. */
const TASK_TYPES: readonly TaskType[] = [
  "medication",
  "appointment",
  "routine",
  "checklist",
  "reminder",
];
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

/** JSON-schema properties shared by add_task and the `changes` of update_task. */
const TASK_FIELDS = {
  type: {
    type: "string",
    enum: [...TASK_TYPES],
    description:
      "medication (pills), appointment (a prompted preparation, not a calendar event), routine, checklist or reminder.",
  },
  title: {
    type: "string",
    description: 'What it is, as caregivers would write it, e.g. "Morning pills".',
  },
  display_label: {
    type: "string",
    description: 'Short, calm wording the senior sees, e.g. "Morning pills".',
  },
  spoken_prompt: {
    type: "string",
    description:
      'The exact sentence the senior hears. Defaults to "Time for <display_label>." when omitted or blank.',
  },
  times: {
    type: "array",
    items: { type: "string" },
    description:
      "Local times of day, 24-hour HH:MM, at least one. Replaces the whole list on update.",
  },
  repeat_weekdays: {
    type: "array",
    items: { type: "string", enum: WEEKDAYS },
    description: "Optional weekdays the task runs on. Omit for every day.",
  },
  once_on: {
    type: "string",
    description: "Optional single local date, YYYY-MM-DD, for a one-off task (no repeat_weekdays).",
  },
  starts_on: { type: "string", description: "Optional first local date, YYYY-MM-DD." },
  ends_on: { type: "string", description: "Optional last local date, YYYY-MM-DD." },
  window_minutes: {
    type: "integer",
    description: "Optional minutes the senior has to confirm, 1 to 720 (default 60).",
  },
  pill_description: {
    type: "string",
    description: "Optional description of the pills, only in the caregiver's words.",
  },
  checklist_items: {
    type: "array",
    items: { type: "string" },
    description: "Optional checklist entries, in order. Replaces the whole list on update.",
  },
  as_needed_max_per_day: {
    type: "integer",
    description: "Optional as-needed daily limit, only if the caregiver gave one.",
  },
  as_needed_min_hours: {
    type: "number",
    description: "Optional as-needed minimum gap in hours, only if the caregiver gave one.",
  },
};

/** The task_id property shared by the tools that act on one task. */
const TASK_ID_PROPERTY = {
  task_id: { type: "string", description: "The task_id from get_tasks." },
};

/** Custom tool definitions for the Managed Agents agent config. */
export const AGENT_TOOLS: NonNullable<Anthropic.Beta.Agents.AgentCreateParams["tools"]> = [
  {
    type: "custom",
    name: "get_tasks",
    description:
      "List the household's tasks (things the senior is prompted to do and confirm), in creation order, each with its task_id. Stopped tasks are left out unless include_stopped is true. Use it to check for duplicates and to find a task's id before changing or stopping it.",
    input_schema: {
      type: "object",
      properties: {
        include_stopped: { type: "boolean", description: "Also list stopped tasks." },
      },
    },
  },
  {
    type: "custom",
    name: "add_task",
    description:
      "Add a task the senior is prompted to do and confirm on the display (pills, routine, reminder, checklist). It needs at least one time, in the household's local time, and starts prompting at once.",
    input_schema: {
      type: "object",
      properties: TASK_FIELDS,
      required: ["type", "title", "display_label", "times"],
    },
  },
  {
    type: "custom",
    name: "update_task",
    description:
      "Change an existing task. Send only the fields that change; null clears an optional field (pill_description, once_on, starts_on, ends_on, as_needed_max_per_day, as_needed_min_hours), and null or blank spoken_prompt restores the default sentence. A null or empty repeat_weekdays makes the task run every day. times and checklist_items replace the whole list. active true resumes a stopped task.",
    input_schema: {
      type: "object",
      properties: {
        ...TASK_ID_PROPERTY,
        changes: {
          type: "object",
          properties: { ...TASK_FIELDS, active: { type: "boolean" } },
        },
      },
      required: ["task_id", "changes"],
    },
  },
  {
    type: "custom",
    name: "stop_task",
    description:
      "Stop a task so the senior is no longer prompted. Its history is kept and update_task with active true resumes it. Tasks cannot be deleted.",
    input_schema: {
      type: "object",
      properties: TASK_ID_PROPERTY,
      required: ["task_id"],
    },
  },
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
 * purpose: Read a list-of-strings field of tool input.
 * @param value: (unknown) The field's value.
 * @param key: (string) Field name, for the error message.
 * @return: (string[]) The strings.
 * @raises invalid when it is not an array of strings.
 */
function stringListField(value: unknown, key: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw appError("invalid", `${key} must be a list of strings`);
  }
  return value as string[];
}

/**
 * purpose: Read a number field of tool input; null is allowed when the field is clearable.
 * @param value: (unknown) The field's value.
 * @param key: (string) Field name, for the error message.
 * @param integer: (boolean) Whether it must be a whole number.
 * @return: (number | null) The number, or null.
 * @raises invalid for anything else.
 */
function numberField(value: unknown, key: string, integer: boolean): number | null {
  if (value === null) return null;
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    (integer && !Number.isInteger(value))
  ) {
    throw appError("invalid", `${key} must be ${integer ? "a whole number" : "a number"}`);
  }
  return value;
}

/**
 * purpose: Convert tool-style task fields (snake_case, weekday names) to the task core's
 *          camelCase changes (ISO weekday numbers). A null clears a clearable field; null or
 *          an empty repeat_weekdays list becomes null (every day); a null spoken_prompt
 *          becomes blank (restores the default). Values are only typed here; times, dates and
 *          ranges are validated by the core.
 * @param fields: (Record<string, unknown>) title, times, repeat_weekdays, ...
 * @return: (TaskChanges) type, displayLabel, daysOfWeek (1 = Monday .. 7 = Sunday), ...
 * @raises invalid for an unknown field or a value of the wrong type.
 */
export function toTaskChanges(fields: Record<string, unknown>): TaskChanges {
  const out: TaskChanges = {};
  for (const [key, value] of Object.entries(fields)) {
    switch (key) {
      case "type": {
        const type = stringField(value, key);
        if (!TASK_TYPES.includes(type as TaskType)) {
          throw appError("invalid", `type must be one of ${TASK_TYPES.join(", ")}`);
        }
        out.type = type as TaskType;
        break;
      }
      case "title":
        out.title = stringField(value, key);
        break;
      case "display_label":
        out.displayLabel = stringField(value, key);
        break;
      case "spoken_prompt":
        out.spokenPrompt = stringField(value, key, true) ?? "";
        break;
      case "pill_description":
        out.pillDescription = stringField(value, key, true);
        break;
      case "once_on":
        out.onceOn = stringField(value, key, true);
        break;
      case "starts_on":
        out.startsOn = stringField(value, key, true);
        break;
      case "ends_on":
        out.endsOn = stringField(value, key, true);
        break;
      case "times":
        out.times = stringListField(value, key);
        break;
      case "checklist_items":
        out.checklistItems = stringListField(value, key);
        break;
      case "repeat_weekdays":
        if (value === null) {
          out.daysOfWeek = null;
          break;
        }
        if (!Array.isArray(value) || value.some((d) => !WEEKDAYS.includes(String(d)))) {
          throw appError("invalid", "repeat_weekdays must be a list of mon..sun");
        }
        out.daysOfWeek = value.length ? value.map((d) => WEEKDAYS.indexOf(String(d)) + 1) : null;
        break;
      case "window_minutes": {
        const minutes = numberField(value, key, true);
        if (minutes === null) throw appError("invalid", "window_minutes cannot be cleared");
        out.windowMinutes = minutes;
        break;
      }
      case "as_needed_max_per_day":
        out.asNeededMaxPerDay = numberField(value, key, true);
        break;
      case "as_needed_min_hours":
        out.asNeededMinHours = numberField(value, key, false);
        break;
      case "active":
        if (typeof value !== "boolean") throw appError("invalid", "active must be true or false");
        out.active = value;
        break;
      default:
        throw appError("invalid", `Unknown field ${key}`);
    }
  }
  return out;
}

/**
 * purpose: Build the arguments of a new task from add_task input: the mapped fields with
 *          nulls treated as absent, and type, title, display_label and at least one time
 *          required. active is not an add_task field.
 * @param input: (Record<string, unknown>) add_task input.
 * @return: (CreateTaskArgs) Arguments for createTaskCore.
 * @raises invalid when a required field is missing or a field is unknown.
 */
function toAddTaskArgs(input: Record<string, unknown>): CreateTaskArgs {
  if ("active" in input) throw appError("invalid", "Unknown field active");
  const mapped = toTaskChanges(input);
  const { type, title, displayLabel, times } = mapped;
  if (type === undefined || title === undefined || displayLabel === undefined) {
    throw appError("invalid", "type, title and display_label are required");
  }
  if (times === undefined || times.length === 0) {
    throw appError(
      "invalid",
      "A task needs at least one time (HH:MM); ask the caregiver for it instead of guessing",
    );
  }
  const present = Object.fromEntries(
    Object.entries(mapped).filter(([, value]) => value !== null && value !== undefined),
  );
  return { ...present, type, title, displayLabel, times };
}

/**
 * purpose: Read and validate a task_id from tool input as a task id.
 * @param ctx: (MutationCtx) Context (to normalize the id).
 * @param input: (Record<string, unknown>) Tool input.
 * @return: (Id<"tasks">) The task id.
 * @raises invalid when missing or not an id of the tasks table.
 */
function taskIdOf(ctx: MutationCtx, input: Record<string, unknown>): Id<"tasks"> {
  const id = ctx.db.normalizeId("tasks", stringField(input.task_id, "task_id"));
  if (id === null) {
    throw appError("invalid", "task_id is not a valid task id; use a task_id from get_tasks");
  }
  return id;
}

/**
 * purpose: Present a task the way the model reads it: snake_case names matching the other
 *          tools, task_id first, weekday names instead of ISO numbers.
 * @param task: (Doc<"tasks">) One task.
 * @return: (Record<string, unknown>) JSON-ready item.
 */
function taskForModel(task: Doc<"tasks">): Record<string, unknown> {
  return {
    task_id: task._id,
    type: task.type,
    title: task.title,
    display_label: task.displayLabel,
    spoken_prompt: task.spokenPrompt,
    times: task.times,
    repeat_weekdays: task.daysOfWeek ? task.daysOfWeek.map((d) => WEEKDAYS[d - 1]) : null,
    once_on: task.onceOn ?? null,
    starts_on: task.startsOn ?? null,
    ends_on: task.endsOn ?? null,
    window_minutes: task.windowMinutes,
    pill_description: task.pillDescription ?? null,
    checklist_items: task.checklistItems,
    as_needed_max_per_day: task.asNeededMaxPerDay ?? null,
    as_needed_min_hours: task.asNeededMinHours ?? null,
    active: task.active,
  };
}

/**
 * purpose: Run one of the task tools and present the resulting task.
 * @param ctx: (MutationCtx) Context.
 * @param householdId: (Id<"households">) Household of the request (never from the model).
 * @param requestedBy: (string) Clerk user id of the requesting caregiver, recorded as creator.
 * @param name: (string) Tool name.
 * @param input: (Record<string, unknown>) Tool input from the model.
 * @param now: (number) Epoch ms.
 * @return: (Promise<unknown | undefined>) The result, or undefined for a non-task tool.
 */
async function runTaskTool(
  ctx: MutationCtx,
  householdId: Id<"households">,
  requestedBy: string,
  name: string,
  input: Record<string, unknown>,
  now: number,
): Promise<unknown> {
  switch (name) {
    case "get_tasks": {
      const includeStopped = input.include_stopped;
      if (includeStopped !== undefined && typeof includeStopped !== "boolean") {
        throw appError("invalid", "include_stopped must be true or false");
      }
      const tasks = await listTasksCore(ctx, householdId);
      return tasks.filter((t) => includeStopped === true || t.active).map(taskForModel);
    }
    case "add_task": {
      const taskId = await createTaskCore(
        ctx,
        AGENT_ACTOR,
        householdId,
        toAddTaskArgs(input),
        now,
        requestedBy,
      );
      return taskForModel((await ctx.db.get(taskId))!);
    }
    case "update_task": {
      const taskId = taskIdOf(ctx, input);
      const changes = input.changes;
      if (!changes || typeof changes !== "object" || Array.isArray(changes)) {
        throw appError("invalid", "changes must be an object");
      }
      const task = await updateTaskCore(
        ctx,
        AGENT_ACTOR,
        householdId,
        taskId,
        toTaskChanges(changes as Record<string, unknown>),
        now,
      );
      return taskForModel(task);
    }
    case "stop_task": {
      const task = await updateTaskCore(
        ctx,
        AGENT_ACTOR,
        householdId,
        taskIdOf(ctx, input),
        { active: false },
        now,
      );
      return taskForModel(task);
    }
    default:
      return undefined;
  }
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
 * @param requestedBy: (string) Clerk user id of the requesting caregiver (from the request row).
 * @param name: (string) Tool name.
 * @param input: (Record<string, unknown>) Tool input from the model.
 * @param now: (number) Epoch ms the calendar's "not in the past" rules are checked against.
 * @return: (Promise<unknown | undefined>) The result, or undefined for an unknown tool.
 */
async function runTool(
  ctx: MutationCtx,
  householdId: Id<"households">,
  requestedBy: string,
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
      return await runTaskTool(ctx, householdId, requestedBy, name, input, now);
  }
}

/**
 * purpose: Run one custom tool call for a household.
 * @param ctx: (MutationCtx) Context.
 * @param householdId: (Id<"households">) Household from the request row (never the model).
 * @param requestedBy: (string) Clerk user id of the requesting caregiver (the request row's
 *        requestedBy); recorded as the creator of tasks the agent adds.
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
  requestedBy: string,
  name: string,
  input: Record<string, unknown>,
  now: number,
): Promise<{ text: string; isError: boolean }> {
  try {
    const result = await runTool(ctx, householdId, requestedBy, name, input, now);
    if (result === undefined) return { text: `Unknown tool ${name}`, isError: true };
    const text = JSON.stringify(result);
    if (text.length > MAX_TOOL_RESULT_CHARS) {
      return {
        text: `Error: The result is too large (${text.length} characters). Ask for something narrower (a shorter date range, or fewer tasks).`,
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
