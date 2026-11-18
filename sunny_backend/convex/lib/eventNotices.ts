import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { insertNotification } from "./delivery";
import { householdOccurrences } from "./occurrences";
import type { Occurrence } from "./occurrences";
import { formatTime12, localDate, localTime } from "./time";

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

export async function announceEvents(
  ctx: MutationCtx,
  household: Doc<"households">,
  now: number,
): Promise<number> {
  const householdId = household._id;
  if (localTime(now, household.timezone) < household.eventNoticeTime) return 0;
  const today = localDate(now, household.timezone);
  const upcoming = (
    await householdOccurrences(ctx, householdId, household.timezone, today, today)
  ).filter((o) => o.startsAt > now);
  if (upcoming.length === 0) return 0;
  const announced = new Set(
    (
      await Promise.all(
        upcoming.map((o) =>
          ctx.db
            .query("eventNotices")
            .withIndex("by_event_date", (q) => q.eq("eventId", o.event._id).eq("localDate", today))
            .first(),
        ),
      )
    )
      .filter((notice) => notice !== null)
      .map((notice) => notice.eventId),
  );
  const due = upcoming.filter((o) => !announced.has(o.event._id));
  if (due.length === 0) return 0;
  const members = await ctx.db
    .query("householdMembers")
    .withIndex("by_household_user", (q) => q.eq("householdId", householdId))
    .collect();
  await Promise.all(
    due.map(async (occurrence) => {
      const eventId = occurrence.event._id;
      await ctx.db.insert("eventNotices", { eventId, localDate: today });
      const { title, body, payload } = noticeContent(household, occurrence);
      await Promise.all(
        members.map((member) =>
          insertNotification(ctx, {
            householdId,
            kind: "event_notice",
            eventId,
            recipientUserId: member.userId,
            title,
            body,
            payload,
          }),
        ),
      );
    }),
  );
  return due.length;
}
