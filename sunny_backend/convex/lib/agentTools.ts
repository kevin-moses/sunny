import type Anthropic from "@anthropic-ai/sdk";
import { ConvexError } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { addEventCore, cancelEventCore, listOccurrencesCore, updateEventCore } from "../calendar";
import type { AddEventArgs, EventChanges } from "../calendar";
import { createTaskCore, listTasksCore, updateTaskCore } from "../tasks";
import type { CreateTaskArgs, TaskChanges } from "../tasks";
import { SETUP_TOOL_HANDLERS, SETUP_TOOLS } from "./agentSetupTools";
import type { SetupToolName } from "./agentSetupTools";
import { isAnytimeTask } from "./anytime";
import { ALERT_MINUTES, alertsCaregivers } from "./escalation";
import { appError, type AppErrorData } from "./errors";
import type { OccurrenceJson } from "./occurrences";
import { isAsNeededTask } from "./taskDraft";
import { booleanField, changesOf, idField, stringField } from "./toolInput";
import type { ToolContext, ToolHandler } from "./toolInput";
import { isoWeekday, WEEKDAY_CODES, weekdayCodes } from "./time";
import { taskType } from "./validators";
import type { TaskType } from "./validators";

export const MAX_TOOL_RESULT_CHARS = 50_000;

const AS_NEEDED_REFUSAL = "As-needed medications are managed in the app.";

const TASK_TYPES: readonly TaskType[] = taskType.members.map((m) => m.value);

export interface ToolCall {
  name: string;
  input: Record<string, unknown>;
}

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
  screen_sentence: {
    type: "string",
    description:
      'The short sentence the senior reads on their phone above the Done button, 60 characters at most, e.g. "Take your morning pills." Blank shows the display label instead.',
  },
  times: {
    type: "array",
    items: { type: "string" },
    description:
      "Local times, 24-hour HH:MM. Required for medication; omit or leave empty for an anytime task (never prompted). Replaces the whole list on update.",
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
    description:
      "Optional steps, in order. With two or more, the senior sees one step at a time: Done moves to the next step, and the task is done only after the last one. Replaces the whole list on update.",
  },
  high_priority: {
    type: "boolean",
    description: `true: every caregiver is alerted when the senior has not confirmed it ${ALERT_MINUTES} minutes after its time. Only when the caregiver asks; default false. Medications always alert; anytime tasks never do.`,
  },
};

const UPDATE_TASK_FIELDS = {
  ...TASK_FIELDS,
  active: { type: "boolean", description: "false stops the task, true resumes a stopped one." },
};

const ADD_TASK_KEYS: readonly string[] = Object.keys(TASK_FIELDS);
const UPDATE_TASK_KEYS: readonly string[] = Object.keys(UPDATE_TASK_FIELDS);

const TASK_ID_PROPERTY = {
  task_id: { type: "string", description: "The task_id from the briefing or get_tasks." },
};

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
      'Add a task the senior confirms on the display (pills, routine, reminder, checklist). With times (household local time) the senior is prompted at those times. Without times it is an anytime task: shown as "Anytime" for the day, never prompted, done any time that day; medication always needs a time. An active task with the same type, label and a shared time (or both anytime) is refused.',
    input_schema: {
      type: "object",
      properties: TASK_FIELDS,
      required: ["type", "title", "display_label"],
    },
  },
  {
    type: "custom",
    name: "update_task",
    description:
      "Change an existing task. Send only the fields that change; null clears an optional field (pill_description, once_on, starts_on, ends_on), and null or blank spoken_prompt restores the default sentence. Changing display_label clears the stored screen_sentence unless the same call sends a new one; null or blank screen_sentence clears it. A null or empty repeat_weekdays makes the task run every day. times and checklist_items replace the whole list. active true resumes a stopped task.",
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
  ...SETUP_TOOLS,
];

function stringListField(value: unknown, key: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw appError("invalid", `${key} must be a list of strings`);
  }
  return value as string[];
}

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

