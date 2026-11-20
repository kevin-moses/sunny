import { describe, expect, test } from "vitest";
import { jevAnswers } from "../mailMocks.helpers";
import { cleanText } from "./frameText";
import { compactAnswers } from "./jevClient";
import { FLAGS, FLAG_GROUPS } from "./jevQuestions";
import type { Flag } from "./jevQuestions";
import type { Level } from "./jevConfidence";
import { TRUTH_TABLE, decide, readAnswers } from "./mailJudge";
import type { Invite, Readings } from "./mailJudge";
import { ANCHOR, CLOCK, DEC_10, EYE_EXAM, QUESTIONS } from "./mailFixtures.helpers";
import { appointmentFields } from "./mailPolicy";
import { APPOINTMENT_KIND_NAMES, SENIOR_SENTENCES, appointmentTitle } from "./mailTypes";
import type { IcsEvent, MailVerdict } from "./mailTypes";

function readings(
  flags: Partial<Record<Flag, Level>>,
  rest: Partial<Omit<Readings, "flags">> = {},
): Readings {
  return {
    flags: new Map(FLAGS.map((f) => [f, flags[f] ?? "no"])),
    otherTimeZone: "no",
    kind: "other",
    when: null,
    before: null,
    invite: null,
    ...rest,
  };
}

function label(verdict: MailVerdict): string {
  switch (verdict.kind) {
    case "ignore":
      return "ignore";
    case "appointment":
      return `appointment:${verdict.change}`;
    case "senior_info":
      return `senior_info:${verdict.topic}`;
    case "needs_decision":
      return `needs_decision:${verdict.reason}`;
    case "suspicious":
      return `suspicious:${verdict.suspicion}`;
  }
}

const NOV_20 = { date: "2026-11-20", time: "14:00" };
const INVITE: Invite = {
  method: "REQUEST",
  start: { date: "2026-12-09", time: "14:30" },
  durationMinutes: 45,
};

