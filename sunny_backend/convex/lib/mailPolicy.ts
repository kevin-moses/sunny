import {
  APPOINTMENT_KINDS,
  APPOINTMENT_KIND_NAMES,
  APPOINTMENT_TITLES,
  SENIOR_SENTENCES,
  appointmentTitle,
} from "./mailTypes";
import type {
  Appointment,
  AppointmentKind,
  AppointmentRef,
  CalendarEventFact,
  CaregiverConfirms,
  CaregiverMessage,
  CaregiverPush,
  DecisionReason,
  EscalationReason,
  IcsEvent,
  InfoTopic,
  LinkedEvent,
  LinkMaker,
  MailEffect,
  MailSender,
  MailVerdict,
  PolicyFacts,
  Proposed,
  Suspicion,
  Triaged,
} from "./mailTypes";
import { domainOf } from "./mailParse";
import { noteExpiry } from "./seniorNotes";
import { ellipsize, oneLine, textKey } from "./text";
import {
  DAY_MS,
  MINUTE_MS,
  dateLabel,
  daysBetween,
  formatTime12,
  isLocalDate,
  isLocalTime,
  localDate,
  localTime,
  weekdayName,
  zonedInstant,
} from "./time";

export const STALE_AFTER_MS = DAY_MS;
const MAX_DAYS_AHEAD = 400;
export const MAX_CALENDAR_CHANGES_PER_DAY = 5;
export const MAX_NOTES_PER_DAY = 3;
const DAILY_LIMIT = `the daily limit of ${MAX_CALENDAR_CHANGES_PER_DAY} calendar changes from email was reached`;
const MIN_DURATION_MINUTES = 5;
const MAX_DURATION_MINUTES = 480;
const ASSUMED_DURATION_MINUTES = 30;
const MAX_SHOWN_SUBJECT = 120;
const MAX_CAREGIVER_BODY = 600;
const MAX_SCRUBBED = 4 * MAX_CAREGIVER_BODY;
const LINK_REMOVED = "[link removed]";
const NUMBER_REMOVED = "[number removed]";

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

function appointmentOf(verdict: MailVerdict | null): Appointment | null {
  return verdict?.kind === "appointment" && verdict.change !== "cancel"
    ? verdict.appointment
    : null;
}

export function linkKey(verdict: MailVerdict | null, ics: IcsEvent | null): string | null {
  if (ics !== null) return icsKey(ics);
  const appointment = appointmentOf(verdict);
  return appointment === null ? null : appointmentKey(appointment, null);
}

