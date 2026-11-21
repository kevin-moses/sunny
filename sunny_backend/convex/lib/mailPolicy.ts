import { APPOINTMENT_KINDS, APPOINTMENT_TITLES, SENIOR_SENTENCES } from "./mailTypes";
import { APPOINTMENT_KIND_NAMES } from "./mailConstants";
import type {
  Appointment,
  AppointmentKind,
  CalendarEventFact,
  CaregiverConfirms,
  DecisionReason,
  EscalationReason,
  IcsEvent,
  MailDraft,
  MailEffect,
  PolicyFacts,
  Proposed,
  Triaged,
} from "./mailTypes";
import { firstMatch } from "./firstMatch";
import { titleWords } from "./mailAppointments";
import type { CheckedAppointment } from "./mailAppointments";
import { appointmentKey } from "./mailLinks";
import { situationOf } from "./mailSituation";
import type { Case, SituationOf } from "./mailSituation";
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

const DECISION_TABLE: { [K in Case]: Row<SituationOf<K>>[] } = {
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

interface Drafted {
  rule: string;
  drafts: MailDraft[];
}

function planFor<K extends Case>(situation: SituationOf<K>, context: Context): Drafted {
  const rows: Row<SituationOf<K>>[] = DECISION_TABLE[situation.case];
  const matched = firstMatch(rows, (row) => row.plan(situation, context));
  if (matched === null) {
    throw new Error(`The mail decision table has no matching row for ${situation.case}`);
  }
  return { rule: matched.rule, drafts: matched.result };
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
