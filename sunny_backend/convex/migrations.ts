import { v } from "convex/values";
import type { FunctionReference, WithoutSystemFields } from "convex/server";
import { internal } from "./_generated/api";
import type { Doc, TableNames } from "./_generated/dataModel";
import { internalMutation, internalQuery } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { SYSTEM_ACTOR } from "./lib/access";
import { ESCALATION_LADDER, isCaregiverAlert } from "./lib/escalation";
import type { FiredStep } from "./lib/escalation";
import { patchTask } from "./lib/schedule";
import type { TaskFields } from "./lib/schedule";
import { TASK_CAPS } from "./tasks";

const DEFAULT_BATCH = 100;
const MAX_BATCH = 500;

export const UNKNOWN_AGENT_CONFIG = "unknown";

const PROMPT_STEP_IDS = ESCALATION_LADDER.filter((s) => s.action === "prompt_senior").map(
  (s) => s.id,
);
const ALERT_STEP = ESCALATION_LADDER.find((s) => isCaregiverAlert(s.action))!;

export interface MigrationPage {
  scanned: number;
  changed: number;
  isDone: boolean;
}

export interface LegacyReport {
  householdsWithOnCall: number;
  membersWithDigestOptOut: number;
  escalationPolicies: number;
  tasksWithPolicy: number;
  tasksWithoutHighPriority: number;
  tasksOverCaps: number;
  instancesWithLegacySteps: number;
  agentRequestsWithoutConfig: number;
  doseLogWithoutLoggedAt: number;
}

const pageArgs = {
  cursor: v.optional(v.union(v.string(), v.null())),
  batchSize: v.optional(v.number()),
};

type PageArgs = { cursor?: string | null; batchSize?: number };

type MigrationRef = FunctionReference<"mutation", "internal", PageArgs, MigrationPage>;

function clampBatch(batchSize: number | undefined): number {
  const wanted = batchSize !== undefined && Number.isFinite(batchSize) ? batchSize : DEFAULT_BATCH;
  return Math.min(Math.max(Math.floor(wanted), 1), MAX_BATCH);
}

async function migratePage<T extends TableNames>(
  ctx: MutationCtx,
  table: T,
  args: PageArgs,
  self: MigrationRef,
  fix: (doc: Doc<T>) => Promise<boolean>,
): Promise<MigrationPage> {
  const numItems = clampBatch(args.batchSize);
  const page = await ctx.db.query(table).paginate({ cursor: args.cursor ?? null, numItems });
  let changed = 0;
  for (const doc of page.page) if (await fix(doc)) changed += 1;
  const result = { scanned: page.page.length, changed, isDone: page.isDone };
  console.log(`migrations:${table} ${JSON.stringify(result)}`);
  if (!page.isDone) {
    await ctx.scheduler.runAfter(0, self, { cursor: page.continueCursor, batchSize: numItems });
  }
  return result;
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max).trimEnd();
}

export function cappedTaskFields(task: Doc<"tasks">): Partial<TaskFields> {
  const spoken = task.spokenPrompt.trim();
  const capped: Partial<TaskFields> = {
    title: clip(task.title, TASK_CAPS.title),
    displayLabel: clip(task.displayLabel, TASK_CAPS.displayLabel),
    spokenPrompt:
      spoken.length <= TASK_CAPS.spokenPrompt
        ? task.spokenPrompt
        : clip(spoken, TASK_CAPS.spokenPrompt),
    times: task.times.slice(0, TASK_CAPS.times),
    checklistItems: task.checklistItems
      .slice(0, TASK_CAPS.checklistItems)
      .map((item) => clip(item, TASK_CAPS.checklistItem)),
  };
  if (task.pillDescription !== undefined) {
    capped.pillDescription = clip(task.pillDescription, TASK_CAPS.pillDescription);
  }
  return Object.fromEntries(
    Object.entries(capped).filter(
      ([key, value]) => JSON.stringify(value) !== JSON.stringify(task[key as keyof Doc<"tasks">]),
    ),
  );
}

async function policyAlertsCaregivers(ctx: QueryCtx, task: Doc<"tasks">): Promise<boolean> {
  if (task.escalationPolicyId === undefined) return false;
  const policy = await ctx.db.get(task.escalationPolicyId);
  return policy?.steps.some((step) => isCaregiverAlert(step.action)) ?? false;
}

async function taskFixes(ctx: QueryCtx, task: Doc<"tasks">): Promise<Partial<TaskFields>> {
  const fixes = cappedTaskFields(task);
  if (task.highPriority === undefined) {
    fixes.highPriority = task.type !== "medication" && (await policyAlertsCaregivers(ctx, task));
  }
  if (task.escalationPolicyId !== undefined) fixes.escalationPolicyId = undefined;
  return fixes;
}

export function ladderFiredSteps(fired: readonly FiredStep[]): FiredStep[] {
  const out: FiredStep[] = [];
  let prompts = 0;
  for (const step of fired) {
    if (step.action === "prompt_senior") {
      const stepId = PROMPT_STEP_IDS[prompts];
      prompts += 1;
      if (stepId !== undefined) out.push({ ...step, stepId });
      continue;
    }
    const index = out.findIndex((s) => s.stepId === ALERT_STEP.id);
    if (index === -1) {
      out.push({ ...step, stepId: ALERT_STEP.id, action: ALERT_STEP.action });
    } else {
      const first = out[index]!;
      out[index] = { ...first, notified: first.notified || step.notified };
    }
  }
  return out;
}

function firedStepsChange(instance: Doc<"taskInstances">): FiredStep[] | null {
  const normalized = ladderFiredSteps(instance.firedSteps);
  return JSON.stringify(normalized) === JSON.stringify(instance.firedSteps) ? null : normalized;
}

