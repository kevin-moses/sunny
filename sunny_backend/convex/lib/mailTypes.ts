import type { Infer } from "convex/values";
import {
  APPOINTMENT_KIND_NAMES,
  DECISION_REASONS,
  ESCALATION_REASONS,
  INFO_TOPICS,
  SUSPICIONS,
} from "./mailConstants";
import type {
  appointment,
  appointmentRef,
  icsEvent,
  jevAnswer,
  jevAnswers,
  mailSender,
  mailVerdict,
  proposed,
  triaged,
  usage,
} from "./validators";

export { APPOINTMENT_KIND_NAMES, DECISION_REASONS, ESCALATION_REASONS, INFO_TOPICS, SUSPICIONS };

export type MailSender = Infer<typeof mailSender>;

export type IcsEvent = Infer<typeof icsEvent>;

export type Appointment = Infer<typeof appointment>;

export type AppointmentRef = Infer<typeof appointmentRef>;

export type MailVerdict = Infer<typeof mailVerdict>;

export type Usage = Infer<typeof usage>;

export type JevAnswer = Infer<typeof jevAnswer>;

export type JevAnswers = Infer<typeof jevAnswers>;

export type Triaged = Infer<typeof triaged>;

export type Proposed = Infer<typeof proposed>;

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

export type AppointmentKind = (typeof APPOINTMENT_KIND_NAMES)[number];

export interface CaregiverConfirms {
  reason: Extract<EscalationReason, "home_visit" | "phone_call">;
  because: string;
  checked: string;
}

export const APPOINTMENT_KINDS: Record<
  AppointmentKind,
  { describe: string; title: string; caregiverConfirms: CaregiverConfirms | null }
> = {
  doctor_visit: {
    describe: "A visit with a doctor, nurse or other clinician",
    title: "Doctor visit",
    caregiverConfirms: null,
  },
  dentist: {
    describe: "A dentist visit or teeth cleaning",
    title: "Dentist appointment",
    caregiverConfirms: null,
  },
  eye_doctor: {
    describe: "An eye exam or a visit to an eye doctor",
    title: "Eye exam",
    caregiverConfirms: null,
  },
  hearing: {
    describe: "A hearing test or a hearing aid visit",
    title: "Hearing appointment",
    caregiverConfirms: null,
  },
  physical_therapy: {
    describe: "Physical or occupational therapy",
    title: "Physical therapy",
    caregiverConfirms: null,
  },
  medical_test: {
    describe: "A lab test, blood draw, scan, X-ray, MRI or other medical test",
    title: "Medical test",
    caregiverConfirms: null,
  },
  vaccine: {
    describe: "A vaccine or a shot",
    title: "Vaccine appointment",
    caregiverConfirms: null,
  },
  hair: {
    describe: "A haircut or a salon visit",
    title: "Hair appointment",
    caregiverConfirms: null,
  },
  group_activity: {
    describe: "A class, club or group activity",
    title: "Group activity",
    caregiverConfirms: null,
  },
  meal: {
    describe: "A breakfast, lunch, dinner or coffee with someone",
    title: "Meal",
    caregiverConfirms: null,
  },
  family_visit: {
    describe: "A visit with family or friends",
    title: "Family visit",
    caregiverConfirms: null,
  },
  video_call: { describe: "A video call", title: "Video call", caregiverConfirms: null },
  phone_call: {
    describe: "A phone call",
    title: "Phone call",
    caregiverConfirms: {
      reason: "phone_call",
      because: "someone would phone the senior",
      checked: "the call",
    },
  },
  meeting: {
    describe: "A meeting or counseling session",
    title: "Meeting",
    caregiverConfirms: null,
  },
  home_service: {
    describe: "A worker coming to the home",
    title: "Home service visit",
    caregiverConfirms: {
      reason: "home_visit",
      because: "someone would come to the home",
      checked: "the visit",
    },
  },
  other: {
    describe: "Any other kind of appointment",
    title: "Appointment",
    caregiverConfirms: null,
  },
};

const MEAL_TITLES: [string, string][] = [
  ["11:00", "Breakfast"],
  ["16:00", "Lunch"],
  ["24:00", "Dinner"],
];

export const APPOINTMENT_TITLES: ReadonlySet<string> = new Set([
  ...APPOINTMENT_KIND_NAMES.map((kind) => APPOINTMENT_KINDS[kind].title),
  ...MEAL_TITLES.map(([, title]) => title),
]);

export function appointmentTitle(kind: AppointmentKind, time: string | null): string {
  if (kind !== "meal" || time === null) return APPOINTMENT_KINDS[kind].title;
  return MEAL_TITLES.find(([before]) => time < before)?.[1] ?? APPOINTMENT_KINDS.meal.title;
}

export type InfoTopic = (typeof INFO_TOPICS)[number];

export const SENIOR_SENTENCES: Record<InfoTopic, string> = {
  prescription_ready: "Your prescription is ready to pick up at the pharmacy.",
  prescription_coming: "The pharmacy is getting your prescription ready.",
  package_arrived: "A package was delivered to your home.",
  package_coming: "A package is on the way to your home.",
  personal_note: "You have a personal email. Someone can read it with you.",
};

export type DecisionReason = (typeof DECISION_REASONS)[number];

export type Suspicion = (typeof SUSPICIONS)[number];

export const NO_USAGE: Usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 };

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
  subject: string;
  receivedAt: number;
  gmailId: string;
  ics: IcsEvent | null;
  events: CalendarEventFact[];
  linked: LinkedEvent | null;
  calendarChangesToday: number;
}

export type LinkMaker = "this_address" | "another_address";

export type LinkedEvent =
  | { eventId: string; occurs: true }
  | { eventId: string; occurs: false; date: string; time: string; madeBy: LinkMaker };

export type EscalationReason = (typeof ESCALATION_REASONS)[number];

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
  | { kind: "already_on_calendar"; eventId: string; appointmentKey: string }
  | { kind: "senior_note"; text: string; expiresAt: number }
  | ({ kind: "tell_caregivers"; push: boolean } & CaregiverMessage)
  | ({
      kind: "escalate";
      reason: EscalationReason;
      push: boolean;
      eventId: string | null;
      proposed: Proposed | null;
    } & CaregiverMessage);
