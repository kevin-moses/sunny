// calendar.ts
// Purpose: The shared calendar and day clock, ported from the Supabase calendar migration
// (add_event, update_event, cancel_event, list_events, get_day_view). One write path serves
// the caregiver app and, later, the agent: each operation's core is a plain helper taking
// (ctx, actor, householdId, args, now) so the agent tools and runtime can reuse it with an
// agent actor and an explicit clock. The public mutations resolve the actor from auth
// (editor caregivers only) and use Date.now(). Events are scheduled in household-local
// terms (see lib/occurrences.ts); cancelling is a soft delete (deletedAt). listEvents and
// dayView are readable by caregivers of any role and by the household's paired device.
// updateEvent takes `changes`: an absent key is unchanged, a key present as null clears the
// field, and unknown keys are rejected by the validator. listOccurrencesCore and
// householdWeek are shared helpers for the agent tools and briefing (lib/agentTools.ts,
// lib/agentBriefing.ts).
//
// Last modified: 2026-10-29

import { v } from "convex/values";
import type { ObjectType } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { mutation, query } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { actorUserId, loadHousehold, requireEditor, requireReader } from "./lib/access";
import type { Actor } from "./lib/access";
import { audit } from "./lib/audit";
import { appError } from "./lib/errors";
import {
  assertEventNotPast,
  eventJson,
  eventWithNext,
  expandOccurrences,
  householdOccurrences,
  liveEvents,
  occurrenceJson,
} from "./lib/occurrences";
import type { EventJson, EventWithNext, Occurrence, OccurrenceJson } from "./lib/occurrences";
import {
  addDays,
  dateLabel,
  daysBetween,
  isLocalDate,
  isLocalTime,
  localDate,
  localDateTime,
  localTime,
  minutes,
  partOfDay,
  weekdayName,
} from "./lib/time";
import { cleanOptional, normalizeWeekdays, requireNonBlank } from "./lib/text";
import { todayInstances } from "./lib/today";

const MAX_TITLE = 200;
const MAX_LABEL = 80;
const MAX_PLACE = 300;
const MAX_VISITOR = 120;
const MAX_NOTES = 2000;
const REPEAT_DAYS_MESSAGE = "Repeat days must be weekdays 1 (Monday) to 7 (Sunday)";
const MAX_LIST_RANGE_DAYS = 92;
const WEEK_DAYS = 7;
const DEFAULT_DURATION_MINUTES = 30;

/** Fields a new event is created from (everything but the household). */
const addEventFields = {
  title: v.string(),
  onDate: v.string(),
  startTime: v.string(),
  durationMinutes: v.optional(v.number()),
  place: v.optional(v.string()),
  notes: v.optional(v.string()),
  visitorName: v.optional(v.string()),
  label: v.optional(v.string()),
  repeatDays: v.optional(v.array(v.number())),
  repeatUntil: v.optional(v.string()),
};

/** Arguments of addEventCore: the event's fields as a caller supplies them. */
export type AddEventArgs = ObjectType<typeof addEventFields>;

/**
 * Edits to an event. A key that is absent is unchanged; a clearable key given as null is
 * cleared (repeatDays null makes the event one-off). Title, onDate and startTime cannot be
 * null. Unknown keys are rejected by this validator.
 */
export const eventChanges = v.object({
  title: v.optional(v.string()),
  label: v.optional(v.union(v.null(), v.string())),
  onDate: v.optional(v.string()),
  startTime: v.optional(v.string()),
  durationMinutes: v.optional(v.union(v.null(), v.number())),
  place: v.optional(v.union(v.null(), v.string())),
  notes: v.optional(v.union(v.null(), v.string())),
  visitorName: v.optional(v.union(v.null(), v.string())),
  repeatDays: v.optional(v.union(v.null(), v.array(v.number()))),
  repeatUntil: v.optional(v.union(v.null(), v.string())),
});

/** Type of the changes argument of updateEventCore. */
export type EventChanges = ObjectType<typeof eventChanges.fields>;

