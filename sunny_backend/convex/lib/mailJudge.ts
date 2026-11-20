import { JEV_MODEL } from "./jevClient";
import type { AskJev } from "./jevClient";
import { level, oneOf, sure } from "./jevConfidence";
import type { Level, Picked } from "./jevConfidence";
import { FLAGS, flagsIn, judgeQuestions, judgeState } from "./jevQuestions";
import type { Flag, SlotName } from "./jevQuestions";
import { resolveSlot } from "./mailDates";
import type { Slot, SlotPicks } from "./mailDates";
import { gate } from "./mailGate";
import { APPOINTMENT_KIND_NAMES } from "./mailConstants";
import type {
  AppointmentKind,
  AppointmentRef,
  Clock,
  DecisionReason,
  IcsEvent,
  InfoTopic,
  JevAnswers,
  KnownInvite,
  MailVerdict,
  ParsedEmail,
  Suspicion,
  Triaged,
} from "./mailTypes";
import { localDate } from "./time";

export interface Invite {
  method: "REQUEST" | "CANCEL";
  start: { date: string; time: string };
  durationMinutes: number | null;
}

export interface Readings {
  flags: ReadonlyMap<Flag, Level>;
  otherTimeZone: Level;
  kind: AppointmentKind;
  when: Slot | null;
  before: Slot | null;
  invite: Invite | null;
}

interface Decision {
  verdict: MailVerdict;
  summary: string;
}

function suspicious(suspicion: Suspicion, summary: string): Decision {
  return { verdict: { kind: "suspicious", suspicion }, summary };
}

function decision(reason: DecisionReason, summary: string): Decision {
  return { verdict: { kind: "needs_decision", reason }, summary };
}

function info(topic: InfoTopic, summary: string): Decision {
  return { verdict: { kind: "senior_info", topic }, summary };
}

function timed(r: Readings): { date: string; time: string } | null {
  const slot = r.when;
  if (slot === null || slot.time === null || r.otherTimeZone !== "no") return null;
  return { date: slot.date, time: slot.time };
}

const SAFETY_FLAGS = flagsIn("safety", "pressure");
const PRESSURE_FLAGS = flagsIn("pressure");
const DECISION_FLAGS = flagsIn("decision");
const SPECIFIC_DECISION_FLAGS = flagsIn("decision", "appointment");
const BROAD_FLAGS = flagsIn("broad");
const INFO_FLAGS = flagsIn("information");

interface Row {
  id: string;
  decide: (r: Readings) => Decision | null;
}

const is = (r: Readings, flag: Flag): boolean => r.flags.get(flag) === "yes";
const anyUnsure = (r: Readings, flags: Flag[]): boolean =>
  flags.some((f) => r.flags.get(f) === "unsure");

interface NamedDecision {
  id: string;
  flag: Flag;
  reason: DecisionReason;
  summary: string;
}

const NAMED_DECISIONS: NamedDecision[] = [
  {
    id: "test-results",
    flag: "about_test_results",
    reason: "health_result",
    summary: "The email is about medical test results.",
  },
  {
    id: "bill",
    flag: "about_bill",
    reason: "bill_or_payment",
    summary: "The email is about a bill or a payment.",
  },
  {
    id: "account-security",
    flag: "about_account_security",
    reason: "account_or_credentials",
    summary: "The email is about the security of one of the senior's accounts.",
  },
  {
    id: "government",
    flag: "from_government",
    reason: "legal_or_government",
    summary: "The email is from a government, court or tax office.",
  },
  {
    id: "question-for-senior",
    flag: "asks_question",
    reason: "reply_needed",
    summary: "The email asks the senior a question that needs an answer.",
  },
];

const NEEDS_ACTION: NamedDecision = {
  id: "action-needed",
  flag: "needs_action",
  reason: "other",
  summary: "The email needs a payment, a reply, a signature or a decision.",
};

function decisionOf(r: Readings): DecisionReason | null {
  const named = NAMED_DECISIONS.find(({ flag }) => is(r, flag));
  if (named !== undefined) return named.reason;
  return anyUnsure(r, DECISION_FLAGS) ? "other" : null;
}

function cancelled(r: Readings, previous: AppointmentRef, summary: string): Decision {
  return {
    verdict: { kind: "appointment", change: "cancel", previous, decision: decisionOf(r) },
    summary,
  };
}

