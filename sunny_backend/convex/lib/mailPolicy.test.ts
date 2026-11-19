import { describe, expect, test } from "vitest";
import {
  appointmentFields,
  appointmentKey,
  caregiverText,
  linkKey,
  matchEvent,
  noteExpiry,
  planWithRule,
  seniorNoteText,
} from "./mailPolicy";
import type {
  Appointment,
  CalendarEventFact,
  IcsEvent,
  MailEffect,
  MailVerdict,
  PolicyFacts,
  Triaged,
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
    senderTrusted: true,
    subject: "Your appointment",
    receivedAt: NOW - 3_600_000,
    gmailId: "m1",
    ics: null,
    events: EVENTS,
    linkedEventId: null,
    ...overrides,
  };
}

function model(verdict: MailVerdict | null): Triaged {
  return {
    stage: "model",
    verdict,
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 },
    classifier: "test",
  };
}

function appointment(overrides: Partial<Appointment> = {}): Appointment {
  return {
    title: "Hearing test",
    date: "2026-12-10",
    time: "14:15",
    durationMinutes: 45,
    place: "Brookfield Audiology",
    ...overrides,
  };
}

function newAppointment(overrides: Partial<Appointment> = {}): MailVerdict {
  return {
    kind: "appointment",
    change: "new",
    appointment: appointment(overrides),
    summary: "A hearing test was booked.",
  };
}

function reschedule(
  previous: { date: string; time: string | null; title: string },
  overrides: Partial<Appointment> = {},
): MailVerdict {
  return {
    kind: "appointment",
    change: "reschedule",
    previous,
    appointment: appointment({
      title: "Physical therapy",
      date: "2026-11-23",
      time: "15:00",
      ...overrides,
    }),
    summary: "The clinic moved the visit.",
  };
}

function effectsOf(triaged: Triaged, policyFacts: PolicyFacts): MailEffect[] {
  return planWithRule(triaged, policyFacts).effects;
}

function kinds(effects: MailEffect[]): string[] {
  return effects.map((e) => (e.kind === "escalate" ? `escalate:${e.reason}:${e.push}` : e.kind));
}

