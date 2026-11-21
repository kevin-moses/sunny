import { APPOINTMENT_KINDS, APPOINTMENT_TITLES, SENIOR_SENTENCES } from "./mailTypes";
import { APPOINTMENT_KIND_NAMES } from "./mailConstants";
import type {
  Appointment,
  AppointmentKind,
  AppointmentRef,
  CalendarEventFact,
  CaregiverConfirms,
  DecisionReason,
  EscalationReason,
  IcsEvent,
  InfoTopic,
  MailDraft,
  MailEffect,
  MailVerdict,
  PolicyFacts,
  Proposed,
  Suspicion,
  Triaged,
} from "./mailTypes";
import type { CheckedAppointment } from "./mailLinks";
import { appointmentKey, linkedFacts, matchEvent, resolveLink, titleWords } from "./mailLinks";
import { caregiverMessage, described, when } from "./mailProse";
import { noteExpiry } from "./seniorNotes";
import { DAY_MS, dateLabel, formatTime12 } from "./time";

const STALE_AFTER_MS = DAY_MS;
export const MAX_CALENDAR_CHANGES_PER_DAY = 5;
export const MAX_NOTES_PER_DAY = 3;
const DAILY_LIMIT = `the daily limit of ${MAX_CALENDAR_CHANGES_PER_DAY} calendar changes from email was reached`;

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

function isStale(facts: { receivedAt: number; now: number }): boolean {
  return facts.receivedAt < facts.now - STALE_AFTER_MS;
}

interface Context {
  facts: PolicyFacts;
  stale: boolean;
  atDailyLimit: boolean;
  atNoteLimit: boolean;
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

export type Situation =
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
  plan: (s: S, c: Context) => MailDraft[] | null;
}

export interface Plan {
  rule: string;
  effects: MailEffect[];
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
): MailDraft {
  return { kind: "escalate", reason, line, push: true, eventId, proposed: proposal(appointment) };
}

function tell(line: string): MailDraft {
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
  drafts: MailDraft[];
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

function withDecision(drafts: MailDraft[], decision: DecisionReason | null): MailDraft[] {
  if (decision === null) return drafts;
  const also = ALSO_NEEDS[decision];
  return drafts.flatMap((draft): MailDraft[] => {
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

function withoutPush(draft: MailDraft): MailDraft {
  switch (draft.kind) {
    case "escalate":
      return { ...draft, push: false };
    case "tell_caregivers":
      return tell(draft.line);
    default:
      return draft;
  }
}

function rendered(draft: MailDraft, ics: IcsEvent | null, summary: string): MailEffect {
  switch (draft.kind) {
    case "escalate":
    case "tell_caregivers":
      return { ...draft, ...caregiverMessage(ics, draft.line, summary) };
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
  return { rule, effects: pushed.map((draft) => rendered(draft, facts.ics, summary)) };
}
