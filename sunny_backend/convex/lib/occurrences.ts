import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { appError } from "./errors";
import { addDays, daysBetween, isoWeekday, localDate, minutes, zonedInstant } from "./time";
import type { ActorKind } from "./validators";

const NEXT_OCCURRENCE_HORIZON_DAYS = 400;

export interface EventSchedule {
  startsOn: string;
  startTime: string;
  repeatDays?: number[] | undefined;
  repeatUntil?: string | undefined;
}

export interface Occurrence {
  event: Doc<"events">;
  localDate: string;
  startsAt: number;
  endsAt: number | null;
}

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

export interface OccurrenceJson extends EventJson {
  localDate: string;
  startsAt: number;
  endsAt: number | null;
}

export interface EventWithNext extends EventJson {
  nextOccurrence: { localDate: string; startsAt: number } | null;
}

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

export function occurrenceJson(occurrence: Occurrence): OccurrenceJson {
  return {
    ...eventJson(occurrence.event),
    localDate: occurrence.localDate,
    startsAt: occurrence.startsAt,
    endsAt: occurrence.endsAt,
  };
}

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

export async function householdOccurrences(
  ctx: QueryCtx,
  householdId: Id<"households">,
  timezone: string,
  from: string,
  to: string,
): Promise<Occurrence[]> {
  return expandOccurrences(await liveEvents(ctx, householdId), timezone, from, to);
}

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
    const span = Math.min(7, daysBetween(event.startsOn, event.repeatUntil) + 1);
    let found = false;
    for (let n = 0; n < span; n++) {
      if (event.repeatDays.includes(isoWeekday(addDays(event.startsOn, n)))) found = true;
    }
    if (!found) throw appError("invalid", "The repeat has no dates between its start and end");
  }
}
