import { v } from "convex/values";
import type { ObjectType } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation, mutation, query } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { actorUserId, requireEditor, requireReader, SYSTEM_ACTOR } from "./lib/access";
import type { Actor } from "./lib/access";
import { isAnytimeTask } from "./lib/anytime";
import { appError } from "./lib/errors";
import { assignStepIds } from "./lib/policies";
import { deleteTask, insertTask, patchTask, purgeTaskBatch } from "./lib/schedule";
import type { TaskFields } from "./lib/schedule";
import { normalizeWeekdays, requireMaxLength, requireNonBlank } from "./lib/text";
import { isLocalDate, isLocalTime } from "./lib/time";
import { escalationStepInput, taskType } from "./lib/validators";
import type { EscalationStepInput, TaskType } from "./lib/validators";

const MAX_WINDOW_MINUTES = 720;
const MAX_TITLE_LENGTH = 200;
const MAX_DISPLAY_LABEL_LENGTH = 60;
const MAX_SPOKEN_PROMPT_LENGTH = 300;
const MAX_PILL_DESCRIPTION_LENGTH = 200;
const MAX_TIMES = 24;
const MAX_CHECKLIST_ITEMS = 50;
const MAX_CHECKLIST_ITEM_LENGTH = 200;
const DEFAULT_WINDOW_MINUTES = 60;
const MAX_POLICY_NAME_LENGTH = 80;
const MAX_POLICY_STEPS = 10;
const MAX_STEP_OFFSET_MINUTES = 1440;
const BACKFILL_HOUSEHOLD_PAGE = 20;
const BACKFILL_TASK_BATCH = 100;

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

function enforceSizeCaps(draft: TaskDraft, written: ReadonlySet<keyof TaskDraft>): void {
  if (written.has("title")) requireMaxLength(draft.title, MAX_TITLE_LENGTH, "Title");
  if (written.has("displayLabel")) {
    requireMaxLength(draft.displayLabel, MAX_DISPLAY_LABEL_LENGTH, "Display label");
  }
  if (written.has("spokenPrompt")) {
    requireMaxLength(draft.spokenPrompt.trim(), MAX_SPOKEN_PROMPT_LENGTH, "Spoken prompt");
  }
  if (written.has("pillDescription") && draft.pillDescription !== undefined) {
    requireMaxLength(draft.pillDescription, MAX_PILL_DESCRIPTION_LENGTH, "Pill description");
  }
  if (written.has("times") && draft.times.length > MAX_TIMES) {
    throw appError("invalid", `A task can have at most ${MAX_TIMES} times`);
  }
  if (written.has("checklistItems")) {
    if (draft.checklistItems.length > MAX_CHECKLIST_ITEMS) {
      throw appError("invalid", `A checklist can have at most ${MAX_CHECKLIST_ITEMS} items`);
    }
    for (const item of draft.checklistItems) {
      requireMaxLength(item, MAX_CHECKLIST_ITEM_LENGTH, "Checklist item");
    }
  }
}

