import { v } from "convex/values";
import type { ObjectType } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { mutation, query } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { actorUserId, loadHousehold, requireEditor, requireReader } from "./lib/access";
import type { Actor } from "./lib/access";
import { audit } from "./lib/audit";
import { queueEventSync } from "./lib/calendarSync";
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
import { upcomingTasks } from "./lib/upcomingTasks";
import { requestWidgetRefresh } from "./lib/widgetRefresh";

const MAX_TITLE = 200;
const MAX_LABEL = 80;
const MAX_PLACE = 300;
const MAX_VISITOR = 120;
const MAX_NOTES = 2000;
const REPEAT_DAYS_MESSAGE = "Repeat days must be weekdays 1 (Monday) to 7 (Sunday)";
const MAX_LIST_RANGE_DAYS = 92;
const WEEK_DAYS = 7;
const DEFAULT_DURATION_MINUTES = 30;

const EVENT_FIELD_KEYS = [
  "title",
  "label",
  "startsOn",
  "startTime",
  "durationMinutes",
  "place",
  "visitorName",
  "notes",
  "repeatDays",
  "repeatUntil",
] as const;

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

export type AddEventArgs = ObjectType<typeof addEventFields>;

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

export type EventChanges = ObjectType<typeof eventChanges.fields>;

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
  await queueEventSync(ctx, id);
  await requestWidgetRefresh(ctx, actor, householdId);
  return eventWithNext(event, household.timezone, now);
}

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
  if (EVENT_FIELD_KEYS.some((k) => JSON.stringify(current[k]) !== JSON.stringify(event[k]))) {
    await queueEventSync(ctx, eventId);
    await requestWidgetRefresh(ctx, actor, householdId);
  }
  return eventWithNext(event, household.timezone, now);
}

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
  await queueEventSync(ctx, eventId);
  await requestWidgetRefresh(ctx, actor, householdId);
  return eventJson(event);
}

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

export interface HouseholdWeek {
  household: Doc<"households">;
  today: string;
  weekday: string;
  week: Occurrence[];
}

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

export const addEvent = mutation({
  args: { householdId: v.id("households"), ...addEventFields },
  handler: async (ctx, { householdId, ...args }) => {
    const actor = await requireEditor(ctx, householdId);
    return await addEventCore(ctx, actor, householdId, args, Date.now());
  },
});

export const updateEvent = mutation({
  args: { householdId: v.id("households"), eventId: v.id("events"), changes: eventChanges },
  handler: async (ctx, { householdId, eventId, changes }) => {
    const actor = await requireEditor(ctx, householdId);
    return await updateEventCore(ctx, actor, householdId, eventId, changes, Date.now());
  },
});

export const cancelEvent = mutation({
  args: { householdId: v.id("households"), eventId: v.id("events") },
  handler: async (ctx, { householdId, eventId }) => {
    const actor = await requireEditor(ctx, householdId);
    return await cancelEventCore(ctx, actor, householdId, eventId, Date.now());
  },
});

export const listEvents = query({
  args: { householdId: v.id("households"), from: v.string(), to: v.string() },
  handler: async (ctx, { householdId, from, to }) => {
    await requireReader(ctx, householdId);
    return await listOccurrencesCore(ctx, householdId, from, to);
  },
});

export const dayView = query({
  args: { householdId: v.id("households"), minute: v.optional(v.number()) },
  handler: async (ctx, { householdId }) => {
    const actor = await requireReader(ctx, householdId);
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
      tasks: await todayInstances(ctx, householdId, now, actor),
      upcomingTasks:
        actor.kind === "caregiver"
          ? await upcomingTasks(ctx, householdId, today, WEEK_DAYS - 1)
          : [],
      eventsToday: week.filter((o) => o.localDate === today).map(occurrenceJson),
      nextUp: nextUp ? occurrenceJson(nextUp) : null,
      upcoming: week.filter((o) => o.localDate > today).map(occurrenceJson),
    };
  },
});