function weekdaysField(value: unknown): number[] | null {
  if (value === null) return null;
  if (!Array.isArray(value) || value.some((d) => !WEEKDAY_CODES.includes(String(d)))) {
    throw appError("invalid", "repeat_weekdays must be a list of mon..sun");
  }
  return value.length ? value.map((d) => WEEKDAY_CODES.indexOf(String(d)) + 1) : null;
}

function taskTypeField(value: unknown): TaskType {
  const type = stringField(value, "type");
  if (!TASK_TYPES.includes(type as TaskType)) {
    throw appError("invalid", `type must be one of ${TASK_TYPES.join(", ")}`);
  }
  return type as TaskType;
}

function withoutNulls<T extends object>(fields: T): { [K in keyof T]?: Exclude<T[K], null> } {
  return Object.fromEntries(
    Object.entries(fields).filter(([, value]) => value !== null && value !== undefined),
  ) as { [K in keyof T]?: Exclude<T[K], null> };
}

const ID_SOURCES = {
  events: { key: "event_id", tool: "get_calendar" },
  tasks: { key: "task_id", tool: "get_tasks" },
} as const;

function idOf<T extends keyof typeof ID_SOURCES>(
  ctx: MutationCtx,
  table: T,
  input: Record<string, unknown>,
): Id<T> {
  const { key, tool } = ID_SOURCES[table];
  return idField(ctx, table, input[key], key, `the briefing or ${tool}`);
}

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

function toAddEventArgs(input: Record<string, unknown>): AddEventArgs {
  const mapped = toEventChanges(input);
  const { title, onDate, startTime } = mapped;
  if (title === undefined || onDate === undefined || startTime === undefined) {
    throw appError("invalid", "title, date and start_time are required");
  }
  return { ...withoutNulls(mapped), title, onDate, startTime };
}

const TASK_FIELD_READERS: Record<string, (out: TaskChanges, value: unknown, key: string) => void> =
  {
    type: (out, value) => {
      out.type = taskTypeField(value);
    },
    title: (out, value, key) => {
      out.title = stringField(value, key);
    },
    display_label: (out, value, key) => {
      out.displayLabel = stringField(value, key);
    },
    spoken_prompt: (out, value, key) => {
      out.spokenPrompt = stringField(value, key, true) ?? "";
    },
    screen_sentence: (out, value, key) => {
      out.screenSentence = stringField(value, key, true) ?? "";
    },
    pill_description: (out, value, key) => {
      out.pillDescription = stringField(value, key, true);
    },
    once_on: (out, value, key) => {
      out.onceOn = stringField(value, key, true);
    },
    starts_on: (out, value, key) => {
      out.startsOn = stringField(value, key, true);
    },
    ends_on: (out, value, key) => {
      out.endsOn = stringField(value, key, true);
    },
    times: (out, value, key) => {
      out.times = stringListField(value, key);
    },
    checklist_items: (out, value, key) => {
      out.checklistItems = stringListField(value, key);
    },
    repeat_weekdays: (out, value) => {
      out.daysOfWeek = weekdaysField(value);
    },
    window_minutes: (out, value, key) => {
      const minutes = numberField(value, key, true);
      if (minutes === null) throw appError("invalid", "window_minutes cannot be cleared");
      out.windowMinutes = minutes;
    },
    active: (out, value, key) => {
      out.active = booleanField(value, key);
    },
    high_priority: (out, value, key) => {
      out.highPriority = booleanField(value, key);
    },
  };

export function toTaskChanges(
  fields: Record<string, unknown>,
  allowed: readonly string[] = UPDATE_TASK_KEYS,
): TaskChanges {
  const out: TaskChanges = {};
  for (const [key, value] of Object.entries(fields)) {
    const read = Object.hasOwn(TASK_FIELD_READERS, key) ? TASK_FIELD_READERS[key] : undefined;
    if (!read || !allowed.includes(key)) throw appError("invalid", `Unknown field ${key}`);
    read(out, value, key);
  }
  return out;
}