function titleWords(title: string): Set<string> {
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

const CONFIRMED = APPOINTMENT_KIND_NAMES.flatMap((kind) => {
  const { title, caregiverConfirms } = APPOINTMENT_KINDS[kind];
  return caregiverConfirms === null ? [] : [{ title, caregiverConfirms }];
});

const UNCONFIRMED_WORDS = new Set(
  [...APPOINTMENT_TITLES]
    .filter((title) => !CONFIRMED.some((k) => k.title === title))
    .flatMap((title) => [...titleWords(title)]),
);

const CONFIRMING_WORDS = CONFIRMED.map(({ title, caregiverConfirms }) => ({
  words: [...titleWords(title)].filter((word) => !UNCONFIRMED_WORDS.has(word)),
  caregiverConfirms,
}));

function confirmsMove(kind: AppointmentKind, eventTitle: string): CaregiverConfirms | null {
  const words = titleWords(eventTitle);
  return (
    APPOINTMENT_KINDS[kind].caregiverConfirms ??
    CONFIRMING_WORDS.find((k) => k.words.some((word) => words.has(word)))?.caregiverConfirms ??
    null
  );
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

function scrub(text: string): string {
  return oneLine(text.slice(0, MAX_SCRUBBED))
    .replace(/(?:https?:\/\/|www\.)\S+/gi, LINK_REMOVED)
    .replace(/\b[a-z0-9-]+(?:\.[a-z0-9-]+)+\/\S*/gi, LINK_REMOVED)
    .replace(/\d(?:[\s().-]*\d){6,}/g, NUMBER_REMOVED);
}

export function when(date: string, time: string): string {
  return `${weekdayName(date)}, ${dateLabel(date)} at ${formatTime12(time)}`;
}

export function caregiverText(
  facts: Pick<PolicyFacts, "sender" | "subject" | "receivedAt" | "timezone">,
  lines: string[],
): string {
  const { sender } = facts;
  const name = scrub(sender.name);
  const from = name === "" ? sender.address : `${name} <${sender.address}>`;
  const received = when(
    localDate(facts.receivedAt, facts.timezone),
    localTime(facts.receivedAt, facts.timezone),
  );
  const body = lines.map(scrub).filter((line) => line !== "");
  return [
    `From: ${from} (${sender.authenticated ? "verified sender" : "sender not verified"})`,
    `Subject: ${ellipsize(scrub(facts.subject), MAX_SHOWN_SUBJECT)}`,
    `Received: ${received}`,
    "",
    ellipsize(body.join("\n"), MAX_CAREGIVER_BODY),
  ].join("\n");
}

export function isStale(facts: { receivedAt: number; now: number }): boolean {
  return facts.receivedAt < facts.now - STALE_AFTER_MS;
}

export function caregiverMessage(
  facts: PolicyFacts,
  line: string,
  summary: string,
): CaregiverMessage {
  const place = facts.ics?.location ?? null;
  const placeLine = place === null ? [] : [`Place in the invitation: ${place}`];
  return { body: caregiverText(facts, [line, ...placeLine, summary]), notice: scrub(line) };
}

function overlaps(a: Appointment, b: CalendarEventFact, timezone: string): boolean {
  const aStart = zonedInstant(a.date, a.time, timezone);
  const bStart = zonedInstant(b.date, b.time, timezone);
  const aEnd = aStart + (a.durationMinutes ?? ASSUMED_DURATION_MINUTES) * MINUTE_MS;
  const bEnd = bStart + (b.durationMinutes ?? ASSUMED_DURATION_MINUTES) * MINUTE_MS;
  return aStart < bEnd && bStart < aEnd;
}

interface Context {
  facts: PolicyFacts;
  stale: boolean;
  atDailyLimit: boolean;
  atNoteLimit: boolean;
}

type Draft =
  | Exclude<MailEffect, { kind: "tell_caregivers" | "escalate" }>
  | ({ kind: "tell_caregivers"; line: string } & CaregiverPush)
  | {
      kind: "escalate";
      reason: EscalationReason;
      line: string;
      push: boolean;
      eventId: string | null;
      proposed: Proposed | null;
    };

const ALSO_NEEDS: Record<DecisionReason, string> = {
  cancellation: "The email also mentions a cancellation.",
  bill_or_payment: "The email is also about a bill or a payment.",
  account_or_credentials: "The email is also about the security of an account.",
  reply_needed: "The email also asks a question that needs an answer.",
  legal_or_government: "The email is also from a government, court or tax office.",
  health_result: "The email is also about medical test results.",
  home_visit: "The email also says someone will come to the home.",
  other: "The email may also need a reply, a payment or a decision.",
};

declare const SLOT_CHECKED: unique symbol;

type CheckedAppointment = Appointment & { readonly [SLOT_CHECKED]: true };

type Situation =
  | { case: "ignore" }
  | { case: "new"; appointment: CheckedAppointment; conflict: CalendarEventFact | null }
  | { case: "new_rejected"; appointment: CheckedAppointment }
  | { case: "new_on_calendar"; appointment: CheckedAppointment; eventId: string }
  | {
      case: "new_linked_elsewhere";
      appointment: CheckedAppointment;
      eventId: string;
      seen: CalendarEventFact | null;
    }
  | { case: "new_linked_by_another_address"; appointment: CheckedAppointment }
  | { case: "reschedule"; appointment: CheckedAppointment; match: CalendarEventFact }
  | { case: "reschedule_rejected"; appointment: CheckedAppointment; match: CalendarEventFact }
  | { case: "reschedule_repeating"; appointment: CheckedAppointment; match: CalendarEventFact }
  | { case: "reschedule_no_match"; appointment: CheckedAppointment }
  | { case: "cancel"; previous: AppointmentRef; matches: CalendarEventFact[] }
  | { case: "senior_info"; topic: InfoTopic }
  | { case: "needs_decision"; reason: DecisionReason }
  | { case: "suspicious"; suspicion: Suspicion };

type Case = Situation["case"];

interface Row<S> {
  id: string;
  plan: (s: S, c: Context) => Draft[] | null;
}

interface Plan {
  rule: string;
  effects: MailEffect[];
}

function checked(appointment: Appointment): CheckedAppointment {
  const { date, time } = appointment;
  if (!isLocalDate(date) || !isLocalTime(time)) {
    throw new Error(
      `The verdict gives an appointment at ${date} ${time}, which is not a date and a time`,
    );
  }
  return appointment as CheckedAppointment;
}

function proposal(appointment: CheckedAppointment | null): Proposed | null {
  if (appointment === null) return null;
  const { kind, date, time } = appointment;
  return { kind, date, time };
}

function escalate(
  reason: EscalationReason,
  line: string,
  eventId: string | null,
  appointment: CheckedAppointment | null,
): Draft {
  return { kind: "escalate", reason, line, push: true, eventId, proposed: proposal(appointment) };
}

function tell(line: string): Draft {
  return { kind: "tell_caregivers", line, push: false };
}

function notMoved(
  match: CalendarEventFact,
  appointment: Appointment,
  because: string,
  ask: string,
): string {
  return `Sunny did not move ${match.title}, ${when(match.date, match.time)}, to ${when(appointment.date, appointment.time)}, because ${because}. Tell Sunny in chat to move it${ask}.`;
}

function asked(appointment: Appointment): string {
  return when(appointment.date, appointment.time);
}

export function described(appointment: Appointment): string {
  return `${appointmentTitle(appointment.kind, appointment.time)}, ${when(appointment.date, appointment.time)}`;
}

const NEW_UNVERIFIED: Row<{ appointment: CheckedAppointment }> = {
  id: "new-unverified-sender",
  plan: (s, c) =>
    c.facts.sender.authenticated
      ? null
      : [
          escalate(
            "unverified_sender",
            `${described(s.appointment)}. Sunny has not added it because Gmail could not verify the sender. Tell Sunny in chat to add it if the email is genuine.`,
            null,
            s.appointment,
          ),
        ],
};

const RESCHEDULE_UNVERIFIED: Row<{ appointment: CheckedAppointment; match: CalendarEventFact }> = {
  id: "reschedule-unverified-sender",
  plan: ({ appointment, match }, c) =>
    c.facts.sender.authenticated
      ? null
      : [
          escalate(
            "unclear_reschedule",
            `Sunny did not move ${match.title}, ${when(match.date, match.time)}, because Gmail could not verify the sender. The email asks to move it to ${asked(appointment)}. Tell Sunny in chat to move it if the email is genuine.`,
            match.eventId,
            appointment,
          ),
        ],
};

const DECISION_TABLE: { [K in Case]: Row<Extract<Situation, { case: K }>>[] } = {
  ignore: [{ id: "ignore", plan: () => [] }],
  new_linked_elsewhere: [
    NEW_UNVERIFIED,
    {
      id: "new-linked-elsewhere",
      plan: (s) => {
        const has =
          s.seen === null
            ? "no longer has this appointment at that time"
            : `has this appointment on ${when(s.seen.date, s.seen.time)}`;
        return [
          escalate(
            "unclear_appointment",
            `The email gives ${described(s.appointment)}. Sunny's calendar ${has}, so Sunny changed nothing. Tell Sunny in chat which time is right.`,
            s.eventId,
            s.appointment,
          ),
        ];
      },
    },
  ],
  new_rejected: [
    NEW_UNVERIFIED,
    {
      id: "new-fields-rejected",
      plan: (s) => [
        escalate(
          "unclear_appointment",
          `Sunny did not add this appointment because its date or time did not pass Sunny's checks: ${described(s.appointment)}.`,
          null,
          s.appointment,
        ),
      ],
    },
  ],
  new_on_calendar: [
    NEW_UNVERIFIED,
    {
      id: "new-on-calendar",
      plan: (s, c) => [
        {
          kind: "already_on_calendar",
          eventId: s.eventId,
          appointmentKey: appointmentKey(s.appointment, c.facts.ics),
        },
      ],
    },
  ],
  new_linked_by_another_address: [
    NEW_UNVERIFIED,
    {
      id: "new-linked-by-another-address",
      plan: (s) => [
        escalate(
          "unclear_appointment",
          `The email gives ${described(s.appointment)}. An earlier email from another address at the same mail domain gave this appointment, and it is no longer coming up on Sunny's calendar, so Sunny changed nothing. Tell Sunny in chat if it should be added.`,
          null,
          s.appointment,
        ),
      ],
    },
  ],
  new: [
    NEW_UNVERIFIED,
    {
      id: "new-caregiver-confirms",
      plan: (s) => {
        const confirms = APPOINTMENT_KINDS[s.appointment.kind].caregiverConfirms;
        if (confirms === null) return null;
        return [
          escalate(
            confirms.reason,
            `${described(s.appointment)}. Sunny has not added it because ${confirms.because}. Tell Sunny in chat to add it once you have checked ${confirms.checked}.`,
            null,
            s.appointment,
          ),
        ];
      },
    },
    {
      id: "new-conflict",
      plan: (s) =>
        s.conflict === null
          ? null
          : [
              escalate(
                "conflict",
                `Sunny did not add ${described(s.appointment)}, because it overlaps ${s.conflict.title} at ${formatTime12(s.conflict.time)}.`,
                null,
                s.appointment,
              ),
            ],
    },
    {
      id: "new-daily-limit",
      plan: (s, c) =>
        c.atDailyLimit
          ? [
              escalate(
                "daily_limit",
                `Sunny did not add ${described(s.appointment)}, because ${DAILY_LIMIT}. Tell Sunny in chat to add it.`,
                null,
                s.appointment,
              ),
            ]
          : null,
    },
    {
      id: "new-add",
      plan: (s, c) => [
        {
          kind: "add_event",
          appointment: s.appointment,
          appointmentKey: appointmentKey(s.appointment, c.facts.ics),
        },
        tell(`Sunny added ${described(s.appointment)}, to the calendar.`),
      ],
    },
  ],
  reschedule_no_match: [
    {
      id: "reschedule-no-match",
      plan: (s) => [
        escalate(
          "unclear_reschedule",
          `Sunny did not move any appointment. The email asks to move one to ${asked(s.appointment)}.`,
          null,
          s.appointment,
        ),
      ],
    },
  ],
  reschedule_repeating: [
    {
      id: "reschedule-repeating",
      plan: ({ appointment, match }) => [
        escalate(
          "unclear_reschedule",
          `Sunny did not move ${match.title}, ${when(match.date, match.time)}, because it is one date of a repeating event. The email asks to move it to ${asked(appointment)}. Tell Sunny in chat what to change.`,
          match.eventId,
          appointment,
        ),
      ],
    },
  ],
  reschedule_rejected: [
    RESCHEDULE_UNVERIFIED,
    {
      id: "reschedule-fields-rejected",
      plan: ({ appointment, match }) => [
        escalate(
          "unclear_reschedule",
          `Sunny did not move ${match.title}, ${when(match.date, match.time)}. The email asks to move it to ${asked(appointment)}. Tell Sunny in chat to move it.`,
          match.eventId,
          appointment,
        ),
      ],
    },
  ],
  reschedule: [
    RESCHEDULE_UNVERIFIED,
    {
      id: "reschedule-already-there",
      plan: ({ appointment, match }, c) =>
        match.date === appointment.date && match.time === appointment.time
          ? [
              {
                kind: "already_on_calendar",
                eventId: match.eventId,
                appointmentKey: appointmentKey(appointment, c.facts.ics),
              },
            ]
          : null,
    },
    {
      id: "reschedule-caregiver-confirms",
      plan: ({ appointment, match }) => {
        const confirms = confirmsMove(appointment.kind, match.title);
        if (confirms === null) return null;
        return [
          escalate(
            confirms.reason,
            notMoved(
              match,
              appointment,
              confirms.because,
              ` once you have checked ${confirms.checked}`,
            ),
            match.eventId,
            appointment,
          ),
        ];
      },
    },
    {
      id: "reschedule-daily-limit",
      plan: ({ appointment, match }, c) =>
        c.atDailyLimit
          ? [
              escalate(
                "daily_limit",
                notMoved(match, appointment, DAILY_LIMIT, ""),
                match.eventId,
                appointment,
              ),
            ]
          : null,
    },
    {
      id: "reschedule-move",
      plan: ({ appointment, match }, c) => [
        {
          kind: "reschedule_event",
          eventId: match.eventId,
          appointment,
          appointmentKey: appointmentKey(appointment, c.facts.ics),
        },
        {
          kind: "tell_caregivers",
          line: `Sunny moved ${match.title} from ${when(match.date, match.time)} to ${asked(appointment)}.`,
          push: true,
          title: "Sunny moved an appointment",
        },
      ],
    },
  ],
  cancel: [
    {
      id: "cancel",
      plan: (s) => {
        const match = s.matches.length === 1 ? s.matches[0] : undefined;
        const line =
          match === undefined
            ? `The sender cancelled an appointment on ${dateLabel(s.previous.date)}. Sunny found no single matching event and changed nothing.`
            : `The sender cancelled ${match.title}, ${when(match.date, match.time)}. Sunny left it on the calendar; tell Sunny in chat to cancel it.`;
        return [escalate("cancellation", line, match?.eventId ?? null, null)];
      },
    },
  ],
  senior_info: [
    { id: "senior-info-stale", plan: (_, c) => (c.stale ? [] : null) },
    {
      id: "senior-info-unverified-sender",
      plan: (_, c) =>
        c.facts.sender.authenticated
          ? null
          : [
              tell(
                "Sunny did not tell the senior about this email because Gmail could not verify the sender.",
              ),
            ],
    },
    {
      id: "senior-info-daily-limit",
      plan: (s, c) =>
        c.atNoteLimit
          ? [
              tell(
                `Sunny held back this note for the senior because the daily limit of ${MAX_NOTES_PER_DAY} notes was reached: ${SENIOR_SENTENCES[s.topic]}`,
              ),
            ]
          : null,
    },
    {
      id: "senior-info-note",
      plan: (s, c) => [
        {
          kind: "senior_note",
          text: SENIOR_SENTENCES[s.topic],
          expiresAt: noteExpiry(c.facts.receivedAt, c.facts.timezone),
        },
      ],
    },
  ],
  needs_decision: [
    {
      id: "needs-decision",
      plan: (s) => [escalate(s.reason, "This email needs a decision.", null, null)],
    },
  ],
  suspicious: [
    {
      id: "suspicious",
      plan: (s) => [
        escalate(
          s.suspicion,
          "Sunny thinks this email may be a scam and did not tell the senior about it.",
          null,
          null,
        ),
      ],
    },
  ],
};

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

function situationOf(verdict: MailVerdict, facts: PolicyFacts): Situation {
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

interface Drafted {
  rule: string;
  drafts: Draft[];
}

function runTable<K extends Case>(
  rows: Row<Extract<Situation, { case: K }>>[],
  situation: Extract<Situation, { case: K }>,
  context: Context,
): Drafted {
  for (const row of rows) {
    const drafts = row.plan(situation, context);
    if (drafts !== null) return { rule: row.id, drafts };
  }
  throw new Error(`The mail decision table has no matching row for ${situation.case}`);
}

function withDecision(drafts: Draft[], decision: DecisionReason | null): Draft[] {
  if (decision === null) return drafts;
  const also = ALSO_NEEDS[decision];
  return drafts.flatMap((draft): Draft[] => {
    switch (draft.kind) {
      case "escalate":
        return [{ ...draft, line: `${draft.line} ${also}` }];
      case "tell_caregivers":
        return [escalate(decision, `${draft.line} ${also}`, null, null)];
      case "already_on_calendar":
        return [
          draft,
          escalate(
            decision,
            `The appointment is already on the calendar. ${also}`,
            draft.eventId,
            null,
          ),
        ];
      default:
        return [draft];
    }
  });
}

function withoutPush(draft: Draft): Draft {
  switch (draft.kind) {
    case "escalate":
      return { ...draft, push: false };
    case "tell_caregivers":
      return tell(draft.line);
    default:
      return draft;
  }
}

function rendered(draft: Draft, facts: PolicyFacts, summary: string): MailEffect {
  switch (draft.kind) {
    case "escalate":
    case "tell_caregivers": {
      const { line, ...effect } = draft;
      return { ...effect, ...caregiverMessage(facts, line, summary) };
    }
    default:
      return draft;
  }
}

function planFor(situation: Situation, context: Context): Drafted {
  switch (situation.case) {
    case "ignore":
      return runTable(DECISION_TABLE.ignore, situation, context);
    case "new":
      return runTable(DECISION_TABLE.new, situation, context);
    case "new_rejected":
      return runTable(DECISION_TABLE.new_rejected, situation, context);
    case "new_on_calendar":
      return runTable(DECISION_TABLE.new_on_calendar, situation, context);
    case "new_linked_elsewhere":
      return runTable(DECISION_TABLE.new_linked_elsewhere, situation, context);
    case "new_linked_by_another_address":
      return runTable(DECISION_TABLE.new_linked_by_another_address, situation, context);
    case "reschedule":
      return runTable(DECISION_TABLE.reschedule, situation, context);
    case "reschedule_rejected":
      return runTable(DECISION_TABLE.reschedule_rejected, situation, context);
    case "reschedule_repeating":
      return runTable(DECISION_TABLE.reschedule_repeating, situation, context);
    case "reschedule_no_match":
      return runTable(DECISION_TABLE.reschedule_no_match, situation, context);
    case "cancel":
      return runTable(DECISION_TABLE.cancel, situation, context);
    case "senior_info":
      return runTable(DECISION_TABLE.senior_info, situation, context);
    case "needs_decision":
      return runTable(DECISION_TABLE.needs_decision, situation, context);
    case "suspicious":
      return runTable(DECISION_TABLE.suspicious, situation, context);
  }
}

export function planWithRule(
  triaged: Pick<Triaged, "verdict" | "summary">,
  facts: PolicyFacts,
): Plan {
  const { verdict, summary } = triaged;
  const context: Context = {
    facts,
    stale: isStale(facts),
    atDailyLimit: facts.calendarChangesToday >= MAX_CALENDAR_CHANGES_PER_DAY,
    atNoteLimit: facts.seniorNotesToday >= MAX_NOTES_PER_DAY,
  };
  const { rule, drafts } = planFor(situationOf(verdict, facts), context);
  const decided = withDecision(drafts, verdict.kind === "appointment" ? verdict.decision : null);
  const pushed = context.stale ? decided.map(withoutPush) : decided;
  return { rule, effects: pushed.map((draft) => rendered(draft, facts, summary)) };
}
