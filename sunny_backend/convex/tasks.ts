import { v } from "convex/values";
import type { ObjectType } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation, mutation, query } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { actorUserId, requireEditor, requireReader } from "./lib/access";
import type { Actor } from "./lib/access";
import { appError } from "./lib/errors";
import { isHighPriority } from "./lib/escalation";
import { deleteTask, insertTask, patchTask, purgeTaskBatch } from "./lib/schedule";
import type { TaskFields } from "./lib/schedule";
import { normalizeWeekdays, requireMaxLength, requireNonBlank } from "./lib/text";
import { isLocalDate, isLocalTime } from "./lib/time";
import { taskType } from "./lib/validators";

const MAX_WINDOW_MINUTES = 720;
const DEFAULT_WINDOW_MINUTES = 60;

type TaskDraft = Omit<
  TaskFields,
  "householdId" | "createdByKind" | "createdBy" | "scheduleChangedAt"
>;

function normalizeSchedule(draft: TaskDraft): TaskDraft {
  for (const time of draft.times) {
    if (!isLocalTime(time)) throw appError("invalid", `Time ${time} must be HH:MM`);
  }
  if (new Set(draft.times).size !== draft.times.length) {
    throw appError("invalid", "Times must be unique");
  }
  let daysOfWeek = draft.daysOfWeek;
  if (daysOfWeek !== undefined) {
    daysOfWeek = normalizeWeekdays(daysOfWeek, "Days of week must be 1 (Monday) to 7 (Sunday)");
  }
  for (const [label, date] of [
    ["Once on", draft.onceOn],
    ["Starts on", draft.startsOn],
    ["Ends on", draft.endsOn],
  ] as const) {
    if (date !== undefined && !isLocalDate(date)) {
      throw appError("invalid", `${label} must be YYYY-MM-DD`);
    }
  }
  if (draft.onceOn !== undefined && daysOfWeek !== undefined) {
    throw appError("invalid", "A one-off task cannot also repeat on weekdays");
  }
  if (draft.startsOn !== undefined && draft.endsOn !== undefined && draft.endsOn < draft.startsOn) {
    throw appError("invalid", "Ends on cannot be before starts on");
  }
  const window = draft.windowMinutes;
  if (!Number.isInteger(window) || window < 1 || window > MAX_WINDOW_MINUTES) {
    throw appError("invalid", `Window must be 1 to ${MAX_WINDOW_MINUTES} minutes`);
  }
  return { ...draft, times: [...draft.times].sort(), daysOfWeek };
}

export function isAsNeededTask(
  task: Pick<TaskFields, "type" | "times" | "asNeededMaxPerDay" | "asNeededMinHours">,
): boolean {
  return (
    task.type === "medication" &&
    task.times.length === 0 &&
    (task.asNeededMaxPerDay !== undefined || task.asNeededMinHours !== undefined)
  );
}

export const TASK_CAPS = {
  title: 200,
  displayLabel: 60,
  spokenPrompt: 300,
  pillDescription: 200,
  times: 24,
  checklistItems: 50,
  checklistItem: 200,
} as const;

function enforceSizeCaps(draft: TaskDraft): void {
  requireMaxLength(draft.title, TASK_CAPS.title, "Title");
  requireMaxLength(draft.displayLabel, TASK_CAPS.displayLabel, "Display label");
  requireMaxLength(draft.spokenPrompt.trim(), TASK_CAPS.spokenPrompt, "Spoken prompt");
  if (draft.pillDescription !== undefined) {
    requireMaxLength(draft.pillDescription, TASK_CAPS.pillDescription, "Pill description");
  }
  if (draft.times.length > TASK_CAPS.times) {
    throw appError("invalid", `A task can have at most ${TASK_CAPS.times} times`);
  }
  if (draft.checklistItems.length > TASK_CAPS.checklistItems) {
    throw appError("invalid", `A checklist can have at most ${TASK_CAPS.checklistItems} items`);
  }
  for (const item of draft.checklistItems) {
    requireMaxLength(item, TASK_CAPS.checklistItem, "Checklist item");
  }
}

