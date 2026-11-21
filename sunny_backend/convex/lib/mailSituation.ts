import { appointmentFields, checked, factsCover, matchEvent, overlaps } from "./mailAppointments";
import type { CheckedAppointment } from "./mailAppointments";
import type {
  Appointment,
  AppointmentRef,
  CalendarEventFact,
  DecisionReason,
  InfoTopic,
  LinkedEvent,
  LinkMaker,
  MailVerdict,
  PolicyFacts,
  Suspicion,
} from "./mailTypes";

interface Situations {
  ignore: object;
  new: { appointment: CheckedAppointment; conflict: CalendarEventFact | null };
  new_rejected: { appointment: CheckedAppointment };
  new_on_calendar: { appointment: CheckedAppointment; eventId: string };
  new_linked_elsewhere: {
    appointment: CheckedAppointment;
    eventId: string;
    seen: CalendarEventFact | null;
  };
  new_linked_by_another_address: { appointment: CheckedAppointment };
  reschedule: { appointment: CheckedAppointment; match: CalendarEventFact };
  reschedule_rejected: { appointment: CheckedAppointment; match: CalendarEventFact };
  reschedule_repeating: { appointment: CheckedAppointment; match: CalendarEventFact };
  reschedule_no_match: { appointment: CheckedAppointment };
  cancel: { previous: AppointmentRef; matches: CalendarEventFact[] };
  senior_info: { topic: InfoTopic };
  needs_decision: { reason: DecisionReason };
  suspicious: { suspicion: Suspicion };
}

export type Case = keyof Situations;

export type SituationOf<K extends Case> = { case: K } & Situations[K];

export type Situation = { [K in Case]: SituationOf<K> }[Case];

type LinkPlace =
  | { at: "slot" }
  | { at: "elsewhere"; seen: CalendarEventFact | null }
  | { at: "outside_facts" }
  | { at: "over"; date: string; time: string; madeBy: LinkMaker };

type AppointmentChange = Extract<MailVerdict, { change: "new" | "reschedule" }>;

function sameSlot(a: { date: string; time: string }, b: { date: string; time: string }): boolean {
  return a.date === b.date && a.time === b.time;
}

function linkedFacts(linked: LinkedEvent, facts: PolicyFacts): CalendarEventFact[] {
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

function resolveLink(verdict: AppointmentChange, facts: PolicyFacts): Situation {
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

export function situationOf(verdict: MailVerdict, facts: PolicyFacts): Situation {
  switch (verdict.kind) {
    case "ignore":
      return { case: "ignore" };
    case "senior_info":
      return { case: "senior_info", topic: verdict.topic };
    case "needs_decision":
      return { case: "needs_decision", reason: verdict.reason };
    case "suspicious":
      return { case: "suspicious", suspicion: verdict.suspicion };
  }
  if (verdict.change !== "cancel") return resolveLink(verdict, facts);
  const { linked } = facts;
  return {
    case: "cancel",
    previous: verdict.previous,
    matches:
      linked === null ? matchEvent(verdict.previous, facts.events) : linkedFacts(linked, facts),
  };
}
