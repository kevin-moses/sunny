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

export function appointmentFields(
  appointment: Appointment,
  clock: { now: number; timezone: string },
): Appointment | null {
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
  authenticated: boolean;
  stale: boolean;
  atDailyLimit: boolean;
  summary: string;
  decision: DecisionReason | null;
}

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

type Situation =
  | { case: "ignore" }
  | {
      case: "new";
      appointment: Appointment;
      fields: Appointment | null;
      conflict: CalendarEventFact | null;
    }
  | {
      case: "new_on_calendar";
      appointment: Appointment;
      fields: Appointment | null;
      eventId: string;
    }
  | {
      case: "new_linked_elsewhere";
      appointment: Appointment;
      eventId: string;
      seen: CalendarEventFact | null;
    }
  | { case: "new_linked_by_another_address"; appointment: Appointment; fields: Appointment | null }
  | {
      case: "reschedule";
      appointment: Appointment;
      fields: Appointment | null;
      matches: CalendarEventFact[];
    }
  | { case: "cancel"; previous: AppointmentRef; matches: CalendarEventFact[] }
  | { case: "senior_info"; topic: InfoTopic }
  | { case: "needs_decision"; reason: DecisionReason }
  | { case: "suspicious"; suspicion: Suspicion };

type Case = Situation["case"];

interface Row<S> {
  rule: string;
  plan: (s: S, c: Context) => MailEffect[] | null;
}

interface Plan {
  rule: string;
  effects: MailEffect[];
}

export function proposed(appointment: Appointment): Proposed {
  return { kind: appointment.kind, date: appointment.date, time: appointment.time };
}

function escalate(
  c: Context,
  reason: EscalationReason,
  line: string,
  eventId: string | null,
  appointment: Appointment | null,
): MailEffect {
  const also = c.decision === null ? "" : ` ${ALSO_NEEDS[c.decision]}`;
  return {
    kind: "escalate",
    reason,
    ...caregiverMessage(c.facts, `${line}${also}`, c.summary),
    push: true,
    eventId,
    proposed: appointment === null ? null : proposed(appointment),
  };
}

function tell(c: Context, line: string, push: boolean): MailEffect {
  if (c.decision !== null) return escalate(c, c.decision, line, null, null);
  return {
    kind: "tell_caregivers",
    ...caregiverMessage(c.facts, line, c.summary),
    push,
  };
}

function onCalendar(c: Context, eventId: string, key: string): MailEffect[] {
  const already: MailEffect = {
    kind: "already_on_calendar",
    eventId,
    appointmentKey: key,
  };
  if (c.decision === null) return [already];
  return [
    already,
    escalate(c, c.decision, "The appointment is already on the calendar.", eventId, null),
  ];
}

function notMoved(
  match: CalendarEventFact,
  fields: Appointment,
  because: string,
  ask: string,
): string {
  return `Sunny did not move ${match.title}, ${when(match.date, match.time)}, to ${when(fields.date, fields.time)}, because ${because}. Tell Sunny in chat to move it${ask}.`;
}

function only(matches: CalendarEventFact[]): CalendarEventFact | null {
  return matches.length === 1 ? (matches[0] ?? null) : null;
}

export function described(appointment: Appointment): string {
  return `${appointmentTitle(appointment.kind, appointment.time)}, ${when(appointment.date, appointment.time)}`;
}

const NEW_UNVERIFIED: Row<{ appointment: Appointment }> = {
  rule: "new: sender not authenticated",
  plan: (s, c) =>
    c.authenticated
      ? null
      : [
          escalate(
            c,
            "unverified_sender",
            `${described(s.appointment)}. Sunny has not added it because Gmail could not verify the sender. Tell Sunny in chat to add it if the email is genuine.`,
            null,
            s.appointment,
          ),
        ],
};