function validateDraft(draft: TaskDraft): TaskDraft {
  const title = requireNonBlank(draft.title, "Title");
  const displayLabel = requireNonBlank(draft.displayLabel, "Display label");
  enforceSizeCaps({ ...draft, title, displayLabel });
  if (
    draft.active &&
    draft.type === "medication" &&
    draft.times.length === 0 &&
    !isAsNeededTask(draft)
  ) {
    throw appError(
      "invalid",
      "A medication needs at least one time (HH:MM) unless it is as-needed with a limit; ask the caregiver for the time instead of guessing",
    );
  }
  const spokenPrompt = draft.spokenPrompt.trim() || `Time for ${displayLabel}.`;
  const max = draft.asNeededMaxPerDay;
  if (max !== undefined && (!Number.isInteger(max) || max <= 0)) {
    throw appError("invalid", "As-needed maximum per day must be a positive whole number");
  }
  const minHours = draft.asNeededMinHours;
  if (minHours !== undefined && !(Number.isFinite(minHours) && minHours > 0)) {
    throw appError("invalid", "As-needed minimum hours must be positive");
  }
  return normalizeSchedule({ ...draft, title, displayLabel, spokenPrompt });
}

async function loadTask(
  ctx: QueryCtx,
  householdId: Id<"households">,
  taskId: Id<"tasks">,
): Promise<Doc<"tasks">> {
  const task = await ctx.db.get(taskId);
  if (!task || task.householdId !== householdId) throw appError("not_found", "Task not found");
  return task;
}

const createTaskFields = {
  type: taskType,
  title: v.string(),
  displayLabel: v.string(),
  spokenPrompt: v.optional(v.string()),
  pillDescription: v.optional(v.string()),
  checklistItems: v.optional(v.array(v.string())),
  times: v.optional(v.array(v.string())),
  daysOfWeek: v.optional(v.array(v.number())),
  onceOn: v.optional(v.string()),
  startsOn: v.optional(v.string()),
  endsOn: v.optional(v.string()),
  windowMinutes: v.optional(v.number()),
  highPriority: v.optional(v.boolean()),
  asNeededMaxPerDay: v.optional(v.number()),
  asNeededMinHours: v.optional(v.number()),
  active: v.optional(v.boolean()),
};

export type CreateTaskArgs = ObjectType<typeof createTaskFields>;

const taskChangeFields = {
  type: v.optional(taskType),
  title: v.optional(v.string()),
  displayLabel: v.optional(v.string()),
  spokenPrompt: v.optional(v.string()),
  pillDescription: v.optional(v.union(v.string(), v.null())),
  checklistItems: v.optional(v.array(v.string())),
  times: v.optional(v.array(v.string())),
  daysOfWeek: v.optional(v.union(v.array(v.number()), v.null())),
  onceOn: v.optional(v.union(v.string(), v.null())),
  startsOn: v.optional(v.union(v.string(), v.null())),
  endsOn: v.optional(v.union(v.string(), v.null())),
  windowMinutes: v.optional(v.number()),
  highPriority: v.optional(v.boolean()),
  asNeededMaxPerDay: v.optional(v.union(v.number(), v.null())),
  asNeededMinHours: v.optional(v.union(v.number(), v.null())),
  active: v.optional(v.boolean()),
};

export type TaskChanges = ObjectType<typeof taskChangeFields>;

export async function listTasksCore(
  ctx: QueryCtx,
  householdId: Id<"households">,
  activeOnly = false,
): Promise<Doc<"tasks">[]> {
  if (activeOnly) {
    return await ctx.db
      .query("tasks")
      .withIndex("by_household_active", (q) => q.eq("householdId", householdId).eq("active", true))
      .collect();
  }
  return await ctx.db
    .query("tasks")
    .withIndex("by_household", (q) => q.eq("householdId", householdId))
    .collect();
}

