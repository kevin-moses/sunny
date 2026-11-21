import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { factsCover } from "./mailAppointments";
import { linkDomain, linkKey } from "./mailLinks";
import { MAX_CALENDAR_CHANGES_PER_DAY, MAX_NOTES_PER_DAY } from "./mailPolicy";
import type {
  CalendarEventFact,
  Clock,
  IcsEvent,
  KnownInvite,
  LinkedEvent,
  MailHeader,
  MailSender,
  MailVerdict,
  PolicyFacts,
} from "./mailTypes";
import { canStillOccur, expandOccurrences, liveEvents } from "./occurrences";
import { addDays, localDate, localMidnight } from "./time";

export interface FactSources {
  household: Doc<"households">;
  header: MailHeader;
  now: number;
  verdict: MailVerdict;
  ics: IcsEvent | null;
}

export interface LoadedFacts {
  facts: PolicyFacts;
  events: Map<string, Doc<"events">>;
}

export function recordedHeader(item: Doc<"mailItems">): MailHeader | null {
  const { sender, subject, receivedAt } = item;
  return sender === undefined || subject === undefined || receivedAt === undefined
    ? null
    : { sender, subject, receivedAt };
}

export function knownInvite(link: { sequence?: number } | null): KnownInvite | null {
  return link === null ? null : { sequence: link.sequence ?? 0 };
}

export function linkedEvent(
  link: { eventId: string; senderAddress: string },
  ended: { date: string; time: string } | null,
  sender: MailSender,
): LinkedEvent {
  const { eventId } = link;
  if (ended === null) return { eventId, occurs: true };
  return {
    eventId,
    occurs: false,
    date: ended.date,
    time: ended.time,
    madeBy: link.senderAddress === sender.address ? "this_address" : "another_address",
  };
}

export async function linkOf(
  ctx: QueryCtx,
  householdId: Id<"households">,
  senderDomain: string,
  appointmentKey: string,
): Promise<Doc<"mailEventLinks"> | null> {
  return await ctx.db
    .query("mailEventLinks")
    .withIndex("by_household_domain_key", (q) =>
      q
        .eq("householdId", householdId)
        .eq("senderDomain", senderDomain)
        .eq("appointmentKey", appointmentKey),
    )
    .unique();
}

export async function senderLink(
  ctx: QueryCtx,
  householdId: Id<"households">,
  sender: MailSender,
  appointmentKey: string,
): Promise<Doc<"mailEventLinks"> | null> {
  const senderDomain = linkDomain(sender);
  return senderDomain === null
    ? null
    : await linkOf(ctx, householdId, senderDomain, appointmentKey);
}

function eventFact(event: Doc<"events">, date: string): CalendarEventFact {
  return {
    eventId: event._id,
    title: event.title,
    date,
    time: event.startTime,
    durationMinutes: event.durationMinutes ?? null,
    repeating: event.repeatDays !== undefined,
  };
}

function datesNamed(verdict: MailVerdict): string[] {
  if (verdict.kind !== "appointment") return [];
  if (verdict.change === "cancel") return [verdict.previous.date];
  const { date } = verdict.appointment;
  const dates = [addDays(date, -1), date];
  return verdict.change === "reschedule" && verdict.previous !== null
    ? [...dates, verdict.previous.date]
    : dates;
}

async function calendarFacts(
  ctx: QueryCtx,
  household: Doc<"households">,
  clock: Clock,
  verdict: MailVerdict,
): Promise<{ events: Doc<"events">[]; facts: CalendarEventFact[] }> {
  const inHorizon = (date: string) => factsCover(date, clock);
  const live = await liveEvents(ctx, household._id);
  const singles = live.filter((e) => e.repeatDays === undefined && inHorizon(e.startsOn));
  const series = live.filter((e) => e.repeatDays !== undefined);
  const occurrences = [...new Set(datesNamed(verdict).filter(inHorizon))].flatMap((date) =>
    expandOccurrences(series, clock.timezone, date, date),
  );
  const facts = [
    ...singles.map((e) => eventFact(e, e.startsOn)),
    ...occurrences.map((o) => eventFact(o.event, o.localDate)),
  ];
  return { events: [...singles, ...series], facts };
}

async function countsToday(
  ctx: QueryCtx,
  householdId: Id<"households">,
  clock: Clock,
): Promise<{ calendarChangesToday: number; seniorNotesToday: number }> {
  const startOfToday = localMidnight(clock.now, clock.timezone);
  const [changed, written] = await Promise.all([
    ctx.db
      .query("mailItems")
      .withIndex("by_household_calendar_changed", (q) =>
        q.eq("householdId", householdId).gte("calendarChangedAt", startOfToday),
      )
      .take(MAX_CALENDAR_CHANGES_PER_DAY),
    ctx.db
      .query("seniorNotes")
      .withIndex("by_household", (q) =>
        q.eq("householdId", householdId).gte("_creationTime", startOfToday),
      )
      .take(MAX_NOTES_PER_DAY),
  ]);
  return { calendarChangesToday: changed.length, seniorNotesToday: written.length };
}

async function linkedFact(
  ctx: QueryCtx,
  household: Doc<"households">,
  header: MailHeader,
  key: string | null,
  today: string,
): Promise<{ linked: LinkedEvent; event: Doc<"events"> } | null> {
  const link = key === null ? null : await senderLink(ctx, household._id, header.sender, key);
  const event = link === null ? null : await ctx.db.get(link.eventId);
  if (link === null || event === null) return null;
  const ended = canStillOccur(event, today)
    ? null
    : { date: event.startsOn, time: event.startTime };
  return { linked: linkedEvent(link, ended, header.sender), event };
}

export async function loadFacts(
  ctx: QueryCtx,
  { household, header, now, verdict, ics }: FactSources,
): Promise<LoadedFacts> {
  const clock = { now, timezone: household.timezone };
  const calendar = await calendarFacts(ctx, household, clock, verdict);
  const events = new Map<string, Doc<"events">>(calendar.events.map((e) => [e._id, e]));
  const today = localDate(now, household.timezone);
  const link = await linkedFact(ctx, household, header, linkKey(verdict, ics), today);
  if (link !== null) events.set(link.event._id, link.event);
  return {
    facts: {
      now,
      timezone: household.timezone,
      ...header,
      ics,
      events: calendar.facts,
      linked: link?.linked ?? null,
      ...(await countsToday(ctx, household._id, clock)),
    },
    events,
  };
}
