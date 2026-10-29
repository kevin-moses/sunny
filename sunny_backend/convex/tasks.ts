// tasks.ts
// Purpose: Caregiver task and escalation policy management, ported from the Supabase tasks
// migration. Tasks: list, create, update and hard delete, with the validation the SQL CHECK
// constraints performed (non-blank wording, unique "HH:MM" times, weekdays 1..7, a one-off
// date excludes weekdays, ends on or after starts, window 1..720 minutes, positive as-needed
// limits, a policy from the same household), the default spoken prompt, and the resync of
// instances after a schedule change (lib/schedule). Escalation policies: list, create,
// rename or change steps, and delete; seeded policies (systemKey set) are never deleted and
// their systemKey is not an argument anywhere, so it cannot change. Editors write and
// readers read, as RLS did.
//
// Last modified: 2026-10-28

import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { mutation, query } from "./_generated/server";
import type { QueryCtx } from "./_generated/server";
import { requireEditor, requireReader } from "./lib/access";
import { appError } from "./lib/errors";
import { deleteTask, insertTask, patchTask } from "./lib/schedule";
import type { TaskFields } from "./lib/schedule";
import { isLocalDate, isLocalTime } from "./lib/time";
import { escalationStep, taskType } from "./lib/validators";
import type { EscalationStep } from "./lib/validators";

const MAX_WINDOW_MINUTES = 720;
const DEFAULT_WINDOW_MINUTES = 60;

/** The writable task fields after defaults, before validation. */
type TaskDraft = Omit<
  TaskFields,
  "householdId" | "createdByKind" | "createdBy" | "scheduleChangedAt"
>;

/**
 * purpose: Reject a blank string.
 * @param value: (string) Candidate.
 * @param label: (string) Field name for the error message.
 * @return: (string) The trimmed value.
 */
function requireNonBlank(value: string, label: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) throw appError("invalid", `${label} cannot be blank`);
  return trimmed;
}

/**
 * purpose: Validate and normalize the schedule part of a task (the SQL CHECK constraints).
 *          Times and weekdays are de-duplicated and sorted.
 * @param draft: (TaskDraft) The task fields.
 * @return: (TaskDraft) The draft with times and daysOfWeek normalized.
 * @raises invalid for any rule violation.
 */
