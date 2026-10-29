// lib/eventNotices.ts
// Purpose: Day-of event notices, ported from public.event_notice_tick in the SQL calendar
// migration. Once a household's local time reaches its eventNoticeTime, every live event
// occurrence on the household's local today that has not started yet and has no eventNotices
// row for (eventId, localDate) is announced: the eventNotices row is inserted and one
// "event_notice" notificationOutbox row is queued for every household member (the SQL joined
// household_members with no role filter; devices are separate and get none). An event added
// after the notice time the same day is announced on the next scheduler tick; an event that
// already started is not. Cancelled events are never announced and notices already queued
// stay. Like the SQL, the pass does not look at backgroundPaused. It runs inside the
// household's own tickHousehold mutation (scheduler.ts), so there is no second cron and no
// global transaction. Times are household-local, so DST and zones far from UTC follow the
// household's zone.
//
// Last modified: 2026-10-29

import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { expandOccurrences, liveEvents } from "./occurrences";
import type { Occurrence } from "./occurrences";
import { formatTime12, localDate, localTime } from "./time";

/**
 * purpose: The title, body and payload of one occurrence's notice, worded as the SQL did:
 *          "Today: Physio at 3:00 PM" / "Mom has Physio at 3:00 PM today at Clinic."
 * @param household: (Doc<"households">) The household (for the senior's name).
 * @param occurrence: (Occurrence) The occurrence being announced.
 * @return: (object) title, body and payload { eventId, localDate }.
 */
export function noticeContent(
  household: Doc<"households">,
  occurrence: Occurrence,
): { title: string; body: string; payload: { eventId: Id<"events">; localDate: string } } {
  const { event } = occurrence;
  const time = formatTime12(event.startTime);
  const place = event.place === undefined ? "" : ` at ${event.place}`;
  return {
    title: `Today: ${event.title} at ${time}`,
    body: `${household.seniorPreferredName} has ${event.title} at ${time} today${place}.`,
    payload: { eventId: event._id, localDate: occurrence.localDate },
  };
}

/**
 * purpose: Announce the household's day-of events that are due: nothing before the notice
 *          time; afterwards each unannounced occurrence of today that has not started gets an
 *          eventNotices row and one outbox row per household member. Idempotent per
 *          (event, local date).
 * @param ctx: (MutationCtx) Mutation context.
 * @param householdId: (Id<"households">) Household.
 * @param now: (number) Epoch ms.
 * @return: (Promise<number>) Occurrences announced.
 */
export async function announceEvents(
  ctx: MutationCtx,
  householdId: Id<"households">,
  now: number,
): Promise<number> {
  const household = await ctx.db.get(householdId);
  if (!household) return 0;
  if (localTime(now, household.timezone) < household.eventNoticeTime) return 0;
  const today = localDate(now, household.timezone);
  const upcoming = expandOccurrences(
    await liveEvents(ctx, householdId),
    household.timezone,
    today,
    today,
  ).filter((o) => o.startsAt > now);
  if (upcoming.length === 0) return 0;
  const members = await ctx.db
    .query("householdMembers")
    .withIndex("by_household_user", (q) => q.eq("householdId", householdId))
    .collect();
  let announced = 0;
  for (const occurrence of upcoming) {
    const eventId = occurrence.event._id;
    const seen = await ctx.db
      .query("eventNotices")
      .withIndex("by_event_date", (q) => q.eq("eventId", eventId).eq("localDate", today))
      .first();
    if (seen) continue;
    await ctx.db.insert("eventNotices", { eventId, localDate: today });
    const { title, body, payload } = noticeContent(household, occurrence);
    for (const member of members) {
      await ctx.db.insert("notificationOutbox", {
        householdId,
        kind: "event_notice",
        eventId,
        recipientUserId: member.userId,
        title,
        body,
        payload,
      });
    }
    announced += 1;
  }
  return announced;
}
