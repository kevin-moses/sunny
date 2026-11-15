import { v } from "convex/values";
import type { WorkflowId } from "@convex-dev/workflow";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import { workflow } from "./agentRuntime";
import { AGENT_CONFIG_FINGERPRINT } from "./lib/agentFingerprint";
import {
  EDITOR_ROLES,
  findMember,
  requireCaregiverReader,
  requireEditor,
  type CaregiverActor,
} from "./lib/access";
import { isInProgress, transitionRequest } from "./lib/agentRequestState";
import { audit } from "./lib/audit";
import { ANYTIME } from "./lib/anytime";
import { recentPosts, type ChatPostView } from "./lib/chatPosts";
import { clockTime, cueSpeech } from "./lib/deviceWording";
import { appError } from "./lib/errors";
import { requireMaxLength, requireNonBlank } from "./lib/text";
import type { AgentRequestStatus } from "./lib/validators";

const MAX_MESSAGE_LENGTH = 4000;
const MAX_IN_PROGRESS = 5;
const DEFAULT_LIST_LIMIT = 20;
const MAX_LIST_LIMIT = 100;
const MAX_CONTINUABLE_SCAN = 20;

export interface AgentRequestView {
  id: Id<"agentRequests">;
  householdId: Id<"households">;
  requestedBy: string;
  requestedByName: string | null;
  message: string;
  continueRequestId: Id<"agentRequests"> | null;
  status: AgentRequestStatus;
  reply: string | null;
  error: string | null;
  createdAt: number;
  finishedAt: number | null;
}

function toView(row: Doc<"agentRequests">, requestedByName: string | null): AgentRequestView {
  return {
    id: row._id,
    householdId: row.householdId,
    requestedBy: row.requestedBy,
    requestedByName,
    message: row.message,
    continueRequestId: row.continueRequestId ?? null,
    status: row.status,
    reply: row.reply ?? null,
    error: row.error ?? null,
    createdAt: row._creationTime,
    finishedAt: row.finishedAt ?? null,
  };
}

async function requesterName(
  ctx: QueryCtx,
  householdId: Id<"households">,
  userId: string,
  cache: Map<string, string | null>,
): Promise<string | null> {
  const cached = cache.get(userId);
  if (cached !== undefined) return cached;
  const name = (await findMember(ctx, householdId, userId))?.displayName ?? null;
  cache.set(userId, name);
  return name;
}

async function loadForEditor(
  ctx: QueryCtx,
  requestId: Id<"agentRequests">,
): Promise<{ row: Doc<"agentRequests">; actor: CaregiverActor }> {
  const row = await ctx.db.get(requestId);
  if (!row) throw appError("not_found", "Request not found");
  return { row, actor: await requireEditor(ctx, row.householdId) };
}

async function countInProgress(ctx: QueryCtx, householdId: Id<"households">): Promise<number> {
  let total = 0;
  for (const status of ["queued", "running"] as const) {
    const rows = await ctx.db
      .query("agentRequests")
      .withIndex("by_household_status", (q) =>
        q.eq("householdId", householdId).eq("status", status),
      )
      .take(MAX_IN_PROGRESS);
    total += rows.length;
  }
  return total;
}

async function requireContinuable(
  ctx: MutationCtx,
  householdId: Id<"households">,
  continueRequestId: Id<"agentRequests">,
): Promise<{ sessionId: string; agentConfig: string }> {
  const earlier = await ctx.db.get(continueRequestId);
  if (
    !earlier ||
    earlier.householdId !== householdId ||
    earlier.status !== "succeeded" ||
    !earlier.sessionId
  ) {
    throw appError("not_found", "Nothing to continue (the earlier request must have finished)");
  }
  for (const status of ["queued", "running"] as const) {
    const busy = await ctx.db
      .query("agentRequests")
      .withIndex("by_session", (q) => q.eq("sessionId", earlier.sessionId).eq("status", status))
      .first();
    if (busy) throw appError("limit", "Sunny is still working on that conversation");
  }
  return { sessionId: earlier.sessionId, agentConfig: earlier.agentConfig };
}

async function findLatestContinuable(
  ctx: QueryCtx,
  householdId: Id<"households">,
): Promise<Id<"agentRequests"> | null> {
  const rows = await ctx.db
    .query("agentRequests")
    .withIndex("by_household_status", (q) =>
      q.eq("householdId", householdId).eq("status", "succeeded"),
    )
    .order("desc")
    .take(MAX_CONTINUABLE_SCAN);
  const latest = rows.find((row) => row.sessionId);
  if (!latest || latest.agentConfig !== AGENT_CONFIG_FINGERPRINT) return null;
  return latest._id;
}

export const request = mutation({
  args: {
    householdId: v.id("households"),
    message: v.string(),
    continueRequestId: v.optional(v.id("agentRequests")),
    continueLatest: v.optional(v.boolean()),
  },
  handler: async (ctx, args): Promise<Id<"agentRequests">> => {
    const actor = await requireEditor(ctx, args.householdId);
    if (args.continueRequestId !== undefined && args.continueLatest) {
      throw appError("invalid", "Use continueRequestId or continueLatest, not both");
    }
    const message = requireMaxLength(
      requireNonBlank(args.message, "Message"),
      MAX_MESSAGE_LENGTH,
      "Message",
    );
    if ((await countInProgress(ctx, args.householdId)) >= MAX_IN_PROGRESS) {
      throw appError("limit", "Too many agent requests in progress");
    }
    const continueRequestId =
      args.continueRequestId ??
      (args.continueLatest ? await findLatestContinuable(ctx, args.householdId) : null) ??
      undefined;
    const continued = continueRequestId
      ? await requireContinuable(ctx, args.householdId, continueRequestId)
      : undefined;
    const requestId = await ctx.db.insert("agentRequests", {
      householdId: args.householdId,
      requestedBy: actor.userId,
      message,
      continueRequestId,
      sessionId: continued?.sessionId,
      agentConfig: continued ? continued.agentConfig : AGENT_CONFIG_FINGERPRINT,
      carryOver: !continued && args.continueLatest ? true : undefined,
      status: "queued",
    });
    const workflowId = await workflow.start(
      ctx,
      internal.agentRuntime.run,
      { requestId },
      { onComplete: internal.agentRuntime.onRunComplete, context: { requestId } },
    );
    await ctx.db.patch(requestId, { workflowId });
    await audit(ctx, {
      householdId: args.householdId,
      actor,
      action: "agent_request",
      entity: "agentRequest",
      entityId: requestId,
      detail: { continued: continueRequestId !== undefined },
    });
    return requestId;
  },
});

