import { appointmentTitle } from "./mailTypes";
import type { Appointment, CaregiverMessage, PolicyFacts } from "./mailTypes";
import { ellipsize, oneLine } from "./text";
import { dateLabel, formatTime12, localDate, localTime, weekdayName } from "./time";

const MAX_SHOWN_SUBJECT = 120;
const MAX_CAREGIVER_BODY = 600;
const MAX_SCRUBBED = 4 * MAX_CAREGIVER_BODY;
const LINK_REMOVED = "[link removed]";
const NUMBER_REMOVED = "[number removed]";

function scrub(text: string): string {
  return oneLine(text.slice(0, MAX_SCRUBBED))
    .replace(/(?:https?:\/\/|www\.)\S+/gi, LINK_REMOVED)
    .replace(/\b[a-z0-9-]+(?:\.[a-z0-9-]+)+\/\S*/gi, LINK_REMOVED)
    .replace(/\d(?:[\s().-]*\d){6,}/g, NUMBER_REMOVED);
}

export function when(date: string, time: string): string {
  return `${weekdayName(date)}, ${dateLabel(date)} at ${formatTime12(time)}`;
}

export type MailHeaderFacts = Pick<PolicyFacts, "sender" | "subject" | "receivedAt" | "timezone">;

export interface MailHeader {
  senderName: string | null;
  senderAddress: string;
  senderVerified: boolean;
  subject: string;
  receivedDate: string;
  receivedTime: string;
}

export function mailHeader(facts: MailHeaderFacts): MailHeader {
  const name = scrub(facts.sender.name);
  return {
    senderName: name === "" ? null : name,
    senderAddress: facts.sender.address,
    senderVerified: facts.sender.authenticated,
    subject: ellipsize(scrub(facts.subject), MAX_SHOWN_SUBJECT),
    receivedDate: localDate(facts.receivedAt, facts.timezone),
    receivedTime: localTime(facts.receivedAt, facts.timezone),
  };
}

export function caregiverText(facts: MailHeaderFacts, lines: string[]): string {
  const body = lines.map(scrub).filter((line) => line !== "");
  return ellipsize(body.join("\n"), MAX_CAREGIVER_BODY);
}

export function caregiverMessage(
  facts: Pick<PolicyFacts, "sender" | "subject" | "receivedAt" | "timezone" | "ics">,
  line: string,
  summary: string,
): CaregiverMessage {
  const place = facts.ics?.location ?? null;
  const placeLine = place === null ? [] : [`Place in the invitation: ${place}`];
  return { body: caregiverText(facts, [line, ...placeLine, summary]), notice: scrub(line) };
}

export function described(appointment: Appointment): string {
  return `${appointmentTitle(appointment.kind, appointment.time)}, ${when(appointment.date, appointment.time)}`;
}
