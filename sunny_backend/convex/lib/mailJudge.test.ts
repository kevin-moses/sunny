import { APIError } from "@typesafe-ai/sdk";
import { afterEach, describe, expect, test, vi } from "vitest";
import { jevAnswers, jevCalls, jevSays } from "../mailMocks.helpers";
import type { JevSays } from "../mailMocks.helpers";
import { cleanText } from "./frameText";
import {
  FLAGS,
  FLAG_GROUPS,
  JEV_MODEL,
  JevAnswerError,
  MAX_JEV_BODY,
  TRUTH_TABLE,
  askJev,
  compactAnswers,
  decide,
  judgeQuestions,
  judgeState,
  readAnswers,
  resolveDate,
  resolveSlot,
  resolveTime,
  triageEmail,
  weekdayDate,
} from "./mailJudge";
import type { Flag, Invite, Level, Readings, SlotPicks } from "./mailJudge";
import { appointmentFields } from "./mailPolicy";
import { APPOINTMENT_KIND_NAMES, SENIOR_SENTENCES, appointmentTitle } from "./mailTypes";
import type { IcsEvent, MailVerdict, ParsedEmail } from "./mailTypes";
import { zonedInstant } from "./time";

const NY = "America/New_York";
const CLOCK = { now: zonedInstant("2026-11-18", "09:00", NY), timezone: NY };
const ANCHOR = "2026-11-18";

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

const DEC_10 = { date: "2026-12-10", time: "14:15" };
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
    "calendar invitation",
    "a cancellation",
    readings({}, { invite: { ...INVITE, method: "CANCEL" } }),
    "appointment:cancel",
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
    "senior_info:home_visit",
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
  ["personal note", "", readings({ personal_note: "yes" }), "senior_info:family_news"],
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

  test("every appointment the table can build passes the calendar field checks", () => {
    for (const kind of APPOINTMENT_KIND_NAMES) {
      const { verdict } = decide(readings({ confirms_appointment: "yes" }, { kind, when: DEC_10 }));
      if (verdict.kind !== "appointment" || verdict.change !== "new") throw new Error(kind);
      expect(appointmentFields(verdict.appointment, CLOCK)).toEqual(verdict.appointment);
    }
  });
});

function picks(parts: Partial<Record<keyof SlotPicks, string>>, probability = 0.95): SlotPicks {
  const pick = (choice: string) => ({ choice, probability });
  return {
    date_form: pick(parts.date_form ?? "not_stated"),
    month: pick(parts.month ?? "not_stated"),
    day: pick(parts.day ?? "not_stated"),
    year: pick(parts.year ?? "not_stated"),
    weekday: pick(parts.weekday ?? "not_stated"),
    week: pick(parts.week ?? "unqualified"),
    hour: pick(parts.hour ?? "not_stated"),
    minute: pick(parts.minute ?? "00"),
    half: pick(parts.half ?? "am"),
  };
}

