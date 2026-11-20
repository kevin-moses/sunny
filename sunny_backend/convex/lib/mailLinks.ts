import { appointmentTitle } from "./mailTypes";
import type {
  Appointment,
  AppointmentRef,
  CalendarEventFact,
  IcsEvent,
  LinkedEvent,
  LinkMaker,
  MailSender,
  MailVerdict,
  PolicyFacts,
} from "./mailTypes";
import type { Situation } from "./mailPolicy";
import { domainOf } from "./mailParse";
import { textKey } from "./text";
import { MINUTE_MS, daysBetween, isLocalDate, isLocalTime, localDate, zonedInstant } from "./time";

const MAX_DAYS_AHEAD = 400;
const MIN_DURATION_MINUTES = 5;
const MAX_DURATION_MINUTES = 480;
const ASSUMED_DURATION_MINUTES = 30;
const STOP_WORDS = new Set(["the", "and", "for", "with", "appointment", "appt", "visit", "your"]);

export function icsKey(ics: IcsEvent): string {
  return `ics:${ics.uid}`;
}

export function appointmentKey(appointment: Appointment, ics: IcsEvent | null): string {
  if (ics !== null) return icsKey(ics);
  return `appt:${appointment.date}:${appointment.time}:${textKey(appointmentTitle(appointment.kind, appointment.time))}`;
}

export function linkDomain(sender: MailSender): string | null {
  return sender.authenticated ? domainOf(sender.address) : null;
}

function appointmentOf(verdict: MailVerdict): Appointment | null {
  return verdict.kind === "appointment" && verdict.change !== "cancel" ? verdict.appointment : null;
}

export function linkKey(verdict: MailVerdict, ics: IcsEvent | null): string | null {
  if (ics !== null) return icsKey(ics);
  const appointment = appointmentOf(verdict);
  return appointment === null ? null : appointmentKey(appointment, null);
}

export function titleWords(title: string): Set<string> {
  return new Set(
    textKey(title)
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length >= 3 && !STOP_WORDS.has(w)),
  );
}

function sharesWords(a: string, b: string): boolean {
  const words = titleWords(a);
  return [...titleWords(b)].some((w) => words.has(w));
}

export function matchEvent(ref: AppointmentRef, events: CalendarEventFact[]): CalendarEventFact[] {
  return events.filter(
    (e) =>
      e.date === ref.date &&
      (ref.time === null || e.time === ref.time) &&
      sharesWords(e.title, appointmentTitle(ref.kind, ref.time)),
  );
}

export function factsCover(date: string, clock: { now: number; timezone: string }): boolean {
  const today = localDate(clock.now, clock.timezone);
  return date >= today && daysBetween(today, date) <= MAX_DAYS_AHEAD;
}

export function appointmentFields<A extends Appointment>(
  appointment: A,
  clock: { now: number; timezone: string },
): A | null {
  const { date, time, durationMinutes } = appointment;
  if (!isLocalDate(date) || !isLocalTime(time)) return null;
  if (zonedInstant(date, time, clock.timezone) < clock.now) return null;
  if (!factsCover(date, clock)) return null;
  if (
    durationMinutes !== null &&
    (!Number.isInteger(durationMinutes) ||
      durationMinutes < MIN_DURATION_MINUTES ||
      durationMinutes > MAX_DURATION_MINUTES)
  ) {
    return null;
  }
  return appointment;
}

function overlaps(a: Appointment, b: CalendarEventFact, timezone: string): boolean {
  const aStart = zonedInstant(a.date, a.time, timezone);
  const bStart = zonedInstant(b.date, b.time, timezone);
  const aEnd = aStart + (a.durationMinutes ?? ASSUMED_DURATION_MINUTES) * MINUTE_MS;
  const bEnd = bStart + (b.durationMinutes ?? ASSUMED_DURATION_MINUTES) * MINUTE_MS;
  return aStart < bEnd && bStart < aEnd;
}

declare const SLOT_CHECKED: unique symbol;

export type CheckedAppointment = Appointment & { readonly [SLOT_CHECKED]: true };

function checked(appointment: Appointment): CheckedAppointment {
  const { date, time } = appointment;
  if (!isLocalDate(date) || !isLocalTime(time)) {
    throw new Error(
      `The verdict gives an appointment at ${date} ${time}, which is not a date and a time`,
    );
  }
  return appointment as CheckedAppointment;
}

