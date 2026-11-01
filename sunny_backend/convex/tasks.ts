// tasks.ts
// Purpose: Caregiver task and escalation policy management, ported from the Supabase tasks
// migration. Tasks: list, create, update and hard delete, with the validation the SQL CHECK
// constraints performed (non-blank wording, unique "HH:MM" times, weekdays 1..7, a one-off
// date excludes weekdays, ends on or after starts, window 1..720 minutes, positive as-needed
// limits, a policy from the same household), the default spoken prompt, and the resync of
// instances after a schedule change (lib/schedule). Deleting a task removes the task at once
// and its instances, notifications and dose log in bounded background batches
// (purgeTaskData). Escalation policies: list, create, rename or change steps, and delete;
// every step has a server-assigned stable id; seeded policies (systemKey set) are never
// deleted and their systemKey is not an argument anywhere, so it cannot change. Editors write
// and readers read, as RLS did. The create, update and list logic lives in exported cores
// (createTaskCore, updateTaskCore, listTasksCore) that the public mutations and the household
// agent's task tools (lib/agentTools.ts) share, so validation, audit and instance resync are
// identical; only the public mutations check the caller's role, and only they hard delete.
//
// Last modified: 2026-11-01

import { v } from "convex/values";
import type { ObjectType } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation, mutation, query } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { actorUserId, requireEditor, requireReader } from "./lib/access";
import type { Actor } from "./lib/access";
import { appError } from "./lib/errors";
import { assignStepIds } from "./lib/policies";
import { deleteTask, insertTask, patchTask, purgeTaskBatch } from "./lib/schedule";
import type { TaskFields } from "./lib/schedule";
import { normalizeWeekdays, requireMaxLength, requireNonBlank } from "./lib/text";
import { isLocalDate, isLocalTime } from "./lib/time";
import { escalationStepInput, taskType } from "./lib/validators";
import type { EscalationStepInput } from "./lib/validators";

const MAX_WINDOW_MINUTES = 720;
const DEFAULT_WINDOW_MINUTES = 60;
const MAX_POLICY_NAME_LENGTH = 80;
const MAX_POLICY_STEPS = 10;
const MAX_STEP_OFFSET_MINUTES = 1440;

/** The writable task fields after defaults, before validation. */
type TaskDraft = Omit<
  TaskFields,
  "householdId" | "createdByKind" | "createdBy" | "scheduleChangedAt"
>;

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

/** Fields a new task is created from (everything but the household). */
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

/** Arguments of createTaskCore: the task's fields as a caller supplies them. */
export type CreateTaskArgs = ObjectType<typeof createTaskFields>;

/** Fields of a task change: absent = unchanged, null clears a clearable field. */
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

/** Edits to a task: a key that is absent is unchanged; a clearable key given as null is cleared. */
export type TaskChanges = ObjectType<typeof taskChangeFields>;

/**
 * purpose: The household's tasks, active and inactive (core of list, shared with the agent).
 * @param ctx: (QueryCtx) Context.
 * @param householdId: (Id<"households">) Household.
 * @return: (Promise<Doc<"tasks">[]>) Tasks in creation order.
 */
export async function listTasksCore(
  ctx: QueryCtx,
  householdId: Id<"households">,
): Promise<Doc<"tasks">[]> {
  return await ctx.db
    .query("tasks")
    .withIndex("by_household", (q) => q.eq("householdId", householdId))
    .collect();
}

/**
 * purpose: Core of create, reusable by agent tools: validate and insert a task and expand its
 *          first instances. The caller has already checked that the actor may edit the
 *          household. A blank spokenPrompt becomes "Time for <displayLabel>."; windowMinutes
 *          defaults to 60; with no escalationPolicyId the task has no escalation policy and
 *          so never escalates (no default policy is assigned). The task is recorded as
 *          created by a caregiver.
 * @param ctx: (MutationCtx) Context.
 * @param actor: (Actor) Who creates it (audit actor).
 * @param householdId: (Id<"households">) Household.
 * @param args: (CreateTaskArgs) The task's fields.
 * @param now: (number) Epoch ms.
 * @param createdBy: (string, optional) Clerk user id recorded as the creator; defaults to the
 *        actor's own user id. The agent passes the requesting caregiver.
 * @return: (Promise<Id<"tasks">>) The new task.
 * @raises invalid for any rule violation.
 */
export async function createTaskCore(
  ctx: MutationCtx,
  actor: Actor,
  householdId: Id<"households">,
  args: CreateTaskArgs,
  now: number,
  createdBy: string | undefined = actorUserId(actor),
): Promise<Id<"tasks">> {
  const draft = await validateDraft(ctx, householdId, {
    ...args,
    spokenPrompt: args.spokenPrompt ?? "",
    checklistItems: args.checklistItems ?? [],
    times: args.times ?? [],
    windowMinutes: args.windowMinutes ?? DEFAULT_WINDOW_MINUTES,
    active: args.active ?? true,
  });
  return await insertTask(
    ctx,
    actor,
    { ...draft, householdId, createdByKind: "caregiver", createdBy },
    now,
  );
}

/**
 * purpose: Core of update, reusable by agent tools: merge changes into a task of the
 *          household, validate the result, patch and audit it, and resync instances when the
 *          schedule changed (deactivating removes upcoming, due and escalated instances).
 * @param ctx: (MutationCtx) Context.
 * @param actor: (Actor) Who changes it (audit actor).
 * @param householdId: (Id<"households">) Household the caller acts for.
 * @param taskId: (Id<"tasks">) Task to change.
 * @param changes: (TaskChanges) Absent key = unchanged, null = cleared. daysOfWeek null means
 *        every day; a blank spokenPrompt restores the default.
 * @param now: (number) Epoch ms.
 * @return: (Promise<Doc<"tasks">>) The task after the change.
 * @raises not_found for a missing or foreign task; invalid for bad values.
 */