describe("date resolution against the day the email arrived", () => {
  test.each([
    [
      "a full date whose weekday matches",
      {
        date_form: "calendar_date",
        month: "December",
        day: "10",
        year: "2026",
        weekday: "Thursday",
      },
      "2026-12-10",
    ],
    [
      "a full date whose weekday does not match",
      { date_form: "calendar_date", month: "December", day: "10", year: "2026", weekday: "Friday" },
      null,
    ],
    [
      "a date without a year later this year",
      { date_form: "calendar_date", month: "December", day: "5" },
      "2026-12-05",
    ],
    [
      "a date without a year early next year",
      { date_form: "calendar_date", month: "January", day: "11" },
      "2027-01-11",
    ],
    [
      "a date without a year a few days ago",
      { date_form: "calendar_date", month: "November", day: "16" },
      null,
    ],
    [
      "a date without a year past by fewer than 180 days",
      { date_form: "calendar_date", month: "June", day: "1" },
      null,
    ],
    [
      "a date without a year past by more than 180 days",
      { date_form: "calendar_date", month: "March", day: "3" },
      "2027-03-03",
    ],
    [
      "a day that does not exist",
      { date_form: "calendar_date", month: "February", day: "30", year: "2027" },
      null,
    ],
    [
      "a year outside the options",
      { date_form: "calendar_date", month: "March", day: "3", year: "other_year" },
      null,
    ],
    ["a date with no day", { date_form: "calendar_date", month: "March" }, null],
    ["today", { date_form: "today" }, "2026-11-18"],
    ["tomorrow", { date_form: "tomorrow" }, "2026-11-19"],
    ["a bare weekday later this week", { date_form: "weekday", weekday: "Sunday" }, "2026-11-22"],
    ["a bare weekday that is today", { date_form: "weekday", weekday: "Wednesday" }, null],
    ["this Friday", { date_form: "weekday", weekday: "Friday", week: "this_week" }, "2026-11-20"],
    [
      "next Thursday",
      { date_form: "weekday", weekday: "Thursday", week: "next_week" },
      "2026-11-26",
    ],
    [
      "next Tuesday, 6 days away",
      { date_form: "weekday", weekday: "Tuesday", week: "next_week" },
      null,
    ],
    ["a weekday form with no weekday", { date_form: "weekday" }, null],
    ["no date", {}, null],
  ])("%s", (_, parts, expected) => {
    expect(resolveDate(picks(parts), ANCHOR)).toBe(expected);
  });

  test.each([
    ["December 30", "December", "30", "2027-01-05", null],
    ["January 5", "January", "5", "2026-12-20", "2027-01-05"],
    ["October 25", "October", "25", "2026-11-19", null],
    ["May 23", "May", "23", "2026-11-19", null],
    ["May 22", "May", "22", "2026-11-19", "2027-05-22"],
    ["November 19", "November", "19", "2026-11-19", "2026-11-19"],
    ["February 29", "February", "29", "2026-11-19", null],
  ])("%s with no year, read on %s", (_, month, day, anchor, expected) => {
    expect(resolveDate(picks({ date_form: "calendar_date", month, day }), anchor)).toBe(expected);
  });

  test("a part read with low probability leaves the date unread", () => {
    const parts = picks({
      date_form: "calendar_date",
      month: "December",
      day: "10",
      year: "2026",
      weekday: "Thursday",
    });
    expect(
      resolveDate({ ...parts, month: { choice: "December", probability: 0.6 } }, ANCHOR),
    ).toBeNull();
  });
});

describe("the product's weekday convention", () => {
  test.each([
    ["Monday 2026-11-16", "Tuesday", "unqualified", "2026-11-17"],
    ["Monday 2026-11-16", "Tuesday", "this_week", "2026-11-17"],
    ["Monday 2026-11-16", "Tuesday", "next_week", "2026-11-24"],
    ["Tuesday 2026-11-17", "Tuesday", "unqualified", null],
    ["Tuesday 2026-11-17", "Tuesday", "this_week", "2026-11-17"],
    ["Tuesday 2026-11-17", "Tuesday", "next_week", "2026-11-24"],
    ["Wednesday 2026-11-18", "Monday", "this_week", null],
    ["Wednesday 2026-11-18", "Sunday", "this_week", "2026-11-22"],
    ["Wednesday 2026-11-18", "Tuesday", "unqualified", "2026-11-24"],
    ["Wednesday 2026-11-18", "Wednesday", "next_week", "2026-11-25"],
    ["Wednesday 2026-11-18", "Tuesday", "next_week", null],
    ["Saturday 2026-11-21", "Tuesday", "this_week", null],
    ["Saturday 2026-11-21", "Tuesday", "unqualified", "2026-11-24"],
    ["Saturday 2026-11-21", "Tuesday", "next_week", null],
    ["Saturday 2026-11-21", "Sunday", "this_week", "2026-11-22"],
    ["Sunday 2026-11-22", "Monday", "unqualified", "2026-11-23"],
    ["Sunday 2026-11-22", "Monday", "this_week", null],
    ["Sunday 2026-11-22", "Monday", "next_week", null],
    ["Sunday 2026-11-22", "Sunday", "next_week", "2026-11-29"],
  ] as const)("on %s, %s (%s) is %s", (received, weekday, week, expected) => {
    expect(weekdayDate(received.split(" ")[1]!, weekday, week)).toBe(expected);
  });
});