describe("planWithRule decision table", () => {
  test("an unreadable model verdict escalates with a push", () => {
    expect(kinds(effectsOf(model(null), facts()))).toEqual(["escalate:unreadable:true"]);
  });

  test("ignore plans nothing", () => {
    expect(effectsOf(model({ kind: "ignore", summary: "A receipt." }), facts())).toEqual([]);
  });

  describe("new appointment", () => {
    test("from an unverified sender escalates and is not added", () => {
      const effects = effectsOf(
        model(newAppointment()),
        facts({ sender: { ...facts().sender, authenticated: false } }),
      );
      expect(kinds(effects)).toEqual(["escalate:unverified_sender:true"]);
    });

    test("from an authenticated sender no caregiver trusts escalates as a new sender and is not added", () => {
      const effects = effectsOf(model(newAppointment()), facts({ senderTrusted: false }));
      expect(kinds(effects)).toEqual(["escalate:new_sender:true"]);
      expect(effects[0]).toMatchObject({
        eventId: null,
        proposed: { date: "2026-12-10", time: "14:15" },
        notice:
          "Hearing test, Thursday, December 10 at 2:15 PM. Sunny has not added it because no caregiver has approved this sender yet. Tell Sunny in chat to add it, and to trust this sender if the email is genuine.",
      });
    });

    test("from an untrusted sender that repeats a live event is already on the calendar", () => {
      expect(
        effectsOf(
          model(newAppointment()),
          facts({ senderTrusted: false, linkedEventId: "evt_eye" }),
        ),
      ).toEqual([{ kind: "already_on_calendar", eventId: "evt_eye" }]);
    });

    test("with rejected fields escalates as unclear", () => {
      const effects = effectsOf(model(newAppointment({ date: "2026-11-17" })), facts());
      expect(kinds(effects)).toEqual(["escalate:unclear_appointment:true"]);
    });

    test("already linked to an event is already on the calendar", () => {
      expect(effectsOf(model(newAppointment()), facts({ linkedEventId: "evt_eye" }))).toEqual([
        { kind: "already_on_calendar", eventId: "evt_eye" },
      ]);
    });

    test("at the same date and time as a live event with a shared title word is already on the calendar", () => {
      const verdict = newAppointment({
        title: "Dr. Rivera follow-up",
        date: "2026-11-24",
        time: "10:30",
      });
      expect(effectsOf(model(verdict), facts())).toEqual([
        { kind: "already_on_calendar", eventId: "evt_eye" },
      ]);
    });

    test("overlapping another live event escalates as a conflict and is not added", () => {
      const verdict = newAppointment({ date: "2026-11-24", time: "11:00" });
      const effects = effectsOf(model(verdict), facts());
      expect(kinds(effects)).toEqual(["escalate:conflict:true"]);
      expect(effects[0]).toMatchObject({ eventId: null });
    });

    test("otherwise is added and caregivers are told without a push", () => {
      const verdict = newAppointment({ title: "  Hearing   test ", place: " " });
      const effects = effectsOf(model(verdict), facts());
      expect(effects[0]).toEqual({
        kind: "add_event",
        appointment: {
          title: "Hearing test",
          date: "2026-12-10",
          time: "14:15",
          durationMinutes: 45,
          place: null,
        },
        appointmentKey: "appt:2026-12-10:14:15:hearing test",
      });
      expect(effects[1]).toMatchObject({ kind: "tell_caregivers", push: false });
      expect(effects).toHaveLength(2);
    });

    test("from an invitation is keyed by its UID", () => {
      const ics: IcsEvent = {
        method: "REQUEST",
        uid: "u-1",
        start: { date: "2026-12-10", time: "14:15" },
        durationMinutes: 45,
        summary: "Hearing test",
        location: null,
        recurring: false,
        sequence: 0,
      };
      const effects = effectsOf(model(newAppointment()), facts({ ics }));
      expect(effects[0]).toMatchObject({ kind: "add_event", appointmentKey: "ics:u-1" });
    });
  });

  describe("reschedule", () => {
    const pt = { date: "2026-11-20", time: "14:00", title: "Physical therapy" };

    test("with exactly one match from the event's source moves it and tells caregivers with a push", () => {
      const effects = effectsOf(model(reschedule(pt)), facts({ sender: PT_SENDER }));
      expect(effects[0]).toMatchObject({
        kind: "reschedule_event",
        eventId: "evt_pt",
        appointment: { date: "2026-11-23", time: "15:00" },
      });
      expect(effects[1]).toMatchObject({ kind: "tell_caregivers", push: true });
      const body = effects[1]?.kind === "tell_caregivers" ? effects[1].body : "";
      expect(body).toContain(
        "from Friday, November 20 at 2:00 PM to Monday, November 23 at 3:00 PM",
      );
    });

    test("finds the event through the link before the previous time", () => {
      const effects = effectsOf(
        model(reschedule({ date: "2030-01-01", time: null, title: "?" })),
        facts({ linkedEventId: "evt_pt", sender: PT_SENDER }),
      );
      expect(effects[0]).toMatchObject({ kind: "reschedule_event", eventId: "evt_pt" });
    });

    test("from a trusted sender moves the one matching event, whoever entered it", () => {
      const effects = effectsOf(
        model(reschedule({ date: "2026-12-02", time: "09:00", title: "Dentist" })),
        facts({
          sender: { name: "Anna Ellis", address: "anna.ellis@example.net", authenticated: true },
        }),
      );
      expect(effects[0]).toMatchObject({ kind: "reschedule_event", eventId: "evt_dentist" });
    });

    test("to the time the event already has is already on the calendar", () => {
      const effects = effectsOf(
        model(reschedule(pt, { date: "2026-11-20", time: "14:00" })),
        facts({ sender: PT_SENDER }),
      );
      expect(effects).toEqual([{ kind: "already_on_calendar", eventId: "evt_pt" }]);
    });

    test("an escalation with one match names the event, both times and what to tell Sunny", () => {
      const effects = effectsOf(
        model(reschedule(pt)),
        facts({ sender: { name: "x", address: "x@x.example", authenticated: false } }),
      );
      const body = effects[0]?.kind === "escalate" ? effects[0].body : "";
      expect(body).toContain(
        "Sunny did not move Physical therapy, Friday, November 20 at 2:00 PM. The email asks to move it to Monday, November 23 at 3:00 PM. Tell Sunny in chat to move it.",
      );
    });

    test("an escalation with no single match says Sunny moved nothing and names no event", () => {
      const effects = effectsOf(
        model(reschedule({ date: "2030-01-01", time: null, title: "?" })),
        facts({ sender: PT_SENDER }),
      );
      const body = effects[0]?.kind === "escalate" ? effects[0].body : "";
      expect(body).toContain("Sunny did not move any appointment.");
      expect(body).not.toContain("Tell Sunny in chat");
    });

    test.each([
      [
        "the sender is not verified",
        reschedule(pt),
        { sender: { name: "x", address: "x@x.example", authenticated: false } },
        "evt_pt",
      ],
      [
        "nothing matches",
        reschedule({ date: "2026-11-21", time: "09:00", title: "Physical therapy" }),
        {},
        null,
      ],
      [
        "several events match",
        reschedule({ date: "2026-11-20", time: null, title: "therapy" }),
        {
          events: [
            ...EVENTS,
            {
              eventId: "evt_ot",
              title: "Occupational therapy",
              date: "2026-11-20",
              time: "16:00",
              durationMinutes: 30,
              repeating: false,
            },
          ],
        },
        null,
      ],
      ["the new fields are rejected", reschedule(pt, { place: "Call 555-014-2233" }), {}, "evt_pt"],
      [
        "the sender is a lookalike of the event's source",
        reschedule({ date: "2026-11-24", time: "10:30", title: "Eye exam" }),
        {
          sender: {
            name: "Lakeside Eye Care",
            address: "appointments@lakeside-eyecare.example",
            authenticated: true,
          },
          senderTrusted: false,
        },
        "evt_eye",
      ],
      [
        "an untrusted sender asks to move an event",
        reschedule({ date: "2026-12-02", time: "09:00", title: "Dentist" }),
        {
          sender: {
            name: "Maple Street Dental",
            address: "office@maplestreetdental.example",
            authenticated: true,
          },
          senderTrusted: false,
        },
        "evt_dentist",
      ],
    ])("escalates as unclear when %s", (_, verdict, overrides, eventId) => {
      const effects = effectsOf(model(verdict), facts({ sender: PT_SENDER, ...overrides }));
      expect(kinds(effects)).toEqual(["escalate:unclear_reschedule:true"]);
      expect(effects[0]).toMatchObject({ eventId });
    });
  });

  test("a cancellation is escalated, never applied, with the event when exactly one matches", () => {
    const cancel = (time: string | null): MailVerdict => ({
      kind: "appointment",
      change: "cancel",
      previous: { date: "2026-12-02", time, title: "Dentist" },
      summary: "The dentist cancelled.",
    });
    const matched = effectsOf(model(cancel("09:00")), facts());
    expect(kinds(matched)).toEqual(["escalate:cancellation:true"]);
    expect(matched[0]).toMatchObject({ eventId: "evt_dentist" });
    expect(effectsOf(model(cancel("16:00")), facts())[0]).toMatchObject({ eventId: null });
  });

  describe("senior info", () => {
    const info: MailVerdict = {
      kind: "senior_info",
      topic: "prescription",
      note: "Your prescription is ready at the pharmacy.",
      summary: "Refill ready.",
    };

    test("becomes a note that expires at the end of the next local day", () => {
      expect(effectsOf(model(info), facts())).toEqual([
        {
          kind: "senior_note",
          text: "Your prescription is ready at the pharmacy.",
          expiresAt: zonedInstant("2026-11-20", "00:00", NY),
        },
      ]);
    });

    test("from a stale email plans nothing", () => {
      expect(effectsOf(model(info), facts({ receivedAt: NOW - DAY_MS - 1 }))).toEqual([]);
    });

    test("from an unverified sender goes to caregivers without a push", () => {
      const effects = effectsOf(
        model(info),
        facts({ sender: { name: "Pharmacy", address: "rx@x.example", authenticated: false } }),
      );
      expect(kinds(effects)).toEqual(["tell_caregivers"]);
      expect(effects[0]).toMatchObject({ push: false });
    });

    test("from an authenticated sender no caregiver trusts goes to caregivers without a push", () => {
      const effects = effectsOf(model(info), facts({ senderTrusted: false }));
      expect(effects).toEqual([expect.objectContaining({ kind: "tell_caregivers", push: false })]);
      expect(effects[0]).toMatchObject({
        notice:
          "Sunny did not tell the senior about this email because no caregiver has approved this sender yet.",
      });
    });

    test("with a note the validator rejects goes to caregivers without a push", () => {
      const effects = effectsOf(model({ ...info, note: "Call the pharmacy today." }), facts());
      expect(effects).toEqual([expect.objectContaining({ kind: "tell_caregivers", push: false })]);
    });
  });

  test("needs decision escalates with its reason and a push", () => {
    const effects = effectsOf(
      model({ kind: "needs_decision", reason: "bill_or_payment", summary: "Electric bill due." }),
      facts(),
    );
    expect(kinds(effects)).toEqual(["escalate:bill_or_payment:true"]);
  });

  test("suspicious mail escalates with its suspicion and never reaches the senior", () => {
    const effects = effectsOf(
      model({ kind: "suspicious", suspicion: "money_request", summary: "Asks for gift cards." }),
      facts(),
    );
    expect(kinds(effects)).toEqual(["escalate:money_request:true"]);
  });

  test("a stale email never pushes", () => {
    const stale = facts({ receivedAt: NOW - 3 * DAY_MS, sender: PT_SENDER });
    expect(
      kinds(effectsOf(model({ kind: "suspicious", suspicion: "scam", summary: "x" }), stale)),
    ).toEqual(["escalate:scam:false"]);
    const moved = effectsOf(
      model(reschedule({ date: "2026-11-20", time: "14:00", title: "Physical therapy" })),
      stale,
    );
    expect(moved[1]).toMatchObject({ kind: "tell_caregivers", push: false });
  });

  test("a gate verdict runs through the same table", () => {
    const gateTriaged: Triaged = {
      stage: "gate",
      verdict: newAppointment(),
      rule: "ics:request_new",
    };
    expect(kinds(effectsOf(gateTriaged, facts()))).toEqual(["add_event", "tell_caregivers"]);
  });
});