const ROWS: [string, string, Readings, string][] = [
  ["instructions to an assistant", "", readings({ addresses_assistant: "yes" }), "suspicious:scam"],
  [
    "asks for private details",
    "",
    readings({ asks_private_details: "yes", confirms_appointment: "yes" }, { when: DEC_10 }),
    "suspicious:credentials",
  ],
  [
    "asks for hard-to-trace payment",
    "",
    readings({ asks_hard_to_trace_payment: "yes", personal_note: "yes" }),
    "suspicious:money_request",
  ],
  [
    "asks to bring payment",
    "even on a calendar invitation",
    readings({ asks_to_bring_payment: "yes" }, { invite: INVITE }),
    "suspicious:money_request",
  ],
  [
    "new contact details or a mismatched sender name",
    "new address",
    readings({ announces_new_contact: "yes" }),
    "suspicious:impersonation",
  ],
  [
    "new contact details or a mismatched sender name",
    "name does not match address",
    readings({ name_mismatch: "yes" }),
    "suspicious:impersonation",
  ],
  [
    "threat, secrecy or unexpected money",
    "threat of arrest",
    readings({ threatens_arrest: "yes" }),
    "suspicious:scam",
  ],
  [
    "threat, secrecy or unexpected money",
    "lockout posing as a bank",
    readings({ threatens_lockout: "yes", about_account_security: "yes" }),
    "suspicious:impersonation",
  ],
  [
    "a safety question is unsettled",
    "blocks a calendar invitation",
    readings({ discourages_checking: "unsure" }, { invite: INVITE }),
    "needs_decision:other",
  ],
  [
    "calendar invitation",
    "a request",
    readings({ asks_question: "yes" }, { kind: "medical_test", invite: INVITE }),
    "appointment:new",
  ],
  [
    "calendar cancellation",
    "",
    readings({}, { invite: { ...INVITE, method: "CANCEL" } }),
    "appointment:cancel",
  ],
  [
    "invitation for a cancelled appointment",
    "",
    readings({ appointment_cancelled: "yes", appointment_moved: "yes" }, { invite: INVITE }),
    "appointment:cancel",
  ],
  [
    "invitation for a moved appointment",
    "",
    readings({ appointment_moved: "yes" }, { invite: INVITE, before: NOV_20 }),
    "appointment:reschedule",
  ],
  [
    "cancelled",
    "with the old date",
    readings(
      { appointment_cancelled: "yes" },
      { kind: "dentist", before: { date: "2026-12-02", time: "09:00" } },
    ),
    "appointment:cancel",
  ],
  [
    "cancelled",
    "without the old date",
    readings({ appointment_cancelled: "yes" }),
    "needs_decision:cancellation",
  ],
  [
    "moved",
    "with old and new times",
    readings(
      { appointment_moved: "yes" },
      { kind: "physical_therapy", when: DEC_10, before: NOV_20 },
    ),
    "appointment:reschedule",
  ],
  [
    "moved",
    "without a new start time",
    readings(
      { appointment_moved: "yes" },
      { when: { date: "2026-12-10", time: null }, before: NOV_20 },
    ),
    "needs_decision:other",
  ],
  [
    "confirms an appointment with a date and start time",
    "",
    readings({ confirms_appointment: "yes" }, { kind: "eye_doctor", when: DEC_10 }),
    "appointment:new",
  ],
  [
    "test results",
    "",
    readings({ about_test_results: "yes", about_bill: "yes" }),
    "needs_decision:health_result",
  ],
  [
    "bill",
    "",
    readings({ about_bill: "yes", about_package: "yes" }),
    "needs_decision:bill_or_payment",
  ],
  [
    "account security",
    "",
    readings({ about_account_security: "yes" }),
    "needs_decision:account_or_credentials",
  ],
  ["government", "", readings({ from_government: "yes" }), "needs_decision:legal_or_government"],
  [
    "question for the senior",
    "",
    readings({ asks_question: "yes", personal_note: "yes" }),
    "needs_decision:reply_needed",
  ],
  [
    "payment, reply, signature or decision needed",
    "",
    readings({ needs_action: "yes", bulk_mail: "yes" }),
    "needs_decision:other",
  ],
  [
    "a specific decision question is unsettled",
    "",
    readings({ about_bill: "unsure", about_package: "yes" }),
    "needs_decision:other",
  ],
  [
    "prescription",
    "ready now",
    readings({ about_prescription: "yes", prescription_ready_now: "yes" }),
    "senior_info:prescription_ready",
  ],
  [
    "prescription",
    "being prepared",
    readings({ about_prescription: "yes", needs_action: "unsure" }),
    "senior_info:prescription_coming",
  ],
  [
    "package",
    "arrived",
    readings({ about_package: "yes", package_arrived: "yes" }),
    "senior_info:package_arrived",
  ],
  ["package", "on its way", readings({ about_package: "yes" }), "senior_info:package_coming"],
  [
    "home visit",
    "",
    readings(
      { home_visit: "yes", confirms_appointment: "yes" },
      { when: { date: "2026-11-19", time: null } },
    ),
    "needs_decision:home_visit",
  ],
  [
    "appointment without a readable date and start time",
    "no start time",
    readings({ confirms_appointment: "yes" }, { when: { date: "2026-11-19", time: null } }),
    "needs_decision:other",
  ],
  [
    "appointment without a readable date and start time",
    "time zone not settled",
    readings({ confirms_appointment: "yes" }, { when: DEC_10, otherTimeZone: "unsure" }),
    "needs_decision:other",
  ],
  ["personal note", "", readings({ personal_note: "yes" }), "senior_info:personal_note"],
  [
    "bulk mail, receipt or feedback request",
    "bulk mail with an unsettled broad question",
    readings({ bulk_mail: "yes", confirms_appointment: "unsure" }),
    "ignore",
  ],
  ["bulk mail, receipt or feedback request", "receipt", readings({ receipt: "yes" }), "ignore"],
  [
    "bulk mail, receipt or feedback request",
    "survey",
    readings({ feedback_request: "yes", needs_action: "unsure" }),
    "ignore",
  ],
  [
    "a broad question is unsettled",
    "",
    readings({ needs_action: "unsure" }),
    "needs_decision:other",
  ],
  [
    "an information question is unsettled",
    "",
    readings({ personal_note: "unsure" }),
    "needs_decision:other",
  ],
  ["otherwise", "", readings({}), "needs_decision:other"],
];

