// lib/agentRequestState.ts
// Purpose: The one place an agentRequests row changes status. Only queued or running requests
// move on, so a caregiver's cancel always beats a late result from the workflow; finishing a
// request sets finishedAt and stores a caregiver-safe `error` (the app shows it) plus the raw
// `errorDetail` (SDK messages, env var names, workflow errors; never returned by the API, also
// logged with console.error). Used by the caregiver API (agentRequests.ts)
// and the workflow steps (agentRuntime.ts).
//
// Last modified: 2026-10-29

import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import type { AgentRequestStatus } from "./validators";

/** Longest caregiver-facing error stored on a request. */
const MAX_ERROR_LENGTH = 500;
/** Longest internal error detail stored on a request. */
const MAX_DETAIL_LENGTH = 2000;

/** What a caregiver sees when the cause is internal (the detail goes to errorDetail). */
export const GENERIC_ERROR = "Sunny could not finish this request. Please try again.";

/** A move to a new status, with the reply or error that goes with it. */
export type RequestTransition =
  | { status: "running" }
  | { status: "succeeded"; reply: string }
  | { status: "failed"; error: string; detail?: string }
  | { status: "cancelled" };

/**
 * purpose: Whether a request is still being worked on.
 * @param status: (AgentRequestStatus) The status.
 * @return: (boolean) True for queued and running.
 */
export function isInProgress(status: AgentRequestStatus): boolean {
  return status === "queued" || status === "running";
}

/**
 * purpose: Shorten text for storing on a request.
 * @param text: (string) Text.
 * @param max: (number) Longest allowed length; defaults to MAX_ERROR_LENGTH.
 * @return: (string) At most max characters plus an ellipsis.
 */
export function clipError(text: string, max: number = MAX_ERROR_LENGTH): string {
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

/**
 * purpose: The message of a caught value, for the internal errorDetail.
 * @param e: (unknown) Caught value.
 * @return: (string) The error's message, or the value as text.
 */
export function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * purpose: Move a request to a new status, but only if it is still queued or running.
 * @param ctx: (MutationCtx) Mutation context.
 * @param requestId: (Id<"agentRequests">) The request.
 * @param transition: (RequestTransition) The new status and its reply or error.
 * @return: (Promise<boolean>) True when the request moved (or was already running for a
 *         "running" move); false when it is gone or already finished.
 */
export async function transitionRequest(
  ctx: MutationCtx,
  requestId: Id<"agentRequests">,
  transition: RequestTransition,
): Promise<boolean> {
  const row = await ctx.db.get(requestId);
  if (!row || !isInProgress(row.status)) return false;
  if (transition.status === "running") {
    if (row.status === "queued") await ctx.db.patch(requestId, { status: "running" });
    return true;
  }
  const detail = transition.status === "failed" ? transition.detail : undefined;
  if (detail) console.error(`agentRequest ${requestId} failed: ${detail}`);
  await ctx.db.patch(requestId, {
    status: transition.status,
    reply: transition.status === "succeeded" ? transition.reply : undefined,
    error: transition.status === "failed" ? clipError(transition.error) : undefined,
    errorDetail: detail === undefined ? undefined : clipError(detail, MAX_DETAIL_LENGTH),
    finishedAt: Date.now(),
  });
  return true;
}
