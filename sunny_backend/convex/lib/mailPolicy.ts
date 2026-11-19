import { cleanText } from "./frameText";
import type {
  Appointment,
  AppointmentRef,
  CalendarEventFact,
  DecisionReason,
  EscalationReason,
  IcsEvent,
  InfoTopic,
  MailEffect,
  MailVerdict,
  PolicyFacts,
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
const MAX_TITLE = 60;
const MAX_PLACE = 120;
const MAX_DAYS_AHEAD = 400;
const MIN_DURATION_MINUTES = 5;
const MAX_DURATION_MINUTES = 480;
const ASSUMED_DURATION_MINUTES = 30;
export const MAX_NOTE = 160;
const MAX_NOTE_SENTENCES = 2;
const MAX_SUBJECT = 120;
const MAX_CAREGIVER_BODY = 600;
const MAX_SCRUBBED = 4 * MAX_CAREGIVER_BODY;
const LINK_REMOVED = "[link removed]";
const NUMBER_REMOVED = "[number removed]";

const LINK = /:\/\/|www\.|@|\b[a-z0-9-]{2,}\.[a-z]{2,}\b/i;
const CURRENCY = /\p{Sc}/u;
const TITLE_DIGITS = /\d(?:[\s().-]*\d){2,}/;
const PLACE_DIGITS = /\d(?:[\s().-]*\d){6,}/;
const MARKUP = /[<>{}[\]*_`#|\\=]/;
const MONEY_AND_CREDENTIAL_WORDS = [
  "pay",
  "money",
  "bank",
  "card",
  "gift",
  "wire",
  "transfer",
  "password",
  "code",
  "verify",
  "account",
  "prize",
  "refund",
  "medicare",
];
const ACTION_WORDS = [
  "call",
  "phone",
  "dial",
  "click",
  "tap",
  "link",
  "download",
  "reply",
  "send",
  "urgent",
];
const INFLECTION = "(?:s|es|ed|d|ing|er|ers|ment|ments|ly)?";
const EXTRA_MONEY_AND_CREDENTIAL_FORMS =
  "\\bpaid\\b|\\bsocial\\s+security\\b|\\bverif(?:ied|ication)\\b";

function wordPattern(words: string[]): RegExp {
  return new RegExp(
    `\\b(?:${words.join("|")})${INFLECTION}\\b|${EXTRA_MONEY_AND_CREDENTIAL_FORMS}`,
    "i",
  );
}

const DENIED_IN_TITLES = wordPattern(MONEY_AND_CREDENTIAL_WORDS);
export const NOTE_DENIED_WORDS = [...MONEY_AND_CREDENTIAL_WORDS, ...ACTION_WORDS];
const DENIED_IN_NOTES = wordPattern(NOTE_DENIED_WORDS);
const STOP_WORDS = new Set(["the", "and", "for", "with", "appointment", "appt", "visit", "your"]);

export function appointmentKey(appointment: Appointment, ics: IcsEvent | null): string {
  if (ics !== null) return `ics:${ics.uid}`;
  return `appt:${appointment.date}:${appointment.time}:${textKey(appointment.title)}`;
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
      (ref.time === null ? sharesWords(e.title, ref.title) : e.time === ref.time),
  );
}

export function appointmentFields(
  appointment: Appointment,
  clock: { now: number; timezone: string },
): Appointment | null {
  const title = oneLine(appointment.title);
  const place = appointment.place === null ? "" : oneLine(appointment.place);
  const { date, time, durationMinutes } = appointment;
  if (title.length === 0 || title.length > MAX_TITLE) return null;
  if (TITLE_DIGITS.test(title) || LINK.test(title) || CURRENCY.test(title)) return null;
  if (place.length > MAX_PLACE || PLACE_DIGITS.test(place)) return null;
  if (LINK.test(place) || CURRENCY.test(place)) return null;
  if (DENIED_IN_TITLES.test(title) || DENIED_IN_TITLES.test(place)) return null;
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
  return { title, date, time, durationMinutes, place: place === "" ? null : place };
}

function foldPunctuation(text: string): string {
  return text
    .replace(/[‘’‛′]/g, "'")
    .replace(/[“”„″]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/…/g, "...");
}

function sentenceCount(text: string): number {
  return text.split(/[.!?]+(?:\s+|$)/).filter((s) => s.trim() !== "").length;
}

export function seniorNoteText(
  note: string,
  topic: InfoTopic,
  senderKnown: boolean,
): string | null {
  if (topic === "other" || (topic === "family_news" && !senderKnown)) return null;
  const text = oneLine(foldPunctuation(note));
  if (text.length === 0 || text.length > MAX_NOTE) return null;
  if (sentenceCount(text) > MAX_NOTE_SENTENCES) return null;
  if (/\d/.test(text) || LINK.test(text) || MARKUP.test(text) || CURRENCY.test(text)) return null;
  if (DENIED_IN_NOTES.test(text)) return null;
  return cleanText(text) === text ? text : null;
}

function scrub(text: string): string {
  return oneLine(text.slice(0, MAX_SCRUBBED))
    .replace(/(?:https?:\/\/|www\.)\S+/gi, LINK_REMOVED)
    .replace(/\b[a-z0-9-]+(?:\.[a-z0-9-]+)+\/\S*/gi, LINK_REMOVED)
    .replace(/\d(?:[\s().-]*\d){6,}/g, NUMBER_REMOVED);
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 3).trimEnd()}...`;
}

function when(date: string, time: string): string {
  return `${weekdayName(date)}, ${dateLabel(date)} at ${formatTime12(time)}`;
}

export function caregiverText(facts: PolicyFacts, lines: string[]): string {
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
    `Subject: ${clip(scrub(facts.subject), MAX_SUBJECT)}`,
    `Received: ${received}`,
    "",
    clip(body.join("\n"), MAX_CAREGIVER_BODY),
  ].join("\n");
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
  stale: boolean;
  summary: string;
}