describe("truth table", () => {
  test("every row has a case", () => {
    expect(new Set(ROWS.map(([rule]) => rule))).toEqual(new Set(TRUTH_TABLE.map((r) => r.rule)));
  });

  test.each(ROWS)("%s %s", (rule, _, input, expected) => {
    const result = decide(input);
    expect(result.rule).toBe(rule);
    expect(label(result.verdict)).toBe(expected);
    expect(result.summary.length).toBeGreaterThan(0);
  });

  test.each(FLAGS.filter((f) => FLAG_GROUPS[f] !== "follow_up"))(
    "an unsettled %s on its own goes to the caregivers",
    (flag) => {
      expect(decide(readings({ [flag]: "unsure" })).verdict.kind).toBe("needs_decision");
    },
  );

  test("a follow-up question is read only after its parent says yes", () => {
    expect(
      label(decide(readings({ about_package: "yes", package_arrived: "unsure" })).verdict),
    ).toBe("senior_info:package_coming");
    expect(decide(readings({ prescription_ready_now: "yes" })).rule).toBe("otherwise");
  });

  test("an appointment carries a kind and a slot, never a title or place", () => {
    expect(
      decide(readings({ confirms_appointment: "yes" }, { kind: "eye_doctor", when: DEC_10 }))
        .verdict,
    ).toEqual({
      kind: "appointment",
      change: "new",
      appointment: { kind: "eye_doctor", date: "2026-12-10", time: "14:15", durationMinutes: null },
      decision: null,
    });
  });

  test("an invitation takes its start and length from the calendar part, not from the reading", () => {
    expect(
      decide(
        readings(
          { confirms_appointment: "yes" },
          { kind: "medical_test", when: DEC_10, invite: INVITE },
        ),
      ).verdict,
    ).toEqual({
      kind: "appointment",
      change: "new",
      appointment: { kind: "medical_test", date: "2026-12-09", time: "14:30", durationMinutes: 45 },
      decision: null,
    });
  });

  test.each([
    ["a bill", { about_bill: "yes", needs_action: "yes" }, "bill_or_payment"],
    [
      "test results and a question",
      { about_test_results: "yes", asks_question: "yes" },
      "health_result",
    ],
    ["an unsettled bill", { about_bill: "unsure" }, "other"],
    ["only something to do", { needs_action: "yes" }, null],
    ["an unsettled reply", { needs_action: "unsure" }, null],
    ["nothing else", {}, null],
  ] as const)(
    "a confirmed appointment that also has %s carries that decision",
    (_, flags, reason) => {
      const { verdict } = decide(
        readings({ confirms_appointment: "yes", ...flags }, { kind: "eye_doctor", when: DEC_10 }),
      );
      expect(verdict).toMatchObject({ kind: "appointment", change: "new", decision: reason });
    },
  );

  test("an invitation that is also about a bill carries the bill", () => {
    const { verdict } = decide(
      readings({ about_bill: "yes", needs_action: "yes" }, { invite: INVITE }),
    );
    expect(verdict).toMatchObject({ change: "new", decision: "bill_or_payment" });
  });

  test("an invitation Jev reads as moved takes the new slot from the calendar part", () => {
    expect(
      decide(readings({ appointment_moved: "yes" }, { kind: "hearing", invite: INVITE })).verdict,
    ).toEqual({
      kind: "appointment",
      change: "reschedule",
      previous: null,
      appointment: { kind: "hearing", date: "2026-12-09", time: "14:30", durationMinutes: 45 },
      decision: null,
    });
    expect(
      decide(
        readings({ appointment_moved: "yes" }, { kind: "hearing", invite: INVITE, before: NOV_20 }),
      ).verdict,
    ).toMatchObject({ previous: { kind: "hearing", date: "2026-11-20", time: "14:00" } });
  });

  test("an invitation Jev reads as cancelled names the invitation's slot", () => {
    expect(
      decide(readings({ appointment_cancelled: "yes" }, { kind: "hearing", invite: INVITE }))
        .verdict,
    ).toEqual({
      kind: "appointment",
      change: "cancel",
      previous: { kind: "hearing", date: "2026-12-09", time: "14:30" },
      decision: null,
    });
  });

  test("a reschedule names the old slot with the same kind", () => {
    const { verdict } = decide(
      readings(
        { appointment_moved: "yes" },
        { kind: "physical_therapy", when: DEC_10, before: NOV_20 },
      ),
    );
    expect(verdict).toMatchObject({
      previous: { kind: "physical_therapy", date: "2026-11-20", time: "14:00" },
      appointment: { kind: "physical_therapy", date: "2026-12-10", time: "14:15" },
    });
  });
});

