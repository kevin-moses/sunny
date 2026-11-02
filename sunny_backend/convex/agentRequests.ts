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
// session id onto its row up front. `continueLatest` lets the server own the thread: it
// continues the household's newest succeeded request that has a session (or starts fresh when
// there is none), so the app never tracks which request to continue. It excludes
// continueRequestId ("invalid" if both are given). Each row stores the agent config fingerprint
// of its session (agentConfig); a conversation started under a different config (a deploy
// changed the prompt, model or tools, or an old row has none) is not continued, so the next
// continueLatest message starts a session with the deployed config and is marked carryOver (the
// runtime then replays the recent chat into it). Views carry requestedByName (the requester's
// member display name, null once they have left) so the shared chat can attribute messages.
//
// Last modified: 2026-11-01

import { v } from "convex/values";
import type { WorkflowId } from "@convex-dev/workflow";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import { workflow } from "./agentRuntime";
import { AGENT_CONFIG_FINGERPRINT } from "./lib/agentFingerprint";
import { findMember, requireEditor, type CaregiverActor } from "./lib/access";
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
/** Most succeeded requests scanned for one with a session when continuing the latest thread. */
const MAX_CONTINUABLE_SCAN = 20;

/** A request as the caregiver app sees it (absent fields are null). */
export interface AgentRequestView {
  id: Id<"agentRequests">;
  householdId: Id<"households">;
  requestedBy: string;
  /** The requester's display name; null when they are no longer a member. */
  requestedByName: string | null;
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
 * @param requestedByName: (string | null) The requester's display name, null if unknown.
 * @return: (AgentRequestView) The view.
 */
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

/**
 * purpose: Look up a requester's display name in a household, caching per user within one call.
 * @param ctx: (QueryCtx) Context.
 * @param householdId: (Id<"households">) Household.
 * @param userId: (string) Requester's user id.
 * @param cache: (Map<string, string | null>) Names already looked up in this call; updated.
 * @return: (Promise<string | null>) The display name, or null if they are no longer a member.
 */
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
 * @return: (Promise<{ sessionId, agentConfig }>) The session id to continue and the agent config
 *          fingerprint of that session (undefined for rows from before it was stored).
 * @raises not_found when the earlier request cannot be continued; limit when the session is busy.
 */
async function requireContinuable(
  ctx: MutationCtx,
  householdId: Id<"households">,
  continueRequestId: Id<"agentRequests">,
): Promise<{ sessionId: string; agentConfig: string | undefined }> {
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

/**
 * purpose: The household's newest succeeded request that has a session, the head of its
 *          conversation thread. Returns null (so the next message starts a new session) when
 *          there is none or its session was started under a different agent config than the
 *          deployed one (AGENT_CONFIG_FINGERPRINT).
 * @param ctx: (QueryCtx) Context.
 * @param householdId: (Id<"households">) Household.
 * @return: (Promise<Id<"agentRequests"> | null>) The request, or null when there is none.
 */
async function findLatestContinuable(
  ctx: QueryCtx,
  householdId: Id<"households">,
): Promise<Id<"agentRequests"> | null> {
  // Newest first: creation time is the implicit last field of by_household_status.
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

/**
 * purpose: Ask the household agent to do something. Queues the request and starts its workflow.
 * @param householdId: (Id<"households">) Household the agent acts for.
 * @param message: (string) What the caregiver wants; trimmed, 1 to 4000 characters.
 * @param continueRequestId: (Id<"agentRequests">, optional) A succeeded earlier request whose
 *        conversation to continue.
 * @param continueLatest: (boolean, optional) Continue the household's newest succeeded
 *        conversation instead, or start a new session if there is none or the agent config
 *        changed since (the request is then marked carryOver). Omitting it starts fresh without
 *        carry-over. Not with continueRequestId.
 * @return: (Id<"agentRequests">) The new request; subscribe to `get` for the reply.
 * @raises invalid when both continueRequestId and continueLatest are given.
 */
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
      // A continuation runs in the old session, so it keeps that session's config fingerprint.
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

/**
 * purpose: One request, for the app to subscribe to.
 * @param requestId: (Id<"agentRequests">) The request.
 * @return: (AgentRequestView) The request with its status, reply or error.
 */
export const get = query({
  args: { requestId: v.id("agentRequests") },
  handler: async (ctx, { requestId }): Promise<AgentRequestView> => {
    const { row } = await loadForEditor(ctx, requestId);
    return toView(row, await requesterName(ctx, row.householdId, row.requestedBy, new Map()));
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
    const names = new Map<string, string | null>();
    const views: AgentRequestView[] = [];
    for (const row of rows) {
      views.push(toView(row, await requesterName(ctx, householdId, row.requestedBy, names)));
    }
    return views;
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