const NEW_REJECTED: Row<{ appointment: Appointment; fields: Appointment | null }> = {
  rule: "new: appointmentFields rejects",
  plan: (s, c) =>
    s.fields !== null
      ? null
      : [
          escalate(
            c,
            "unclear_appointment",
            `Sunny did not add this appointment because its date or time did not pass Sunny's checks: ${described(s.appointment)}.`,
            null,
            s.appointment,
          ),
        ],
};

const DECISION_TABLE: { [K in Case]: Row<Extract<Situation, { case: K }>>[] } = {
  ignore: [{ rule: "ignore: any", plan: () => [] }],
  new_linked_elsewhere: [
    NEW_UNVERIFIED,
    {
      rule: "new: the sender's link has this appointment at another time, and no live event has the email's date, time and title words",
      plan: (s, c) => {
        const has =
          s.seen === null
            ? "no longer has this appointment at that time"
            : `has this appointment on ${when(s.seen.date, s.seen.time)}`;
        return [
          escalate(
            c,
            "unclear_appointment",
            `The email gives ${described(s.appointment)}. Sunny's calendar ${has}, so Sunny changed nothing. Tell Sunny in chat which time is right.`,
            s.eventId,
            s.appointment,
          ),
        ];
      },
    },
  ],
  new_on_calendar: [
    NEW_UNVERIFIED,
    NEW_REJECTED,
    {
      rule: "new: already linked, unless the link is over and another address made it, or same date, time and title words as a live event",
      plan: (s, c) => onCalendar(c, s.eventId, appointmentKey(s.appointment, c.facts.ics)),
    },
  ],
  new_linked_by_another_address: [
    NEW_UNVERIFIED,
    NEW_REJECTED,
    {
      rule: "new: the link's event is over, and another address at the sender's domain made it",
      plan: (s, c) => [
        escalate(
          c,
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
    NEW_REJECTED,
    {
      rule: "new: a caregiver confirms this kind first",
      plan: (s, c) => {
        const confirms = APPOINTMENT_KINDS[s.appointment.kind].caregiverConfirms;
        if (confirms === null) return null;
        return [
          escalate(
            c,
            confirms.reason,
            `${described(s.appointment)}. Sunny has not added it because ${confirms.because}. Tell Sunny in chat to add it once you have checked ${confirms.checked}.`,
            null,
            s.appointment,
          ),
        ];
      },
    },
    {
      rule: "new: overlaps another live event",
      plan: (s, c) =>
        s.conflict === null || s.fields === null
          ? null
          : [
              escalate(
                c,
                "conflict",
                `Sunny did not add ${described(s.fields)}, because it overlaps ${s.conflict.title} at ${formatTime12(s.conflict.time)}.`,
                null,
                s.fields,
              ),
            ],
    },
    {
      rule: "new: daily limit of calendar changes reached",
      plan: (s, c) =>
        !c.atDailyLimit || s.fields === null
          ? null
          : [
              escalate(
                c,
                "daily_limit",
                `Sunny did not add ${described(s.fields)}, because ${DAILY_LIMIT}. Tell Sunny in chat to add it.`,
                null,
                s.fields,
              ),
            ],
    },
    {
      rule: "new: otherwise",
      plan: (s, c) =>
        s.fields === null
          ? null
          : [
              {
                kind: "add_event",
                appointment: s.fields,
                appointmentKey: appointmentKey(s.fields, c.facts.ics),
              },
              tell(c, `Sunny added ${described(s.fields)}, to the calendar.`, false),
            ],
    },
  ],
  reschedule: [
    {
      rule: "reschedule: not authenticated, no single match, the match repeats, or new fields rejected",
      plan: (s, c) => {
        const match = only(s.matches);
        if (c.authenticated && match !== null && !match.repeating && s.fields !== null) return null;
        const asked = when(s.appointment.date, s.appointment.time);
        const line =
          match === null
            ? `Sunny did not move any appointment. The email asks to move one to ${asked}.`
            : match.repeating
              ? `Sunny did not move ${match.title}, ${when(match.date, match.time)}, because it is one date of a repeating event. The email asks to move it to ${asked}. Tell Sunny in chat what to change.`
              : !c.authenticated
                ? `Sunny did not move ${match.title}, ${when(match.date, match.time)}, because Gmail could not verify the sender. The email asks to move it to ${asked}. Tell Sunny in chat to move it if the email is genuine.`
                : `Sunny did not move ${match.title}, ${when(match.date, match.time)}. The email asks to move it to ${asked}. Tell Sunny in chat to move it.`;
        return [escalate(c, "unclear_reschedule", line, match?.eventId ?? null, s.appointment)];
      },
    },
    {
      rule: "reschedule: the match already has the new date and time",
      plan: (s, c) => {
        const match = only(s.matches);
        return match !== null &&
          s.fields !== null &&
          match.date === s.fields.date &&
          match.time === s.fields.time
          ? onCalendar(c, match.eventId, appointmentKey(s.fields, c.facts.ics))
          : null;
      },
    },
    {
      rule: "reschedule: a caregiver confirms moving this kind first",
      plan: (s, c) => {
        const match = only(s.matches);
        if (match === null || s.fields === null) return null;
        const confirms = confirmsMove(s.appointment.kind, match.title);
        if (confirms === null) return null;
        return [
          escalate(
            c,
            confirms.reason,
            notMoved(
              match,
              s.fields,
              confirms.because,
              ` once you have checked ${confirms.checked}`,
            ),
            match.eventId,
            s.fields,
          ),
        ];
      },
    },
    {
      rule: "reschedule: daily limit of calendar changes reached",
      plan: (s, c) => {
        const match = only(s.matches);
        if (!c.atDailyLimit || match === null || s.fields === null) return null;
        return [
          escalate(
            c,
            "daily_limit",
            notMoved(match, s.fields, DAILY_LIMIT, ""),
            match.eventId,
            s.fields,
          ),
        ];
      },
    },
    {
      rule: "reschedule: exactly one match",
      plan: (s, c) => {
        const match = only(s.matches);
        if (match === null || s.fields === null) return null;
        return [
          {
            kind: "reschedule_event",
            eventId: match.eventId,
            appointment: s.fields,
            appointmentKey: appointmentKey(s.fields, c.facts.ics),
          },
          tell(
            c,
            `Sunny moved ${match.title} from ${when(match.date, match.time)} to ${when(s.fields.date, s.fields.time)}.`,
            true,
          ),
        ];
      },
    },
  ],
  cancel: [
    {
      rule: "cancel: any",
      plan: (s, c) => {
        const match = only(s.matches);
        const line =
          match === null
            ? `The sender cancelled an appointment on ${dateLabel(s.previous.date)}. Sunny found no single matching event and changed nothing.`
            : `The sender cancelled ${match.title}, ${when(match.date, match.time)}. Sunny left it on the calendar; tell Sunny in chat to cancel it.`;
        return [escalate(c, "cancellation", line, match?.eventId ?? null, null)];
      },
    },
  ],
  senior_info: [
    { rule: "senior_info: stale", plan: (_, c) => (c.stale ? [] : null) },
    {
      rule: "senior_info: not authenticated",
      plan: (_, c) =>
        c.authenticated
          ? null
          : [
              tell(
                c,
                "Sunny did not tell the senior about this email because Gmail could not verify the sender.",
                false,
              ),
            ],
    },
    {
      rule: "senior_info: otherwise",
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
      rule: "needs_decision: any",
      plan: (s, c) => [escalate(c, s.reason, "This email needs a decision.", null, null)],
    },
  ],
  suspicious: [
    {
      rule: "suspicious: any",
      plan: (s, c) => [
        escalate(
          c,
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
  appointment: Appointment,
  matches: CalendarEventFact[],
  facts: PolicyFacts,
): Situation {
  return {
    case: "reschedule",
    appointment,
    fields: appointmentFields(appointment, facts),
    matches,
  };
}

function sameSlotEvent(fields: Appointment | null, facts: PolicyFacts): string | null {
  return fields === null ? null : (matchEvent(fields, facts.events)[0]?.eventId ?? null);
}

function unlinked(appointment: Appointment, facts: PolicyFacts): Situation {
  const fields = appointmentFields(appointment, facts);
  const eventId = sameSlotEvent(fields, facts);
  if (eventId !== null) return { case: "new_on_calendar", appointment, fields, eventId };
  return {
    case: "new",
    appointment,
    fields,
    conflict:
      fields === null
        ? null
        : (facts.events.find((e) => overlaps(fields, e, facts.timezone)) ?? null),
  };
}

function resolveLink(verdict: AppointmentChange, facts: PolicyFacts): Situation {
  const { appointment } = verdict;
  const { linked } = facts;
  if (linked === null) {
    return verdict.change === "new"
      ? unlinked(appointment, facts)
      : moving(appointment, previousMatches(verdict.previous, facts), facts);
  }
  const invite = facts.ics !== null;
  const place = linkPlace(linked, appointment, facts);
  const fields = appointmentFields(appointment, facts);
  const linkedHere: Situation = {
    case: "new_on_calendar",
    appointment,
    fields,
    eventId: linked.eventId,
  };
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
      const eventId = sameSlotEvent(fields, facts);
      return eventId === null
        ? { case: "new_linked_elsewhere", appointment, eventId: linked.eventId, seen: place.seen }
        : { case: "new_on_calendar", appointment, fields, eventId };
    }
    case "over": {
      if (verdict.change === "reschedule") {
        return moving(appointment, linkedFacts(linked, facts), facts);
      }
      if (invite && !sameSlot(place, appointment)) return moving(appointment, [], facts);
      if (place.madeBy === "this_address") return linkedHere;
      const eventId = sameSlotEvent(fields, facts);
      return eventId === null
        ? { case: "new_linked_by_another_address", appointment, fields }
        : { case: "new_on_calendar", appointment, fields, eventId };
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

function runTable<K extends Case>(
  rows: Row<Extract<Situation, { case: K }>>[],
  situation: Extract<Situation, { case: K }>,
  context: Context,
): Plan {
  for (const row of rows) {
    const effects = row.plan(situation, context);
    if (effects !== null) return { rule: row.rule, effects };
  }
  return { rule: `${situation.case}: no row`, effects: [] };
}

function planFor(situation: Situation, context: Context): Plan {
  switch (situation.case) {
    case "ignore":
      return runTable(DECISION_TABLE.ignore, situation, context);
    case "new":
      return runTable(DECISION_TABLE.new, situation, context);
    case "new_on_calendar":
      return runTable(DECISION_TABLE.new_on_calendar, situation, context);
    case "new_linked_elsewhere":
      return runTable(DECISION_TABLE.new_linked_elsewhere, situation, context);
    case "new_linked_by_another_address":
      return runTable(DECISION_TABLE.new_linked_by_another_address, situation, context);
    case "reschedule":
      return runTable(DECISION_TABLE.reschedule, situation, context);
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
  const context: Context = {
    facts,
    authenticated: facts.sender.authenticated,
    stale: isStale(facts),
    atDailyLimit: facts.calendarChangesToday >= MAX_CALENDAR_CHANGES_PER_DAY,
    summary: triaged.summary,
    decision: triaged.verdict.kind === "appointment" ? triaged.verdict.decision : null,
  };
  const plan = planFor(situationOf(triaged.verdict, facts), context);
  if (!context.stale) return plan;
  return {
    rule: plan.rule,
    effects: plan.effects.map((e) =>
      (e.kind === "escalate" || e.kind === "tell_caregivers") && e.push ? { ...e, push: false } : e,
    ),
  };
}
