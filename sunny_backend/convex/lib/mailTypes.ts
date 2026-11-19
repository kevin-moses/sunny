export interface MailSender {
  name: string;
  address: string;
  authenticated: boolean;
}

export interface IcsEvent {
  method: "REQUEST" | "CANCEL" | "REPLY" | "OTHER";
  uid: string;
  start: { date: string; time: string } | null;
  durationMinutes: number | null;
  summary: string;
  location: string | null;
  recurring: boolean;
  sequence: number;
}

export interface KnownInvite {
  sequence: number;
}

export interface ParsedEmail {
  gmailId: string;
  labels: string[];
  sender: MailSender;
  subject: string;
  receivedAt: number;
  text: string;
  ics: IcsEvent | null;
}

export interface Appointment {
  title: string;
  date: string;
  time: string;
  durationMinutes: number | null;
  place: string | null;
}

export interface AppointmentRef {
  date: string;
  time: string | null;
  title: string;
}

export const INFO_TOPICS = [
  "delivery",
  "prescription",
  "family_news",
  "service_visit",
  "other",
] as const;
export type InfoTopic = (typeof INFO_TOPICS)[number];

export const DECISION_REASONS = [
  "cancellation",
  "bill_or_payment",
  "account_or_credentials",
  "reply_needed",
  "legal_or_government",
  "health_result",
  "other",
] as const;
export type DecisionReason = (typeof DECISION_REASONS)[number];

export const SUSPICIONS = ["scam", "money_request", "credentials", "impersonation"] as const;
export type Suspicion = (typeof SUSPICIONS)[number];

export type MailVerdict =
  | { kind: "ignore"; summary: string }
  | { kind: "appointment"; change: "new"; appointment: Appointment; summary: string }
  | {
      kind: "appointment";
      change: "reschedule";
      previous: AppointmentRef;
      appointment: Appointment;
      summary: string;
    }
  | { kind: "appointment"; change: "cancel"; previous: AppointmentRef; summary: string }
  | { kind: "senior_info"; topic: InfoTopic; note: string; summary: string }
  | { kind: "needs_decision"; reason: DecisionReason; summary: string }
  | { kind: "suspicious"; suspicion: Suspicion; summary: string };

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
}

export type Triaged =
  | { stage: "gate"; verdict: MailVerdict; rule: string }
  | { stage: "model"; verdict: MailVerdict | null; usage: Usage; classifier: string };

export interface CalendarEventFact {
  eventId: string;
  title: string;
  date: string;
  time: string;
  durationMinutes: number | null;
  repeating: boolean;
  sourceSender: string | null;
}

export interface PolicyFacts {
  now: number;
  timezone: string;
  sender: MailSender;
  senderKnown: boolean;
  subject: string;
  receivedAt: number;
  gmailId: string;
  ics: IcsEvent | null;
  events: CalendarEventFact[];
  linkedEventId: string | null;
}

export type EscalationReason =
  | DecisionReason
  | Suspicion
  | "unverified_sender"
  | "unclear_appointment"
  | "unclear_reschedule"
  | "conflict"
  | "unreadable";

export interface Slot {
  date: string;
  time: string;
}

export interface CaregiverMessage {
  body: string;
  notice: string;
}

export type MailEffect =
  | { kind: "add_event"; appointment: Appointment; appointmentKey: string }
  | {
      kind: "reschedule_event";
      eventId: string;
      appointment: Appointment;
      appointmentKey: string;
    }
  | { kind: "already_on_calendar"; eventId: string }
  | { kind: "senior_note"; text: string; expiresAt: number }
  | ({ kind: "tell_caregivers"; push: boolean } & CaregiverMessage)
  | ({
      kind: "escalate";
      reason: EscalationReason;
      push: boolean;
      eventId: string | null;
      proposed: Slot | null;
    } & CaregiverMessage);