type Situation =
  | { case: "unreadable" }
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
  | { case: "senior_info"; note: string | null }
  | { case: "needs_decision"; reason: DecisionReason }
  | { case: "suspicious"; suspicion: Suspicion };

type Case = Situation["case"];

interface Row<S> {
  rule: string;
  plan: (s: S, c: Context) => MailEffect[] | null;
}

export interface Plan {
  rule: string;
  effects: MailEffect[];
}

function escalate(
  c: Context,
  reason: EscalationReason,
  line: string,
  eventId: string | null = null,
): MailEffect {
  return {
    kind: "escalate",
    reason,
    body: caregiverText(c.facts, [line, c.summary]),
    push: true,
    eventId,
  };
}

function domainOf(address: string): string {
  return address.slice(address.lastIndexOf("@") + 1).toLowerCase();
}

function sameDomain(source: string | null, sender: string): boolean {
  if (source === null) return false;
  const a = domainOf(source);
  const b = domainOf(sender);
  return a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`);
}

function only(matches: CalendarEventFact[]): CalendarEventFact | null {
  return matches.length === 1 ? (matches[0] ?? null) : null;
}

const DECISION_TABLE: { [K in Case]: Row<Extract<Situation, { case: K }>>[] } = {
  unreadable: [
    {
      rule: "any",
      plan: (_, c) => [
        {
          kind: "escalate",
          reason: "unreadable",
          body: caregiverText(c.facts, ["Sunny could not sort this email. Please look at it."]),
          push: true,
          eventId: null,
        },
      ],
    },
  ],
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
                `Sunny did not add this appointment because the sender is not verified: ${s.appointment.title}, ${when(s.appointment.date, s.appointment.time)}.`,
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
                `Sunny did not add this appointment because its details did not pass Sunny's checks: ${s.appointment.title}, ${when(s.appointment.date, s.appointment.time)}.`,
              ),
            ],
    },
    {
      rule: "already linked, or same date, time and title words as a live event",
      plan: (s) =>
        s.duplicate === null ? null : [{ kind: "already_on_calendar", eventId: s.duplicate }],
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
                `Sunny did not add ${s.fields.title}, ${when(s.fields.date, s.fields.time)}, because it overlaps ${s.conflict.title} at ${formatTime12(s.conflict.time)}.`,
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
              {
                kind: "tell_caregivers",
                body: caregiverText(c.facts, [
                  `Sunny added ${s.fields.title}, ${when(s.fields.date, s.fields.time)}, to the calendar.`,
                  c.summary,
                ]),
                push: false,
              },
            ],
    },
  ],
  reschedule: [
    {
      rule: "not authenticated, no single match, new fields rejected, or sender neither known nor the event's source",
      plan: (s, c) => {
        const match = only(s.matches);
        const mayMove =
          match !== null &&
          (c.facts.senderKnown || sameDomain(match.sourceSender, c.facts.sender.address));
        if (c.authenticated && mayMove && s.fields !== null) return null;
        return [
          escalate(
            c,
            "unclear_reschedule",
            match === null
              ? `Sunny did not move any appointment. The email asks to move one to ${when(s.appointment.date, s.appointment.time)}.`
              : `Sunny did not move ${match.title}, ${when(match.date, match.time)}. The email asks to move it to ${when(s.appointment.date, s.appointment.time)}. Tell Sunny in chat to move it.`,
            match?.eventId ?? null,
          ),
        ];
      },
    },
    {
      rule: "the match already has the new date and time",
      plan: (s) => {
        const match = only(s.matches);
        return match !== null &&
          s.fields !== null &&
          match.date === s.fields.date &&
          match.time === s.fields.time
          ? [{ kind: "already_on_calendar", eventId: match.eventId }]
          : null;
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
          {
            kind: "tell_caregivers",
            body: caregiverText(c.facts, [
              `Sunny moved ${match.title} from ${when(match.date, match.time)} to ${when(s.fields.date, s.fields.time)}.`,
              c.summary,
            ]),
            push: true,
          },
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
        return [escalate(c, "cancellation", line, match?.eventId ?? null)];
      },
    },
  ],
  senior_info: [
    { rule: "stale", plan: (_, c) => (c.stale ? [] : null) },
    {
      rule: "not authenticated, or seniorNoteText rejects",
      plan: (s, c) =>
        c.authenticated && s.note !== null
          ? null
          : [
              {
                kind: "tell_caregivers",
                body: caregiverText(c.facts, [
                  "Sunny did not pass this on to the senior because it did not pass Sunny's checks.",
                  c.summary,
                ]),
                push: false,
              },
            ],
    },
    {
      rule: "otherwise",
      plan: (s, c) =>
        s.note === null
          ? null
          : [
              {
                kind: "senior_note",
                text: s.note,
                expiresAt: noteExpiry(c.facts.receivedAt, c.facts.timezone),
              },
            ],
    },
  ],
  needs_decision: [
    { rule: "any", plan: (s, c) => [escalate(c, s.reason, "This email needs a decision.")] },
  ],
  suspicious: [
    {
      rule: "any",
      plan: (s, c) => [
        escalate(
          c,
          s.suspicion,
          "Sunny thinks this email may be a scam and did not tell the senior about it.",
        ),
      ],
    },
  ],
};

