import { describe, expect, test } from "vitest";
import {
  appointmentFields,
  appointmentKey,
  caregiverText,
  linkKey,
  matchEvent,
  planWithRule,
} from "./mailPolicy";
import { SENIOR_SENTENCES } from "./mailTypes";
import { noteExpiry } from "./seniorNotes";
import type {
  Appointment,
  AppointmentRef,
  CalendarEventFact,
  IcsEvent,
  LinkedEvent,
  MailEffect,
  MailVerdict,
  PolicyFacts,
} from "./mailTypes";
import { DAY_MS, zonedInstant } from "./time";

const NY = "America/New_York";
const NOW = zonedInstant("2026-11-18", "09:00", NY);
const CLOCK = { now: NOW, timezone: NY };

const EVENTS: CalendarEventFact[] = [
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

const UNVERIFIED = { sender: { name: "x", address: "x@x.example", authenticated: false } };

const PT_SENDER = {
  name: "Riverside Physical Therapy",
  address: "frontdesk@riversidept.example",
  authenticated: true,
};

function facts(overrides: Partial<PolicyFacts> = {}): PolicyFacts {
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
    gmailId: "m1",
    ics: null,
    events: EVENTS,
    linked: null,
    calendarChangesToday: 0,
    seniorNotesToday: 0,
    ...overrides,
  };
}

const CANCELLED_HEARING: LinkedEvent = {
  eventId: "evt_gone",
  occurs: false,
  date: "2026-12-10",
  time: "14:15",
  madeBy: "this_address",
};

function linkTo(eventId: string): LinkedEvent {
  const event = EVENTS.find((e) => e.eventId === eventId);
  if (event === undefined) throw new Error(eventId);
  return { eventId, occurs: true };
}

