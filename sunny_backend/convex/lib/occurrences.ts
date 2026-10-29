// lib/occurrences.ts
// Purpose: Calendar occurrences, ported from private.event_occurrences, event_json,
// occurrence_json, event_with_next and assert_event_not_past. A household's live (not
// cancelled) events expand into occurrences between two local dates inclusive: a one-off
// event occurs on startsOn; a weekly repeat occurs on repeatDays from startsOn until
// repeatUntil. Each occurrence carries its local date and start and end instants computed
// with lib/time.zonedInstant, so 2 PM stays 2 PM local across DST. Absent optional event
// fields are null in the JSON shapes, as they were in the SQL.
//
// Last modified: 2026-10-28

import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { appError } from "./errors";
import { addDays, daysBetween, isoWeekday, localDate, minutes, zonedInstant } from "./time";
import type { ActorKind } from "./validators";

/** Days ahead eventWithNext searches for the next occurrence. */
const NEXT_OCCURRENCE_HORIZON_DAYS = 400;

/** The fields of an event that decide when it happens. */
export interface EventSchedule {
  startsOn: string;
  startTime: string;
  repeatDays?: number[] | undefined;
  repeatUntil?: string | undefined;
}

/** One occurrence of a live event. */
export interface Occurrence {
  event: Doc<"events">;
  localDate: string;
  startsAt: number;
  endsAt: number | null;
}

/** An event's definition as returned to clients (absent optional fields are null). */
export interface EventJson {
  eventId: Id<"events">;
  title: string;
  label: string;
  startsOn: string;
  startTime: string;
  durationMinutes: number | null;
  place: string | null;
  visitorName: string | null;
  notes: string | null;
  repeatDays: number[] | null;
  repeatUntil: string | null;
  createdVia: ActorKind;
  cancelled: boolean;
}

/** An event definition plus one occurrence's local date and instants. */
export interface OccurrenceJson extends EventJson {
  localDate: string;
  startsAt: number;
  endsAt: number | null;
}

/** An event definition plus its next occurrence, if any. */
export interface EventWithNext extends EventJson {
  nextOccurrence: { localDate: string; startsAt: number } | null;
}

/**
 * purpose: An event's definition as JSON (the label falls back to the title).
 * @param event: (Doc<"events">) The event.
 * @return: (EventJson) Camel case definition.
 */
export function eventJson(event: Doc<"events">): EventJson {
  return {
    eventId: event._id,
    title: event.title,
    label: event.label ?? event.title,
    startsOn: event.startsOn,
    startTime: event.startTime,
    durationMinutes: event.durationMinutes ?? null,
    place: event.place ?? null,
    visitorName: event.visitorName ?? null,
    notes: event.notes ?? null,
    repeatDays: event.repeatDays ?? null,
    repeatUntil: event.repeatUntil ?? null,
    createdVia: event.createdVia,
    cancelled: event.deletedAt !== undefined,
  };
}

/**
 * purpose: One occurrence as JSON: the event's definition plus the occurrence's local date
 *          and instants.
 * @param occurrence: (Occurrence) The occurrence.
 * @return: (OccurrenceJson) Definition with localDate, startsAt and endsAt.
 */
export function occurrenceJson(occurrence: Occurrence): OccurrenceJson {
  return {
    ...eventJson(occurrence.event),
    localDate: occurrence.localDate,
    startsAt: occurrence.startsAt,
    endsAt: occurrence.endsAt,
  };
}

/**
 * purpose: Local dates on which an event occurs between two local dates inclusive.
 * @param event: (EventSchedule) When the event happens.
 * @param from: (string) First local date, "YYYY-MM-DD".
 * @param to: (string) Last local date, "YYYY-MM-DD".
 * @return: (string[]) Dates in ascending order.
 */
function occurrenceDates(event: EventSchedule, from: string, to: string): string[] {
  if (event.repeatDays === undefined) {
    return event.startsOn >= from && event.startsOn <= to ? [event.startsOn] : [];
  }
  const first = from > event.startsOn ? from : event.startsOn;
  const last = event.repeatUntil !== undefined && event.repeatUntil < to ? event.repeatUntil : to;
  const dates: string[] = [];
  for (let date = first; date <= last; date = addDays(date, 1)) {
    if (event.repeatDays.includes(isoWeekday(date))) dates.push(date);
  }
  return dates;
}

