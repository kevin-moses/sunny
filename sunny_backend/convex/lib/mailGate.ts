import type {
  Appointment,
  IcsEvent,
  KnownInvite,
  MailVerdict,
  ParsedEmail,
  Triaged,
} from "./mailTypes";

export type GateTriaged = Extract<Triaged, { stage: "gate" }>;

export type GateResult = { kind: "settled"; triaged: GateTriaged } | { kind: "classify" };

const IGNORED_LABELS = [
  "SPAM",
  "TRASH",
  "SENT",
  "DRAFT",
  "CATEGORY_PROMOTIONS",
  "CATEGORY_SOCIAL",
  "CATEGORY_FORUMS",
];

function settled(verdict: MailVerdict, rule: string): GateResult {
  return { kind: "settled", triaged: { stage: "gate", verdict, rule } };
}

function invitedAppointment(ics: IcsEvent, start: { date: string; time: string }): Appointment {
  return {
    title: ics.summary,
    date: start.date,
    time: start.time,
    durationMinutes: ics.durationMinutes,
    place: ics.location,
  };
}

function inviteSummary(ics: IcsEvent, start: { date: string; time: string }, what: string): string {
  return `${what}: ${ics.summary === "" ? "untitled event" : ics.summary} on ${start.date} at ${start.time}.`;
}

export function gate(email: ParsedEmail, known: KnownInvite | null): GateResult {
  const label = IGNORED_LABELS.find((l) => email.labels.includes(l));
  if (label !== undefined) {
    return settled({ kind: "ignore", summary: `Filed by Gmail as ${label}.` }, `label:${label}`);
  }
  const ics = email.ics;
  if (ics === null) return { kind: "classify" };
  if (ics.method === "REPLY") {
    return settled({ kind: "ignore", summary: "A reply to a calendar invitation." }, "ics:reply");
  }
  if (ics.recurring) {
    return settled(
      {
        kind: "needs_decision",
        reason: "other",
        summary: "A calendar invitation for a repeating appointment, or for one date of one.",
      },
      "ics:recurring",
    );
  }
  if (known !== null && ics.sequence < known.sequence) {
    return settled(
      { kind: "ignore", summary: "An older version of a calendar invitation Sunny already has." },
      "ics:older_sequence",
    );
  }
  const start = ics.start;
  if (start === null) return { kind: "classify" };
  if (ics.method === "CANCEL") {
    return settled(
      {
        kind: "appointment",
        change: "cancel",
        previous: { date: start.date, time: start.time, title: ics.summary },
        summary: inviteSummary(ics, start, "Calendar cancellation"),
      },
      "ics:cancel",
    );
  }
  if (ics.method !== "REQUEST") return { kind: "classify" };
  const appointment = invitedAppointment(ics, start);
  if (known === null) {
    return settled(
      {
        kind: "appointment",
        change: "new",
        appointment,
        summary: inviteSummary(ics, start, "Calendar invitation"),
      },
      "ics:request_new",
    );
  }
  return settled(
    {
      kind: "appointment",
      change: "reschedule",
      previous: { date: start.date, time: start.time, title: ics.summary },
      appointment,
      summary: inviteSummary(ics, start, "Updated calendar invitation"),
    },
    "ics:request_known",
  );
}