export const TRUTH_TABLE: Row[] = [
  {
    id: "assistant-instructions",
    decide: (r) =>
      is(r, "addresses_assistant")
        ? suspicious(
            "scam",
            "The email contains instructions aimed at an assistant or a program that reads mail, which is a sign of an attack.",
          )
        : null,
  },
  {
    id: "private-details",
    decide: (r) =>
      is(r, "asks_private_details")
        ? suspicious("credentials", "The email asks for private login or identity details.")
        : null,
  },
  {
    id: "hard-to-trace-payment",
    decide: (r) =>
      is(r, "asks_hard_to_trace_payment")
        ? suspicious(
            "money_request",
            "The email asks for money by gift card, wire transfer, cash or another hard-to-trace way.",
          )
        : null,
  },
  {
    id: "bring-payment",
    decide: (r) =>
      is(r, "asks_to_bring_payment")
        ? suspicious(
            "money_request",
            "The email tells the senior to bring a bank card, checkbook or cash.",
          )
        : null,
  },
  {
    id: "new-contact-details",
    decide: (r) =>
      is(r, "announces_new_contact") || is(r, "name_mismatch")
        ? suspicious("impersonation", "The sender may not be who they claim to be.")
        : null,
  },
  {
    id: "threat-or-secrecy",
    decide: (r) => {
      if (!PRESSURE_FLAGS.some((f) => is(r, f))) return null;
      const posing = is(r, "from_government") || is(r, "about_account_security");
      return suspicious(
        posing ? "impersonation" : "scam",
        "The email uses pressure, secrecy or a promise of money, which are signs of a scam.",
      );
    },
  },
  {
    id: "safety-unsettled",
    decide: (r) =>
      anyUnsure(r, SAFETY_FLAGS)
        ? decision(
            "other",
            "Sunny could not rule out that this email is a scam. Please look at it.",
          )
        : null,
  },
  {
    id: "ics-cancellation",
    decide: (r) => {
      const invite = r.invite;
      if (invite?.method !== "CANCEL") return null;
      return cancelled(
        r,
        { kind: r.kind, ...invite.start },
        "The email is a calendar cancellation.",
      );
    },
  },
  {
    id: "ics-cancelled",
    decide: (r) => {
      const invite = r.invite;
      if (invite === null || !is(r, "appointment_cancelled")) return null;
      return cancelled(
        r,
        { kind: r.kind, ...(r.before ?? invite.start) },
        "The email is a calendar invitation that says the appointment is cancelled.",
      );
    },
  },
  {
    id: "ics-moved",
    decide: (r) => {
      const invite = r.invite;
      if (invite === null || !is(r, "appointment_moved")) return null;
      return {
        verdict: {
          kind: "appointment",
          change: "reschedule",
          previous: r.before === null ? null : { kind: r.kind, ...r.before },
          appointment: { kind: r.kind, ...invite.start, durationMinutes: invite.durationMinutes },
          decision: decisionOf(r),
        },
        summary: "The email is a calendar invitation that moves an appointment.",
      };
    },
  },
  {
    id: "ics-invitation",
    decide: (r) => {
      const invite = r.invite;
      if (invite === null) return null;
      return {
        verdict: {
          kind: "appointment",
          change: "new",
          appointment: { kind: r.kind, ...invite.start, durationMinutes: invite.durationMinutes },
          decision: decisionOf(r),
        },
        summary: "The email is a calendar invitation.",
      };
    },
  },
  {
    id: "cancelled",
    decide: (r) => {
      if (!is(r, "appointment_cancelled")) return null;
      return r.before === null
        ? decision(
            "cancellation",
            "The email says an appointment was cancelled, but Sunny could not read which one.",
          )
        : cancelled(
            r,
            { kind: r.kind, ...r.before },
            "The email says an appointment was cancelled.",
          );
    },
  },
  {
    id: "moved",
    decide: (r) => {
      if (!is(r, "appointment_moved")) return null;
      const slot = timed(r);
      return r.before === null || slot === null
        ? decision(
            "other",
            "The email says an appointment moved, but Sunny could not read the old and new times.",
          )
        : {
            verdict: {
              kind: "appointment",
              change: "reschedule",
              previous: { kind: r.kind, ...r.before },
              appointment: { kind: r.kind, ...slot, durationMinutes: null },
              decision: decisionOf(r),
            },
            summary: "The email says an appointment moved to a new time.",
          };
    },
  },
  {
    id: "confirmed-appointment",
    decide: (r) => {
      const slot = timed(r);
      return is(r, "confirms_appointment") && slot !== null
        ? {
            verdict: {
              kind: "appointment",
              change: "new",
              appointment: { kind: r.kind, ...slot, durationMinutes: null },
              decision: decisionOf(r),
            },
            summary: "The email confirms an appointment.",
          }
        : null;
    },
  },
  ...[...NAMED_DECISIONS, NEEDS_ACTION].map(({ id, flag, reason, summary }): Row => ({
    id,
    decide: (r) => (is(r, flag) ? decision(reason, summary) : null),
  })),
  {
    id: "decision-unsettled",
    decide: (r) =>
      anyUnsure(r, SPECIFIC_DECISION_FLAGS)
        ? decision(
            "other",
            "Sunny could not tell whether this email needs a decision. Please look at it.",
          )
        : null,
  },
  {
    id: "prescription",
    decide: (r) => {
      if (!is(r, "about_prescription")) return null;
      return is(r, "prescription_ready_now")
        ? info("prescription_ready", "The email says a prescription is ready for pickup.")
        : info("prescription_coming", "The email says a prescription is being prepared.");
    },
  },
  {
    id: "package",
    decide: (r) => {
      if (!is(r, "about_package")) return null;
      return is(r, "package_arrived")
        ? info("package_arrived", "The email says a package was delivered.")
        : info("package_coming", "The email says a package is on its way.");
    },
  },
  {
    id: "home-visit",
    decide: (r) =>
      is(r, "home_visit")
        ? decision("home_visit", "The email says a worker will visit the home.")
        : null,
  },
  {
    id: "appointment-without-time",
    decide: (r) =>
      is(r, "confirms_appointment")
        ? decision(
            "other",
            "The email is about an appointment, but Sunny could not read its date and start time.",
          )
        : null,
  },
  {
    id: "personal-note",
    decide: (r) =>
      is(r, "personal_note") ? info("personal_note", "The email reads as a personal note.") : null,
  },
  {
    id: "bulk-mail",
    decide: (r) =>
      is(r, "bulk_mail") || is(r, "receipt") || is(r, "feedback_request")
        ? {
            verdict: { kind: "ignore" },
            summary: "The email is bulk mail, a receipt or a request for feedback.",
          }
        : null,
  },
  {
    id: "broad-unsettled",
    decide: (r) =>
      anyUnsure(r, BROAD_FLAGS)
        ? decision(
            "other",
            "Sunny could not tell whether this email needs a decision. Please look at it.",
          )
        : null,
  },
  {
    id: "information-unsettled",
    decide: (r) =>
      anyUnsure(r, INFO_FLAGS)
        ? decision("other", "Sunny could not tell what this email is about. Please look at it.")
        : null,
  },
  {
    id: "otherwise",
    decide: () =>
      decision("other", "Sunny did not recognize what this email is about. Please look at it."),
  },
];

