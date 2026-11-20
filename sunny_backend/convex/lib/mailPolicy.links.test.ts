import { describe, expect, test } from "vitest";
import type { LinkFact } from "./mailFacts";
import {
  CLINIC,
  NOW,
  NY,
  factsFrom,
  invite,
  newAppointment,
  planOf,
} from "./mailPolicyFixtures.helpers";
import type { CalendarEventFact, MailSender, MailVerdict } from "./mailTypes";
import { DAY_MS, MINUTE_MS } from "./time";

const STRANGER: MailSender = {
  name: "Desk",
  address: "events@attacker.example",
  authenticated: true,
};

function from(sender: MailSender, receivedAt = NOW - 30 * MINUTE_MS) {
  return { header: { sender, subject: "Invitation", receivedAt } };
}

function live(eventId: string, senderAddress = CLINIC.address): LinkFact {
  return { eventId, senderAddress, event: { occurs: true } };
}

function over(
  eventId: string,
  date: string,
  time: string,
  senderAddress = CLINIC.address,
): LinkFact {
  return { eventId, senderAddress, event: { occurs: false, date, time } };
}

function fact(
  eventId: string,
  title: string,
  date: string,
  time: string,
  repeating = false,
): CalendarEventFact {
  return { eventId, title, date, time, durationMinutes: 30, repeating };
}

const EYE_EXAM = newAppointment({
  kind: "eye_doctor",
  date: "2026-12-10",
  time: "14:15",
  durationMinutes: null,
});

const EYE_EXAM_KEY = "appt:2026-12-10:14:15:eye exam";

describe("an appointment on a weekly series", () => {
  const series = fact("evt_series", "Eye exam", "2026-12-10", "14:15", true);

  test("a confirmation of one of its dates is already on the calendar", () => {
    expect(planOf(EYE_EXAM, factsFrom({ events: [series] }))).toEqual({
      rule: "new-on-calendar",
      effects: [
        { kind: "already_on_calendar", eventId: "evt_series", appointmentKey: EYE_EXAM_KEY },
      ],
    });
  });

  test("an appointment that overlaps one of its dates escalates as a conflict", () => {
    const { rule, effects } = planOf(
      newAppointment({ date: "2026-12-10", time: "14:30", durationMinutes: null }),
      factsFrom({ events: [series] }),
    );
    expect(rule).toBe("new-conflict");
    expect(effects).toMatchObject([
      {
        kind: "escalate",
        reason: "conflict",
        push: true,
        eventId: null,
        proposed: { kind: "hearing", date: "2026-12-10", time: "14:30" },
        notice:
          "Sunny did not add Hearing appointment, Thursday, December 10 at 2:30 PM, because it overlaps Eye exam at 2:15 PM.",
      },
    ]);
  });
});

