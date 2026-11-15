import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import type { AgentRequestStatus } from "./validators";

const MAX_ERROR_LENGTH = 500;
const MAX_DETAIL_LENGTH = 2000;

export const GENERIC_ERROR = "Sunny could not finish this request. Please try again.";

export type RequestTransition =
  | { status: "running" }
  | { status: "succeeded"; reply: string }
  | { status: "failed"; error: string; detail?: string }
  | { status: "cancelled" };

export function isInProgress(status: AgentRequestStatus): boolean {
  return status === "queued" || status === "running";
}

export function clipError(text: string, max: number = MAX_ERROR_LENGTH): string {
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

export function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

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
