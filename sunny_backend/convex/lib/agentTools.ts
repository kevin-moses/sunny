// lib/agentTools.ts
// Purpose: The household agent's custom tools: their definitions (sent to Managed Agents by
// scripts/setup_managed_agent.ts; they must match the deployed agent, so re-run that script
// after changing them) and their execution inside a Convex mutation. Calendar tools
// (get_calendar, add_event, update_event, cancel_event) are thin wrappers over the calendar
// cores (addEventCore, updateEventCore, cancelEventCore, listOccurrencesCore); task tools
// (get_tasks, add_task, update_task, stop_task) wrap the task cores in tasks.ts
// (listTasksCore, createTaskCore, updateTaskCore). These are the cores the caregiver app also
// uses, so every write goes through the same validation, audit and resync rules.
//
// Context and provenance: executeAgentTool takes a ToolContext { householdId, actor, now }
// built by the runtime from the request row, never from the model's input. The actor is an
// agent actor { kind: "agent", onBehalfOf: <requesting caregiver>, requestId }, so a task or
// event the agent adds records createdBy = the requester (a task is createdByKind
// "caregiver", an event createdVia "agent") and the audit row records the requester as its
// user id and the request id in detail. The cores refuse events and tasks of any other
// household. Tools are a Record<ToolName, handler> table; an unknown tool is a missing key.
//
// Task rules the agent has beyond the app: an active task must have at least one time (checked
// by the core on the merged result of add_task and update_task; as-needed medications, which
// have no times and limits, stay app-only, so their fields are not in the tool schema), and
// add_task refuses a duplicate (an active task of the household with the same type, the same
// display label ignoring case and spacing, and a shared time), naming the existing task_id.
// The agent can stop a task (active false, history kept) but never hard delete one.
//
// Bad input and application errors become tool errors the model can read and fix; anything
// else is rethrown. A result over MAX_TOOL_RESULT_CHARS becomes a tool error asking for a
// narrower request.
//
// get_calendar result: a JSON array of occurrences, earliest first, each
// { event_id, title, label, starts_on, start_time, duration_minutes, place, visitor_name,
//   repeat_weekdays (mon..sun names or null), repeat_until, created_via, cancelled,
//   local_date, starts_at, ends_at }.
// get_tasks result: a JSON array of tasks in creation order, each { task_id, type, title,
//   display_label, spoken_prompt, times (HH:MM), repeat_weekdays (mon..sun names or null =
//   every day), once_on, starts_on, ends_on, window_minutes, pill_description,
//   checklist_items, active }; stopped tasks only with include_stopped; optionally only one
//   type. add_task, update_task and stop_task return the task in that shape.
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
import type { AgentActor } from "./access";
import { appError, type AppErrorData } from "./errors";
import type { OccurrenceJson } from "./occurrences";
import { requireNonBlank } from "./text";
import { WEEKDAY_CODES, weekdayCodes } from "./time";
import { taskType } from "./validators";
import type { TaskType } from "./validators";

/** Longest tool result sent to the model; larger results become a tool error, never truncated JSON. */
export const MAX_TOOL_RESULT_CHARS = 50_000;

/** Task types, as the model writes them. */
const TASK_TYPES: readonly TaskType[] = taskType.members.map((m) => m.value);

/** Everything a tool needs besides the model's input; built from the request row. */
export interface ToolContext {
  /** Household of the request (never from the model). */
  householdId: Id<"households">;
  /** The agent actor, carrying the requesting caregiver (onBehalfOf) and the request. */
  actor: AgentActor;
  /** Epoch ms the calendar's "not in the past" rules and instance expansion use. */
  now: number;
}

/** One tool call: its name and the model's input. */
export interface ToolCall {
  name: string;
  input: Record<string, unknown>;
}

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
    items: { type: "string", enum: WEEKDAY_CODES },
    description: "Optional weekly repeat days. Omit for a one-off event.",
  },
  repeat_until: {
    type: "string",
    description: "Optional last date of a weekly repeat, YYYY-MM-DD.",
  },
};