/** An event's stored, normalized fields. */
interface EventFields {
  title: string;
  label: string | undefined;
  startsOn: string;
  startTime: string;
  durationMinutes: number | undefined;
  place: string | undefined;
  visitorName: string | undefined;
  notes: string | undefined;
  repeatDays: number[] | undefined;
  repeatUntil: string | undefined;
}

/**
 * purpose: Validate and normalize an event's fields as the whole stored row (the SQL check
 *          constraints applied to the final row).
 * @param raw: (EventFields) Fields as supplied or merged with an existing event.
 * @return: (EventFields) Trimmed, bounded, deduplicated fields.
 * @raises invalid for a blank title, bad date or time, bad duration, or a bad repeat.
 */
function normalizeFields(raw: EventFields): EventFields {
  const title = requireNonBlank(raw.title, "Title");
  if (title.length > MAX_TITLE)
    throw appError("invalid", `Title is too long (${MAX_TITLE} at most)`);
  if (!isLocalDate(raw.startsOn)) throw appError("invalid", "Date must be YYYY-MM-DD");
  if (!isLocalTime(raw.startTime)) throw appError("invalid", "Start time must be HH:MM");
  const duration = raw.durationMinutes;
  if (duration !== undefined && (!Number.isInteger(duration) || duration < 1 || duration > 1440)) {
    throw appError("invalid", "Duration must be 1 to 1440 minutes");
  }
  if (raw.repeatDays?.length === 0) {
    throw appError("invalid", REPEAT_DAYS_MESSAGE);
  }
  const repeatDays = raw.repeatDays && normalizeWeekdays(raw.repeatDays, REPEAT_DAYS_MESSAGE);
  const repeatUntil = raw.repeatUntil;
  if (repeatUntil !== undefined) {
    if (!isLocalDate(repeatUntil)) throw appError("invalid", "Repeat end must be YYYY-MM-DD");
    if (repeatDays === undefined) throw appError("invalid", "A repeat end needs repeat days");
    if (repeatUntil < raw.startsOn) {
      throw appError("invalid", "The repeat end cannot be before the start date");
    }
  }
  return {
    title,
    label: cleanOptional(raw.label, MAX_LABEL, "Label"),
    startsOn: raw.startsOn,
    startTime: raw.startTime,
    durationMinutes: duration,
    place: cleanOptional(raw.place, MAX_PLACE, "Place"),
    visitorName: cleanOptional(raw.visitorName, MAX_VISITOR, "Visitor name"),
    notes: cleanOptional(raw.notes, MAX_NOTES, "Notes"),
    repeatDays,
    repeatUntil,
  };
}

/**
 * purpose: A live event of the given household (the port of private.lock_event: an event of
 *          another household, or a cancelled one, is not found).
 * @param ctx: (QueryCtx) Context.
 * @param householdId: (Id<"households">) The household the caller acts for.
 * @param eventId: (Id<"events">) Event.
 * @return: (Promise<Doc<"events">>) The event.
 * @raises not_found when missing, cancelled, or in another household.
 */
async function loadLiveEvent(
  ctx: QueryCtx,
  householdId: Id<"households">,
  eventId: Id<"events">,
): Promise<Doc<"events">> {
  const event = await ctx.db.get(eventId);
  if (!event || event.householdId !== householdId || event.deletedAt !== undefined) {
    throw appError("not_found", "Event not found");
  }
  return event;
}

/**
 * purpose: Write the audit row for an event change.
 * @param ctx: (MutationCtx) Context.
 * @param actor: (Actor) Who changed it.
 * @param action: (string) "insert", "update" or "cancel".
 * @param event: (Doc<"events">) The event after the change.
 * @return: (Promise<void>) Resolves when written.
 */
async function auditEvent(
  ctx: MutationCtx,
  actor: Actor,
  action: string,
  event: Doc<"events">,
): Promise<void> {
  await audit(ctx, {
    householdId: event.householdId,
    actor,
    action,
    entity: "event",
    entityId: event._id,
    detail: {
      title: event.title,
      startsOn: event.startsOn,
      startTime: event.startTime,
      createdVia: event.createdVia,
    },
  });
}

