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
// createTaskCore returns the inserted task; its creator (createdBy) is the actor's user id,
// which for the household agent is the caregiver it acts for (actorUserId). Wording limits: a
// title is 200 characters at most (as for calendar events) and a display label 60, because the
// senior's display shows the label in large type and a longer one would not fit.
// Anytime tasks (lib/anytime.ts): a task of any type except medication with no times is done
// "anytime that day". A medication needs at least one time unless it is a valid as-needed
// medication (isAsNeededTask: a daily or spacing limit); an active medication that would have
// neither is rejected when the write touches its times, type, active flag or limits, so older data
// stays editable. Anytime tasks get no escalation policy (they never prompt or escalate).
// Size caps apply to the values being written, never to data already stored: a create checks
// every field it was given; an update checks only the fields present in its changes, so a task
// saved under older, looser limits can still be stopped, rescheduled or edited elsewhere.
// Caps: title 200, display label 60, spoken prompt 300, pill description 200, at most 24
// times, at most 50 checklist items of at most 200 characters each.
// Default policy: a task created with no escalationPolicyId gets the household's seeded
// "medication" policy (type medication) or "prompt_only" policy (every other type), found by
// systemKey, because a task without a policy is never prompted or escalated; an anytime task
// gets none. A later change of type across the medication boundary (to or from medication), or
// of whether the task has times (anytime or not), switches the policy to the new default
// (none for an anytime task), but only when the current policy is one of the seeded policies
// (or, for a task turning from anytime to timed, when it has none); a custom policy is left
// alone, and an escalationPolicyId in the same update wins.
// backfillDefaultPolicies (internal, run once from the CLI) assigns the same defaults to
// existing tasks that have no policy, in bounded batches. isAsNeededTask identifies
// as-needed medications (no times, a daily or spacing limit), which the agent may not edit.
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
/** Same limit as a calendar event title. */
const MAX_TITLE_LENGTH = 200;
/** The senior's display shows the label in large type; longer wording would not fit. */
const MAX_DISPLAY_LABEL_LENGTH = 60;
/** Caps on newly written wording and lists (see the header). */
const MAX_SPOKEN_PROMPT_LENGTH = 300;
const MAX_PILL_DESCRIPTION_LENGTH = 200;
const MAX_TIMES = 24;
const MAX_CHECKLIST_ITEMS = 50;
const MAX_CHECKLIST_ITEM_LENGTH = 200;
const DEFAULT_WINDOW_MINUTES = 60;
const MAX_POLICY_NAME_LENGTH = 80;
const MAX_POLICY_STEPS = 10;
const MAX_STEP_OFFSET_MINUTES = 1440;
/** Households handled per backfill page, and tasks handled per backfill batch. */
const BACKFILL_HOUSEHOLD_PAGE = 20;
const BACKFILL_TASK_BATCH = 100;

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
 * purpose: Whether a task is an as-needed medication: a medication with no times and a daily
 *          or spacing limit. These are managed in the app; the household agent does not edit
 *          them. A task of another type is never as-needed, whatever limits it still carries
 *          (an ex-medication with no times is an anytime task instead).
 * @param task: (Pick<TaskFields, "type" | "times" | "asNeededMaxPerDay" | "asNeededMinHours">) A
 *        task.
 * @return: (boolean) True for an as-needed medication.
 */
export function isAsNeededTask(
  task: Pick<TaskFields, "type" | "times" | "asNeededMaxPerDay" | "asNeededMinHours">,
): boolean {
  return (
    task.type === "medication" &&
    task.times.length === 0 &&
    (task.asNeededMaxPerDay !== undefined || task.asNeededMinHours !== undefined)
  );
}

/**
 * purpose: Apply the size caps to the draft fields being written. Fields not being written
 *          are not checked, so older data with longer values stays editable.
 * @param draft: (TaskDraft) The merged task fields.
 * @param written: (ReadonlySet<keyof TaskDraft>) The fields the caller is writing.
 * @return: (void)
 * @raises invalid naming the field that is too long or has too many entries.
 */
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

/**
 * purpose: Validate a whole task draft: wording, schedule, as-needed limits and policy; fill a
 *          blank spoken prompt with "Time for <displayLabel>.". Size caps (enforceSizeCaps)
 *          apply only to the fields being written; non-blank, schedule and limit rules apply
 *          to the whole merged draft.
 * @param ctx: (QueryCtx) Context.
 * @param householdId: (Id<"households">) The task's household.
 * @param draft: (TaskDraft) The task fields.
 * @param written: (ReadonlySet<keyof TaskDraft>) The fields the caller is writing (all, on
 *        create).
 * @return: (Promise<TaskDraft>) The normalized draft.
 * @raises invalid for any rule violation.
 */
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
 * purpose: The household's tasks (core of list, shared with the agent).
 * @param ctx: (QueryCtx) Context.
 * @param householdId: (Id<"households">) Household.
 * @param activeOnly: (boolean) True reads only active tasks through the by_household_active
 *        index; false (default) reads active and inactive ones.
 * @return: (Promise<Doc<"tasks">[]>) Tasks in creation order.
 */
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