/** JSON-schema properties of add_task and (with active) of the `changes` of update_task. */
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
    description:
      'Short, calm wording the senior sees, 60 characters at most, e.g. "Morning pills".',
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
    items: { type: "string", enum: WEEKDAY_CODES },
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
};

/** The `changes` properties of update_task: the add_task fields plus active. */
const UPDATE_TASK_FIELDS = {
  ...TASK_FIELDS,
  active: { type: "boolean", description: "false stops the task, true resumes a stopped one." },
};

/** Keys add_task accepts, and keys update_task's `changes` accepts. */
const ADD_TASK_KEYS: readonly string[] = Object.keys(TASK_FIELDS);
const UPDATE_TASK_KEYS: readonly string[] = Object.keys(UPDATE_TASK_FIELDS);

/** The task_id property shared by the tools that act on one task. */
const TASK_ID_PROPERTY = {
  task_id: { type: "string", description: "The task_id from the briefing or get_tasks." },
};

/** Custom tool definitions for the Managed Agents agent config. */
export const AGENT_TOOLS: NonNullable<Anthropic.Beta.Agents.AgentCreateParams["tools"]> = [
  {
    type: "custom",
    name: "get_tasks",
    description:
      "List the household's tasks (things the senior is prompted to do and confirm), in creation order, each with its task_id. Stopped tasks are left out unless include_stopped is true. The briefing already lists the active tasks with their task_id; use this for stopped tasks or when the briefing's list is cut off.",
    input_schema: {
      type: "object",
      properties: {
        include_stopped: { type: "boolean", description: "Also list stopped tasks." },
        type: {
          type: "string",
          enum: [...TASK_TYPES],
          description: "Only tasks of this type.",
        },
      },
    },
  },
  {
    type: "custom",
    name: "add_task",
    description:
      "Add a task the senior is prompted to do and confirm on the display (pills, routine, reminder, checklist). It needs at least one time, in the household's local time, and starts prompting at once. An active task with the same type, label and a shared time is refused.",
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
      "Change an existing task. Send only the fields that change; null clears an optional field (pill_description, once_on, starts_on, ends_on), and null or blank spoken_prompt restores the default sentence. A null or empty repeat_weekdays makes the task run every day. times and checklist_items replace the whole list. active true resumes a stopped task.",
    input_schema: {
      type: "object",
      properties: {
        ...TASK_ID_PROPERTY,
        changes: { type: "object", properties: UPDATE_TASK_FIELDS },
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
      "List the household's calendar events (each occurrence, earliest first) between two local dates, at most 92 days apart. The briefing already lists the next 7 days with their event_id; use this for other dates.",
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
        event_id: {
          type: "string",
          description: "The event_id from the briefing or get_calendar.",
        },
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
      properties: {
        event_id: {
          type: "string",
          description: "The event_id from the briefing or get_calendar.",
        },
      },
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
 * purpose: Read a repeat_weekdays field of tool input (events and tasks).
 * @param value: (unknown) A list of mon..sun codes, an empty list or null.
 * @return: (number[] | null) ISO weekdays (1 = Monday .. 7 = Sunday); null for null or an
 *          empty list (no repeat for an event, every day for a task).
 * @raises invalid when it is not a list of mon..sun.
 */
function weekdaysField(value: unknown): number[] | null {
  if (value === null) return null;
  if (!Array.isArray(value) || value.some((d) => !WEEKDAY_CODES.includes(String(d)))) {
    throw appError("invalid", "repeat_weekdays must be a list of mon..sun");
  }
  return value.length ? value.map((d) => WEEKDAY_CODES.indexOf(String(d)) + 1) : null;
}

/**
 * purpose: Read a task type from tool input.
 * @param value: (unknown) The field's value.
 * @return: (TaskType) The type.
 * @raises invalid when it is missing or not one of the task types.
 */
function taskTypeField(value: unknown): TaskType {
  const type = stringField(value, "type");
  if (!TASK_TYPES.includes(type as TaskType)) {
    throw appError("invalid", `type must be one of ${TASK_TYPES.join(", ")}`);
  }
  return type as TaskType;
}

/**
 * purpose: Drop the keys whose value is null or undefined (null means "absent" when adding).
 * @param fields: (T) Mapped fields.
 * @return: A copy without null and undefined values.
 */
function withoutNulls<T extends object>(fields: T): { [K in keyof T]?: Exclude<T[K], null> } {
  return Object.fromEntries(
    Object.entries(fields).filter(([, value]) => value !== null && value !== undefined),
  ) as { [K in keyof T]?: Exclude<T[K], null> };
}

/**
 * purpose: Read the `changes` object of update_event or update_task input.
 * @param input: (Record<string, unknown>) Tool input.
 * @return: (Record<string, unknown>) The changes.
 * @raises invalid when it is not an object.
 */
function changesOf(input: Record<string, unknown>): Record<string, unknown> {
  const changes = input.changes;
  if (!changes || typeof changes !== "object" || Array.isArray(changes)) {
    throw appError("invalid", "changes must be an object");
  }
  return changes as Record<string, unknown>;
}

/** Where an id in tool input comes from: its input key and the tool that lists it. */
const ID_SOURCES = {
  events: { key: "event_id", tool: "get_calendar" },
  tasks: { key: "task_id", tool: "get_tasks" },
} as const;

/**
 * purpose: Read and validate an event_id or task_id from tool input as an id of that table.
 * @param ctx: (MutationCtx) Context (to normalize the id).
 * @param table: ("events" | "tasks") Which table's id to read.
 * @param input: (Record<string, unknown>) Tool input.
 * @return: (Id<T>) The id.
 * @raises invalid when missing or not an id of that table.
 */
function idOf<T extends keyof typeof ID_SOURCES>(
  ctx: MutationCtx,
  table: T,
  input: Record<string, unknown>,
): Id<T> {
  const { key, tool } = ID_SOURCES[table];
  const id = ctx.db.normalizeId(table, stringField(input[key], key));
  if (id === null) {
    throw appError(
      "invalid",
      `${key} is not a valid ${key.replace("_id", "")} id; use a ${key} from the briefing or ${tool}`,
    );
  }
  return id;
}

/**
 * purpose: Convert tool-style event fields (snake_case, weekday names) to the calendar
 *          core's camelCase fields (ISO weekday numbers). A null clears a clearable field;
 *          an empty or null repeat_weekdays becomes null (one-off). Values are only typed
 *          here; dates, times, lengths and ranges are validated by the core.
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
        out.durationMinutes = numberField(value, key, true);
        break;
      case "repeat_weekdays":
        out.repeatDays = weekdaysField(value);
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
function toAddEventArgs(input: Record<string, unknown>): AddEventArgs {
  const mapped = toEventChanges(input);
  const { title, onDate, startTime } = mapped;
  if (title === undefined || onDate === undefined || startTime === undefined) {
    throw appError("invalid", "title, date and start_time are required");
  }
  return { ...withoutNulls(mapped), title, onDate, startTime };
}

/**
 * purpose: Convert tool-style task fields (snake_case, weekday names) to the task core's
 *          camelCase changes (ISO weekday numbers). A null clears a clearable field; null or
 *          an empty repeat_weekdays list becomes null (every day); a null spoken_prompt
 *          becomes blank (restores the default). Values are only typed here; times, dates and
 *          ranges are validated by the core.
 * @param fields: (Record<string, unknown>) title, times, repeat_weekdays, ...
 * @param allowed: (readonly string[]) Keys this call may carry; default is everything
 *        update_task accepts (add_task passes the shorter list, which has no active).
 * @return: (TaskChanges) type, displayLabel, daysOfWeek (1 = Monday .. 7 = Sunday), ...
 * @raises invalid for an unknown or not allowed field or a value of the wrong type.
 */
export function toTaskChanges(
  fields: Record<string, unknown>,
  allowed: readonly string[] = UPDATE_TASK_KEYS,
): TaskChanges {
  const out: TaskChanges = {};
  for (const [key, value] of Object.entries(fields)) {
    if (!allowed.includes(key)) throw appError("invalid", `Unknown field ${key}`);
    switch (key) {
      case "type":
        out.type = taskTypeField(value);
        break;
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
        out.daysOfWeek = weekdaysField(value);
        break;
      case "window_minutes": {
        const minutes = numberField(value, key, true);
        if (minutes === null) throw appError("invalid", "window_minutes cannot be cleared");
        out.windowMinutes = minutes;
        break;
      }
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
 *          nulls treated as absent, and type, title and display_label required. That it has
 *          a time is checked by the core (TaskOptions.requireTimes).
 * @param input: (Record<string, unknown>) add_task input.
 * @return: (CreateTaskArgs) Arguments for createTaskCore.
 * @raises invalid when a required field is missing or a field is unknown (including active).
 */
function toAddTaskArgs(input: Record<string, unknown>): CreateTaskArgs {
  const mapped = toTaskChanges(input, ADD_TASK_KEYS);
  const { type, title, displayLabel } = mapped;
  if (type === undefined || title === undefined || displayLabel === undefined) {
    throw appError("invalid", "type, title and display_label are required");
  }
  return { ...withoutNulls(mapped), type, title, displayLabel };
}

/**
 * purpose: A task label compared loosely: trimmed, spacing collapsed, lower case.
 * @param label: (string) A display label.
 * @return: (string) The normalized label.
 */
function normalizeLabel(label: string): string {
  return label.trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * purpose: Refuse a new task that duplicates an active one: same type, same normalized
 *          display label and at least one shared time.
 * @param ctx: (MutationCtx) Context.
 * @param householdId: (Id<"households">) Household.
 * @param args: (CreateTaskArgs) The task about to be added.
 * @return: (Promise<void>) Resolves when there is no duplicate.
 * @raises invalid naming the existing task_id.
 */
async function rejectDuplicateTask(
  ctx: MutationCtx,
  householdId: Id<"households">,
  args: CreateTaskArgs,
): Promise<void> {
  const label = normalizeLabel(args.displayLabel);
  const times = args.times ?? [];
  const existing = (await listTasksCore(ctx, householdId, true)).find(
    (t) =>
      t.type === args.type &&
      normalizeLabel(t.displayLabel) === label &&
      t.times.some((time) => times.includes(time)),
  );
  if (existing) {
    throw appError(
      "invalid",
      `This task already exists (task_id ${existing._id}, "${existing.displayLabel}" at ${existing.times.join(", ")}); use update_task to change it`,
    );
  }
}

/**
 * purpose: Present a task the way the model reads it: snake_case names matching the other
 *          tools, task_id first, weekday names instead of ISO numbers. As-needed limits are
 *          app-only and not shown.
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
    repeat_weekdays: weekdayCodes(task.daysOfWeek),
    once_on: task.onceOn ?? null,
    starts_on: task.startsOn ?? null,
    ends_on: task.endsOn ?? null,
    window_minutes: task.windowMinutes,
    pill_description: task.pillDescription ?? null,
    checklist_items: task.checklistItems,
    active: task.active,
  };
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
    repeat_weekdays: weekdayCodes(o.repeatDays),
    repeat_until: o.repeatUntil,
    created_via: o.createdVia,
    cancelled: o.cancelled,
    local_date: o.localDate,
    starts_at: o.startsAt,
    ends_at: o.endsAt,
  };
}

/** A tool: runs with the context and the model's input, returns the raw result. */
type ToolHandler = (
  ctx: MutationCtx,
  toolCtx: ToolContext,
  input: Record<string, unknown>,
) => Promise<unknown>;

/** The tools, by name (the names of AGENT_TOOLS). */
type ToolName =
  | "get_tasks"
  | "add_task"
  | "update_task"
  | "stop_task"
  | "get_calendar"
  | "add_event"
  | "update_event"
  | "cancel_event";

/** The tool handlers; a name not in this table is an unknown tool. */
const TOOL_HANDLERS: Record<ToolName, ToolHandler> = {
  get_tasks: async (ctx, { householdId }, input) => {
    const { include_stopped: includeStopped, type } = input;
    if (includeStopped !== undefined && typeof includeStopped !== "boolean") {
      throw appError("invalid", "include_stopped must be true or false");
    }
    const only = type === undefined ? undefined : taskTypeField(type);
    const tasks = await listTasksCore(ctx, householdId, includeStopped !== true);
    return tasks.filter((t) => only === undefined || t.type === only).map(taskForModel);
  },
  add_task: async (ctx, { householdId, actor, now }, input) => {
    const args = toAddTaskArgs(input);
    await rejectDuplicateTask(ctx, householdId, args);
    const task = await createTaskCore(ctx, actor, householdId, args, now, { requireTimes: true });
    return taskForModel(task);
  },
  update_task: async (ctx, { householdId, actor, now }, input) => {
    const taskId = idOf(ctx, "tasks", input);
    const changes = toTaskChanges(changesOf(input));
    const task = await updateTaskCore(ctx, actor, householdId, taskId, changes, now, {
      requireTimes: true,
    });
    return taskForModel(task);
  },
  stop_task: async (ctx, { householdId, actor, now }, input) => {
    const taskId = idOf(ctx, "tasks", input);
    return taskForModel(
      await updateTaskCore(ctx, actor, householdId, taskId, { active: false }, now),
    );
  },
  get_calendar: async (ctx, { householdId }, input) => {
    const from = stringField(input.from_date, "from_date");
    const to = stringField(input.to_date, "to_date");
    return (await listOccurrencesCore(ctx, householdId, from, to)).map(occurrenceForModel);
  },
  add_event: async (ctx, { householdId, actor, now }, input) =>
    await addEventCore(ctx, actor, householdId, toAddEventArgs(input), now),
  update_event: async (ctx, { householdId, actor, now }, input) => {
    const eventId = idOf(ctx, "events", input);
    const changes = toEventChanges(changesOf(input));
    return await updateEventCore(ctx, actor, householdId, eventId, changes, now);
  },
  cancel_event: async (ctx, { householdId, actor, now }, input) =>
    await cancelEventCore(ctx, actor, householdId, idOf(ctx, "events", input), now),
};

/**
 * purpose: Run one custom tool call for a household.
 * @param ctx: (MutationCtx) Context.
 * @param toolCtx: (ToolContext) Household, agent actor and clock, from the request row.
 * @param call: (ToolCall) Tool name and the model's input.
 * @return: (Promise<{text: string, isError: boolean}>) Result text for the model. Bad input,
 *          application errors and unknown tools give isError true ("Error: <message>" for
 *          errors); other errors are rethrown.
 */
export async function executeAgentTool(
  ctx: MutationCtx,
  toolCtx: ToolContext,
  call: ToolCall,
): Promise<{ text: string; isError: boolean }> {
  if (!Object.hasOwn(TOOL_HANDLERS, call.name)) {
    return { text: `Unknown tool ${call.name}`, isError: true };
  }
  try {
    const result = await TOOL_HANDLERS[call.name as ToolName](ctx, toolCtx, call.input);
    const text = JSON.stringify(result);
    if (text.length > MAX_TOOL_RESULT_CHARS) {
      return {
        text: `Error: The result is too large (${text.length} characters). Ask for something narrower: get_calendar a shorter date range; get_tasks without include_stopped, or with a type.`,
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