async function validateDraft(
  ctx: QueryCtx,
  householdId: Id<"households">,
  draft: TaskDraft,
  written: ReadonlySet<keyof TaskDraft>,
): Promise<TaskDraft> {
  const title = requireNonBlank(draft.title, "Title");
  const displayLabel = requireNonBlank(draft.displayLabel, "Display label");
  enforceSizeCaps({ ...draft, title, displayLabel }, written);
  if (
    draft.active &&
    draft.type === "medication" &&
    draft.times.length === 0 &&
    !isAsNeededTask(draft) &&
    (written.has("times") ||
      written.has("type") ||
      written.has("active") ||
      written.has("asNeededMaxPerDay") ||
      written.has("asNeededMinHours"))
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
  if (draft.escalationPolicyId !== undefined) {
    const policy = await ctx.db.get(draft.escalationPolicyId);
    if (!policy || policy.householdId !== householdId) {
      throw appError("invalid", "Escalation policy not found in this household");
    }
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
  escalationPolicyId: v.optional(v.id("escalationPolicies")),
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
  escalationPolicyId: v.optional(v.union(v.id("escalationPolicies"), v.null())),
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
    active: args.active ?? true,
  };
  const written = new Set(Object.keys(fields) as (keyof TaskDraft)[]);
  const draft = await validateDraft(ctx, householdId, fields, written);
  const escalationPolicyId =
    draft.escalationPolicyId ??
    (isAnytimeTask(draft) ? undefined : await defaultPolicyId(ctx, householdId, draft.type));
  const taskId = await insertTask(
    ctx,
    actor,
    {
      ...draft,
      escalationPolicyId,
      householdId,
      createdByKind: "caregiver",
      createdBy: actorUserId(actor),
    },
    now,
  );
  return (await ctx.db.get(taskId))!;
}

export async function defaultPolicyId(
  ctx: QueryCtx,
  householdId: Id<"households">,
  type: TaskType,
): Promise<Id<"escalationPolicies"> | undefined> {
  const systemKey = type === "medication" ? "medication" : "prompt_only";
  const policy = await ctx.db
    .query("escalationPolicies")
    .withIndex("by_household_system_key", (q) =>
      q.eq("householdId", householdId).eq("systemKey", systemKey),
    )
    .first();
  return policy?._id;
}

async function policyForChange(
  ctx: QueryCtx,
  task: Doc<"tasks">,
  newType: TaskType,
  newTimes: string[],
): Promise<Id<"escalationPolicies"> | null | undefined> {
  const wasAnytime = isAnytimeTask(task);
  const nowAnytime = isAnytimeTask({ type: newType, times: newTimes });
  const current =
    task.escalationPolicyId === undefined ? null : await ctx.db.get(task.escalationPolicyId);
  const seeded =
    current !== null && current.householdId === task.householdId && current.systemKey !== undefined;
  if (nowAnytime) return seeded ? null : undefined;
  if (task.escalationPolicyId === undefined) {
    return wasAnytime ? await defaultPolicyId(ctx, task.householdId, newType) : undefined;
  }
  if ((task.type === "medication") === (newType === "medication") || !seeded) return undefined;
  return await defaultPolicyId(ctx, task.householdId, newType);
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
  const switchedPolicy =
    (changes.type !== undefined || changes.times !== undefined) &&
    changes.escalationPolicyId === undefined
      ? await policyForChange(ctx, task, changes.type ?? task.type, changes.times ?? task.times)
      : undefined;
  const written = new Set(
    (Object.keys(changes) as (keyof TaskChanges)[]).filter((k) => changes[k] !== undefined),
  ) as ReadonlySet<keyof TaskDraft>;
  const draft = await validateDraft(
    ctx,
    task.householdId,
    {
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
      escalationPolicyId:
        switchedPolicy === undefined
          ? orUndefined(changes.escalationPolicyId, task.escalationPolicyId)
          : (switchedPolicy ?? undefined),
      asNeededMaxPerDay: orUndefined(changes.asNeededMaxPerDay, task.asNeededMaxPerDay),
      asNeededMinHours: orUndefined(changes.asNeededMinHours, task.asNeededMinHours),
      active: changes.active ?? task.active,
    },
    written,
  );
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

export const backfillDefaultPolicies = internalMutation({
  args: { cursor: v.optional(v.string()) },
  handler: async (ctx, args): Promise<null> => {
    const page = await ctx.db
      .query("households")
      .paginate({ numItems: BACKFILL_HOUSEHOLD_PAGE, cursor: args.cursor ?? null });
    for (const household of page.page) {
      await ctx.scheduler.runAfter(0, internal.tasks.backfillHouseholdPolicies, {
        householdId: household._id,
      });
    }
    if (!page.isDone) {
      await ctx.scheduler.runAfter(0, internal.tasks.backfillDefaultPolicies, {
        cursor: page.continueCursor,
      });
    }
    return null;
  },
});

export const backfillHouseholdPolicies = internalMutation({
  args: { householdId: v.id("households"), cursor: v.optional(v.string()) },
  handler: async (ctx, args): Promise<null> => {
    const now = Date.now();
    const page = await ctx.db
      .query("tasks")
      .withIndex("by_household", (q) => q.eq("householdId", args.householdId))
      .paginate({ numItems: BACKFILL_TASK_BATCH, cursor: args.cursor ?? null });
    for (const task of page.page) {
      if (task.escalationPolicyId !== undefined) continue;
      const policyId = await defaultPolicyId(ctx, args.householdId, task.type);
      if (policyId === undefined) continue;
      await patchTask(ctx, SYSTEM_ACTOR, task, { escalationPolicyId: policyId }, now);
    }
    if (!page.isDone) {
      await ctx.scheduler.runAfter(0, internal.tasks.backfillHouseholdPolicies, {
        householdId: args.householdId,
        cursor: page.continueCursor,
      });
    }
    return null;
  },
});

function assertSteps(steps: EscalationStepInput[]): void {
  if (steps.length > MAX_POLICY_STEPS) {
    throw appError("invalid", `A policy can have ${MAX_POLICY_STEPS} steps at most`);
  }
  for (const step of steps) {
    const offset = step.offsetMinutes;
    if (!Number.isInteger(offset) || offset < 0 || offset > MAX_STEP_OFFSET_MINUTES) {
      throw appError(
        "invalid",
        `Step offsets must be whole minutes from 0 to ${MAX_STEP_OFFSET_MINUTES}`,
      );
    }
  }
}

async function requirePolicyName(
  ctx: QueryCtx,
  householdId: Id<"households">,
  name: string,
  exceptId?: Id<"escalationPolicies">,
): Promise<string> {
  const trimmed = requireMaxLength(
    requireNonBlank(name, "Policy name"),
    MAX_POLICY_NAME_LENGTH,
    "Policy name",
  );
  const policies = await ctx.db
    .query("escalationPolicies")
    .withIndex("by_household", (q) => q.eq("householdId", householdId))
    .collect();
  if (policies.some((p) => p.name === trimmed && p._id !== exceptId)) {
    throw appError("invalid", "A policy with this name already exists");
  }
  return trimmed;
}

async function loadPolicy(
  ctx: QueryCtx,
  householdId: Id<"households">,
  policyId: Id<"escalationPolicies">,
): Promise<Doc<"escalationPolicies">> {
  const policy = await ctx.db.get(policyId);
  if (!policy || policy.householdId !== householdId) {
    throw appError("not_found", "Escalation policy not found");
  }
  return policy;
}

export const listPolicies = query({
  args: { householdId: v.id("households") },
  handler: async (ctx, args): Promise<Doc<"escalationPolicies">[]> => {
    await requireReader(ctx, args.householdId);
    return await ctx.db
      .query("escalationPolicies")
      .withIndex("by_household", (q) => q.eq("householdId", args.householdId))
      .collect();
  },
});

export const createPolicy = mutation({
  args: {
    householdId: v.id("households"),
    name: v.string(),
    steps: v.array(escalationStepInput),
  },
  handler: async (ctx, args): Promise<Id<"escalationPolicies">> => {
    await requireEditor(ctx, args.householdId);
    const name = await requirePolicyName(ctx, args.householdId, args.name);
    assertSteps(args.steps);
    return await ctx.db.insert("escalationPolicies", {
      householdId: args.householdId,
      name,
      steps: assignStepIds(args.steps),
    });
  },
});

export const updatePolicy = mutation({
  args: {
    householdId: v.id("households"),
    policyId: v.id("escalationPolicies"),
    name: v.optional(v.string()),
    steps: v.optional(v.array(escalationStepInput)),
  },
  handler: async (ctx, args): Promise<null> => {
    await requireEditor(ctx, args.householdId);
    const policy = await loadPolicy(ctx, args.householdId, args.policyId);
    const patch: Partial<Pick<Doc<"escalationPolicies">, "name" | "steps">> = {};
    if (args.name !== undefined) {
      patch.name = await requirePolicyName(ctx, args.householdId, args.name, policy._id);
    }
    if (args.steps !== undefined) {
      assertSteps(args.steps);
      patch.steps = assignStepIds(args.steps, new Set(policy.steps.map((s) => s.id)));
    }
    await ctx.db.patch(policy._id, patch);
    return null;
  },
});

export const removePolicy = mutation({
  args: { householdId: v.id("households"), policyId: v.id("escalationPolicies") },
  handler: async (ctx, args): Promise<null> => {
    const actor = await requireEditor(ctx, args.householdId);
    const policy = await loadPolicy(ctx, args.householdId, args.policyId);
    if (policy.systemKey !== undefined) {
      throw appError("forbidden", "Default escalation policies cannot be deleted");
    }
    const users = await ctx.db
      .query("tasks")
      .withIndex("by_household_policy", (q) =>
        q.eq("householdId", args.householdId).eq("escalationPolicyId", policy._id),
      )
      .collect();
    const now = Date.now();
    for (const task of users) {
      await patchTask(ctx, actor, task, { escalationPolicyId: undefined }, now);
    }
    await ctx.db.delete(policy._id);
    return null;
  },
});