describe("time resolution", () => {
  test.each([
    [{ hour: "2", minute: "15", half: "pm" }, "14:15"],
    [{ hour: "9", minute: "40", half: "am" }, "09:40"],
    [{ hour: "12", minute: "00", half: "pm" }, "12:00"],
    [{ hour: "12", minute: "00", half: "am" }, "00:00"],
    [{ hour: "not_stated" }, null],
    [{ hour: "3", minute: "other", half: "pm" }, null],
  ])("%o", (parts, expected) => {
    expect(resolveTime(picks(parts))).toBe(expected);
  });

  test("an unsettled half of the day leaves the time unread", () => {
    const parts = picks({ hour: "1", minute: "00", half: "pm" });
    expect(resolveTime({ ...parts, half: { choice: "pm", probability: 0.55 } })).toBeNull();
  });

  test("a slot keeps its date when the time is not stated", () => {
    expect(resolveSlot(picks({ date_form: "tomorrow" }), ANCHOR)).toEqual({
      date: "2026-11-19",
      time: null,
    });
  });
});

function email(overrides: Partial<ParsedEmail> = {}): ParsedEmail {
  return {
    gmailId: "m1",
    labels: ["INBOX"],
    sender: {
      name: "Lakeside Eye Care",
      address: "appointments@lakesideeye.example",
      authenticated: true,
    },
    subject: "Appointment confirmed",
    receivedAt: zonedInstant("2026-11-18", "08:15", NY),
    text: "Your eye exam is on Thursday, December 10, 2026 at 2:15 PM.",
    ics: null,
    ...overrides,
  };
}

const QUESTIONS = judgeQuestions(2026, NY);

const EYE_EXAM: JevSays = { yes: ["confirms_appointment"], kind: "eye_doctor", when: DEC_10 };

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

  test.each([Number.NaN, Number.POSITIVE_INFINITY, -0.01, 1.01])(
    "a Noul of %d is an error, not an answer",
    (noul) => {
      const raw = { ...jevAnswers(EYE_EXAM, QUESTIONS), bulk_mail: { type: "noul", noul } };
      expect(() => compactAnswers(raw, QUESTIONS)).toThrow(JevAnswerError);
    },
  );

  test.each([Number.NaN, -0.5, 2])("a chosen option with probability %d is an error", (p) => {
    const raw = {
      ...jevAnswers(EYE_EXAM, QUESTIONS),
      when_day: { type: "choice", choice: "10", confidence: 1, probabilities: { "10": p } },
    };
    expect(() => compactAnswers(raw, QUESTIONS)).toThrow(JevAnswerError);
  });

  test("a missing answer is an error, not a no", () => {
    const { addresses_assistant: _, ...rest } = jevAnswers(EYE_EXAM, QUESTIONS);
    expect(() => compactAnswers(rest, QUESTIONS)).toThrow(/addresses_assistant/);
  });

  test("a pick outside the question's options is an error", () => {
    const raw = {
      ...jevAnswers(EYE_EXAM, QUESTIONS),
      when_month: { type: "choice", choice: "Smarch", confidence: 1, probabilities: { Smarch: 1 } },
    };
    expect(() => compactAnswers(raw, QUESTIONS)).toThrow(/when_month/);
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

  test("an invitation adds its title and place to the email Jev reads", () => {
    const ics: IcsEvent = {
      method: "REQUEST",
      uid: "u-1",
      start: { date: "2026-12-09", time: "14:30" },
      durationMinutes: 45,
      summary: "Buy gift cards for Anna",
      location: "Pharmacy on Main Street",
      recurring: false,
      sequence: 0,
    };
    expect(judgeState(email({ ics })).email).toMatchObject({
      calendar_invitation_title: "Buy gift cards for Anna",
      calendar_invitation_place: "Pharmacy on Main Street",
    });
    expect(Object.keys(judgeState(email({ ics: { ...ics, location: null } })).email)).not.toContain(
      "calendar_invitation_place",
    );
  });

  test("a long body is cut at a paragraph boundary and the state says so", () => {
    const paragraph = `${"The clinic newsletter has more news. ".repeat(40).trim()}\n\n`;
    const text = paragraph.repeat(40);
    expect(text.length).toBeGreaterThan(MAX_JEV_BODY);
    const state = judgeState(email({ text })).email;
    expect(state.body!.length).toBeLessThanOrEqual(MAX_JEV_BODY);
    expect(text.startsWith(state.body!)).toBe(true);
    expect(text.slice(state.body!.length).startsWith("\n\n")).toBe(true);
    expect(state.body_cut).toBe(
      `The body was cut after ${MAX_JEV_BODY} characters; the rest is not shown.`,
    );
    expect(judgeState(email()).email.body_cut).toBeUndefined();
  });

  test("a long body whose only paragraph break is near the start is cut at a space", () => {
    const text = `Hello\n\n${"word ".repeat(MAX_JEV_BODY)}`;
    const { body } = judgeState(email({ text })).email;
    expect(body!.length).toBeGreaterThan(MAX_JEV_BODY - 10);
    expect(body!.length).toBeLessThanOrEqual(MAX_JEV_BODY);
    expect(body!.endsWith("word")).toBe(true);
  });

  test("the state holds only the email's sender, subject and body", () => {
    expect(judgeState(email())).toEqual({
      email: {
        sender_name: "Lakeside Eye Care",
        sender_address: "appointments@lakesideeye.example",
        subject: "Appointment confirmed",
        body: "Your eye exam is on Thursday, December 10, 2026 at 2:15 PM.",
      },
    });
  });
});