function invite(overrides: Partial<IcsEvent> = {}): IcsEvent {
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

function appointment(overrides: Partial<Appointment> = {}): Appointment {
  return { kind: "hearing", date: "2026-12-10", time: "14:15", durationMinutes: 45, ...overrides };
}

function newAppointment(overrides: Partial<Appointment> = {}): MailVerdict {
  return {
    kind: "appointment",
    change: "new",
    appointment: appointment(overrides),
    decision: null,
  };
}

function reschedule(previous: AppointmentRef, overrides: Partial<Appointment> = {}): MailVerdict {
  return {
    kind: "appointment",
    change: "reschedule",
    previous,
    decision: null,
    appointment: appointment({
      kind: "physical_therapy",
      date: "2026-11-23",
      time: "15:00",
      ...overrides,
    }),
  };
}

function effectsOf(verdict: MailVerdict, policyFacts: PolicyFacts): MailEffect[] {
  return planWithRule({ verdict, summary: "Sunny's sentence." }, policyFacts).effects;
}

function kinds(effects: MailEffect[]): string[] {
  return effects.map((e) => (e.kind === "escalate" ? `escalate:${e.reason}:${e.push}` : e.kind));
}

describe("planWithRule decision table", () => {
  test("ignore plans nothing", () => {
    expect(effectsOf({ kind: "ignore" }, facts())).toEqual([]);
  });

  describe("new appointment", () => {
    test("from an unverified sender escalates with the proposal and is not added", () => {
      const effects = effectsOf(newAppointment(), facts(UNVERIFIED));
      expect(kinds(effects)).toEqual(["escalate:unverified_sender:true"]);
      expect(effects[0]).toMatchObject({
        eventId: null,
        proposed: { kind: "hearing", date: "2026-12-10", time: "14:15" },
        notice:
          "Hearing appointment, Thursday, December 10 at 2:15 PM. Sunny has not added it because Gmail could not verify the sender. Tell Sunny in chat to add it if the email is genuine.",
      });
    });

    test.each([
      ["linked to it", { linked: linkTo("evt_eye") }],
      ["at its slot with a new invitation UID", { ics: invite({ uid: "attacker" }) }],
    ])(
      "from an unverified sender that repeats a live event %s escalates and links nothing",
      (_, overrides) => {
        const effects = effectsOf(
          newAppointment({ kind: "eye_doctor", date: "2026-11-24", time: "10:30" }),
          facts({ ...UNVERIFIED, ...overrides }),
        );
        expect(kinds(effects)).toEqual(["escalate:unverified_sender:true"]);
      },
    );

    test("with a date in the past escalates as unclear", () => {
      const effects = effectsOf(newAppointment({ date: "2026-11-17" }), facts());
      expect(kinds(effects)).toEqual(["escalate:unclear_appointment:true"]);
      expect(effects[0]).toMatchObject({
        proposed: { kind: "hearing", date: "2026-11-17", time: "14:15" },
      });
    });
    test("an appointment without a date and a time Sunny can read is not planned", () => {
      expect(() => effectsOf(newAppointment({ time: "2:15 PM" }), facts(UNVERIFIED))).toThrow(
        "not a date and a time",
      );
    });

    test("linked to a cancelled event at its slot is already on the calendar and not added again", () => {
      expect(effectsOf(newAppointment(), facts({ linked: CANCELLED_HEARING }))).toEqual([
        {
          kind: "already_on_calendar",
          eventId: "evt_gone",
          appointmentKey: "appt:2026-12-10:14:15:hearing appointment",
        },
      ]);
    });

    test("a slot link whose event has moved away changes nothing and asks which time is right", () => {
      const effects = effectsOf(newAppointment(), facts({ linked: linkTo("evt_eye") }));
      expect(kinds(effects)).toEqual(["escalate:unclear_appointment:true"]);
      expect(effects[0]).toMatchObject({
        eventId: "evt_eye",
        proposed: { kind: "hearing", date: "2026-12-10", time: "14:15" },
        notice:
          "The email gives Hearing appointment, Thursday, December 10 at 2:15 PM. Sunny's calendar has this appointment on Tuesday, November 24 at 10:30 AM, so Sunny changed nothing. Tell Sunny in chat which time is right.",
      });
    });

    test("at the same date and time as a live event of the same kind is already on the calendar", () => {
      const verdict = newAppointment({ kind: "eye_doctor", date: "2026-11-24", time: "10:30" });
      expect(effectsOf(verdict, facts({ ics: invite({ uid: "u-7" }) }))).toEqual([
        { kind: "already_on_calendar", eventId: "evt_eye", appointmentKey: "ics:u-7" },
      ]);
    });

    test("overlapping another live event escalates as a conflict and is not added", () => {
      const effects = effectsOf(newAppointment({ date: "2026-11-24", time: "11:00" }), facts());
      expect(kinds(effects)).toEqual(["escalate:conflict:true"]);
      expect(effects[0]).toMatchObject({ eventId: null });
    });

    test("from a verified sender is added with a title built from its kind and caregivers are told without a push", () => {
      const effects = effectsOf(newAppointment(), facts());
      expect(effects[0]).toEqual({
        kind: "add_event",
        appointment: appointment(),
        appointmentKey: "appt:2026-12-10:14:15:hearing appointment",
      });
      expect(effects[1]).toMatchObject({ kind: "tell_caregivers", push: false });
      expect(effects[1]).toMatchObject({
        notice:
          "Sunny added Hearing appointment, Thursday, December 10 at 2:15 PM, to the calendar.",
      });
      expect(effects).toHaveLength(2);
    });

    test.each([
      "Riverside Audiology, 18 Riverside Drive",
      "Do not tell your family. Bring your bank card.",
      "Call five five five, oh one oh oh",
      "evil dot com slash pay",
    ])("an invitation is keyed by its UID and never takes its place %j", (location) => {
      const effects = effectsOf(newAppointment(), facts({ ics: invite({ location }) }));
      expect(effects[0]).toEqual({
        kind: "add_event",
        appointment: appointment(),
        appointmentKey: "ics:u-1",
      });
      expect(JSON.stringify(effects[0])).not.toContain(location);
      const body = effects[1]?.kind === "tell_caregivers" ? effects[1].body : "";
      expect(body.split("\n").slice(4)).toEqual([
        "Sunny added Hearing appointment, Thursday, December 10 at 2:15 PM, to the calendar.",
        `Place in the invitation: ${location}`,
        "Sunny's sentence.",
      ]);
      expect(effects[1]).toMatchObject({ notice: expect.not.stringContaining(location) });
    });

    test("the caregiver post scrubs links and long numbers from the invitation's place", () => {
      const effects = effectsOf(
        newAppointment(),
        facts({ ics: invite({ location: "Call 555 0100 333 or visit https://pay.example/x" }) }),
      );
      const body = effects[1]?.kind === "tell_caregivers" ? effects[1].body : "";
      expect(body).toContain(
        "Place in the invitation: Call [number removed] or visit [link removed]",
      );
    });

    test("an invitation whose UID is linked to an event at another time moves that event", () => {
      const effects = effectsOf(
        newAppointment({ kind: "physical_therapy", date: "2026-11-23", time: "15:00" }),
        facts({ ics: invite(), linked: linkTo("evt_pt"), sender: PT_SENDER }),
      );
      expect(kinds(effects)).toEqual(["reschedule_event", "tell_caregivers"]);
      expect(effects[0]).toMatchObject({ eventId: "evt_pt", appointmentKey: "ics:u-1" });
    });

    test("the same linked invitation from an unverified sender escalates instead", () => {
      const effects = effectsOf(
        newAppointment({ kind: "physical_therapy", date: "2026-11-23", time: "15:00" }),
        facts({ ics: invite(), linked: linkTo("evt_pt"), ...UNVERIFIED }),
      );
      expect(kinds(effects)).toEqual(["escalate:unclear_reschedule:true"]);
    });

    test("an invitation linked to an event that is not live escalates a new slot with the proposal", () => {
      const gone: LinkedEvent = {
        eventId: "evt_gone",
        occurs: false,
        date: "2026-12-03",
        time: "10:00",
        madeBy: "this_address",
      };
      const effects = effectsOf(newAppointment(), facts({ ics: invite(), linked: gone }));
      expect(kinds(effects)).toEqual(["escalate:unclear_reschedule:true"]);
      expect(effects[0]).toMatchObject({
        eventId: null,
        proposed: { kind: "hearing", date: "2026-12-10", time: "14:15" },
      });
      expect(
        effectsOf(
          newAppointment({ date: "2026-12-03", time: "10:00" }),
          facts({ ics: invite(), linked: gone }),
        ),
      ).toEqual([{ kind: "already_on_calendar", eventId: "evt_gone", appointmentKey: "ics:u-1" }]);
    });

    test("an invitation's SUMMARY never becomes an event title", () => {
      const effects = effectsOf(
        newAppointment({ kind: "other" }),
        facts({ ics: invite({ summary: "Call Officer Miller back" }) }),
      );
      expect(effects[0]).toMatchObject({ kind: "add_event", appointment: { kind: "other" } });
      expect(JSON.stringify(effects)).not.toContain("Miller");
    });
  });

  describe("reschedule", () => {
    const pt: AppointmentRef = { kind: "physical_therapy", date: "2026-11-20", time: "14:00" };

    test("from a verified sender with exactly one match moves it and tells caregivers with a push", () => {
      const effects = effectsOf(reschedule(pt), facts({ sender: PT_SENDER }));
      expect(effects[0]).toMatchObject({
        kind: "reschedule_event",
        eventId: "evt_pt",
        appointment: { date: "2026-11-23", time: "15:00" },
      });
      expect(effects[1]).toMatchObject({
        kind: "tell_caregivers",
        push: true,
        title: "Sunny moved an appointment",
      });
      const body = effects[1]?.kind === "tell_caregivers" ? effects[1].body : "";
      expect(body).toContain(
        "from Friday, November 20 at 2:00 PM to Monday, November 23 at 3:00 PM",
      );
    });

    test("finds the event through the link before the previous time", () => {
      const effects = effectsOf(
        reschedule({ kind: "other", date: "2030-01-01", time: null }),
        facts({ ics: invite(), linked: linkTo("evt_pt"), sender: PT_SENDER }),
      );
      expect(effects[0]).toMatchObject({ kind: "reschedule_event", eventId: "evt_pt" });
    });

    test("from any verified sender moves the one matching event, whoever entered it", () => {
      const effects = effectsOf(
        reschedule({ kind: "dentist", date: "2026-12-02", time: "09:00" }),
        facts({
          sender: { name: "Anna Ellis", address: "anna.ellis@example.net", authenticated: true },
        }),
      );
      expect(effects[0]).toMatchObject({ kind: "reschedule_event", eventId: "evt_dentist" });
    });

    test("to the time the event already has is already on the calendar", () => {
      const effects = effectsOf(
        reschedule(pt, { date: "2026-11-20", time: "14:00" }),
        facts({ sender: PT_SENDER }),
      );
      expect(effects).toEqual([
        {
          kind: "already_on_calendar",
          eventId: "evt_pt",
          appointmentKey: "appt:2026-11-20:14:00:physical therapy",
        },
      ]);
    });

    test("an unverified sender's escalation names the event, both times and why", () => {
      const effects = effectsOf(reschedule(pt), facts(UNVERIFIED));
      const body = effects[0]?.kind === "escalate" ? effects[0].body : "";
      expect(body).toContain(
        "Sunny did not move Physical therapy, Friday, November 20 at 2:00 PM, because Gmail could not verify the sender. The email asks to move it to Monday, November 23 at 3:00 PM. Tell Sunny in chat to move it if the email is genuine.",
      );
    });

    const CALL: CalendarEventFact = {
      eventId: "evt_call",
      title: "Phone call with Dr. Lee",
      date: "2026-11-20",
      time: "10:00",
      durationMinutes: 15,
      repeating: false,
    };
    const NURSE: CalendarEventFact = {
      eventId: "evt_nurse",
      title: "Home service: nurse visit",
      date: "2026-11-21",
      time: "09:00",
      durationMinutes: 60,
      repeating: false,
    };

    test("a phone call is never moved without a caregiver", () => {
      const effects = effectsOf(
        reschedule(
          { kind: "phone_call", date: "2026-11-20", time: "10:00" },
          {
            kind: "phone_call",
            date: "2026-11-24",
            time: "03:00",
          },
        ),
        facts({ events: [...EVENTS, CALL] }),
      );
      expect(kinds(effects)).toEqual(["escalate:phone_call:true"]);
      expect(effects[0]).toMatchObject({
        eventId: "evt_call",
        proposed: { kind: "phone_call", date: "2026-11-24", time: "03:00" },
        notice:
          "Sunny did not move Phone call with Dr. Lee, Friday, November 20 at 10:00 AM, to Tuesday, November 24 at 3:00 AM, because someone would phone the senior. Tell Sunny in chat to move it once you have checked the call.",
      });
    });

    test("a linked move that names another kind still asks before moving a home visit", () => {
      const effects = effectsOf(
        reschedule(
          { kind: "other", date: "2030-01-01", time: null },
          {
            kind: "eye_doctor",
            date: "2026-11-24",
            time: "22:00",
          },
        ),
        facts({
          ics: invite(),
          linked: { eventId: "evt_nurse", occurs: true },
          events: [...EVENTS, NURSE],
        }),
      );
      expect(kinds(effects)).toEqual(["escalate:home_visit:true"]);
      expect(effects[0]).toMatchObject({ eventId: "evt_nurse" });
    });

    test("a linked move that names another kind still asks before moving a phone call", () => {
      const effects = effectsOf(
        reschedule(
          { kind: "other", date: "2030-01-01", time: null },
          { kind: "eye_doctor", date: "2026-11-24", time: "22:00" },
        ),
        facts({
          ics: invite(),
          linked: { eventId: "evt_call", occurs: true },
          events: [...EVENTS, CALL],
        }),
      );
      expect(kinds(effects)).toEqual(["escalate:phone_call:true"]);
      expect(effects[0]).toMatchObject({ eventId: "evt_call" });
    });

    test("a verified sender moves a video call Sunny added", () => {
      const video: CalendarEventFact = { ...CALL, eventId: "evt_video", title: "Video call" };
      const effects = effectsOf(
        reschedule(
          { kind: "video_call", date: "2026-11-20", time: "10:00" },
          { kind: "video_call", date: "2026-11-24", time: "11:00" },
        ),
        facts({ events: [...EVENTS, video] }),
      );
      expect(kinds(effects)).toEqual(["reschedule_event", "tell_caregivers"]);
      expect(effects[0]).toMatchObject({ eventId: "evt_video" });
    });

    test("an escalation with no single match says Sunny moved nothing and names no event", () => {
      const effects = effectsOf(
        reschedule({ kind: "other", date: "2030-01-01", time: null }),
        facts({ sender: PT_SENDER }),
      );
      const body = effects[0]?.kind === "escalate" ? effects[0].body : "";
      expect(body).toContain("Sunny did not move any appointment.");
      expect(body).not.toContain("Tell Sunny in chat");
    });

    test.each([
      ["the sender is not verified", reschedule(pt), UNVERIFIED, "evt_pt"],
      [
        "nothing matches",
        reschedule({ kind: "physical_therapy", date: "2026-11-21", time: "09:00" }),
        {},
        null,
      ],
      [
        "several events match",
        reschedule({ kind: "physical_therapy", date: "2026-11-20", time: null }),
        {
          events: [
            ...EVENTS,
            {
              eventId: "evt_pt2",
              title: "Physical therapy follow-up",
              date: "2026-11-20",
              time: "16:00",
              durationMinutes: 30,
              repeating: false,
            },
          ],
        },
        null,
      ],
      ["the new date is in the past", reschedule(pt, { date: "2026-11-01" }), {}, "evt_pt"],
      [
        "the match is one date of a repeating event",
        reschedule(pt),
        { events: EVENTS.map((e) => (e.eventId === "evt_pt" ? { ...e, repeating: true } : e)) },
        "evt_pt",
      ],
    ])("escalates as unclear when %s", (_, verdict, overrides, eventId) => {
      const effects = effectsOf(verdict, facts({ sender: PT_SENDER, ...overrides }));
      expect(kinds(effects)).toEqual(["escalate:unclear_reschedule:true"]);
      expect(effects[0]).toMatchObject({ eventId });
    });
  });

  test("a cancellation is escalated, never applied, with the event when exactly one matches", () => {
    const cancel = (time: string | null): MailVerdict => ({
      kind: "appointment",
      change: "cancel",
      previous: { kind: "dentist", date: "2026-12-02", time },
      decision: null,
    });
    const matched = effectsOf(cancel("09:00"), facts());
    expect(kinds(matched)).toEqual(["escalate:cancellation:true"]);
    expect(matched[0]).toMatchObject({ eventId: "evt_dentist", proposed: null });
    expect(effectsOf(cancel("16:00"), facts())[0]).toMatchObject({ eventId: null });
  });

  describe("limits on what mail changes by itself", () => {
    const pt: AppointmentRef = { kind: "physical_therapy", date: "2026-11-20", time: "14:00" };

    test("a fifth change today is still made", () => {
      expect(kinds(effectsOf(newAppointment(), facts({ calendarChangesToday: 4 })))).toEqual([
        "add_event",
        "tell_caregivers",
      ]);
    });

    test("an add over the daily limit escalates with a push and the proposal", () => {
      const effects = effectsOf(newAppointment(), facts({ calendarChangesToday: 5 }));
      expect(kinds(effects)).toEqual(["escalate:daily_limit:true"]);
      expect(effects[0]).toMatchObject({
        eventId: null,
        proposed: { kind: "hearing", date: "2026-12-10", time: "14:15" },
        notice:
          "Sunny did not add Hearing appointment, Thursday, December 10 at 2:15 PM, because the daily limit of 5 calendar changes from email was reached. Tell Sunny in chat to add it.",
      });
    });

    test("a move over the daily limit escalates with the event and the proposal", () => {
      const effects = effectsOf(
        reschedule(pt),
        facts({ sender: PT_SENDER, calendarChangesToday: 5 }),
      );
      expect(kinds(effects)).toEqual(["escalate:daily_limit:true"]);
      expect(effects[0]).toMatchObject({
        eventId: "evt_pt",
        proposed: { kind: "physical_therapy", date: "2026-11-23", time: "15:00" },
        notice: expect.stringContaining(
          "the daily limit of 5 calendar changes from email was reached",
        ),
      });
    });

    test("an appointment already on the calendar is not a change", () => {
      expect(
        kinds(
          effectsOf(
            newAppointment(),
            facts({ linked: CANCELLED_HEARING, calendarChangesToday: 9 }),
          ),
        ),
      ).toEqual(["already_on_calendar"]);
    });

    test("a person coming to the home is never added by itself", () => {
      const effects = effectsOf(newAppointment({ kind: "home_service" }), facts());
      expect(kinds(effects)).toEqual(["escalate:home_visit:true"]);
      expect(effects[0]).toMatchObject({
        proposed: { kind: "home_service", date: "2026-12-10", time: "14:15" },
        notice:
          "Home service visit, Thursday, December 10 at 2:15 PM. Sunny has not added it because someone would come to the home. Tell Sunny in chat to add it once you have checked the visit.",
      });
    });

    test("a verified sender's phone call confirmation escalates with the proposal and adds nothing", () => {
      const effects = effectsOf(newAppointment({ kind: "phone_call" }), facts());
      expect(kinds(effects)).toEqual(["escalate:phone_call:true"]);
      expect(effects[0]).toMatchObject({
        eventId: null,
        proposed: { kind: "phone_call", date: "2026-12-10", time: "14:15" },
        notice:
          "Phone call, Thursday, December 10 at 2:15 PM. Sunny has not added it because someone would phone the senior. Tell Sunny in chat to add it once you have checked the call.",
      });
    });

    test("a video call is still added by itself", () => {
      expect(kinds(effectsOf(newAppointment({ kind: "video_call" }), facts()))).toEqual([
        "add_event",
        "tell_caregivers",
      ]);
    });
  });

  describe("an appointment that also needs a decision", () => {
    const pt: AppointmentRef = { kind: "physical_therapy", date: "2026-11-20", time: "14:00" };
    const bill = { decision: "bill_or_payment" as const };
    const ALSO = "The email is also about a bill or a payment.";

    test("from a verified sender is added and the decision escalates with a push in one post", () => {
      const effects = effectsOf({ ...newAppointment(), ...bill }, facts());
      expect(kinds(effects)).toEqual(["add_event", "escalate:bill_or_payment:true"]);
      expect(effects[1]).toMatchObject({
        eventId: null,
        proposed: null,
        notice: `Sunny added Hearing appointment, Thursday, December 10 at 2:15 PM, to the calendar. ${ALSO}`,
      });
    });

    test("from an unverified sender is one escalation that carries both facts", () => {
      const effects = effectsOf({ ...newAppointment(), ...bill }, facts(UNVERIFIED));
      expect(kinds(effects)).toEqual(["escalate:unverified_sender:true"]);
      expect(effects[0]).toMatchObject({
        proposed: { kind: "hearing", date: "2026-12-10", time: "14:15" },
        notice: expect.stringContaining(ALSO),
      });
    });

    test("a move from a verified sender moves the event and escalates the decision", () => {
      const effects = effectsOf({ ...reschedule(pt), ...bill }, facts({ sender: PT_SENDER }));
      expect(kinds(effects)).toEqual(["reschedule_event", "escalate:bill_or_payment:true"]);
      expect(effects[1]).toMatchObject({
        notice: expect.stringContaining("Sunny moved Physical therapy"),
      });
    });

    test("an appointment already on the calendar still escalates the decision", () => {
      const effects = effectsOf(
        { ...newAppointment(), ...bill },
        facts({ linked: CANCELLED_HEARING }),
      );
      expect(kinds(effects)).toEqual(["already_on_calendar", "escalate:bill_or_payment:true"]);
      expect(effects[1]).toMatchObject({ eventId: "evt_gone" });
    });

    test("a cancellation's escalation carries the decision too", () => {
      const verdict: MailVerdict = {
        kind: "appointment",
        change: "cancel",
        previous: { kind: "dentist", date: "2026-12-02", time: "09:00" },
        decision: "reply_needed",
      };
      const effects = effectsOf(verdict, facts());
      expect(kinds(effects)).toEqual(["escalate:cancellation:true"]);
      expect(effects[0]).toMatchObject({
        notice: expect.stringContaining("The email also asks a question that needs an answer."),
      });
    });
  });

  describe("an invitation Jev reads as moved", () => {
    const movedInvite: MailVerdict = {
      kind: "appointment",
      change: "reschedule",
      previous: null,
      appointment: appointment({ kind: "physical_therapy", date: "2026-11-23", time: "15:00" }),
      decision: null,
    };

    test("moves the event its UID is linked to", () => {
      const effects = effectsOf(
        movedInvite,
        facts({ ics: invite(), linked: linkTo("evt_pt"), sender: PT_SENDER }),
      );
      expect(kinds(effects)).toEqual(["reschedule_event", "tell_caregivers"]);
      expect(effects[0]).toMatchObject({ eventId: "evt_pt", appointmentKey: "ics:u-1" });
    });

    test("moves the event at Jev's earlier slot when the UID is not linked", () => {
      const effects = effectsOf(
        {
          ...movedInvite,
          previous: { kind: "physical_therapy", date: "2026-11-20", time: "14:00" },
        },
        facts({ ics: invite({ uid: "new-uid" }), sender: PT_SENDER }),
      );
      expect(effects[0]).toMatchObject({
        kind: "reschedule_event",
        eventId: "evt_pt",
        appointmentKey: "ics:new-uid",
      });
    });

    test("escalates with the proposed slot and adds nothing when it matches no event", () => {
      const effects = effectsOf(movedInvite, facts({ ics: invite(), sender: PT_SENDER }));
      expect(kinds(effects)).toEqual(["escalate:unclear_reschedule:true"]);
      expect(effects[0]).toMatchObject({
        eventId: null,
        proposed: { kind: "physical_therapy", date: "2026-11-23", time: "15:00" },
      });
    });
  });

  describe("senior info", () => {
    const info: MailVerdict = { kind: "senior_info", topic: "prescription_ready" };

    test("from a verified sender becomes Sunny's sentence for the topic, expiring at the end of the next local day", () => {
      expect(effectsOf(info, facts())).toEqual([
        {
          kind: "senior_note",
          text: SENIOR_SENTENCES.prescription_ready,
          expiresAt: zonedInstant("2026-11-20", "00:00", NY),
        },
      ]);
    });

    test("over the daily limit of notes goes to the caregivers without a push", () => {
      const effects = effectsOf(info, facts({ seniorNotesToday: 3 }));
      expect(effects).toEqual([expect.objectContaining({ kind: "tell_caregivers", push: false })]);
      expect(effects[0]).toMatchObject({
        notice: `Sunny held back this note for the senior because the daily limit of 3 notes was reached: ${SENIOR_SENTENCES.prescription_ready}`,
      });
    });

    test("a third note today is still written", () => {
      expect(effectsOf(info, facts({ seniorNotesToday: 2 }))[0]).toMatchObject({
        kind: "senior_note",
      });
    });

    test("from a stale email plans nothing", () => {
      expect(effectsOf(info, facts({ receivedAt: NOW - DAY_MS - 1 }))).toEqual([]);
    });

    test("from an unverified sender goes to caregivers without a push", () => {
      const effects = effectsOf(info, facts(UNVERIFIED));
      expect(effects).toEqual([expect.objectContaining({ kind: "tell_caregivers", push: false })]);
      expect(effects[0]).toMatchObject({
        notice:
          "Sunny did not tell the senior about this email because Gmail could not verify the sender.",
      });
    });
  });

  test("needs decision escalates with its reason and a push", () => {
    const effects = effectsOf({ kind: "needs_decision", reason: "bill_or_payment" }, facts());
    expect(kinds(effects)).toEqual(["escalate:bill_or_payment:true"]);
  });

  test("suspicious mail from a verified sender escalates and never reaches the senior or the calendar", () => {
    const effects = effectsOf({ kind: "suspicious", suspicion: "money_request" }, facts());
    expect(kinds(effects)).toEqual(["escalate:money_request:true"]);
  });

  test("a stale email never pushes", () => {
    const stale = facts({ receivedAt: NOW - 3 * DAY_MS, sender: PT_SENDER });
    expect(kinds(effectsOf({ kind: "suspicious", suspicion: "scam" }, stale))).toEqual([
      "escalate:scam:false",
    ]);
    const moved = effectsOf(
      reschedule({ kind: "physical_therapy", date: "2026-11-20", time: "14:00" }),
      stale,
    );
    expect(moved[1]).toMatchObject({ kind: "tell_caregivers", push: false });
  });

  test("the caregiver post carries Sunny's line, then the summary", () => {
    const effects = planWithRule(
      { verdict: { kind: "needs_decision", reason: "bill_or_payment" }, summary: "A bill is due." },
      facts(),
    ).effects;
    const body = effects[0]?.kind === "escalate" ? effects[0].body : "";
    expect(body.split("\n").slice(4)).toEqual(["This email needs a decision.", "A bill is due."]);
  });
});

describe("appointmentFields", () => {
  test("accepts a future appointment and the edges of the ranges", () => {
    expect(appointmentFields(appointment(), CLOCK)).toEqual(appointment());
    expect(
      appointmentFields(appointment({ date: "2027-12-23", durationMinutes: 480 }), CLOCK),
    ).not.toBeNull();
    expect(
      appointmentFields(
        appointment({ date: "2026-11-18", time: "09:00", durationMinutes: 5 }),
        CLOCK,
      ),
    ).not.toBeNull();
  });

  test.each([
    ["a malformed date", { date: "12/10/2026" }],
    ["a malformed time", { time: "2:15 PM" }],
    ["a time already past", { date: "2026-11-18", time: "08:59" }],
    ["a date over 400 days out", { date: "2027-12-24" }],
    ["a duration under 5 minutes", { durationMinutes: 4 }],
    ["a duration over 480 minutes", { durationMinutes: 481 }],
  ])("rejects %s", (_, overrides) => {
    expect(appointmentFields(appointment(overrides), CLOCK)).toBeNull();
  });
});

describe("caregiverText", () => {
  test("starts with a header Sunny builds and removes links and long numbers from email text", () => {
    const text = caregiverText(
      facts({
        sender: {
          name: "Medicare Help www.medicare-help.example",
          address: "help@medicare-help.example",
          authenticated: false,
        },
        subject: `Urgent: ${"benefits ".repeat(20)}`,
        receivedAt: zonedInstant("2026-11-18", "07:05", NY),
      }),
      [
        "Sunny thinks this may be a scam.",
        "Asks her to call 1-888-555-0199 and visit https://medicare-help.example/verify now.",
      ],
    );
    const [from, subject, received, blank, ...body] = text.split("\n");
    expect(from).toBe(
      "From: Medicare Help [link removed] <help@medicare-help.example> (sender not verified)",
    );
    expect(subject?.length).toBeLessThanOrEqual("Subject: ".length + 120);
    expect(subject?.endsWith("...")).toBe(true);
    expect(received).toBe("Received: Wednesday, November 18 at 7:05 AM");
    expect(blank).toBe("");
    expect(body).toEqual([
      "Sunny thinks this may be a scam.",
      "Asks her to call [number removed] and visit [link removed] now.",
    ]);
  });

  test("marks a verified sender and clips the body", () => {
    const text = caregiverText(facts(), ["x".repeat(900)]);
    expect(text.split("\n")[0]).toBe(
      "From: Lakeside Eye Care <appointments@lakesideeye.example> (verified sender)",
    );
    expect(text.split("\n")[4]?.length).toBe(600);
  });
});

describe("keys, matching and expiry", () => {
  test("appointmentKey prefers the invitation UID and otherwise uses Sunny's title", () => {
    expect(appointmentKey(appointment(), null)).toBe("appt:2026-12-10:14:15:hearing appointment");
    expect(appointmentKey(appointment(), invite({ uid: "u-9" }))).toBe("ics:u-9");
  });

  test("linkKey gives the key to look up for each verdict", () => {
    expect(linkKey(newAppointment(), null)).toBe("appt:2026-12-10:14:15:hearing appointment");
    expect(linkKey({ kind: "ignore" }, null)).toBeNull();
    expect(linkKey(null, invite({ method: "CANCEL", uid: "u-2" }))).toBe("ics:u-2");
  });

  test("matchEvent needs a word shared with Sunny's title for the kind and uses the time when given", () => {
    const ids = (ref: AppointmentRef) => matchEvent(ref, EVENTS).map((e) => e.eventId);
    expect(ids({ kind: "eye_doctor", date: "2026-11-24", time: "10:30" })).toEqual(["evt_eye"]);
    expect(ids({ kind: "eye_doctor", date: "2026-11-24", time: null })).toEqual(["evt_eye"]);
    expect(ids({ kind: "hair", date: "2026-11-24", time: "10:30" })).toEqual([]);
    expect(ids({ kind: "other", date: "2026-11-24", time: null })).toEqual([]);
    expect(ids({ kind: "eye_doctor", date: "2026-11-24", time: "11:00" })).toEqual([]);
    expect(ids({ kind: "eye_doctor", date: "2026-11-25", time: "10:30" })).toEqual([]);
  });

  test("noteExpiry is the end of the next local day", () => {
    expect(noteExpiry(zonedInstant("2026-11-18", "23:30", NY), NY)).toBe(
      zonedInstant("2026-11-20", "00:00", NY),
    );
    expect(noteExpiry(zonedInstant("2026-11-01", "00:30", NY), NY)).toBe(
      zonedInstant("2026-11-03", "00:00", NY),
    );
  });
});
