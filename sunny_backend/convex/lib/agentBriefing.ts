// lib/agentBriefing.ts
// Purpose: The household briefing the agent receives at the start of each request, ported
// from the Supabase agent runtime: the senior's preferred name, the timezone, the local
// weekday and date/time now, the requesting caregiver's display name, and the calendar for
// today and the next 7 days (one line per occurrence with its event_id so the model can
// change or cancel it). Built on the calendar's householdWeek helper so the week matches
// the day view.
//
// Last modified: 2026-10-29

import type { Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { householdWeek } from "../calendar";
import { localDateTime } from "./time";

/**
 * purpose: Build the household briefing text for an agent request.
 * @param ctx: (QueryCtx) Context.
 * @param householdId: (Id<"households">) Household.
 * @param requestedBy: (string | null) Clerk user id of the requesting caregiver, if any.
 * @param now: (number) Epoch ms.
 * @return: (Promise<string>) Briefing text, one fact per line.
 */
export async function buildBriefing(
  ctx: QueryCtx,
  householdId: Id<"households">,
  requestedBy: string | null,
  now: number,
): Promise<string> {
  const { household, weekday, week } = await householdWeek(ctx, householdId, now);
  const member =
    requestedBy === null
      ? null
      : await ctx.db
          .query("householdMembers")
          .withIndex("by_household_user", (q) =>
            q.eq("householdId", householdId).eq("userId", requestedBy),
          )
          .unique();
  const events = week.map(
    (o) => `- ${o.localDate} ${o.event.startTime} ${o.event.title} (event_id ${o.event._id})`,
  );
  return [
    "Household briefing (from Sunny's records):",
    `- Senior: ${household.seniorPreferredName}`,
    `- Timezone: ${household.timezone}`,
    `- Now: ${weekday}, ${localDateTime(now, household.timezone)} local`,
    `- Requested by: ${member?.displayName ?? "a caregiver"}`,
    "- Calendar, today and the next 7 days:",
    ...(events.length ? events : ["  (nothing scheduled)"]),
  ].join("\n");
}