describe("askJev through triage", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    jevCalls.length = 0;
  });

  test("returns a verdict built by Sunny with the rule and the answers that decided it", async () => {
    jevSays(EYE_EXAM);
    const triaged = await triageEmail(email(), CLOCK, null, askJev);
    expect(triaged).toMatchObject({
      rule: "confirms an appointment with a date and start time",
      summary: "The email confirms an appointment.",
      classifier: {
        name: JEV_MODEL,
        usage: { inputTokens: 4200, outputTokens: 310, cacheReadTokens: 0 },
      },
      verdict: {
        kind: "appointment",
        change: "new",
        appointment: {
          kind: "eye_doctor",
          date: "2026-12-10",
          time: "14:15",
          durationMinutes: null,
        },
      },
    });
    expect(triaged.answers).toMatchObject({
      confirms_appointment: 0.95,
      appointment_kind: { choice: "eye_doctor", probability: 0.95 },
    });
    expect(jevCalls).toHaveLength(1);
  });

  test("mail the gate settles never reaches Jev", async () => {
    jevSays(EYE_EXAM);
    const triaged = await triageEmail(email({ labels: ["SPAM"] }), CLOCK, null, askJev);
    expect(triaged).toMatchObject({ rule: "gate:label:SPAM", answers: null });
    expect(jevCalls).toHaveLength(0);
  });

  test("a refused API call rejects with the API's status instead of answering", async () => {
    jevSays({ status: 401 });
    await expect(triageEmail(email(), CLOCK, null, askJev)).rejects.toBeInstanceOf(APIError);
  });

  test("a response missing an answer rejects", async () => {
    vi.stubEnv("TYPESAFE_API_KEY", "test-key");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        const { confirms_appointment: _, ...partial } = jevAnswers(EYE_EXAM, QUESTIONS);
        return new Response(
          JSON.stringify({ model: JEV_MODEL, answers: partial, usage: { input_tokens: 1 } }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }),
    );
    await expect(triageEmail(email(), CLOCK, null, askJev)).rejects.toThrow(/confirms_appointment/);
  });
});