function toAddTaskArgs(input: Record<string, unknown>): CreateTaskArgs {
  const mapped = toTaskChanges(input, ADD_TASK_KEYS);
  const { type, title, displayLabel } = mapped;
  if (type === undefined || title === undefined || displayLabel === undefined) {
    throw appError("invalid", "type, title and display_label are required");
  }
  return { ...withoutNulls(mapped), type, title, displayLabel };
}

function normalizeLabel(label: string): string {
  return label.trim().replace(/\s+/g, " ").toLowerCase();
}

type DuplicateKey = Pick<
  Doc<"tasks">,
  "type" | "displayLabel" | "times" | "daysOfWeek" | "onceOn" | "startsOn" | "endsOn"
>;

function occursOnDate(task: DuplicateKey, date: string): boolean {
  if (task.startsOn !== undefined && date < task.startsOn) return false;
  if (task.endsOn !== undefined && date > task.endsOn) return false;
  if (task.onceOn !== undefined) return date === task.onceOn;
  return task.daysOfWeek === undefined || task.daysOfWeek.includes(isoWeekday(date));
}

function schedulesOverlap(a: DuplicateKey, b: DuplicateKey): boolean {
  if (a.onceOn !== undefined) return occursOnDate(b, a.onceOn) && occursOnDate(a, a.onceOn);
  if (b.onceOn !== undefined) return occursOnDate(a, b.onceOn) && occursOnDate(b, b.onceOn);
  const startsBeforeOtherEnds = (x: DuplicateKey, y: DuplicateKey) =>
    x.startsOn === undefined || y.endsOn === undefined || x.startsOn <= y.endsOn;
  if (!startsBeforeOtherEnds(a, b) || !startsBeforeOtherEnds(b, a)) return false;
  if (a.daysOfWeek === undefined || b.daysOfWeek === undefined) return true;
  return a.daysOfWeek.some((day) => b.daysOfWeek!.includes(day));
}

function sharesTime(a: DuplicateKey, b: DuplicateKey): boolean {
  if (isAnytimeTask(a) && isAnytimeTask(b)) return true;
  return a.times.some((time) => b.times.includes(time));
}

async function rejectDuplicateTask(
  ctx: MutationCtx,
  householdId: Id<"households">,
  candidate: DuplicateKey,
  excludeId?: Id<"tasks">,
): Promise<void> {
  const label = normalizeLabel(candidate.displayLabel);
  const existing = (await listTasksCore(ctx, householdId, true)).find(
    (t) =>
      t._id !== excludeId &&
      t.type === candidate.type &&
      normalizeLabel(t.displayLabel) === label &&
      sharesTime(t, candidate) &&
      schedulesOverlap(t, candidate),
  );
  if (existing) {
    throw appError(
      "invalid",
      `This task already exists (task_id ${existing._id}, "${existing.displayLabel}" ${isAnytimeTask(existing) ? "anytime" : `at ${existing.times.join(", ")}`}); use update_task to change it`,
    );
  }
}

function mergedForDuplicateCheck(
  task: Doc<"tasks">,
  changes: TaskChanges,
): DuplicateKey & { active: boolean } {
  const merge = <T>(value: T | null | undefined, current: T | undefined) =>
    value === undefined ? current : (value ?? undefined);
  return {
    type: changes.type ?? task.type,
    displayLabel: changes.displayLabel ?? task.displayLabel,
    times: changes.times ?? task.times,
    daysOfWeek: merge(changes.daysOfWeek, task.daysOfWeek),
    onceOn: merge(changes.onceOn, task.onceOn),
    startsOn: merge(changes.startsOn, task.startsOn),
    endsOn: merge(changes.endsOn, task.endsOn),
    active: changes.active ?? task.active,
  };
}

