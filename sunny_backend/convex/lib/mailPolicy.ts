import { APPOINTMENT_KINDS, SENIOR_SENTENCES, appointmentTitle } from "./mailTypes";
import type {
  Appointment,
  AppointmentRef,
  CalendarEventFact,
  CaregiverMessage,
  DecisionReason,
  EscalationReason,
  IcsEvent,
  InfoTopic,
  MailEffect,
  MailVerdict,
  PolicyFacts,
  Proposed,
  Suspicion,
  Triaged,
} from "./mailTypes";
import { oneLine, textKey } from "./text";
import {
  DAY_MS,
  MINUTE_MS,
  addDays,
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
const NEW_SENDER = "this sender is new to Sunny";

export function titleOf(appointment: { kind: Appointment["kind"]; time: string | null }): string {
  return appointmentTitle(appointment.kind, appointment.time);
}

export function appointmentKey(appointment: Appointment, ics: IcsEvent | null): string {
  if (ics !== null) return `ics:${ics.uid}`;
  return `appt:${appointment.date}:${appointment.time}:${textKey(titleOf(appointment))}`;
}

export function linkKey(verdict: MailVerdict | null, ics: IcsEvent | null): string | null {
  if (ics !== null) return `ics:${ics.uid}`;
  if (verdict?.kind !== "appointment" || verdict.change === "cancel") return null;
  return appointmentKey(verdict.appointment, null);
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

export function matchEvent(ref: AppointmentRef, events: CalendarEventFact[]): CalendarEventFact[] {
  return events.filter(
    (e) =>
      e.date === ref.date &&
      (ref.time === null || e.time === ref.time) &&
      sharesWords(e.title, titleOf(ref)),
  );
}

export function appointmentFields(
  appointment: Appointment,
  clock: { now: number; timezone: string },
): Appointment | null {
  const { date, time, durationMinutes } = appointment;
  if (!isLocalDate(date) || !isLocalTime(time)) return null;
  if (zonedInstant(date, time, clock.timezone) < clock.now) return null;
  if (daysBetween(localDate(clock.now, clock.timezone), date) > MAX_DAYS_AHEAD) return null;
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

export function ellipsize(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 3).trimEnd()}...`;
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

export function noteExpiry(receivedAt: number, timezone: string): number {
  return zonedInstant(addDays(localDate(receivedAt, timezone), 2), "00:00", timezone);
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
  trusted: boolean;
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
      duplicate: string | null;
      conflict: CalendarEventFact | null;
    }
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

function proposed(appointment: Appointment): Proposed {
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
    senderNotTrusted: false,
  };
}

function tell(c: Context, line: string, push: boolean): MailEffect {
  if (c.decision !== null) return escalate(c, c.decision, line, null, null);
  return {
    kind: "tell_caregivers",
    ...caregiverMessage(c.facts, line, c.summary),
    push,
    senderNotTrusted: false,
  };
}

function heldForTrust(c: Context, effect: MailEffect): MailEffect {
  if (!c.authenticated || c.trusted) return effect;
  if (effect.kind !== "escalate" && effect.kind !== "tell_caregivers") return effect;
  return { ...effect, senderNotTrusted: true };
}

function onCalendar(c: Context, eventId: string, key: string): MailEffect[] {
  const already: MailEffect = {
    kind: "already_on_calendar",
    eventId,
    appointmentKey: c.trusted ? key : null,
  };
  if (c.decision === null) return [already];
  return [
    already,
    escalate(c, c.decision, "The appointment is already on the calendar.", eventId, null),
  ];
}

function only(matches: CalendarEventFact[]): CalendarEventFact | null {
  return matches.length === 1 ? (matches[0] ?? null) : null;
}

function described(appointment: Appointment): string {
  return `${titleOf(appointment)}, ${when(appointment.date, appointment.time)}`;
}

const DECISION_TABLE: { [K in Case]: Row<Extract<Situation, { case: K }>>[] } = {
  ignore: [{ rule: "any", plan: () => [] }],
  new: [
    {
      rule: "sender not authenticated",
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
    },
    {
      rule: "appointmentFields rejects",
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
    },
    {
      rule: "already linked, or same date, time and title words as a live event",
      plan: (s, c) =>
        s.duplicate === null
          ? null
          : onCalendar(c, s.duplicate, appointmentKey(s.appointment, c.facts.ics)),
    },
    {
      rule: "sender not trusted",
      plan: (s, c) =>
        c.trusted
          ? null
          : [
              heldForTrust(
                c,
                escalate(
                  c,
                  "new_sender",
                  `${described(s.appointment)}. Sunny has not added it because ${NEW_SENDER}. Tell Sunny in chat to add it and to trust this sender.`,
                  null,
                  s.appointment,
                ),
              ),
            ],
    },
    {
      rule: "a person would come to the home",
      plan: (s, c) =>
        !APPOINTMENT_KINDS[s.appointment.kind].comesHome
          ? null
          : [
              escalate(
                c,
                "home_visit",
                `${described(s.appointment)}. Sunny has not added it because someone would come to the home. Tell Sunny in chat to add it once you have checked the visit.`,
                null,
                s.appointment,
              ),
            ],
    },
    {
      rule: "overlaps another live event",
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
      rule: "daily limit of calendar changes reached",
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
      rule: "otherwise",
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
      rule: "not authenticated, not trusted, no single match, the match repeats, or new fields rejected",
      plan: (s, c) => {
        const match = only(s.matches);
        if (c.trusted && match !== null && !match.repeating && s.fields !== null) return null;
        const asked = when(s.appointment.date, s.appointment.time);
        const line =
          match === null
            ? `Sunny did not move any appointment. The email asks to move one to ${asked}.`
            : match.repeating
              ? `Sunny did not move ${match.title}, ${when(match.date, match.time)}, because it is one date of a repeating event. The email asks to move it to ${asked}. Tell Sunny in chat what to change.`
              : c.authenticated && !c.trusted
                ? `Sunny did not move ${match.title}, ${when(match.date, match.time)}, because ${NEW_SENDER}. The email asks to move it to ${asked}. Tell Sunny in chat to move it and to trust this sender.`
                : `Sunny did not move ${match.title}, ${when(match.date, match.time)}. The email asks to move it to ${asked}. Tell Sunny in chat to move it.`;
        return [
          heldForTrust(
            c,
            escalate(c, "unclear_reschedule", line, match?.eventId ?? null, s.appointment),
          ),
        ];
      },
    },
    {
      rule: "the match already has the new date and time",
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
      rule: "daily limit of calendar changes reached",
      plan: (s, c) => {
        const match = only(s.matches);
        if (!c.atDailyLimit || match === null || s.fields === null) return null;
        return [
          escalate(
            c,
            "daily_limit",
            `Sunny did not move ${match.title}, ${when(match.date, match.time)}, to ${when(s.fields.date, s.fields.time)}, because ${DAILY_LIMIT}. Tell Sunny in chat to move it.`,
            match.eventId,
            s.fields,
          ),
        ];
      },
    },
    {
      rule: "exactly one match",
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
      rule: "any",
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
    { rule: "stale", plan: (_, c) => (c.stale ? [] : null) },
    {
      rule: "not authenticated, or not trusted",
      plan: (_, c) =>
        c.trusted
          ? null
          : [
              heldForTrust(
                c,
                tell(
                  c,
                  `Sunny did not tell the senior about this email because ${NEW_SENDER}.`,
                  false,
                ),
              ),
            ],
    },
    {
      rule: "otherwise",
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
      rule: "any",
      plan: (s, c) => [escalate(c, s.reason, "This email needs a decision.", null, null)],
    },
  ],
  suspicious: [
    {
      rule: "any",
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

function matchesFor(ref: AppointmentRef | null, facts: PolicyFacts): CalendarEventFact[] {
  const { linked } = facts;
  if (linked !== null) return facts.events.filter((e) => e.eventId === linked.eventId);
  return ref === null ? [] : matchEvent(ref, facts.events);
}

function sameSlot(a: { date: string; time: string }, b: { date: string; time: string }): boolean {
  return a.date === b.date && a.time === b.time;
}

function newSituation(appointment: Appointment, facts: PolicyFacts): Situation {
  const fields = appointmentFields(appointment, facts);
  const { linked } = facts;
  const live = facts.events.find((e) => e.eventId === linked?.eventId);
  if (live !== undefined && facts.ics !== null && !sameSlot(live, appointment)) {
    return { case: "reschedule", appointment, fields, matches: [live] };
  }
  if (linked !== null && live === undefined && !sameSlot(linked, appointment)) {
    return { case: "reschedule", appointment, fields, matches: [] };
  }
  const same =
    fields === null
      ? undefined
      : facts.events.find(
          (e) =>
            e.date === fields.date &&
            e.time === fields.time &&
            sharesWords(e.title, titleOf(fields)),
        );
  return {
    case: "new",
    appointment,
    fields,
    duplicate: linked?.eventId ?? same?.eventId ?? null,
    conflict:
      fields === null
        ? null
        : (facts.events.find((e) => overlaps(fields, e, facts.timezone)) ?? null),
  };
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
  switch (verdict.change) {
    case "cancel":
      return {
        case: "cancel",
        previous: verdict.previous,
        matches: matchesFor(verdict.previous, facts),
      };
    case "reschedule":
      return {
        case: "reschedule",
        appointment: verdict.appointment,
        fields: appointmentFields(verdict.appointment, facts),
        matches: matchesFor(verdict.previous, facts),
      };
    case "new":
      return newSituation(verdict.appointment, facts);
  }
}

function runTable<K extends Case>(
  rows: Row<Extract<Situation, { case: K }>>[],
  situation: Extract<Situation, { case: K }>,
  context: Context,
): Plan {
  for (const row of rows) {
    const effects = row.plan(situation, context);
    if (effects !== null) return { rule: `${situation.case}: ${row.rule}`, effects };
  }
  return { rule: `${situation.case}: no row`, effects: [] };
}

function planFor(situation: Situation, context: Context): Plan {
  switch (situation.case) {
    case "ignore":
      return runTable(DECISION_TABLE.ignore, situation, context);
    case "new":
      return runTable(DECISION_TABLE.new, situation, context);
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
    trusted: facts.sender.authenticated && facts.senderTrusted,
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
