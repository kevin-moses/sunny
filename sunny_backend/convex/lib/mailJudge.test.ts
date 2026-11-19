import { afterEach, describe, expect, test, vi } from "vitest";
import { triageEmail } from "./mailClassify";
import {
  APPOINTMENT_KINDS,
  FLAG_QUESTIONS,
  JEV_MODEL,
  NOTES,
  TRUTH_TABLE,
  decide,
  jevClassifier,
  judgeQuestions,
  judgeState,
  readAnswers,
  resolveDate,
  resolveSlot,
  resolveTime,
  verdictWire,
} from "./mailJudge";
import type { AppointmentKind, Flag, Level, Readings, SlotPicks } from "./mailJudge";
import { appointmentFields, seniorNoteText } from "./mailPolicy";
import type { MailVerdict, ParsedEmail } from "./mailTypes";
import { parseVerdict } from "./mailVerdict";
import { zonedInstant } from "./time";

const NY = "America/New_York";
const CLOCK = { now: zonedInstant("2026-11-18", "09:00", NY), timezone: NY };
const ANCHOR = "2026-11-18";

const NO_FLAGS = Object.fromEntries(Object.keys(FLAG_QUESTIONS).map((f) => [f, "no"])) as Record<
  Flag,
  Level
>;

function readings(
  flags: Partial<Record<Flag, Level>>,
  rest: Partial<Omit<Readings, "flags">> = {},
): Readings {
  return {
    flags: { ...NO_FLAGS, ...flags },
    otherTimeZone: "no",
    kind: "other",
    when: null,
    before: null,
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
    "",
    readings(
      { asks_to_bring_payment: "yes", appointment_moved: "yes" },
      { when: DEC_10, before: NOV_20 },
    ),
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
    "blocks an appointment",
    readings({ discourages_checking: "unsure", confirms_appointment: "yes" }, { when: DEC_10 }),
    "needs_decision:other",
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
    "senior_info:prescription",
  ],
  [
    "prescription",
    "being prepared",
    readings({ about_prescription: "yes", needs_action: "unsure" }),
    "senior_info:prescription",
  ],
  [
    "package",
    "arrived",
    readings({ about_package: "yes", package_arrived: "yes" }),
    "senior_info:delivery",
  ],
  ["package", "on its way", readings({ about_package: "yes" }), "senior_info:delivery"],
  [
    "home visit",
    "",
    readings(
      { home_visit: "yes", confirms_appointment: "yes" },
      { when: { date: "2026-11-19", time: null } },
    ),
    "senior_info:service_visit",
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
    expect(result.verdict.summary.length).toBeGreaterThan(0);
  });

  test("every verdict survives the wire format unchanged", () => {
    for (const [, , input] of ROWS) {
      const { verdict } = decide(input);
      expect(parseVerdict(verdictWire(verdict))).toEqual(verdict);
    }
  });

  test("appointments carry Sunny's own title and no place or duration", () => {
    expect(
      decide(readings({ confirms_appointment: "yes" }, { kind: "eye_doctor", when: DEC_10 }))
        .verdict,
    ).toEqual({
      kind: "appointment",
      change: "new",
      appointment: {
        title: "Eye exam",
        date: "2026-12-10",
        time: "14:15",
        durationMinutes: null,
        place: null,
      },
      summary: "The email confirms an appointment.",
    });
  });

  test("a reschedule names the old slot with the same title", () => {
    const { verdict } = decide(
      readings(
        { appointment_moved: "yes" },
        { kind: "physical_therapy", when: DEC_10, before: NOV_20 },
      ),
    );
    expect(verdict).toMatchObject({
      previous: { date: "2026-11-20", time: "14:00", title: "Physical therapy" },
      appointment: { date: "2026-12-10", time: "14:15", title: "Physical therapy" },
    });
  });

  test.each([
    ["08:00", "Breakfast"],
    ["12:30", "Lunch"],
    ["18:00", "Dinner"],
  ])("a meal at %s is titled %s", (time, title) => {
    const { verdict } = decide(
      readings(
        { confirms_appointment: "yes" },
        { kind: "meal", when: { date: "2026-12-10", time } },
      ),
    );
    expect(verdict).toMatchObject({ appointment: { title } });
  });

  test("every appointment title passes the calendar field checks", () => {
    for (const kind of Object.keys(APPOINTMENT_KINDS) as AppointmentKind[]) {
      const { verdict } = decide(readings({ confirms_appointment: "yes" }, { kind, when: DEC_10 }));
      if (verdict.kind !== "appointment" || verdict.change !== "new") throw new Error(kind);
      expect(appointmentFields(verdict.appointment, CLOCK)).toEqual(verdict.appointment);
    }
  });

  test("every senior note passes the senior note checks for its topic", () => {
    const notes = ROWS.map(([, , input]) => decide(input).verdict).filter(
      (v): v is Extract<MailVerdict, { kind: "senior_info" }> => v.kind === "senior_info",
    );
    expect(new Set(notes.map((v) => v.note))).toEqual(new Set(Object.values(NOTES)));
    for (const v of notes) expect(seniorNoteText(v.note, v.topic, true)).toBe(v.note);
  });
});

