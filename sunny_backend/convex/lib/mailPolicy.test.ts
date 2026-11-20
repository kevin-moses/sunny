import { describe, expect, test } from "vitest";
import { planWithRule } from "./mailPolicy";
import {
  EVENTS,
  NOW,
  NY,
  appointment,
  facts,
  invite,
  kinds,
  newAppointment,
  planOf,
} from "./mailPolicyFixtures.helpers";
import { SENIOR_SENTENCES } from "./mailTypes";
import { noteExpiry } from "./seniorNotes";
import type {
  Appointment,
  AppointmentRef,
  CalendarEventFact,
  LinkedEvent,
  MailEffect,
  MailVerdict,
  PolicyFacts,
} from "./mailTypes";
import { DAY_MS, zonedInstant } from "./time";

const UNVERIFIED = { sender: { name: "x", address: "x@x.example", authenticated: false } };

const PT_SENDER = {
  name: "Riverside Physical Therapy",
  address: "frontdesk@riversidept.example",
  authenticated: true,
};

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
  return planOf(verdict, policyFacts).effects;
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
        const { rule, effects } = planOf(
          newAppointment({ kind: "eye_doctor", date: "2026-11-24", time: "10:30" }),
          facts({ ...UNVERIFIED, ...overrides }),
        );
        expect(rule).toBe("new-unverified-sender");
        expect(effects).toMatchObject([
          {
            kind: "escalate",
            reason: "unverified_sender",
            push: true,
            eventId: null,
            proposed: { kind: "eye_doctor", date: "2026-11-24", time: "10:30" },
          },
        ]);
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
      expect(body.split("\n")).toEqual([
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
      const { rule, effects } = planOf(newAppointment(), facts({ ics: invite(), linked: gone }));
      expect(rule).toBe("reschedule-no-match");
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

    const HOSTILE = invite({
      uid: "verify-1@benefits-desk.example",
      start: { date: "2026-11-19", time: "10:00" },
      durationMinutes: 30,
      summary: "Call Officer Miller back",
      location: "Kiosk 4",
    });

    test("a hostile invitation from a verified sender adds only the kind, slot and UID", () => {
      const { rule, effects } = planOf(
        newAppointment({ kind: "meeting", date: "2026-11-19", time: "10:00", durationMinutes: 30 }),
        facts({ ics: HOSTILE }),
      );
      expect(rule).toBe("new-add");
      expect(effects[0]).toEqual({
        kind: "add_event",
        appointment: { kind: "meeting", date: "2026-11-19", time: "10:00", durationMinutes: 30 },
        appointmentKey: "ics:verify-1@benefits-desk.example",
      });
      expect(effects[1]).toMatchObject({ kind: "tell_caregivers", push: false });
      expect(JSON.stringify(effects[0])).not.toMatch(/Miller|Kiosk/);
    });

    test("a phone call invitation from a verified sender asks the caregivers and adds nothing", () => {
      const { rule, effects } = planOf(
        newAppointment({
          kind: "phone_call",
          date: "2026-11-19",
          time: "10:00",
          durationMinutes: 30,
        }),
        facts({ ics: HOSTILE }),
      );
      expect(rule).toBe("new-caregiver-confirms");
      expect(effects).toMatchObject([
        {
          kind: "escalate",
          reason: "phone_call",
          push: true,
          eventId: null,
          proposed: { kind: "phone_call", date: "2026-11-19", time: "10:00" },
          notice:
            "Phone call, Thursday, November 19 at 10:00 AM. Sunny has not added it because someone would phone the senior. Tell Sunny in chat to add it once you have checked the call.",
        },
      ]);
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
      const { rule, effects } = planOf(
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
      expect(rule).toBe("reschedule-caregiver-confirms");
      expect(kinds(effects)).toEqual(["escalate:phone_call:true"]);
      expect(effects[0]).toMatchObject({
        eventId: "evt_call",
        proposed: { kind: "phone_call", date: "2026-11-24", time: "03:00" },
        notice:
          "Sunny did not move Phone call with Dr. Lee, Friday, November 20 at 10:00 AM, to Tuesday, November 24 at 3:00 AM, because someone would phone the senior. Tell Sunny in chat to move it once you have checked the call.",
      });
    });

    test.each([
      [
        "a phone call",
        CALL,
        { kind: "phone_call", date: "2026-11-24", time: "03:00" },
        "escalate:phone_call:true",
      ],
      [
        "a home visit",
        NURSE,
        { kind: "home_service", date: "2026-11-25", time: "22:00" },
        "escalate:home_visit:true",
      ],
    ] as const)(
      "a stranger's verified move of %s asks the caregivers and moves nothing",
      (_, event, to, escalation) => {
        const { rule, effects } = planOf(
          reschedule({ kind: to.kind, date: event.date, time: event.time }, to),
          facts({
            sender: { name: "Desk", address: "events@attacker.example", authenticated: true },
            events: [...EVENTS, event],
          }),
        );
        expect(rule).toBe("reschedule-caregiver-confirms");
        expect(kinds(effects)).toEqual([escalation]);
        expect(effects[0]).toMatchObject({ eventId: event.eventId, proposed: to });
      },
    );

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
      const { rule, effects } = planOf(
        reschedule(
          { kind: "video_call", date: "2026-11-20", time: "10:00" },
          { kind: "video_call", date: "2026-11-24", time: "11:00" },
        ),
        facts({ events: [...EVENTS, video] }),
      );
      expect(rule).toBe("reschedule-move");
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
      const { rule, effects } = planOf(
        {
          ...movedInvite,
          previous: { kind: "physical_therapy", date: "2026-11-20", time: "14:00" },
        },
        facts({ ics: invite({ uid: "new-uid" }), sender: PT_SENDER }),
      );
      expect(rule).toBe("reschedule-move");
      expect(kinds(effects)).toEqual(["reschedule_event", "tell_caregivers"]);
      expect(effects[0]).toMatchObject({
        kind: "reschedule_event",
        eventId: "evt_pt",
        appointmentKey: "ics:new-uid",
      });
    });

    test("escalates with the proposed slot and adds nothing when it matches no event", () => {
      const { rule, effects } = planOf(movedInvite, facts({ ics: invite(), sender: PT_SENDER }));
      expect(rule).toBe("reschedule-no-match");
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
      const { rule, effects } = planOf(info, facts(UNVERIFIED));
      expect(rule).toBe("senior-info-unverified-sender");
      expect(effects).toEqual([expect.objectContaining({ kind: "tell_caregivers", push: false })]);
      expect(effects[0]).toMatchObject({
        notice:
          "Sunny did not tell the senior about this email because Gmail could not verify the sender.",
      });
    });
  });

  test.each(["bill_or_payment", "other"] as const)(
    "needs decision for %s escalates with its reason and a push",
    (reason) => {
      const { rule, effects } = planOf({ kind: "needs_decision", reason }, facts());
      expect(rule).toBe("needs-decision");
      expect(effects).toMatchObject([
        { kind: "escalate", reason, push: true, eventId: null, proposed: null },
      ]);
    },
  );

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
    expect(body.split("\n")).toEqual(["This email needs a decision.", "A bill is due."]);
  });
});

describe("noteExpiry", () => {
  test("is the end of the next local day", () => {
    expect(noteExpiry(zonedInstant("2026-11-18", "23:30", NY), NY)).toBe(
      zonedInstant("2026-11-20", "00:00", NY),
    );
    expect(noteExpiry(zonedInstant("2026-11-01", "00:30", NY), NY)).toBe(
      zonedInstant("2026-11-03", "00:00", NY),
    );
  });
});