describe("Sunny's own words", () => {
  test.each([
    ["08:00", "Breakfast"],
    ["12:30", "Lunch"],
    ["18:00", "Dinner"],
  ])("a meal at %s is titled %s", (time, title) => {
    expect(appointmentTitle("meal", time)).toBe(title);
  });

  test("every kind's title is short and has no digits", () => {
    for (const kind of APPOINTMENT_KIND_NAMES) {
      const title = appointmentTitle(kind, "09:00");
      expect(title.length).toBeLessThanOrEqual(60);
      expect(title).not.toMatch(/\d/);
    }
  });

  test.each(Object.entries(SENIOR_SENTENCES))(
    "the %s sentence fits the senior screens",
    (_, sentence) => {
      expect(sentence.length).toBeLessThanOrEqual(160);
      expect(
        sentence.split(/[.!?]+(?:\s+|$)/).filter((s) => s.trim() !== "").length,
      ).toBeLessThanOrEqual(2);
      expect(sentence).not.toMatch(/\d/);
      expect(cleanText(sentence)).toBe(sentence);
    },
  );

  test("the senior hears only these calm sentences, none about a visitor", () => {
    expect(SENIOR_SENTENCES).toEqual({
      prescription_ready: "Your prescription is ready to pick up at the pharmacy.",
      prescription_coming: "The pharmacy is getting your prescription ready.",
      package_arrived: "A package was delivered to your home.",
      package_coming: "A package is on the way to your home.",
      personal_note: "You have a personal email. Someone can read it with you.",
    });
  });

  test("every appointment the table can build passes the calendar field checks", () => {
    for (const kind of APPOINTMENT_KIND_NAMES) {
      const { verdict } = decide(readings({ confirms_appointment: "yes" }, { kind, when: DEC_10 }));
      if (verdict.kind !== "appointment" || verdict.change !== "new") throw new Error(kind);
      expect(appointmentFields(verdict.appointment, CLOCK)).toEqual(verdict.appointment);
    }
  });
});

describe("reading Jev's answers", () => {
  test("turns probabilities and picks into readings", () => {
    const answers = compactAnswers(jevAnswers(EYE_EXAM, QUESTIONS), QUESTIONS);
    const read = readAnswers(answers, ANCHOR, null);
    expect(read.flags.get("confirms_appointment")).toBe("yes");
    expect(read.flags.get("addresses_assistant")).toBe("no");
    expect(read).toMatchObject({
      kind: "eye_doctor",
      when: { date: "2026-12-10", time: "14:15" },
      before: null,
      otherTimeZone: "no",
      invite: null,
    });
  });

  test("a Noul at a threshold reads the way a Choice part at the threshold does", () => {
    const answers = {
      ...compactAnswers(jevAnswers(EYE_EXAM, QUESTIONS), QUESTIONS),
      confirms_appointment: 0.7,
      addresses_assistant: 0.3,
      about_bill: 0.5,
      when_hour: { choice: "2", probability: 0.7 },
    };
    const read = readAnswers(answers, ANCHOR, null);
    expect(read.flags.get("confirms_appointment")).toBe("yes");
    expect(read.flags.get("addresses_assistant")).toBe("no");
    expect(read.flags.get("about_bill")).toBe("unsure");
    expect(read.when).toEqual(DEC_10);
  });

  test("an invitation's start comes from the calendar part", () => {
    const ics: IcsEvent = {
      method: "REQUEST",
      uid: "u-1",
      start: { date: "2026-12-09", time: "14:30" },
      durationMinutes: 45,
      summary: "Call Officer Miller back",
      location: null,
      recurring: false,
      sequence: 0,
    };
    const answers = compactAnswers(jevAnswers(EYE_EXAM, QUESTIONS), QUESTIONS);
    expect(readAnswers(answers, ANCHOR, ics).invite).toEqual({
      method: "REQUEST",
      start: { date: "2026-12-09", time: "14:30" },
      durationMinutes: 45,
    });
    expect(readAnswers(answers, ANCHOR, { ...ics, start: null }).invite).toBeNull();
    expect(readAnswers(answers, ANCHOR, { ...ics, method: "OTHER" }).invite).toBeNull();
  });
});