/**
 * purpose: Core of addEvent, reusable by agent tools: validate, insert and audit an event.
 *          The caller has already checked that the actor may edit the household.
 * @param ctx: (MutationCtx) Context.
 * @param actor: (Actor) Who adds the event; becomes createdVia and createdBy.
 * @param householdId: (Id<"households">) Household.
 * @param args: (AddEventArgs) The event's fields.
 * @param now: (number) Epoch ms the "not in the past" rules are checked against.
 * @return: (Promise<EventWithNext>) The event with its next occurrence.
 */
export async function addEventCore(
  ctx: MutationCtx,
  actor: Actor,
  householdId: Id<"households">,
  args: AddEventArgs,
  now: number,
): Promise<EventWithNext> {
  const household = await loadHousehold(ctx, householdId);
  const fields = normalizeFields({
    title: args.title,
    label: args.label,
    startsOn: args.onDate,
    startTime: args.startTime,
    durationMinutes: args.durationMinutes,
    place: args.place,
    visitorName: args.visitorName,
    notes: args.notes,
    repeatDays: args.repeatDays,
    repeatUntil: args.repeatUntil,
  });
  assertEventNotPast(fields, household.timezone, now);
  const id = await ctx.db.insert("events", {
    householdId,
    ...fields,
    createdVia: actor.kind,
    createdBy: actorUserId(actor),
  });
  const event = (await ctx.db.get(id))!;
  await auditEvent(ctx, actor, "insert", event);
  return eventWithNext(event, household.timezone, now);
}

/**
 * purpose: Core of updateEvent, reusable by agent tools: apply changes to a live event of
 *          the household, validate the resulting event, patch and audit it.
 * @param ctx: (MutationCtx) Context.
 * @param actor: (Actor) Who changes the event.
 * @param householdId: (Id<"households">) Household the caller acts for.
 * @param eventId: (Id<"events">) Event to change.
 * @param changes: (EventChanges) Absent key = unchanged, null = cleared.
 * @param now: (number) Epoch ms the "not in the past" rules are checked against.
 * @return: (Promise<EventWithNext>) The event with its next occurrence.
 * @raises not_found for a missing, cancelled or foreign event; invalid for bad values.
 */
export async function updateEventCore(
  ctx: MutationCtx,
  actor: Actor,
  householdId: Id<"households">,
  eventId: Id<"events">,
  changes: EventChanges,
  now: number,
): Promise<EventWithNext> {
  const household = await loadHousehold(ctx, householdId);
  const current = await loadLiveEvent(ctx, householdId, eventId);
  // Merge: undefined keeps the current value, null clears it.
  /**
   * purpose: Merge a change with the existing value: undefined keeps it, null clears it.
   * @param change: (T | null | undefined) The value from the changes argument.
   * @param existing: (T | undefined) The event's current value.
   * @return: (T | undefined) The value to write.
   */
  const pick = <T>(change: T | null | undefined, existing: T | undefined): T | undefined =>
    change === undefined ? existing : (change ?? undefined);
  const fields = normalizeFields({
    title: changes.title ?? current.title,
    label: pick(changes.label, current.label),
    startsOn: changes.onDate ?? current.startsOn,
    startTime: changes.startTime ?? current.startTime,
    durationMinutes: pick(changes.durationMinutes, current.durationMinutes),
    place: pick(changes.place, current.place),
    visitorName: pick(changes.visitorName, current.visitorName),
    notes: pick(changes.notes, current.notes),
    repeatDays: pick(changes.repeatDays, current.repeatDays),
    repeatUntil: pick(changes.repeatUntil, current.repeatUntil),
  });
  const reschedules = [
    changes.onDate,
    changes.startTime,
    changes.repeatDays,
    changes.repeatUntil,
  ].some((c) => c !== undefined);
  if (reschedules) assertEventNotPast(fields, household.timezone, now);
  await ctx.db.patch(eventId, fields);
  const event = (await ctx.db.get(eventId))!;
  await auditEvent(ctx, actor, "update", event);
  return eventWithNext(event, household.timezone, now);
}

