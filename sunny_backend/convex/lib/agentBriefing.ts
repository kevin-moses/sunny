// lib/agentBriefing.ts
// Purpose: STUB (part A of the agent runtime owns the real file). Builds the household
// briefing that prefixes the caregiver's request. The lead replaces this file with part A's
// version at merge; only the exported name and signature are relied upon.
//
// Last modified: 2026-10-29

import type { Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";

/**
 * purpose: Build the briefing text for a household (stub: the senior's name only).
 * @param ctx: (QueryCtx) Query context.
 * @param householdId: (Id<"households">) Household.
 * @param _requestedBy: (string | null) Clerk user id of the requesting caregiver.
 * @param _now: (number) Epoch ms to treat as now.
 * @return: (Promise<string>) Briefing text.
 */
export async function buildBriefing(
  ctx: QueryCtx,
  householdId: Id<"households">,
  _requestedBy: string | null,
  _now: number,
): Promise<string> {
  const household = await ctx.db.get(householdId);
  return `Household briefing:\n- Senior: ${household?.seniorPreferredName ?? "unknown"}`;
}