describe("appointmentFields", () => {
  test("accepts and cleans a plain appointment", () => {
    expect(
      appointmentFields(
        appointment({
          title: " Eye  exam ",
          place: "Lakeside Eye Care, 40 Harbor Road, Suite 300, Brookfield 02139",
        }),
        CLOCK,
      ),
    ).toEqual({
      title: "Eye exam",
      date: "2026-12-10",
      time: "14:15",
      durationMinutes: 45,
      place: "Lakeside Eye Care, 40 Harbor Road, Suite 300, Brookfield 02139",
    });
    expect(
      appointmentFields(appointment({ title: "Room 12 check-in", durationMinutes: null }), CLOCK),
    ).not.toBeNull();
  });

  test.each([
    ["a blank title", { title: "  " }],
    ["a title over 60 characters", { title: "x".repeat(61) }],
    ["a phone number in the title", { title: "Call 1-800-555-0188 to confirm" }],
    ["three digits in the title", { title: "Visit 2 3 4" }],
    ["a link in the title", { title: "Visit https://x.example" }],
    ["a domain in the title", { title: "Login at medicare-help.example" }],
    ["an @ in the title", { title: "Email help@clinic" }],
    ["a currency sign in the title", { title: "Pay $20 fee" }],
    ["a place over 120 characters", { place: "x".repeat(121) }],
    ["a phone number in the place", { place: "Call (555) 014-2233" }],
    ["a link in the place", { place: "www.clinic.example" }],
    ["a currency sign in the place", { place: "Bring €50" }],
    [
      "money and credential words in the title",
      { title: "Medicare card verification - bring bank card" },
    ],
    ["a credential word in the place", { place: "Kiosk - verify your account first" }],
    ["a payment word in the place", { place: "Pay at the front desk" }],
    ["a malformed date", { date: "12/10/2026" }],
    ["a malformed time", { time: "2:15 PM" }],
    ["a time already past", { date: "2026-11-18", time: "08:59" }],
    ["a date over 400 days out", { date: "2027-12-24" }],
    ["a duration under 5 minutes", { durationMinutes: 4 }],
    ["a duration over 480 minutes", { durationMinutes: 481 }],
  ])("rejects %s", (_, overrides) => {
    expect(appointmentFields(appointment(overrides), CLOCK)).toBeNull();
  });

  test.each([
    ["a video call title", { title: "Video call with David" }],
    ["a phone consultation title", { title: "Phone consultation with Dr. Lee" }],
    ["a place with a call-in note", { place: "Call the front desk on arrival" }],
    ["a place that says open", { place: "Open Door Clinic" }],
  ])("accepts %s because action words only matter in senior notes", (_, overrides) => {
    expect(appointmentFields(appointment(overrides), CLOCK)).not.toBeNull();
  });

  test("accepts the edges of the ranges", () => {
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
});

describe("seniorNoteText", () => {
  test("accepts a short plain note and folds typographic quotes", () => {
    expect(seniorNoteText("Anna’s kids loved  your cookies.", "family_news")).toBe(
      "Anna's kids loved your cookies.",
    );
    expect(
      seniorNoteText(
        "A package is arriving this afternoon. It will be left at the door.",
        "delivery",
      ),
    ).toBe("A package is arriving this afternoon. It will be left at the door.");
  });

  test.each([
    ["the topic other", "Nice weather today.", "other", true],
    ["more than 160 characters", `${"word ".repeat(33)}end.`, "delivery", false],
    ["three sentences", "A package came. It is big. It is red.", "delivery", false],
    ["a digit", "Your package arrives at 3.", "delivery", false],
    ["a link", "See parcelpost.example for details.", "delivery", false],
    ["an @", "Ask rx@pharmacy.", "prescription", false],
    ["markup", "Your *prescription* is ready.", "prescription", false],
    ["a character the display cannot draw", "Happy birthday \u{1F382}", "family_news", true],
    ["an empty note", "  ", "delivery", false],
  ])("rejects %s", (_, note, topic) => {
    expect(seniorNoteText(note, topic as "delivery")).toBeNull();
  });

  test("accepts a note that says a place is open", () => {
    expect(seniorNoteText("The pharmacy is open until six.", "prescription")).toBe(
      "The pharmacy is open until six.",
    );
    expect(seniorNoteText("Your prescription is ready. They open early.", "prescription")).toBe(
      "Your prescription is ready. They open early.",
    );
  });

  test("keeps the 160 character limit exact", () => {
    const at = `${"a".repeat(155)} done.`;
    expect(at).toHaveLength(161);
    expect(seniorNoteText(at.slice(1), "delivery")).not.toBeNull();
    expect(seniorNoteText(at, "delivery")).toBeNull();
  });

  test.each([
    "call",
    "Calling",
    "phone",
    "dial",
    "pay",
    "paid",
    "payment",
    "money",
    "bank",
    "cards",
    "gift",
    "wire",
    "transfer",
    "password",
    "code",
    "verify",
    "verified",
    "account",
    "click",
    "tap",
    "link",
    "download",
    "reply",
    "send",
    "urgent",
    "prize",
    "refund",
    "Medicare",
    "Social Security",
  ])("rejects a note containing %s", (word) => {
    expect(seniorNoteText(`Something about ${word} today.`, "service_visit")).toBeNull();
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
  test("appointmentKey prefers the invitation UID", () => {
    expect(appointmentKey(appointment({ title: "Hearing  Test" }), null)).toBe(
      "appt:2026-12-10:14:15:hearing test",
    );
    const ics: IcsEvent = {
      method: "REQUEST",
      uid: "u-9",
      start: null,
      durationMinutes: null,
      summary: "",
      location: null,
      recurring: false,
      sequence: 0,
    };
    expect(appointmentKey(appointment(), ics)).toBe("ics:u-9");
  });

  test("linkKey gives the key to look up for each verdict", () => {
    expect(linkKey(newAppointment(), null)).toBe("appt:2026-12-10:14:15:hearing test");
    expect(linkKey({ kind: "ignore", summary: "x" }, null)).toBeNull();
    expect(
      linkKey(null, {
        method: "CANCEL",
        uid: "u-2",
        start: null,
        durationMinutes: null,
        summary: "",
        location: null,
        recurring: false,
        sequence: 0,
      }),
    ).toBe("ics:u-2");
  });

  test("matchEvent needs a shared title word and uses the time when given", () => {
    expect(
      matchEvent({ date: "2026-11-24", time: "10:30", title: "Eye exam" }, EVENTS).map(
        (e) => e.eventId,
      ),
    ).toEqual(["evt_eye"]);
    expect(matchEvent({ date: "2026-11-24", time: "10:30", title: "" }, EVENTS)).toEqual([]);
    expect(
      matchEvent({ date: "2026-11-24", time: "10:30", title: "Hair appointment" }, EVENTS),
    ).toEqual([]);
    expect(matchEvent({ date: "2026-11-24", time: "11:00", title: "Eye exam" }, EVENTS)).toEqual(
      [],
    );
    expect(
      matchEvent({ date: "2026-11-24", time: null, title: "Dr. Rivera" }, EVENTS).map(
        (e) => e.eventId,
      ),
    ).toEqual(["evt_eye"]);
    expect(matchEvent({ date: "2026-11-24", time: null, title: "Appointment" }, EVENTS)).toEqual(
      [],
    );
    expect(matchEvent({ date: "2026-11-25", time: "10:30", title: "Eye exam" }, EVENTS)).toEqual(
      [],
    );
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