function normalizeSchedule(draft: TaskDraft): TaskDraft {
  for (const time of draft.times) {
    if (!isLocalTime(time)) throw appError("invalid", `Time ${time} must be HH:MM`);
  }
  if (new Set(draft.times).size !== draft.times.length) {
    throw appError("invalid", "Times must be unique");
  }
  let daysOfWeek = draft.daysOfWeek;
  if (daysOfWeek !== undefined) {
    if (!daysOfWeek.every((d) => Number.isInteger(d) && d >= 1 && d <= 7)) {
      throw appError("invalid", "Days of week must be 1 (Monday) to 7 (Sunday)");
    }
    daysOfWeek = [...new Set(daysOfWeek)].sort((a, b) => a - b);
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

/**
 * purpose: Validate a whole task draft: wording, schedule, as-needed limits and policy; fill a
 *          blank spoken prompt with "Time for <displayLabel>.".
 * @param ctx: (QueryCtx) Context.
 * @param householdId: (Id<"households">) The task's household.
 * @param draft: (TaskDraft) The task fields.
 * @return: (Promise<TaskDraft>) The normalized draft.
 * @raises invalid for any rule violation.
 */
async function validateDraft(
  ctx: QueryCtx,
  householdId: Id<"households">,
  draft: TaskDraft,
): Promise<TaskDraft> {
  const title = requireNonBlank(draft.title, "Title");
  const displayLabel = requireNonBlank(draft.displayLabel, "Display label");
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

/**
 * purpose: Load a task of the household.
 * @param ctx: (QueryCtx) Context.
 * @param householdId: (Id<"households">) Household that must own the task.
 * @param taskId: (Id<"tasks">) Task.
 * @return: (Promise<Doc<"tasks">>) The task.
 * @raises not_found when it does not exist or belongs to another household.
 */
async function loadTask(
  ctx: QueryCtx,
  householdId: Id<"households">,
  taskId: Id<"tasks">,
): Promise<Doc<"tasks">> {
  const task = await ctx.db.get(taskId);
  if (!task || task.householdId !== householdId) throw appError("not_found", "Task not found");
  return task;
}

/**
 * purpose: The household's tasks, active and inactive. Readers only.
 * @param householdId: (Id<"households">) Household.
 * @return: (Doc<"tasks">[]) Tasks in creation order.
 */
export const list = query({
  args: { householdId: v.id("households") },
  handler: async (ctx, args): Promise<Doc<"tasks">[]> => {
    await requireReader(ctx, args.householdId);
    return await ctx.db
      .query("tasks")
      .withIndex("by_household", (q) => q.eq("householdId", args.householdId))
      .collect();
  },
});

/**
 * purpose: Create a task and expand its first instances. Editors only. A blank spokenPrompt
 *          becomes "Time for <displayLabel>."; windowMinutes defaults to 60.
 * @param householdId: (Id<"households">) Household.
 * @param type: (TaskType) Kind of task.
 * @param title: (string) Caregiver-facing name.
 * @param displayLabel: (string) Short label the senior sees.
 * @param spokenPrompt: (string, optional) Exact prompt sentence.
 * @param pillDescription: (string, optional) What the pills look like.
 * @param checklistItems: (string[], optional) Checklist entries.
 * @param times: (string[], optional) Local "HH:MM" times; empty = unscheduled.
 * @param daysOfWeek: (number[], optional) ISO weekdays; absent = every day.
 * @param onceOn: (string, optional) One-off local date.
 * @param startsOn: (string, optional) First local date.
 * @param endsOn: (string, optional) Last local date.
 * @param windowMinutes: (number, optional) Confirmation window, 1..720.
 * @param escalationPolicyId: (Id<"escalationPolicies">, optional) Policy of this household.
 * @param asNeededMaxPerDay: (number, optional) As-needed daily limit.
 * @param asNeededMinHours: (number, optional) As-needed minimum gap in hours.
 * @param active: (boolean, optional) Defaults to true.
 * @return: (Id<"tasks">) The new task.
 */
export const create = mutation({
  args: {
    householdId: v.id("households"),
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
  },
  handler: async (ctx, args): Promise<Id<"tasks">> => {
    const actor = await requireEditor(ctx, args.householdId);
    const { householdId, ...rest } = args;
    const draft = await validateDraft(ctx, householdId, {
      ...rest,
      spokenPrompt: rest.spokenPrompt ?? "",
      checklistItems: rest.checklistItems ?? [],
      times: rest.times ?? [],
      windowMinutes: rest.windowMinutes ?? DEFAULT_WINDOW_MINUTES,
      active: rest.active ?? true,
    });
    return await insertTask(
      ctx,
      actor,
      { ...draft, householdId, createdByKind: "caregiver", createdBy: actor.userId },
      Date.now(),
    );
  },
});

/**
 * purpose: Change a task; fields left out are unchanged and null clears an optional field.
 *          Editors only. A schedule change (times, daysOfWeek, onceOn, startsOn, endsOn,
 *          windowMinutes, active) stamps scheduleChangedAt and resyncs the task's instances:
 *          deactivating removes its upcoming, due and escalated instances.
 * @param householdId: (Id<"households">) Household.
 * @param taskId: (Id<"tasks">) Task to change.
 * @param type: (TaskType, optional) Kind of task.
 * @param title: (string, optional) Caregiver-facing name.
 * @param displayLabel: (string, optional) Short label.
 * @param spokenPrompt: (string, optional) Prompt sentence; blank restores the default.
 * @param pillDescription: (string | null, optional) Pill description.
 * @param checklistItems: (string[], optional) Checklist entries.
 * @param times: (string[], optional) Local "HH:MM" times.
 * @param daysOfWeek: (number[] | null, optional) ISO weekdays; null = every day.
 * @param onceOn: (string | null, optional) One-off date.
 * @param startsOn: (string | null, optional) First date.
 * @param endsOn: (string | null, optional) Last date.
 * @param windowMinutes: (number, optional) Confirmation window, 1..720.
 * @param escalationPolicyId: (Id<"escalationPolicies"> | null, optional) Policy; null = none.
 * @param asNeededMaxPerDay: (number | null, optional) As-needed daily limit.
 * @param asNeededMinHours: (number | null, optional) As-needed minimum gap in hours.
 * @param active: (boolean, optional) Whether the task runs.
 * @return: (null)
 */
export const update = mutation({
  args: {
    householdId: v.id("households"),
    taskId: v.id("tasks"),
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
  },
  handler: async (ctx, args): Promise<null> => {
    const actor = await requireEditor(ctx, args.householdId);
    const task = await loadTask(ctx, args.householdId, args.taskId);
    const orUndefined = <T>(value: T | null | undefined, current: T | undefined) =>
      value === undefined ? current : (value ?? undefined);
    const draft = await validateDraft(ctx, task.householdId, {
      type: args.type ?? task.type,
      title: args.title ?? task.title,
      displayLabel: args.displayLabel ?? task.displayLabel,
      spokenPrompt: args.spokenPrompt ?? task.spokenPrompt,
      pillDescription: orUndefined(args.pillDescription, task.pillDescription),
      checklistItems: args.checklistItems ?? task.checklistItems,
      times: args.times ?? task.times,
      daysOfWeek: orUndefined(args.daysOfWeek, task.daysOfWeek),
      onceOn: orUndefined(args.onceOn, task.onceOn),
      startsOn: orUndefined(args.startsOn, task.startsOn),
      endsOn: orUndefined(args.endsOn, task.endsOn),
      windowMinutes: args.windowMinutes ?? task.windowMinutes,
      escalationPolicyId: orUndefined(args.escalationPolicyId, task.escalationPolicyId),
      asNeededMaxPerDay: orUndefined(args.asNeededMaxPerDay, task.asNeededMaxPerDay),
      asNeededMinHours: orUndefined(args.asNeededMinHours, task.asNeededMinHours),
      active: args.active ?? task.active,
    });
    await patchTask(ctx, actor, task, draft, Date.now());
    return null;
  },
});

/**
 * purpose: Hard delete a task together with its instances (and their notifications) and dose
 *          log rows. Editors only. Prefer update with active = false to keep history.
 * @param householdId: (Id<"households">) Household.
 * @param taskId: (Id<"tasks">) Task to delete.
 * @return: (null)
 */
export const remove = mutation({
  args: { householdId: v.id("households"), taskId: v.id("tasks") },
  handler: async (ctx, args): Promise<null> => {
    const actor = await requireEditor(ctx, args.householdId);
    await deleteTask(ctx, actor, await loadTask(ctx, args.householdId, args.taskId));
    return null;
  },
});

/**
 * purpose: Reject steps that cannot run (a negative or fractional offset).
 * @param steps: (EscalationStep[]) Steps in order; a step's position is its index.
 * @return: (void)
 * @raises invalid when an offset is not a whole number of minutes, 0 or more.
 */
function assertSteps(steps: EscalationStep[]): void {
  for (const step of steps) {
    if (!Number.isInteger(step.offsetMinutes) || step.offsetMinutes < 0) {
      throw appError("invalid", "Step offsets must be whole minutes, 0 or more");
    }
  }
}

/**
 * purpose: Reject a policy name that is blank or already used in the household.
 * @param ctx: (QueryCtx) Context.
 * @param householdId: (Id<"households">) Household.
 * @param name: (string) Candidate name.
 * @param exceptId: (Id<"escalationPolicies">, optional) Policy being renamed.
 * @return: (Promise<string>) The trimmed name.
 * @raises invalid when blank or taken.
 */
async function requirePolicyName(
  ctx: QueryCtx,
  householdId: Id<"households">,
  name: string,
  exceptId?: Id<"escalationPolicies">,
): Promise<string> {
  const trimmed = requireNonBlank(name, "Policy name");
  const policies = await ctx.db
    .query("escalationPolicies")
    .withIndex("by_household", (q) => q.eq("householdId", householdId))
    .collect();
  if (policies.some((p) => p.name === trimmed && p._id !== exceptId)) {
    throw appError("invalid", "A policy with this name already exists");
  }
  return trimmed;
}

/**
 * purpose: Load an escalation policy of the household.
 * @param ctx: (QueryCtx) Context.
 * @param householdId: (Id<"households">) Household that must own it.
 * @param policyId: (Id<"escalationPolicies">) Policy.
 * @return: (Promise<Doc<"escalationPolicies">>) The policy.
 * @raises not_found when missing or owned by another household.
 */
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

/**
 * purpose: The household's escalation policies with their ordered steps. Readers only.
 * @param householdId: (Id<"households">) Household.
 * @return: (Doc<"escalationPolicies">[]) Policies.
 */
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

/**
 * purpose: Create a custom escalation policy. Editors only.
 * @param householdId: (Id<"households">) Household.
 * @param name: (string) Unique, non-blank name.
 * @param steps: (EscalationStep[]) Ordered steps.
 * @return: (Id<"escalationPolicies">) The new policy.
 */
export const createPolicy = mutation({
  args: { householdId: v.id("households"), name: v.string(), steps: v.array(escalationStep) },
  handler: async (ctx, args): Promise<Id<"escalationPolicies">> => {
    await requireEditor(ctx, args.householdId);
    const name = await requirePolicyName(ctx, args.householdId, args.name);
    assertSteps(args.steps);
    return await ctx.db.insert("escalationPolicies", {
      householdId: args.householdId,
      name,
      steps: args.steps,
    });
  },
});

/**
 * purpose: Rename a policy and/or replace its steps; fields left out are unchanged. Seeded
 *          policies may be renamed and tuned (their systemKey never changes). Editors only.
 * @param householdId: (Id<"households">) Household.
 * @param policyId: (Id<"escalationPolicies">) Policy.
 * @param name: (string, optional) New unique, non-blank name.
 * @param steps: (EscalationStep[], optional) New ordered steps.
 * @return: (null)
 */
export const updatePolicy = mutation({
  args: {
    householdId: v.id("households"),
    policyId: v.id("escalationPolicies"),
    name: v.optional(v.string()),
    steps: v.optional(v.array(escalationStep)),
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
      patch.steps = args.steps;
    }
    await ctx.db.patch(policy._id, patch);
    return null;
  },
});

/**
 * purpose: Delete a custom policy; tasks that used it are left with no policy (the SQL
 *          foreign key's `on delete set null`). Seeded policies cannot be deleted. Editors only.
 * @param householdId: (Id<"households">) Household.
 * @param policyId: (Id<"escalationPolicies">) Policy.
 * @return: (null)
 * @raises forbidden for a seeded policy.
 */
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