type Fix<T extends TableNames> = (doc: Doc<T>) => Partial<WithoutSystemFields<Doc<T>>> | null;

async function applyFix<P>(patch: P | null, write: (patch: P) => Promise<void>): Promise<boolean> {
  if (patch === null) return false;
  await write(patch);
  return true;
}

const onCallFix: Fix<"households"> = (row) =>
  row.onCallUserId === undefined ? null : { onCallUserId: undefined };

const digestOptOutFix: Fix<"householdMembers"> = (row) =>
  row.digestOptOut === undefined ? null : { digestOptOut: undefined };

const agentConfigFix: Fix<"agentRequests"> = (row) =>
  row.agentConfig === undefined ? { agentConfig: UNKNOWN_AGENT_CONFIG } : null;

const loggedAtFix: Fix<"doseLog"> = (row) =>
  row.loggedAt === undefined ? { loggedAt: row._creationTime } : null;

export const tasks = internalMutation({
  args: pageArgs,
  handler: async (ctx, args): Promise<MigrationPage> =>
    await migratePage(ctx, "tasks", args, internal.migrations.tasks, async (task) => {
      const fixes = await taskFixes(ctx, task);
      if (Object.keys(fixes).length === 0) return false;
      await patchTask(ctx, SYSTEM_ACTOR, task, fixes, Date.now());
      return true;
    }),
});

export const escalationPolicies = internalMutation({
  args: pageArgs,
  handler: async (ctx, args): Promise<MigrationPage> =>
    await migratePage(
      ctx,
      "escalationPolicies",
      args,
      internal.migrations.escalationPolicies,
      async (policy) => {
        const user = await ctx.db
          .query("tasks")
          .withIndex("by_household_policy", (q) =>
            q.eq("householdId", policy.householdId).eq("escalationPolicyId", policy._id),
          )
          .first();
        if (user !== null) return false;
        await ctx.db.delete(policy._id);
        return true;
      },
    ),
});

export const households = internalMutation({
  args: pageArgs,
  handler: async (ctx, args): Promise<MigrationPage> =>
    await migratePage(
      ctx,
      "households",
      args,
      internal.migrations.households,
      async (row) =>
        await applyFix(onCallFix(row), async (patch) => await ctx.db.patch(row._id, patch)),
    ),
});

export const householdMembers = internalMutation({
  args: pageArgs,
  handler: async (ctx, args): Promise<MigrationPage> =>
    await migratePage(
      ctx,
      "householdMembers",
      args,
      internal.migrations.householdMembers,
      async (row) =>
        await applyFix(digestOptOutFix(row), async (patch) => await ctx.db.patch(row._id, patch)),
    ),
});

export const taskInstances = internalMutation({
  args: pageArgs,
  handler: async (ctx, args): Promise<MigrationPage> =>
    await migratePage(
      ctx,
      "taskInstances",
      args,
      internal.migrations.taskInstances,
      async (row) => {
        const firedSteps = firedStepsChange(row);
        if (firedSteps === null) return false;
        await ctx.db.patch(row._id, { firedSteps });
        return true;
      },
    ),
});

export const agentRequests = internalMutation({
  args: pageArgs,
  handler: async (ctx, args): Promise<MigrationPage> =>
    await migratePage(
      ctx,
      "agentRequests",
      args,
      internal.migrations.agentRequests,
      async (row) =>
        await applyFix(agentConfigFix(row), async (patch) => await ctx.db.patch(row._id, patch)),
    ),
});

export const doseLog = internalMutation({
  args: pageArgs,
  handler: async (ctx, args): Promise<MigrationPage> =>
    await migratePage(
      ctx,
      "doseLog",
      args,
      internal.migrations.doseLog,
      async (row) =>
        await applyFix(loggedAtFix(row), async (patch) => await ctx.db.patch(row._id, patch)),
    ),
});

async function countWhere<T extends TableNames>(
  ctx: QueryCtx,
  table: T,
  needs: (doc: Doc<T>) => boolean,
): Promise<number> {
  let count = 0;
  for await (const doc of ctx.db.query(table)) if (needs(doc)) count += 1;
  return count;
}

async function taskCounts(
  ctx: QueryCtx,
): Promise<Pick<LegacyReport, "tasksWithPolicy" | "tasksWithoutHighPriority" | "tasksOverCaps">> {
  const counts = { tasksWithPolicy: 0, tasksWithoutHighPriority: 0, tasksOverCaps: 0 };
  for await (const task of ctx.db.query("tasks")) {
    if (task.escalationPolicyId !== undefined) counts.tasksWithPolicy += 1;
    if (task.highPriority === undefined) counts.tasksWithoutHighPriority += 1;
    if (Object.keys(cappedTaskFields(task)).length > 0) counts.tasksOverCaps += 1;
  }
  return counts;
}

export const legacyReport = internalQuery({
  args: {},
  handler: async (ctx): Promise<LegacyReport> => ({
    householdsWithOnCall: await countWhere(ctx, "households", (h) => onCallFix(h) !== null),
    membersWithDigestOptOut: await countWhere(
      ctx,
      "householdMembers",
      (m) => digestOptOutFix(m) !== null,
    ),
    escalationPolicies: await countWhere(ctx, "escalationPolicies", () => true),
    ...(await taskCounts(ctx)),
    instancesWithLegacySteps: await countWhere(
      ctx,
      "taskInstances",
      (i) => firedStepsChange(i) !== null,
    ),
    agentRequestsWithoutConfig: await countWhere(
      ctx,
      "agentRequests",
      (r) => agentConfigFix(r) !== null,
    ),
    doseLogWithoutLoggedAt: await countWhere(ctx, "doseLog", (d) => loggedAtFix(d) !== null),
  }),
});