function matchesFor(ref: AppointmentRef, facts: PolicyFacts): CalendarEventFact[] {
  if (facts.linkedEventId === null) return matchEvent(ref, facts.events);
  return facts.events.filter((e) => e.eventId === facts.linkedEventId);
}

function situationOf(verdict: MailVerdict | null, facts: PolicyFacts): Situation {
  const clock = { now: facts.now, timezone: facts.timezone };
  if (verdict === null) return { case: "unreadable" };
  switch (verdict.kind) {
    case "ignore":
      return { case: "ignore" };
    case "senior_info":
      return {
        case: "senior_info",
        note: seniorNoteText(verdict.note, verdict.topic, facts.senderKnown),
      };
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
        fields: appointmentFields(verdict.appointment, clock),
        matches: matchesFor(verdict.previous, facts),
      };
    case "new": {
      const fields = appointmentFields(verdict.appointment, clock);
      const same =
        fields === null
          ? undefined
          : facts.events.find(
              (e) =>
                e.date === fields.date &&
                e.time === fields.time &&
                sharesWords(e.title, fields.title),
            );
      return {
        case: "new",
        appointment: verdict.appointment,
        fields,
        duplicate: facts.linkedEventId ?? same?.eventId ?? null,
        conflict:
          fields === null
            ? null
            : (facts.events.find((e) => overlaps(fields, e, facts.timezone)) ?? null),
      };
    }
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
    case "unreadable":
      return runTable(DECISION_TABLE.unreadable, situation, context);
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

export function planWithRule(triaged: Triaged, facts: PolicyFacts): Plan {
  const verdict = triaged.verdict;
  const context: Context = {
    facts,
    authenticated: facts.sender.authenticated,
    stale: facts.receivedAt < facts.now - STALE_AFTER_MS,
    summary: verdict === null ? "" : verdict.summary,
  };
  const plan = planFor(situationOf(verdict, facts), context);
  if (!context.stale) return plan;
  return {
    rule: plan.rule,
    effects: plan.effects.map((e) =>
      (e.kind === "escalate" || e.kind === "tell_caregivers") && e.push ? { ...e, push: false } : e,
    ),
  };
}

export function planEffects(triaged: Triaged, facts: PolicyFacts): MailEffect[] {
  return planWithRule(triaged, facts).effects;
}