const DUPLICATE_RELEVANT_KEYS: readonly (keyof TaskChanges)[] = [
  "type",
  "displayLabel",
  "times",
  "daysOfWeek",
  "onceOn",
  "startsOn",
  "endsOn",
  "active",
];

function taskForModel(task: Doc<"tasks">): Record<string, unknown> {
  return {
    task_id: task._id,
    type: task.type,
    title: task.title,
    display_label: task.displayLabel,
    spoken_prompt: task.spokenPrompt,
    screen_sentence: task.screenSentence ?? null,
    times: task.times,
    anytime: isAnytimeTask(task),
    repeat_weekdays: weekdayCodes(task.daysOfWeek),
    once_on: task.onceOn ?? null,
    starts_on: task.startsOn ?? null,
    ends_on: task.endsOn ?? null,
    window_minutes: task.windowMinutes,
    pill_description: task.pillDescription ?? null,
    checklist_items: task.checklistItems,
    high_priority: task.highPriority,
    alerts_caregivers: alertsCaregivers(task),
    active: task.active,
  };
}

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

type ToolName =
  | SetupToolName
  | "get_tasks"
  | "add_task"
  | "update_task"
  | "stop_task"
  | "get_calendar"
  | "add_event"
  | "update_event"
  | "cancel_event";

const TOOL_HANDLERS: Record<ToolName, ToolHandler> = {
  get_tasks: async (ctx, { householdId }, input) => {
    const { include_stopped: includeStopped, type } = input;
    const withStopped =
      includeStopped === undefined ? false : booleanField(includeStopped, "include_stopped");
    const only = type === undefined ? undefined : taskTypeField(type);
    const tasks = await listTasksCore(ctx, householdId, !withStopped);
    return tasks.filter((t) => only === undefined || t.type === only).map(taskForModel);
  },
  add_task: async (ctx, { householdId, actor, now }, input) => {
    const args = toAddTaskArgs(input);
    await rejectDuplicateTask(ctx, householdId, { ...args, times: args.times ?? [] });
    const task = await createTaskCore(ctx, actor, householdId, args, now);
    return taskForModel(task);
  },
  update_task: async (ctx, { householdId, actor, now }, input) => {
    const taskId = idOf(ctx, "tasks", input);
    const changes = toTaskChanges(changesOf(input));
    const current = await ctx.db.get(taskId);
    if (current && current.householdId === householdId) {
      if (isAsNeededTask(current)) throw appError("invalid", AS_NEEDED_REFUSAL);
      const merged = mergedForDuplicateCheck(current, changes);
      if (merged.active && DUPLICATE_RELEVANT_KEYS.some((k) => changes[k] !== undefined)) {
        await rejectDuplicateTask(ctx, householdId, merged, taskId);
      }
    }
    const task = await updateTaskCore(ctx, actor, householdId, taskId, changes, now);
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
  ...SETUP_TOOL_HANDLERS,
};

const WORDING_TOOLS: ReadonlySet<string> = new Set(["add_task", "update_task"]);

export interface ToolOutcome {
  text: string;
  isError: boolean;
  taskId?: Id<"tasks">;
}

export async function executeAgentTool(
  ctx: MutationCtx,
  toolCtx: ToolContext,
  call: ToolCall,
): Promise<ToolOutcome> {
  if (!Object.hasOwn(TOOL_HANDLERS, call.name)) {
    return { text: `Unknown tool ${call.name}`, isError: true };
  }
  try {
    const result = await TOOL_HANDLERS[call.name as ToolName](ctx, toolCtx, call.input);
    const text = JSON.stringify(result);
    if (text.length > MAX_TOOL_RESULT_CHARS) {
      return {
        text: `Error: The result is too large (${text.length} characters). Ask for something narrower: get_calendar a shorter date range; get_tasks without include_stopped, or with a type; get_knowledge with a kind.`,
        isError: true,
      };
    }
    if (WORDING_TOOLS.has(call.name)) {
      return { text, isError: false, taskId: (result as { task_id: Id<"tasks"> }).task_id };
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