export const get = query({
  args: { requestId: v.id("agentRequests") },
  handler: async (ctx, { requestId }): Promise<AgentRequestView> => {
    const { row } = await loadForEditor(ctx, requestId);
    return toView(row, await requesterName(ctx, row.householdId, row.requestedBy, new Map()));
  },
});

export const list = query({
  args: { householdId: v.id("households"), limit: v.optional(v.number()) },
  handler: async (ctx, { householdId, limit }): Promise<AgentRequestView[]> => {
    await requireEditor(ctx, householdId);
    return (await recentRequests(ctx, householdId, listCount(limit))).map((r) => r.view);
  },
});

function listCount(limit: number | undefined): number {
  const wanted = limit !== undefined && Number.isFinite(limit) ? limit : DEFAULT_LIST_LIMIT;
  return Math.min(Math.max(Math.floor(wanted), 1), MAX_LIST_LIMIT);
}

async function recentRequests(
  ctx: QueryCtx,
  householdId: Id<"households">,
  count: number,
): Promise<{ row: Doc<"agentRequests">; view: AgentRequestView }[]> {
  const rows = await ctx.db
    .query("agentRequests")
    .withIndex("by_household", (q) => q.eq("householdId", householdId))
    .order("desc")
    .take(count);
  const names = new Map<string, string | null>();
  const out: { row: Doc<"agentRequests">; view: AgentRequestView }[] = [];
  for (const row of rows) {
    out.push({
      row,
      view: toView(row, await requesterName(ctx, householdId, row.requestedBy, names)),
    });
  }
  return out;
}

export interface TaskWording {
  taskId: Id<"tasks">;
  label: string;
  time: string;
  times: string[];
  sentence: string | null;
}

export type TranscriptItem =
  | ({ type: "request"; wording: TaskWording[] } & AgentRequestView)
  | ({ type: "post" } & ChatPostView);

function taskWording(task: Doc<"tasks">): TaskWording {
  const first = task.times[0];
  return {
    taskId: task._id,
    label: task.displayLabel,
    time: clockTime(first ?? ANYTIME),
    times: task.times,
    sentence:
      first === undefined
        ? null
        : cueSpeech({
            type: task.type,
            displayLabel: task.displayLabel,
            spokenPrompt: task.spokenPrompt,
            scheduledTime: first,
          }),
  };
}

async function requestWording(
  ctx: QueryCtx,
  householdId: Id<"households">,
  taskIds: readonly Id<"tasks">[],
  loaded: Map<Id<"tasks">, Doc<"tasks"> | null>,
): Promise<TaskWording[]> {
  const cards: TaskWording[] = [];
  for (const taskId of taskIds) {
    if (!loaded.has(taskId)) loaded.set(taskId, await ctx.db.get(taskId));
    const task = loaded.get(taskId);
    if (task && task.householdId === householdId && task.active) cards.push(taskWording(task));
  }
  return cards;
}

export const transcript = query({
  args: { householdId: v.id("households"), limit: v.optional(v.number()) },
  handler: async (ctx, { householdId, limit }): Promise<TranscriptItem[]> => {
    const actor = await requireCaregiverReader(ctx, householdId);
    const count = listCount(limit);
    const posts = (await recentPosts(ctx, householdId, count)).map((post) => ({
      type: "post" as const,
      ...post,
    }));
    const loadedRequests = EDITOR_ROLES.includes(actor.role)
      ? await recentRequests(ctx, householdId, count)
      : [];
    const changed = new Map(loadedRequests.map(({ row }) => [row._id, row.changedTaskIds ?? []]));
    const requests = loadedRequests.map(({ view }) => ({ type: "request" as const, ...view }));
    const newest = [...posts, ...requests]
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, count);
    const tasks = new Map<Id<"tasks">, Doc<"tasks"> | null>();
    const items: TranscriptItem[] = [];
    for (const item of newest) {
      if (item.type === "post") {
        items.push(item);
        continue;
      }
      const wording = isInProgress(item.status)
        ? []
        : await requestWording(ctx, householdId, changed.get(item.id) ?? [], tasks);
      items.push({ ...item, wording });
    }
    return items;
  },
});

export const cancel = mutation({
  args: { requestId: v.id("agentRequests") },
  handler: async (ctx, { requestId }): Promise<null> => {
    const { row, actor } = await loadForEditor(ctx, requestId);
    if (!isInProgress(row.status)) throw appError("invalid", "This request has already finished");
    if (row.workflowId) await workflow.cancel(ctx, row.workflowId as WorkflowId);
    await transitionRequest(ctx, requestId, { status: "cancelled" });
    await audit(ctx, {
      householdId: row.householdId,
      actor,
      action: "agent_request_cancel",
      entity: "agentRequest",
      entityId: requestId,
      detail: {},
    });
    return null;
  },
});
