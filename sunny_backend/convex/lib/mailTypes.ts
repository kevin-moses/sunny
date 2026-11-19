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

export interface Clock {
  now: number;
  timezone: string;
}

export const APPOINTMENT_KIND_NAMES = [
  "doctor_visit",
  "dentist",
  "eye_doctor",
  "hearing",
  "physical_therapy",
  "medical_test",
  "vaccine",
  "hair",
  "group_activity",
  "meal",
  "family_visit",
  "video_call",
  "phone_call",
  "meeting",
  "home_service",
  "other",
] as const;

export type AppointmentKind = (typeof APPOINTMENT_KIND_NAMES)[number];

export const APPOINTMENT_KINDS: Record<AppointmentKind, { describe: string; title: string }> = {
  doctor_visit: {
    describe: "A visit with a doctor, nurse or other clinician",
    title: "Doctor visit",
  },
  dentist: { describe: "A dentist visit or teeth cleaning", title: "Dentist appointment" },
  eye_doctor: { describe: "An eye exam or a visit to an eye doctor", title: "Eye exam" },
  hearing: { describe: "A hearing test or a hearing aid visit", title: "Hearing appointment" },
  physical_therapy: { describe: "Physical or occupational therapy", title: "Physical therapy" },
  medical_test: {
    describe: "A lab test, blood draw, scan, X-ray, MRI or other medical test",
    title: "Medical test",
  },
  vaccine: { describe: "A vaccine or a shot", title: "Vaccine appointment" },
  hair: { describe: "A haircut or a salon visit", title: "Hair appointment" },
  group_activity: { describe: "A class, club or group activity", title: "Group activity" },
  meal: { describe: "A breakfast, lunch, dinner or coffee with someone", title: "Meal" },
  family_visit: { describe: "A visit with family or friends", title: "Family visit" },
  video_call: { describe: "A video call", title: "Video call" },
  phone_call: { describe: "A phone call", title: "Phone call" },
  meeting: { describe: "A meeting or counseling session", title: "Meeting" },
  home_service: { describe: "A worker coming to the home", title: "Home service visit" },
  other: { describe: "Any other kind of appointment", title: "Appointment" },
};

const MEAL_TITLES: [string, string][] = [
  ["11:00", "Breakfast"],
  ["16:00", "Lunch"],
  ["24:00", "Dinner"],
];

export function appointmentTitle(kind: AppointmentKind, time: string | null): string {
  if (kind !== "meal" || time === null) return APPOINTMENT_KINDS[kind].title;
  return MEAL_TITLES.find(([before]) => time < before)?.[1] ?? APPOINTMENT_KINDS.meal.title;
}

export interface Appointment {
  kind: AppointmentKind;
  date: string;
  time: string;
  durationMinutes: number | null;
}

export interface AppointmentRef {
  kind: AppointmentKind;
  date: string;
  time: string | null;
}

export const INFO_TOPICS = [
  "prescription_ready",
  "prescription_coming",
  "package_arrived",
  "package_coming",
  "home_visit",
  "family_news",
] as const;

export type InfoTopic = (typeof INFO_TOPICS)[number];

export const SENIOR_SENTENCES: Record<InfoTopic, string> = {
  prescription_ready: "The pharmacy has your medicine ready to pick up.",
  prescription_coming: "The pharmacy is getting your prescription ready.",
  package_arrived: "A package was delivered to your home.",
  package_coming: "Someone is bringing a package to your home.",
  home_visit: "A service worker will visit your home soon.",
  family_news: "You have a friendly email from family or a friend. Someone can read it with you.",
};

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
  | { kind: "ignore" }
  | {
      kind: "appointment";
      change: "new";
      appointment: Appointment;
      decision: DecisionReason | null;
    }
  | {
      kind: "appointment";
      change: "reschedule";
      previous: AppointmentRef | null;
      appointment: Appointment;
      decision: DecisionReason | null;
    }
  | {
      kind: "appointment";
      change: "cancel";
      previous: AppointmentRef;
      decision: DecisionReason | null;
    }
  | { kind: "senior_info"; topic: InfoTopic }
  | { kind: "needs_decision"; reason: DecisionReason }
  | { kind: "suspicious"; suspicion: Suspicion };

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
}

export const NO_USAGE: Usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 };

export type JevAnswer = number | { choice: string; probability: number };

export type JevAnswers = Record<string, JevAnswer>;

export interface Triaged {
  verdict: MailVerdict;
  summary: string;
  rule: string;
  classifier: { name: string; usage: Usage };
  answers: JevAnswers | null;
}

export interface CalendarEventFact {
  eventId: string;
  title: string;
  date: string;
  time: string;
  durationMinutes: number | null;
  repeating: boolean;
}

export interface PolicyFacts {
  now: number;
  timezone: string;
  sender: MailSender;
  senderTrusted: boolean;
  subject: string;
  receivedAt: number;
  gmailId: string;
  ics: IcsEvent | null;
  events: CalendarEventFact[];
  linkedEventId: string | null;
}

export const ESCALATION_REASONS = [
  ...DECISION_REASONS,
  ...SUSPICIONS,
  "new_sender",
  "unverified_sender",
  "unclear_appointment",
  "unclear_reschedule",
  "conflict",
] as const;
export type EscalationReason = (typeof ESCALATION_REASONS)[number];

export interface Proposed {
  kind: AppointmentKind;
  date: string;
  time: string;
}

export interface CaregiverMessage {
  body: string;
  notice: string;
}

export type MailEffect =
  | {
      kind: "add_event";
      appointment: Appointment;
      appointmentKey: string;
    }
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
      proposed: Proposed | null;
    } & CaregiverMessage);