function picks(parts: Partial<Record<keyof SlotPicks, string>>, probability = 0.95): SlotPicks {
  const chosen: Record<keyof SlotPicks, string> = {
    date_form: "not_stated",
    month: "not_stated",
    day: "not_stated",
    year: "not_stated",
    weekday: "not_stated",
    week: "unqualified",
    hour: "not_stated",
    minute: "00",
    half: "am",
    ...parts,
  };
  return Object.fromEntries(
    Object.entries(chosen).map(([k, choice]) => [k, { choice, probability }]),
  ) as SlotPicks;
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
      "2026-11-16",
    ],
    [
      "a date without a year well in the past",
      { date_form: "calendar_date", month: "October", day: "1" },
      "2027-10-01",
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
    ["a bare weekday that is today", { date_form: "weekday", weekday: "Wednesday" }, "2026-11-18"],
    ["this Friday", { date_form: "weekday", weekday: "Friday", week: "this_week" }, "2026-11-20"],
    ["next Tuesday", { date_form: "weekday", weekday: "Tuesday", week: "next_week" }, "2026-11-24"],
    ["a weekday form with no weekday", { date_form: "weekday" }, null],
    ["no date", {}, null],
  ])("%s", (_, parts, expected) => {
    expect(resolveDate(picks(parts), ANCHOR)).toBe(expected);
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

function answers(
  nouls: Partial<Record<string, number>>,
  choices: Record<string, string>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(QUESTIONS).map(([name, q]) => {
      if (q.type === "noul") return [name, { type: "noul", noul: nouls[name] ?? 0.02 }];
      const fallback = "not_stated" in q.criteria ? "not_stated" : Object.keys(q.criteria)[0];
      const picked = choices[name] ?? fallback ?? "";
      return [
        name,
        { type: "choice", choice: picked, confidence: 0.9, probabilities: { [picked]: 0.95 } },
      ];
    }),
  );
}

const EYE_EXAM = answers(
  { confirms_appointment: 0.98 },
  {
    appointment_kind: "eye_doctor",
    when_date_form: "calendar_date",
    when_month: "December",
    when_day: "10",
    when_year: "2026",
    when_weekday: "Thursday",
    when_hour: "2",
    when_minute: "15",
    when_half: "pm",
    when_week: "unqualified",
    before_week: "unqualified",
  },
);

describe("reading Jev's answers", () => {
  test("turns probabilities and picks into readings", () => {
    expect(readAnswers(EYE_EXAM, QUESTIONS, ANCHOR)).toMatchObject({
      flags: { confirms_appointment: "yes", addresses_assistant: "no" },
      kind: "eye_doctor",
      when: { date: "2026-12-10", time: "14:15" },
      before: null,
      otherTimeZone: "no",
    });
  });

  test("a missing answer is an error, not a no", () => {
    const { addresses_assistant: _, ...rest } = EYE_EXAM;
    expect(() => readAnswers(rest, QUESTIONS, ANCHOR)).toThrow(/addresses_assistant/);
  });

  test("a pick outside the question's options is an error", () => {
    expect(() =>
      readAnswers(
        {
          ...EYE_EXAM,
          when_month: {
            type: "choice",
            choice: "Smarch",
            confidence: 1,
            probabilities: { Smarch: 1 },
          },
        },
        QUESTIONS,
        ANCHOR,
      ),
    ).toThrow(/when_month/);
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

describe("jevClassifier", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  function respond(status: number, body: unknown): void {
    vi.stubEnv("TYPESAFE_API_KEY", "test-key");
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify(body), {
            status,
            headers: { "content-type": "application/json" },
          }),
      ),
    );
  }

  test("plugs into triage and returns a verdict built by Sunny", async () => {
    respond(200, {
      model: JEV_MODEL,
      answers: EYE_EXAM,
      usage: { input_tokens: 4200, output_tokens: 310 },
    });
    const triaged = await triageEmail(email(), CLOCK, jevClassifier, false);
    expect(triaged).toEqual({
      stage: "model",
      classifier: JEV_MODEL,
      usage: { inputTokens: 4200, outputTokens: 310, cacheReadTokens: 0 },
      verdict: {
        kind: "appointment",
        change: "new",
        appointment: {
          title: "Eye exam",
          date: "2026-12-10",
          time: "14:15",
          durationMinutes: null,
          place: null,
        },
        summary: "The email confirms an appointment.",
      },
    });
  });

  test("a failed API call rejects instead of answering", async () => {
    respond(400, { detail: "bad request" });
    await expect(jevClassifier(email(), CLOCK)).rejects.toThrow();
  });

  test("a response missing an answer rejects", async () => {
    const { confirms_appointment: _, ...partial } = EYE_EXAM;
    respond(200, {
      model: JEV_MODEL,
      answers: partial,
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    await expect(jevClassifier(email(), CLOCK)).rejects.toThrow(/confirms_appointment/);
  });
});