export async function createTaskCore(
  ctx: MutationCtx,
  actor: Actor,
  householdId: Id<"households">,
  args: CreateTaskArgs,
  now: number,
): Promise<Doc<"tasks">> {
  const fields: TaskDraft = {
    ...args,
    spokenPrompt: args.spokenPrompt ?? "",
    checklistItems: args.checklistItems ?? [],
    times: args.times ?? [],
    windowMinutes: args.windowMinutes ?? DEFAULT_WINDOW_MINUTES,
    highPriority: args.highPriority ?? false,
    active: args.active ?? true,
  };
  const draft = validateDraft(fields);
  const taskId = await insertTask(
    ctx,
    actor,
    {
      ...draft,
      householdId,
      createdByKind: "caregiver",
      createdBy: actorUserId(actor),
    },
    now,
  );
  return (await ctx.db.get(taskId))!;
}

export async function updateTaskCore(
  ctx: MutationCtx,
  actor: Actor,
  householdId: Id<"households">,
  taskId: Id<"tasks">,
  changes: TaskChanges,
  now: number,
): Promise<Doc<"tasks">> {
  const task = await loadTask(ctx, householdId, taskId);
  const orUndefined = <T>(value: T | null | undefined, current: T | undefined) =>
    value === undefined ? current : (value ?? undefined);
  const draft = validateDraft({
    type: changes.type ?? task.type,
    title: changes.title ?? task.title,
    displayLabel: changes.displayLabel ?? task.displayLabel,
    spokenPrompt: changes.spokenPrompt ?? task.spokenPrompt,
    pillDescription: orUndefined(changes.pillDescription, task.pillDescription),
    checklistItems: changes.checklistItems ?? task.checklistItems,
    times: changes.times ?? task.times,
    daysOfWeek: orUndefined(changes.daysOfWeek, task.daysOfWeek),
    onceOn: orUndefined(changes.onceOn, task.onceOn),
    startsOn: orUndefined(changes.startsOn, task.startsOn),
    endsOn: orUndefined(changes.endsOn, task.endsOn),
    windowMinutes: changes.windowMinutes ?? task.windowMinutes,
    highPriority: changes.highPriority ?? isHighPriority(task),
    asNeededMaxPerDay: orUndefined(changes.asNeededMaxPerDay, task.asNeededMaxPerDay),
    asNeededMinHours: orUndefined(changes.asNeededMinHours, task.asNeededMinHours),
    active: changes.active ?? task.active,
  });
  return await patchTask(ctx, actor, task, draft, now);
}

export const list = query({
  args: { householdId: v.id("households") },
  handler: async (ctx, args): Promise<Doc<"tasks">[]> => {
    await requireReader(ctx, args.householdId);
    return await listTasksCore(ctx, args.householdId);
  },
});

export const create = mutation({
  args: { householdId: v.id("households"), ...createTaskFields },
  handler: async (ctx, args): Promise<Id<"tasks">> => {
    const actor = await requireEditor(ctx, args.householdId);
    const { householdId, ...rest } = args;
    return (await createTaskCore(ctx, actor, householdId, rest, Date.now()))._id;
  },
});

export const update = mutation({
  args: { householdId: v.id("households"), taskId: v.id("tasks"), ...taskChangeFields },
  handler: async (ctx, args): Promise<null> => {
    const actor = await requireEditor(ctx, args.householdId);
    const { householdId, taskId, ...changes } = args;
    await updateTaskCore(ctx, actor, householdId, taskId, changes, Date.now());
    return null;
  },
});

export const remove = mutation({
  args: { householdId: v.id("households"), taskId: v.id("tasks") },
  handler: async (ctx, args): Promise<null> => {
    const actor = await requireEditor(ctx, args.householdId);
    await deleteTask(ctx, actor, await loadTask(ctx, args.householdId, args.taskId));
    return null;
  },
});

export const purgeTaskData = internalMutation({
  args: { householdId: v.id("households"), taskId: v.id("tasks") },
  handler: async (ctx, args): Promise<null> => {
    if (await purgeTaskBatch(ctx, args.householdId, args.taskId)) {
      await ctx.scheduler.runAfter(0, internal.tasks.purgeTaskData, args);
    }
    return null;
  },
});
