import type {
  Appointment,
  CalendarEventFact,
  IcsEvent,
  MailVerdict,
  PolicyFacts,
} from "./mailTypes";
import { zonedInstant } from "./time";

export const NY = "America/New_York";
export const NOW = zonedInstant("2026-11-18", "09:00", NY);
export const CLOCK = { now: NOW, timezone: NY };

export const EVENTS: CalendarEventFact[] = [
  {
    eventId: "evt_eye",
    title: "Eye exam with Dr. Rivera",
    date: "2026-11-24",
    time: "10:30",
    durationMinutes: 60,
    repeating: false,
  },
  {
    eventId: "evt_pt",
    title: "Physical therapy",
    date: "2026-11-20",
    time: "14:00",
    durationMinutes: 45,
    repeating: false,
  },
  {
    eventId: "evt_dentist",
    title: "Dentist cleaning",
    date: "2026-12-02",
    time: "09:00",
    durationMinutes: null,
    repeating: false,
  },
];

export function facts(overrides: Partial<PolicyFacts> = {}): PolicyFacts {
  return {
    now: NOW,
    timezone: NY,
    sender: {
      name: "Lakeside Eye Care",
      address: "appointments@lakesideeye.example",
      authenticated: true,
    },
    subject: "Your appointment",
    receivedAt: NOW - 3_600_000,
    ics: null,
    events: EVENTS,
    linked: null,
    calendarChangesToday: 0,
    seniorNotesToday: 0,
    ...overrides,
  };
}

export function invite(overrides: Partial<IcsEvent> = {}): IcsEvent {
  return {
    method: "REQUEST",
    uid: "u-1",
    start: { date: "2026-12-10", time: "14:15" },
    durationMinutes: 45,
    summary: "Hearing test",
    location: null,
    recurring: false,
    sequence: 0,
    ...overrides,
  };
}

export function appointment(overrides: Partial<Appointment> = {}): Appointment {
  return { kind: "hearing", date: "2026-12-10", time: "14:15", durationMinutes: 45, ...overrides };
}

export function newAppointment(overrides: Partial<Appointment> = {}): MailVerdict {
  return {
    kind: "appointment",
    change: "new",
    appointment: appointment(overrides),
    decision: null,
  };
}