/**
 * purpose: Core of cancelEvent, reusable by agent tools: soft delete a live event of the
 *          household and audit the cancellation.
 * @param ctx: (MutationCtx) Context.
 * @param actor: (Actor) Who cancels the event.
 * @param householdId: (Id<"households">) Household the caller acts for.
 * @param eventId: (Id<"events">) Event to cancel.
 * @param now: (number) Epoch ms recorded as deletedAt.
 * @return: (Promise<EventJson>) The cancelled event's definition.
 * @raises not_found for a missing, already cancelled or foreign event.
 */
export async function cancelEventCore(
  ctx: MutationCtx,
  actor: Actor,
  householdId: Id<"households">,
  eventId: Id<"events">,
  now: number,
): Promise<EventJson> {
  await loadLiveEvent(ctx, householdId, eventId);
  await ctx.db.patch(eventId, { deletedAt: now });
  const event = (await ctx.db.get(eventId))!;
  await auditEvent(ctx, actor, "cancel", event);
  return eventJson(event);
}

/**
 * purpose: Core of listEvents, reusable by agent tools: validate the range and return the
 *          household's occurrences. The caller has already checked read access.
 * @param ctx: (QueryCtx) Context.
 * @param householdId: (Id<"households">) Household.
 * @param from: (string) First local date, "YYYY-MM-DD".
 * @param to: (string) Last local date (at most 92 days after from).
 * @return: (Promise<OccurrenceJson[]>) Occurrences with their event definitions, earliest first.
 * @raises invalid for malformed dates or a range that is reversed or longer than 92 days.
 */
export async function listOccurrencesCore(
  ctx: QueryCtx,
  householdId: Id<"households">,
  from: string,
  to: string,
): Promise<OccurrenceJson[]> {
  if (!isLocalDate(from) || !isLocalDate(to)) throw appError("invalid", "Dates must be YYYY-MM-DD");
  if (to < from || daysBetween(from, to) > MAX_LIST_RANGE_DAYS) {
    throw appError("invalid", "Date range must be 0 to 92 days");
  }
  const household = await loadHousehold(ctx, householdId);
  const occurrences = await householdOccurrences(ctx, householdId, household.timezone, from, to);
  return occurrences.map(occurrenceJson);
}

/** A household with its local today and its occurrences from today through 7 days ahead. */
export interface HouseholdWeek {
  household: Doc<"households">;
  today: string;
  weekday: string;
  week: Occurrence[];
}

/**
 * purpose: Load a household and its occurrences from local today through today + 7 days
 *          (the shared basis of dayView and the agent briefing).
 * @param ctx: (QueryCtx) Context.
 * @param householdId: (Id<"households">) Household.
 * @param now: (number) Epoch ms.
 * @return: (Promise<HouseholdWeek>) The household, local date, weekday name and occurrences.
 */
export async function householdWeek(
  ctx: QueryCtx,
  householdId: Id<"households">,
  now: number,
): Promise<HouseholdWeek> {
  const household = await loadHousehold(ctx, householdId);
  const today = localDate(now, household.timezone);
  const week = expandOccurrences(
    await liveEvents(ctx, householdId),
    household.timezone,
    today,
    addDays(today, WEEK_DAYS),
  );
  return { household, today, weekday: weekdayName(today), week };
}

/**
 * purpose: Add an event: one-off on onDate, or weekly on repeatDays from onDate until
 *          repeatUntil. Times are household-local. Editor caregivers only.
 * @param householdId: (Id<"households">) Household.
 * @param title: (string) Required, 200 characters at most.
 * @param onDate: (string) First (or only) local date, "YYYY-MM-DD".
 * @param startTime: (string) Local "HH:MM".
 * @param durationMinutes: (number | undefined) 1 to 1440.
 * @param place: (string | undefined) Optional text; blank is absent.
 * @param notes: (string | undefined) Optional text; blank is absent.
 * @param visitorName: (string | undefined) Optional text; blank is absent.
 * @param label: (string | undefined) Optional shorter wording for the senior; blank is absent.
 * @param repeatDays: (number[] | undefined) ISO weekdays for a weekly repeat.
 * @param repeatUntil: (string | undefined) Last local date of the repeat; needs repeatDays.
 * @return: (EventWithNext) The event with its next occurrence.
 */
