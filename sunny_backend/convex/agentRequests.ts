// agentRequests.ts
// Purpose: The caregiver-facing API for asking the household agent to do something, replacing
// request_agent_chat and the jobs rows the app used to read. `request` validates and queues a
// request and starts its workflow (agentRuntime.ts); `get` and `list` return view-shaped rows
// the caregiver app subscribes to for the reply; `cancel` stops a request still in progress.
// All of it is limited to caregivers who can edit (primary or member), like the SQL
// function: replies can contain calendar details the household owns.
//
// Rules ported from request_agent_chat: message trimmed to 1 to 4000 characters; at most 5
// requests queued or running per household ("limit"); a request may continue only a
// succeeded request of the same household that has a session ("not_found" otherwise), and only
// while no other request is in progress in that session ("limit"). A continuation copies the
// session id onto its row up front.
//
// Last modified: 2026-10-29

import { v } from "convex/values";
import type { WorkflowId } from "@convex-dev/workflow";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import { workflow } from "./agentRuntime";
import { requireEditor, type CaregiverActor } from "./lib/access";
import { isInProgress, transitionRequest } from "./lib/agentRequestState";
import { audit } from "./lib/audit";
import { appError } from "./lib/errors";
import { requireMaxLength, requireNonBlank } from "./lib/text";
import type { AgentRequestStatus } from "./lib/validators";

/** Longest message a caregiver may send the agent. */
const MAX_MESSAGE_LENGTH = 4000;
/** Most requests a household may have queued or running at once. */
const MAX_IN_PROGRESS = 5;
/** Default and largest page size of `list`. */
const DEFAULT_LIST_LIMIT = 20;
const MAX_LIST_LIMIT = 100;

/** A request as the caregiver app sees it (absent fields are null). */
export interface AgentRequestView {
  id: Id<"agentRequests">;
  householdId: Id<"households">;
  requestedBy: string;
  message: string;
  continueRequestId: Id<"agentRequests"> | null;
  status: AgentRequestStatus;
  reply: string | null;
  error: string | null;
  createdAt: number;
  finishedAt: number | null;
}

/**
 * purpose: Shape a request row for the app.
 * @param row: (Doc<"agentRequests">) The row.
 * @return: (AgentRequestView) The view.
 */
function toView(row: Doc<"agentRequests">): AgentRequestView {
  return {
    id: row._id,
    householdId: row.householdId,
    requestedBy: row.requestedBy,
    message: row.message,
    continueRequestId: row.continueRequestId ?? null,
    status: row.status,
    reply: row.reply ?? null,
    error: row.error ?? null,
    createdAt: row._creationTime,
    finishedAt: row.finishedAt ?? null,
  };
}

/**
 * purpose: Load a request and check the caller may edit its household.
 * @param ctx: (QueryCtx) Context.
 * @param requestId: (Id<"agentRequests">) The request.
 * @return: (Promise<{ row, actor }>) The row and the calling editor.
 * @raises not_found when it does not exist; forbidden when the caller is not an editor.
 */
async function loadForEditor(
  ctx: QueryCtx,
  requestId: Id<"agentRequests">,
): Promise<{ row: Doc<"agentRequests">; actor: CaregiverActor }> {
  const row = await ctx.db.get(requestId);
  if (!row) throw appError("not_found", "Request not found");
  return { row, actor: await requireEditor(ctx, row.householdId) };
}

/**
 * purpose: Count a household's requests that are queued or running, up to the limit.
 * @param ctx: (QueryCtx) Context.
 * @param householdId: (Id<"households">) Household.
 * @return: (Promise<number>) The count (at most MAX_IN_PROGRESS per status).
 */
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

/**
 * purpose: Check that a request may continue another: same household, succeeded, with a
 *          session, and no other request in progress in that session (two requests must never
 *          drive one session at once).
 * @param ctx: (MutationCtx) Context.
 * @param householdId: (Id<"households">) Household of the new request.
 * @param continueRequestId: (Id<"agentRequests">) The earlier request.
 * @return: (Promise<string>) The session id to continue.
 * @raises not_found when the earlier request cannot be continued; limit when the session is busy.
 */
async function requireContinuable(
  ctx: MutationCtx,
  householdId: Id<"households">,
  continueRequestId: Id<"agentRequests">,
): Promise<string> {
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
  return earlier.sessionId;
}

/**
 * purpose: Ask the household agent to do something. Queues the request and starts its workflow.
 * @param householdId: (Id<"households">) Household the agent acts for.
 * @param message: (string) What the caregiver wants; trimmed, 1 to 4000 characters.
 * @param continueRequestId: (Id<"agentRequests">, optional) A succeeded earlier request whose
 *        conversation to continue.
 * @return: (Id<"agentRequests">) The new request; subscribe to `get` for the reply.
 */
export const request = mutation({
  args: {
    householdId: v.id("households"),
    message: v.string(),
    continueRequestId: v.optional(v.id("agentRequests")),
  },
  handler: async (ctx, args): Promise<Id<"agentRequests">> => {
    const actor = await requireEditor(ctx, args.householdId);
    const message = requireMaxLength(
      requireNonBlank(args.message, "Message"),
      MAX_MESSAGE_LENGTH,
      "Message",
    );
    if ((await countInProgress(ctx, args.householdId)) >= MAX_IN_PROGRESS) {
      throw appError("limit", "Too many agent requests in progress");
    }
    const sessionId = args.continueRequestId
      ? await requireContinuable(ctx, args.householdId, args.continueRequestId)
      : undefined;
    const requestId = await ctx.db.insert("agentRequests", {
      householdId: args.householdId,
      requestedBy: actor.userId,
      message,
      continueRequestId: args.continueRequestId,
      sessionId,
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
      detail: { continued: args.continueRequestId !== undefined },
    });
    return requestId;
  },
});

/**
 * purpose: One request, for the app to subscribe to.
 * @param requestId: (Id<"agentRequests">) The request.
 * @return: (AgentRequestView) The request with its status, reply or error.
 */
export const get = query({
  args: { requestId: v.id("agentRequests") },
  handler: async (ctx, { requestId }): Promise<AgentRequestView> => {
    return toView((await loadForEditor(ctx, requestId)).row);
  },
});

/**
 * purpose: A household's requests, newest first.
 * @param householdId: (Id<"households">) Household.
 * @param limit: (number, optional) How many to return; default 20, at most 100.
 * @return: (AgentRequestView[]) The requests.
 */
export const list = query({
  args: { householdId: v.id("households"), limit: v.optional(v.number()) },
  handler: async (ctx, { householdId, limit }): Promise<AgentRequestView[]> => {
    await requireEditor(ctx, householdId);
    const wanted = limit !== undefined && Number.isFinite(limit) ? limit : DEFAULT_LIST_LIMIT;
    const count = Math.min(Math.max(Math.floor(wanted), 1), MAX_LIST_LIMIT);
    const rows = await ctx.db
      .query("agentRequests")
      .withIndex("by_household", (q) => q.eq("householdId", householdId))
      .order("desc")
      .take(count);
    return rows.map(toView);
  },
});

/**
 * purpose: Stop a request that is still queued or running.
 * @param requestId: (Id<"agentRequests">) The request.
 * @return: (null) Nothing; the request becomes "cancelled" and its workflow is cancelled.
 * @raises invalid when the request has already finished.
 */
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