/**
 * purpose: Expand events into occurrences between two local dates inclusive, earliest first.
 * @param events: (Doc<"events">[]) Events to expand; cancelled ones are skipped.
 * @param timezone: (string) The household's IANA zone.
 * @param from: (string) First local date.
 * @param to: (string) Last local date.
 * @return: (Occurrence[]) Occurrences ordered by start instant.
 */
export function expandOccurrences(
  events: Doc<"events">[],
  timezone: string,
  from: string,
  to: string,
): Occurrence[] {
  const out: Occurrence[] = [];
  for (const event of events) {
    if (event.deletedAt !== undefined) continue;
    for (const date of occurrenceDates(event, from, to)) {
      const startsAt = zonedInstant(date, event.startTime, timezone);
      const endsAt =
        event.durationMinutes === undefined ? null : startsAt + minutes(event.durationMinutes);
      out.push({ event, localDate: date, startsAt, endsAt });
    }
  }
  out.sort((a, b) => a.startsAt - b.startsAt || a.event._creationTime - b.event._creationTime);
  return out;
}

/**
 * purpose: A household's live events.
 * @param ctx: (QueryCtx) Context.
 * @param householdId: (Id<"households">) Household.
 * @return: (Promise<Doc<"events">[]>) Events that are not cancelled.
 */
export async function liveEvents(
  ctx: QueryCtx,
  householdId: Id<"households">,
): Promise<Doc<"events">[]> {
  return await ctx.db
    .query("events")
    .withIndex("by_household_deleted", (q) =>
      q.eq("householdId", householdId).eq("deletedAt", undefined),
    )
    .collect();
}

/**
 * purpose: Occurrences of a household's live events between two local dates inclusive.
 * @param ctx: (QueryCtx) Context.
 * @param householdId: (Id<"households">) Household.
 * @param timezone: (string) The household's IANA zone.
 * @param from: (string) First local date.
 * @param to: (string) Last local date.
 * @return: (Promise<Occurrence[]>) Occurrences, earliest first.
 */
export async function householdOccurrences(
  ctx: QueryCtx,
  householdId: Id<"households">,
  timezone: string,
  from: string,
  to: string,
): Promise<Occurrence[]> {
  return expandOccurrences(await liveEvents(ctx, householdId), timezone, from, to);
}

/**
 * purpose: An event's JSON plus its next occurrence within 400 days (null when none).
 * @param event: (Doc<"events">) The event.
 * @param timezone: (string) The household's IANA zone.
 * @param now: (number) Epoch ms.
 * @return: (EventWithNext) Definition and next occurrence (the first starting at or after now).
 */
export function eventWithNext(event: Doc<"events">, timezone: string, now: number): EventWithNext {
  const today = localDate(now, timezone);
  const next = expandOccurrences(
    [event],
    timezone,
    today,
    addDays(today, NEXT_OCCURRENCE_HORIZON_DAYS),
  ).find((o) => o.startsAt >= now);
  return {
    ...eventJson(event),
    nextOccurrence: next ? { localDate: next.localDate, startsAt: next.startsAt } : null,
  };
}

/**
 * purpose: Reject a one-off event that would start in the past, a repeat that ends in the
 *          past, and a weekly repeat with no date at all (no matching weekday between its
 *          start and repeatUntil). Times are household-local.
 * @param event: (EventSchedule) The schedule to check.
 * @param timezone: (string) The household's IANA zone.
 * @param now: (number) Epoch ms.
 * @return: (void)
 * @raises invalid with the same messages as the SQL.
 */
export function assertEventNotPast(event: EventSchedule, timezone: string, now: number): void {
  if (
    event.repeatDays === undefined &&
    zonedInstant(event.startsOn, event.startTime, timezone) < now
  ) {
    throw appError("invalid", "That time has already passed");
  }
  if (event.repeatUntil !== undefined && event.repeatUntil < localDate(now, timezone)) {
    throw appError("invalid", "The repeat end date has already passed");
  }
  if (event.repeatDays !== undefined && event.repeatUntil !== undefined) {
    // A weekday that does not occur in the first seven days never occurs.
    const span = Math.min(7, daysBetween(event.startsOn, event.repeatUntil) + 1);
    let found = false;
    for (let n = 0; n < span; n++) {
      if (event.repeatDays.includes(isoWeekday(addDays(event.startsOn, n)))) found = true;
    }
    if (!found) throw appError("invalid", "The repeat has no dates between its start and end");
  }
}