describe("links belong to the sender's domain", () => {
  const handEntered = fact("evt_eye", "Eye exam with Dr. Rivera", "2026-12-10", "14:15");
  const phoneCall = fact("evt_call", "Phone call", "2026-12-10", "14:15");

  test("a stranger's linked update that claims a phone call asks before moving the event", () => {
    const { rule, effects } = planOf(
      newAppointment({ kind: "phone_call", date: "2026-12-10", time: "22:00" }),
      factsFrom({
        ...from(STRANGER),
        ics: invite({ uid: "evil-1@attacker.example", sequence: 1 }),
        events: [handEntered],
        link: live("evt_eye", STRANGER.address),
      }),
    );
    expect(rule).toBe("reschedule-caregiver-confirms");
    expect(effects).toMatchObject([
      {
        kind: "escalate",
        reason: "phone_call",
        push: true,
        eventId: "evt_eye",
        proposed: { kind: "phone_call", date: "2026-12-10", time: "22:00" },
      },
    ]);
  });

  test("a stranger's invite at the slot of a phone call is already on the calendar", () => {
    expect(
      planOf(
        newAppointment({ kind: "phone_call", date: "2026-12-10", time: "14:15" }),
        factsFrom({
          ...from(STRANGER),
          ics: invite({ uid: "evil-2@attacker.example" }),
          events: [phoneCall],
        }),
      ),
    ).toEqual({
      rule: "new-on-calendar",
      effects: [
        {
          kind: "already_on_calendar",
          eventId: "evt_call",
          appointmentKey: "ics:evil-2@attacker.example",
        },
      ],
    });
  });

  test("a stranger's linked update of a phone call that claims another kind asks", () => {
    const { rule, effects } = planOf(
      newAppointment({ kind: "eye_doctor", date: "2026-12-10", time: "22:00" }),
      factsFrom({
        ...from(STRANGER),
        ics: invite({ uid: "evil-2@attacker.example", sequence: 1 }),
        events: [phoneCall],
        link: live("evt_call", STRANGER.address),
      }),
    );
    expect(rule).toBe("reschedule-caregiver-confirms");
    expect(effects).toMatchObject([
      {
        kind: "escalate",
        reason: "phone_call",
        push: true,
        eventId: "evt_call",
        proposed: { kind: "eye_doctor", date: "2026-12-10", time: "22:00" },
      },
    ]);
  });

  test("a reminder at the time a caregiver moved the clinic's appointment from asks which time is right", () => {
    const { rule, effects } = planOf(
      EYE_EXAM,
      factsFrom({
        events: [fact("evt_added", "Eye exam", "2026-12-11", "09:00")],
        link: live("evt_added"),
      }),
    );
    expect(rule).toBe("new-linked-elsewhere");
    expect(effects).toMatchObject([
      {
        kind: "escalate",
        reason: "unclear_appointment",
        push: true,
        eventId: "evt_added",
        proposed: { kind: "eye_doctor", date: "2026-12-10", time: "14:15" },
        notice:
          "The email gives Eye exam, Thursday, December 10 at 2:15 PM. Sunny's calendar has this appointment on Friday, December 11 at 9:00 AM, so Sunny changed nothing. Tell Sunny in chat which time is right.",
      },
    ]);
  });

  test("a reminder for an appointment a caregiver moved and then cancelled is already on the calendar", () => {
    expect(
      planOf(EYE_EXAM, factsFrom({ events: [], link: over("evt_added", "2026-12-11", "09:00") })),
    ).toEqual({
      rule: "new-on-calendar",
      effects: [
        { kind: "already_on_calendar", eventId: "evt_added", appointmentKey: EYE_EXAM_KEY },
      ],
    });
  });

  test("the clinic's update moves a video call Sunny added from its invite", () => {
    const { rule, effects } = planOf(
      newAppointment({ kind: "video_call", date: "2026-12-12", time: "10:00" }),
      factsFrom({
        ics: invite({ uid: "tele-7@lakesideeye.example", sequence: 1 }),
        events: [fact("evt_video", "Video call", "2026-12-10", "14:15")],
        link: live("evt_video"),
      }),
    );
    expect(rule).toBe("reschedule-move");
    expect(effects).toMatchObject([
      {
        kind: "reschedule_event",
        eventId: "evt_video",
        appointment: { kind: "video_call", date: "2026-12-12", time: "10:00" },
        appointmentKey: "ics:tele-7@lakesideeye.example",
      },
      { kind: "tell_caregivers", push: true, title: "Sunny moved an appointment" },
    ]);
  });

  describe("on a shared mail domain", () => {
    const HELPER: MailSender = {
      name: "Helper",
      address: "someone.else@gmail.com",
      authenticated: true,
    };
    const GMAIL_CLINIC: MailSender = {
      name: "Lakeside Eye",
      address: "lakesideeye@gmail.com",
      authenticated: true,
    };
    const OVER_ELSEWHERE =
      "The email gives Eye exam, Thursday, December 10 at 2:15 PM. An earlier email from another address at the same mail domain gave this appointment, and it is no longer coming up on Sunny's calendar, so Sunny changed nothing. Tell Sunny in chat if it should be added.";
    const askedElsewhere = {
      rule: "new-linked-by-another-address",
      effects: [
        {
          kind: "escalate",
          reason: "unclear_appointment",
          push: true,
          eventId: null,
          proposed: { kind: "eye_doctor", date: "2026-12-10", time: "14:15" },
          notice: OVER_ELSEWHERE,
        },
      ],
    };

    test("a reminder from another address for an appointment one address added, moved and a caregiver cancelled asks", () => {
      const link = over("evt_added", "2026-12-12", "10:00", HELPER.address);
      expect(
        planOf(EYE_EXAM, factsFrom({ ...from(GMAIL_CLINIC), events: [], link })),
      ).toMatchObject(askedElsewhere);
      expect(planOf(EYE_EXAM, factsFrom({ ...from(HELPER), events: [], link }))).toEqual({
        rule: "new-on-calendar",
        effects: [
          { kind: "already_on_calendar", eventId: "evt_added", appointmentKey: EYE_EXAM_KEY },
        ],
      });
    });

    test("an invite from another address at the slot of one a caregiver cancelled asks and adds nothing", () => {
      const plan = planOf(
        EYE_EXAM,
        factsFrom({
          ...from(GMAIL_CLINIC),
          ics: invite({ uid: "visit-42@gmail.com" }),
          events: [],
          link: over("evt_added", "2026-12-10", "14:15", HELPER.address),
        }),
      );
      expect(plan).toMatchObject(askedElsewhere);
    });
  });

  describe("with a hand-entered weekly therapy series", () => {
    const THERAPY = newAppointment({
      kind: "physical_therapy",
      date: "2026-12-01",
      time: "10:00",
      durationMinutes: null,
    });
    const THERAPY_KEY = "appt:2026-12-01:10:00:physical therapy";
    const THERAPY_INVITE = invite({ uid: "therapy-9@lakesideeye.example", sequence: 1 });
    const monday = (time: string) =>
      fact("evt_therapy", "Physical therapy", "2026-11-30", time, true);
    const tuesday = (time: string) =>
      fact("evt_therapy", "Physical therapy", "2026-12-01", time, true);

    test.each([
      ["a second reminder for one of its dates", [tuesday("10:00")], null, THERAPY_KEY],
      [
        "a second reminder for a date the day after another of its dates",
        [monday("10:00"), tuesday("10:00")],
        null,
        THERAPY_KEY,
      ],
      [
        "an invite sent again for a date the day after another of its dates",
        [monday("10:00"), tuesday("10:00")],
        THERAPY_INVITE,
        "ics:therapy-9@lakesideeye.example",
      ],
    ])("a clinic's %s is already on the calendar", (_, events, ics, appointmentKey) => {
      expect(planOf(THERAPY, factsFrom({ ics, events, link: live("evt_therapy") }))).toEqual({
        rule: "new-on-calendar",
        effects: [{ kind: "already_on_calendar", eventId: "evt_therapy", appointmentKey }],
      });
    });

    test("a clinic's second reminder for a date a caregiver moved the series off asks", () => {
      const { rule, effects } = planOf(
        THERAPY,
        factsFrom({ events: [], link: live("evt_therapy") }),
      );
      expect(rule).toBe("new-linked-elsewhere");
      expect(effects).toMatchObject([
        {
          kind: "escalate",
          reason: "unclear_appointment",
          push: true,
          eventId: "evt_therapy",
          proposed: { kind: "physical_therapy", date: "2026-12-01", time: "10:00" },
          notice:
            "The email gives Physical therapy, Tuesday, December 1 at 10:00 AM. Sunny's calendar no longer has this appointment at that time, so Sunny changed nothing. Tell Sunny in chat which time is right.",
        },
      ]);
    });

    test("a clinic's second reminder for a date a caregiver moved the series off but entered by hand is already on the calendar", () => {
      const visit = fact("evt_visit", "Physical therapy", "2026-12-01", "10:00");
      expect(planOf(THERAPY, factsFrom({ events: [visit], link: live("evt_therapy") }))).toEqual({
        rule: "new-on-calendar",
        effects: [
          { kind: "already_on_calendar", eventId: "evt_visit", appointmentKey: THERAPY_KEY },
        ],
      });
    });

    test("a clinic's second reminder after a caregiver moved a Monday and Tuesday series names the email's date", () => {
      const { rule, effects } = planOf(
        THERAPY,
        factsFrom({ events: [monday("11:00"), tuesday("11:00")], link: live("evt_therapy") }),
      );
      expect(rule).toBe("new-linked-elsewhere");
      expect(effects).toMatchObject([
        {
          kind: "escalate",
          reason: "unclear_appointment",
          eventId: "evt_therapy",
          notice:
            "The email gives Physical therapy, Tuesday, December 1 at 10:00 AM. Sunny's calendar has this appointment on Tuesday, December 1 at 11:00 AM, so Sunny changed nothing. Tell Sunny in chat which time is right.",
        },
      ]);
    });

    test("a clinic's invite sent again after a caregiver moved a Monday and Tuesday series names the email's date", () => {
      const { rule, effects } = planOf(
        THERAPY,
        factsFrom({
          ics: THERAPY_INVITE,
          events: [monday("11:00"), tuesday("11:00")],
          link: live("evt_therapy"),
        }),
      );
      expect(rule).toBe("reschedule-repeating");
      expect(effects).toMatchObject([
        {
          kind: "escalate",
          reason: "unclear_reschedule",
          push: true,
          eventId: "evt_therapy",
          proposed: { kind: "physical_therapy", date: "2026-12-01", time: "10:00" },
          notice:
            "Sunny did not move Physical therapy, Tuesday, December 1 at 11:00 AM, because it is one date of a repeating event. The email asks to move it to Tuesday, December 1 at 10:00 AM. Tell Sunny in chat what to change.",
        },
      ]);
    });

    test("a clinic's invite moved to a date with none of the linked series' dates asks and adds nothing", () => {
      const { rule, effects } = planOf(
        newAppointment({ kind: "physical_therapy", date: "2026-11-30", time: "10:00" }),
        factsFrom({ ics: THERAPY_INVITE, events: [], link: live("evt_therapy") }),
      );
      expect(rule).toBe("reschedule-no-match");
      expect(effects).toMatchObject([
        {
          kind: "escalate",
          reason: "unclear_reschedule",
          push: true,
          eventId: null,
          proposed: { kind: "physical_therapy", date: "2026-11-30", time: "10:00" },
        },
      ]);
    });

    test("a clinic's second reminder after a caregiver cancelled the series is already on the calendar", () => {
      expect(
        planOf(
          THERAPY,
          factsFrom({ events: [], link: over("evt_therapy", "2026-10-05", "10:00") }),
        ),
      ).toEqual({
        rule: "new-on-calendar",
        effects: [
          { kind: "already_on_calendar", eventId: "evt_therapy", appointmentKey: THERAPY_KEY },
        ],
      });
    });

    test("a clinic's late reminder for a past date of the series never says the calendar moved it", () => {
      const now = NOW + 7 * DAY_MS;
      const { rule, effects } = planOf(
        newAppointment({ kind: "physical_therapy", date: "2026-11-24", time: "10:00" }),
        factsFrom({
          ...from(CLINIC, now - 30 * MINUTE_MS),
          clock: { now, timezone: NY },
          events: [],
          link: live("evt_therapy"),
        }),
      );
      expect(rule).toBe("new-fields-rejected");
      expect(effects).toMatchObject([
        {
          kind: "escalate",
          reason: "unclear_appointment",
          push: true,
          eventId: null,
          proposed: { kind: "physical_therapy", date: "2026-11-24", time: "10:00" },
          notice:
            "Sunny did not add this appointment because its date or time did not pass Sunny's checks: Physical therapy, Tuesday, November 24 at 10:00 AM.",
        },
      ]);
    });
  });

  test("a clinic's late reminder for a one-off that is over never says the calendar moved it", () => {
    const now = NOW + 2 * DAY_MS;
    const lateReminder: MailVerdict = newAppointment({
      kind: "eye_doctor",
      date: "2026-11-19",
      time: "10:00",
    });
    const { rule, effects } = planOf(
      lateReminder,
      factsFrom({
        ...from(CLINIC, now - 30 * MINUTE_MS),
        clock: { now, timezone: NY },
        events: [],
        link: over("evt_added", "2026-11-19", "10:00"),
      }),
    );
    expect(rule).toBe("new-fields-rejected");
    expect(effects).toMatchObject([
      {
        kind: "escalate",
        reason: "unclear_appointment",
        eventId: null,
        proposed: { kind: "eye_doctor", date: "2026-11-19", time: "10:00" },
        notice:
          "Sunny did not add this appointment because its date or time did not pass Sunny's checks: Eye exam, Thursday, November 19 at 10:00 AM.",
      },
    ]);
  });
});