type LinkPlace =
  | { at: "slot" }
  | { at: "elsewhere"; seen: CalendarEventFact | null }
  | { at: "outside_facts" }
  | { at: "over"; date: string; time: string; madeBy: LinkMaker };

type AppointmentChange = Extract<MailVerdict, { change: "new" | "reschedule" }>;

function sameSlot(a: { date: string; time: string }, b: { date: string; time: string }): boolean {
  return a.date === b.date && a.time === b.time;
}

export function linkedFacts(linked: LinkedEvent, facts: PolicyFacts): CalendarEventFact[] {
  return facts.events.filter((e) => e.eventId === linked.eventId);
}

function linkPlace(linked: LinkedEvent, slot: Appointment, facts: PolicyFacts): LinkPlace {
  const live = linkedFacts(linked, facts);
  if (live.some((e) => sameSlot(e, slot))) return { at: "slot" };
  const seen = live.find((e) => e.date === slot.date) ?? live[0];
  if (seen !== undefined) return { at: "elsewhere", seen };
  if (!linked.occurs) {
    return { at: "over", date: linked.date, time: linked.time, madeBy: linked.madeBy };
  }
  return factsCover(slot.date, facts) ? { at: "elsewhere", seen: null } : { at: "outside_facts" };
}

function previousMatches(previous: AppointmentRef | null, facts: PolicyFacts): CalendarEventFact[] {
  return previous === null ? [] : matchEvent(previous, facts.events);
}

function moving(
  appointment: CheckedAppointment,
  matches: CalendarEventFact[],
  facts: PolicyFacts,
): Situation {
  const match = matches.length === 1 ? matches[0] : undefined;
  if (match === undefined) return { case: "reschedule_no_match", appointment };
  if (match.repeating) return { case: "reschedule_repeating", appointment, match };
  const fields = appointmentFields(appointment, facts);
  return fields === null
    ? { case: "reschedule_rejected", appointment, match }
    : { case: "reschedule", appointment: fields, match };
}

function sameSlotEvent(fields: Appointment, facts: PolicyFacts): string | null {
  return matchEvent(fields, facts.events)[0]?.eventId ?? null;
}

function unlinked(fields: CheckedAppointment, facts: PolicyFacts): Situation {
  const eventId = sameSlotEvent(fields, facts);
  if (eventId !== null) return { case: "new_on_calendar", appointment: fields, eventId };
  const conflict = facts.events.find((e) => overlaps(fields, e, facts.timezone)) ?? null;
  return { case: "new", appointment: fields, conflict };
}

export function resolveLink(verdict: AppointmentChange, facts: PolicyFacts): Situation {
  const appointment = checked(verdict.appointment);
  const { linked } = facts;
  const fields = appointmentFields(appointment, facts);
  const rejected: Situation = { case: "new_rejected", appointment };
  if (linked === null) {
    if (verdict.change === "reschedule") {
      return moving(appointment, previousMatches(verdict.previous, facts), facts);
    }
    return fields === null ? rejected : unlinked(fields, facts);
  }
  const invite = facts.ics !== null;
  const place = linkPlace(linked, appointment, facts);
  const linkedHere: Situation =
    fields === null
      ? rejected
      : { case: "new_on_calendar", appointment: fields, eventId: linked.eventId };
  switch (place.at) {
    case "slot":
    case "outside_facts":
      return verdict.change === "new"
        ? linkedHere
        : moving(appointment, linkedFacts(linked, facts), facts);
    case "elsewhere": {
      if (verdict.change === "reschedule") {
        const matches = invite
          ? linkedFacts(linked, facts)
          : previousMatches(verdict.previous, facts);
        return moving(appointment, matches, facts);
      }
      if (invite) return moving(appointment, place.seen === null ? [] : [place.seen], facts);
      const eventId = fields === null ? null : sameSlotEvent(fields, facts);
      return fields === null || eventId === null
        ? { case: "new_linked_elsewhere", appointment, eventId: linked.eventId, seen: place.seen }
        : { case: "new_on_calendar", appointment: fields, eventId };
    }
    case "over": {
      if (verdict.change === "reschedule") {
        return moving(appointment, linkedFacts(linked, facts), facts);
      }
      if (invite && !sameSlot(place, appointment)) return moving(appointment, [], facts);
      if (place.madeBy === "this_address") return linkedHere;
      if (fields === null) return rejected;
      const eventId = sameSlotEvent(fields, facts);
      return eventId === null
        ? { case: "new_linked_by_another_address", appointment: fields }
        : { case: "new_on_calendar", appointment: fields, eventId };
    }
  }
}