/**
 * purpose: Core of create, reusable by agent tools: validate and insert a task and expand its
 *          first instances. The caller has already checked that the actor may edit the
 *          household. A blank spokenPrompt becomes "Time for <displayLabel>."; windowMinutes
 *          defaults to 60; with no escalationPolicyId the task gets the household's default
 *          policy for its type (see defaultPolicyId): "medication" for medication tasks,
 *          "prompt_only" for the rest, and none for an anytime task (no times, not a
 *          medication; lib/anytime.ts). An explicit escalationPolicyId wins. If the household
 *          lacks the seeded policy the task is created with no policy (it then never
 *          escalates). A later type change across the medication boundary switches a default
 *          policy to the new type's default (see updateTaskCore). Every given field is
 *          size-capped (enforceSizeCaps). The task is
 *          recorded as created by a caregiver; createdBy is the actor's user id (for the
 *          household agent, the caregiver it acts for).
 * @param ctx: (MutationCtx) Context.
 * @param actor: (Actor) Who creates it (audit actor).
 * @param householdId: (Id<"households">) Household.
 * @param args: (CreateTaskArgs) The task's fields.
 * @param now: (number) Epoch ms.
 * @return: (Promise<Doc<"tasks">>) The new task.
 * @raises invalid for any rule violation.
 */
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

/**
 * purpose: Find the household's default escalation policy for a task type: the seeded
 *          "medication" policy for medication tasks, "prompt_only" for every other type.
 * @param ctx: (QueryCtx) Context.
 * @param householdId: (Id<"households">) Household.
 * @param type: (TaskType) The task's type.
 * @return: (Promise<Id<"escalationPolicies"> | undefined>) The policy id, or undefined when
 *          the household has no policy with that systemKey.
 */
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

/**
 * purpose: The policy a task should move to when an update changes its type or its times.
 *          Becoming an anytime task (no times, not a medication) clears a seeded policy
 *          (null); a custom policy is kept (the scheduler never fires an anytime instance).
 *          Turning from anytime to timed gives a task with no policy the new type's default.
 *          Otherwise, when the change crosses the medication boundary and the current policy
 *          is a seeded one (systemKey set), the new type's default. Everything else keeps the
 *          current policy.
 * @param ctx: (QueryCtx) Context.
 * @param task: (Doc<"tasks">) The task before the change.
 * @param newType: (TaskType) The type after the change.
 * @param newTimes: (string[]) The times after the change.
 * @return: (Promise<Id<"escalationPolicies"> | null | undefined>) The policy to switch to,
 *          null to clear it, or undefined to keep the current one.
 */
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

/**
 * purpose: Core of update, reusable by agent tools: merge changes into a task of the
 *          household, validate the result, patch and audit it, and resync instances when the
 *          schedule changed (deactivating removes upcoming, due and escalated instances).
 *          Size caps apply only to the fields in changes. A change of type or times that
 *          crosses the medication boundary or the anytime boundary moves a seeded default
 *          policy to the new default (see policyForChange) unless the same change sets
 *          escalationPolicyId.
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
    return (await createTaskCore(ctx, actor, householdId, rest, Date.now()))._id;
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
 * purpose: One-off maintenance: give every task that has no escalation policy the default for
 *          its type (see defaultPolicyId), across all households. Pages through households
 *          (20 at a time) and schedules one backfillHouseholdPolicies per household, so each
 *          mutation stays small. Safe to run again: tasks that have a policy are untouched.
 *          Tasks whose caregiver deliberately cleared the policy are indistinguishable from
 *          never-assigned ones and also get the default. Run: npx convex run
 *          tasks:backfillDefaultPolicies (no arguments).
 * @param cursor: (string, optional) Household paging cursor; omit to start. Used by the
 *        function's own continuation.
 * @return: (null)
 */
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

/**
 * purpose: Backfill one household: assign the type default policy to the tasks that have none
 *          in pages of 100, rescheduling itself until the household is done. Each assignment
 *          is audited as a system update. A task whose type has no seeded policy in the
 *          household is skipped.
 * @param householdId: (Id<"households">) Household.
 * @param cursor: (string, optional) Task paging cursor; omit to start.
 * @return: (null)
 */
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
      await patchTask(ctx, { kind: "system" }, task, { escalationPolicyId: policyId }, now);
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