export const addEvent = mutation({
  args: { householdId: v.id("households"), ...addEventFields },
  handler: async (ctx, { householdId, ...args }) => {
    const actor = await requireEditor(ctx, householdId);
    return await addEventCore(ctx, actor, householdId, args, Date.now());
  },
});

/**
 * purpose: Change an event. Absent keys in `changes` are unchanged; a key given as null
 *          clears the field (repeatDays null makes the event one-off). Editor caregivers only.
 * @param householdId: (Id<"households">) Household the event belongs to.
 * @param eventId: (Id<"events">) Event.
 * @param changes: (object) Fields to change; see eventChanges.
 * @return: (EventWithNext) The event with its next occurrence.
 */
export const updateEvent = mutation({
  args: { householdId: v.id("households"), eventId: v.id("events"), changes: eventChanges },
  handler: async (ctx, { householdId, eventId, changes }) => {
    const actor = await requireEditor(ctx, householdId);
    return await updateEventCore(ctx, actor, householdId, eventId, changes, Date.now());
  },
});

/**
 * purpose: Cancel an event (soft delete). Editor caregivers only.
 * @param householdId: (Id<"households">) Household the event belongs to.
 * @param eventId: (Id<"events">) Event.
 * @return: (EventJson) The cancelled event.
 */
export const cancelEvent = mutation({
  args: { householdId: v.id("households"), eventId: v.id("events") },
  handler: async (ctx, { householdId, eventId }) => {
    const actor = await requireEditor(ctx, householdId);
    return await cancelEventCore(ctx, actor, householdId, eventId, Date.now());
  },
});

/**
 * purpose: Occurrences between two local dates (inclusive, at most 92 days), earliest first.
 *          Caregivers of any role and the household's paired device can read.
 * @param householdId: (Id<"households">) Household.
 * @param from: (string) First local date, "YYYY-MM-DD".
 * @param to: (string) Last local date.
 * @return: (OccurrenceJson[]) Occurrences with their event definitions.
 */
export const listEvents = query({
  args: { householdId: v.id("households"), from: v.string(), to: v.string() },
  handler: async (ctx, { householdId, from, to }) => {
    await requireReader(ctx, householdId);
    return await listOccurrencesCore(ctx, householdId, from, to);
  },
});

/**
 * purpose: The day clock every surface renders: local date and part of day, today's tasks
 *          and events, Next up (the first occurrence within 7 days that has not ended;
 *          events without a duration count as 30 minutes) and the coming week. Occurrences
 *          are expanded once. The server clock is read when the query runs, and Convex only
 *          re-runs a query when data it read changes, so `minute` exists to force a re-run:
 *          the client passes its current minute, a new value is a new cache entry, and the
 *          view is never staler than the client's minute clock. The handler ignores it. Any
 *          reader can pass arbitrary values and create extra cache entries; that is accepted
 *          because callers are authenticated household members.
 * @param householdId: (Id<"households">) Household.
 * @param minute: (number | undefined) Client minute counter; only varies the query key.
 * @return: (object) seniorPreferredName, timezone, localNow, localDate, weekday, dateLabel,
 *          header, tasks, eventsToday, nextUp and upcoming.
 */
export const dayView = query({
  args: { householdId: v.id("households"), minute: v.optional(v.number()) },
  handler: async (ctx, { householdId }) => {
    await requireReader(ctx, householdId);
    const now = Date.now();
    const { household, today, weekday, week } = await householdWeek(ctx, householdId, now);
    const timezone = household.timezone;
    const nextUp = week.find(
      (o) => (o.endsAt ?? o.startsAt + minutes(DEFAULT_DURATION_MINUTES)) > now,
    );
    return {
      seniorPreferredName: household.seniorPreferredName,
      timezone,
      localNow: localDateTime(now, timezone),
      localDate: today,
      weekday,
      dateLabel: dateLabel(today),
      header: `${weekday} ${partOfDay(localTime(now, timezone))}`,
      tasks: await todayInstances(ctx, householdId, now),
      eventsToday: week.filter((o) => o.localDate === today).map(occurrenceJson),
      nextUp: nextUp ? occurrenceJson(nextUp) : null,
      upcoming: week.filter((o) => o.localDate > today).map(occurrenceJson),
    };
  },
});