export async function updateTaskCore(
  ctx: MutationCtx,
  actor: Actor,
  householdId: Id<"households">,
  taskId: Id<"tasks">,
  changes: TaskChanges,
  now: number,
): Promise<Doc<"tasks">> {
  const task = await loadTask(ctx, householdId, taskId);
  /**
   * purpose: Merge an update value with the current one: undefined keeps the current value,
   *          null clears it.
   * @param value: (T | null | undefined) The value from the changes.
   * @param current: (T | undefined) The task's current value.
   * @return: (T | undefined) The value to write.
   */
  const orUndefined = <T>(value: T | null | undefined, current: T | undefined) =>
    value === undefined ? current : (value ?? undefined);
  const draft = await validateDraft(ctx, task.householdId, {
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
    escalationPolicyId: orUndefined(changes.escalationPolicyId, task.escalationPolicyId),
    asNeededMaxPerDay: orUndefined(changes.asNeededMaxPerDay, task.asNeededMaxPerDay),
    asNeededMinHours: orUndefined(changes.asNeededMinHours, task.asNeededMinHours),
    active: changes.active ?? task.active,
  });
  return await patchTask(ctx, actor, task, draft, now);
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
    return await listTasksCore(ctx, args.householdId);
  },
});

/**
 * purpose: Create a task and expand its first instances. Editors only. A blank spokenPrompt
 *          becomes "Time for <displayLabel>."; windowMinutes defaults to 60. See createTaskCore.
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
  args: { householdId: v.id("households"), ...createTaskFields },
  handler: async (ctx, args): Promise<Id<"tasks">> => {
    const actor = await requireEditor(ctx, args.householdId);
    const { householdId, ...rest } = args;
    return await createTaskCore(ctx, actor, householdId, rest, Date.now());
  },
});

/**
 * purpose: Change a task; fields left out are unchanged and null clears an optional field.
 *          Editors only. A schedule change (times, daysOfWeek, onceOn, startsOn, endsOn,
 *          windowMinutes, active) stamps scheduleChangedAt and resyncs the task's instances:
 *          deactivating removes its upcoming, due and escalated instances. See updateTaskCore.
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
  args: { householdId: v.id("households"), taskId: v.id("tasks"), ...taskChangeFields },
  handler: async (ctx, args): Promise<null> => {
    const actor = await requireEditor(ctx, args.householdId);
    const { householdId, taskId, ...changes } = args;
    await updateTaskCore(ctx, actor, householdId, taskId, changes, Date.now());
    return null;
  },
});

/**
 * purpose: Hard delete a task. The task row goes (and is audited) immediately; its instances,
 *          their notifications and its dose log rows are removed in the background in batches
 *          (purgeTaskData). Editors only. Prefer update with active = false to keep history.
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
 * purpose: Delete the next batch of a deleted task's instances (with notifications) and dose
 *          log rows, and schedule itself again until nothing is left. Internal.
 * @param householdId: (Id<"households">) The task's household.
 * @param taskId: (Id<"tasks">) The deleted task.
 * @return: (null)
 */
export const purgeTaskData = internalMutation({
  args: { householdId: v.id("households"), taskId: v.id("tasks") },
  handler: async (ctx, args): Promise<null> => {
    if (await purgeTaskBatch(ctx, args.householdId, args.taskId)) {
      await ctx.scheduler.runAfter(0, internal.tasks.purgeTaskData, args);
    }
    return null;
  },
});

/**
 * purpose: Reject steps that cannot run: more than 10 steps, or an offset that is not a whole
 *          number of minutes from 0 to 1440.
 * @param steps: (EscalationStepInput[]) Steps in order.
 * @return: (void)
 * @raises invalid when a rule is broken.
 */
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

/**
 * purpose: Reject a policy name that is blank, over 80 characters or already used in the
 *          household.
 * @param ctx: (QueryCtx) Context.
 * @param householdId: (Id<"households">) Household.
 * @param name: (string) Candidate name.
 * @param exceptId: (Id<"escalationPolicies">, optional) Policy being renamed.
 * @return: (Promise<string>) The trimmed name.
 * @raises invalid when blank, too long or taken.
 */
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
 * purpose: Create a custom escalation policy. Editors only. Every step gets a new id (any id
 *          sent is ignored).
 * @param householdId: (Id<"households">) Household.
 * @param name: (string) Unique, non-blank name, 80 characters at most.
 * @param steps: (EscalationStepInput[]) Ordered steps, 10 at most.
 * @return: (Id<"escalationPolicies">) The new policy.
 */
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

/**
 * purpose: Rename a policy and/or replace its steps; fields left out are unchanged. Seeded
 *          policies may be renamed and tuned (their systemKey never changes). Editors only.
 *          A step sent with the id it was read with keeps that id (so instances that already
 *          fired it do not fire it again); a step without an id, or with an unknown one,
 *          gets a new id.
 * @param householdId: (Id<"households">) Household.
 * @param policyId: (Id<"escalationPolicies">) Policy.
 * @param name: (string, optional) New unique, non-blank name, 80 characters at most.
 * @param steps: (EscalationStepInput[], optional) New ordered steps, 10 at most.
 * @return: (null)
 */
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
