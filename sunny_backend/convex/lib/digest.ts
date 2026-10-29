// lib/digest.ts
// Purpose: When a household's daily digest is due. Called from the per-household scheduler
// tick (scheduler.ts): once the household's local time reaches its digestTime and no digests
// row exists for the local date, insert the row (unique per household and local date, since
// the check and the insert share one transaction) and enqueue the compose-and-send action
// (digest.ts). Rules: a paused household (backgroundPaused) gets no digest until resumed, and
// then the day's digest goes out at the next tick; a household created after that day's
// digest time gets none that day (its first digest is the next day's), so a new household is
// not greeted with a "quiet day" message; DST days work because the comparison is on local
// wall-clock time and "at or after" fires even when digestTime falls in a skipped hour.
//
// Last modified: 2026-10-29

import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { enqueueDigest } from "./delivery";
import { localDate, localTime, zonedInstant } from "./time";

/**
 * purpose: Record and enqueue the household's digest for its local today when it is due.
 * @param ctx: (MutationCtx) Mutation context.
 * @param householdId: (Id<"households">) Household.
 * @param now: (number) Epoch ms.
 * @return: (Promise<boolean>) True when a digest was queued by this call.
 */
export async function queueDigestIfDue(
  ctx: MutationCtx,
  householdId: Id<"households">,
  now: number,
): Promise<boolean> {
  const household = await ctx.db.get(householdId);
  if (!household || household.backgroundPaused) return false;
  if (localTime(now, household.timezone) < household.digestTime) return false;
  const date = localDate(now, household.timezone);
  const existing = await ctx.db
    .query("digests")
    .withIndex("by_household_date", (q) => q.eq("householdId", householdId).eq("localDate", date))
    .first();
  if (existing) return false;
  if (household._creationTime > zonedInstant(date, household.digestTime, household.timezone)) {
    return false;
  }
  const digestId = await ctx.db.insert("digests", {
    householdId,
    localDate: date,
    status: "pending",
  });
  await enqueueDigest(ctx, digestId);
  return true;
}