export function decide(readings: Readings): Decision & { rule: string } {
  for (const row of TRUTH_TABLE) {
    const decided = row.decide(readings);
    if (decided !== null) return { ...decided, rule: row.id };
  }
  throw new Error("The mail truth table has no matching row");
}

function probabilityOf(answers: JevAnswers, name: string): number {
  const answer = answers[name];
  if (typeof answer === "number") return answer;
  throw new Error(`No Noul answer for ${name}`);
}

function pickOf(answers: JevAnswers, name: string): Picked {
  const answer = answers[name];
  if (typeof answer === "object") return answer;
  throw new Error(`No Choice answer for ${name}`);
}

function slotPicks(answers: JevAnswers, slot: SlotName): SlotPicks {
  const read = (part: keyof SlotPicks): Picked => pickOf(answers, `${slot}_${part}`);
  return {
    date_form: read("date_form"),
    month: read("month"),
    day: read("day"),
    year: read("year"),
    weekday: read("weekday"),
    week: read("week"),
    hour: read("hour"),
    minute: read("minute"),
    half: read("half"),
  };
}

function inviteOf(ics: IcsEvent | null): Invite | null {
  if (ics === null || ics.start === null) return null;
  if (ics.method !== "REQUEST" && ics.method !== "CANCEL") return null;
  return { method: ics.method, start: ics.start, durationMinutes: ics.durationMinutes };
}

export function readAnswers(answers: JevAnswers, anchor: string, ics: IcsEvent | null): Readings {
  const kind = sure(pickOf(answers, "appointment_kind"));
  return {
    flags: new Map(FLAGS.map((f) => [f, level(probabilityOf(answers, f))])),
    otherTimeZone: level(probabilityOf(answers, "other_time_zone")),
    kind: oneOf(APPOINTMENT_KIND_NAMES, kind) ?? "other",
    when: resolveSlot(slotPicks(answers, "when"), anchor),
    before: resolveSlot(slotPicks(answers, "before"), anchor),
    invite: inviteOf(ics),
  };
}

export async function triageEmail(
  email: ParsedEmail,
  clock: Clock,
  known: KnownInvite | null,
  ask: AskJev,
): Promise<Triaged> {
  const settled = gate(email, known);
  if (settled !== null) return settled;
  const anchor = localDate(email.receivedAt, clock.timezone);
  const reply = await ask({
    model: JEV_MODEL,
    state: judgeState(email),
    questions: judgeQuestions(Number(anchor.slice(0, 4)), clock.timezone),
  });
  const { verdict, summary, rule } = decide(readAnswers(reply.answers, anchor, email.ics));
  return {
    verdict,
    summary,
    rule,
    classifier: { name: reply.model, usage: reply.usage },
    answers: reply.answers,
  };
}
