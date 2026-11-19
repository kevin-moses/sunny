import { describe, expect, test } from "vitest";
import { VERDICT_SCHEMA, parseVerdict } from "./mailVerdict";

const EMPTY = {
  change: null,
  title: null,
  date: null,
  time: null,
  duration_minutes: null,
  place: null,
  previous_date: null,
  previous_time: null,
  previous_title: null,
  topic: null,
  note: null,
  reason: null,
  suspicion: null,
};

function raw(fields: Record<string, unknown>) {
  return { summary: "Lakeside Eye Care confirmed a visit.", ...EMPTY, ...fields };
}

const NEW_APPOINTMENT = {
  kind: "appointment",
  change: "new",
  title: "Eye exam with Dr. Rivera",
  date: "2026-12-10",
  time: "14:15",
  duration_minutes: 45,
  place: "Lakeside Eye Care, 40 Harbor Road",
};

describe("VERDICT_SCHEMA", () => {
  test("is a flat object that requires every property and allows no others", () => {
    expect(VERDICT_SCHEMA.additionalProperties).toBe(false);
    expect(VERDICT_SCHEMA.required.sort()).toEqual(Object.keys(raw({ kind: "ignore" })).sort());
  });
});

describe("parseVerdict", () => {
  test("reads each verdict kind", () => {
    expect(parseVerdict(raw({ kind: "ignore" }))).toEqual({
      kind: "ignore",
      summary: "Lakeside Eye Care confirmed a visit.",
    });
    expect(parseVerdict(raw(NEW_APPOINTMENT))).toEqual({
      kind: "appointment",
      change: "new",
      appointment: {
        title: "Eye exam with Dr. Rivera",
        date: "2026-12-10",
        time: "14:15",
        durationMinutes: 45,
        place: "Lakeside Eye Care, 40 Harbor Road",
      },
      summary: "Lakeside Eye Care confirmed a visit.",
    });
    expect(
      parseVerdict(
        raw({
          ...NEW_APPOINTMENT,
          change: "reschedule",
          duration_minutes: null,
          place: "  ",
          previous_date: "2026-12-03",
          previous_time: null,
          previous_title: "Eye exam",
        }),
      ),
    ).toMatchObject({
      change: "reschedule",
      previous: { date: "2026-12-03", time: null, title: "Eye exam" },
      appointment: { durationMinutes: null, place: null },
    });
    expect(
      parseVerdict(
        raw({
          kind: "appointment",
          change: "cancel",
          previous_date: "2026-12-02",
          previous_time: "09:00",
          previous_title: "Cleaning",
        }),
      ),
    ).toMatchObject({ change: "cancel", previous: { date: "2026-12-02", time: "09:00" } });
    expect(
      parseVerdict(raw({ kind: "senior_info", topic: "delivery", note: "A package comes today." })),
    ).toMatchObject({ kind: "senior_info", topic: "delivery", note: "A package comes today." });
    expect(parseVerdict(raw({ kind: "needs_decision", reason: "bill_or_payment" }))).toMatchObject({
      kind: "needs_decision",
      reason: "bill_or_payment",
    });
    expect(parseVerdict(raw({ kind: "suspicious", suspicion: "money_request" }))).toMatchObject({
      kind: "suspicious",
      suspicion: "money_request",
    });
  });

  test.each([
    ["not an object", "ignore"],
    ["no summary", { ...EMPTY, kind: "ignore", summary: " " }],
    ["unknown kind", raw({ kind: "call_now" })],
    ["unknown field", { ...raw({ kind: "ignore" }), phone: "555-0100" }],
    ["ignore carrying a note", raw({ kind: "ignore", note: "Call the bank." })],
    ["appointment without a change", raw({ ...NEW_APPOINTMENT, change: null })],
    ["new appointment without a time", raw({ ...NEW_APPOINTMENT, time: null })],
    ["new appointment with a 12-hour time", raw({ ...NEW_APPOINTMENT, time: "2:15 PM" })],
    ["new appointment with an impossible date", raw({ ...NEW_APPOINTMENT, date: "2026-02-30" })],
    [
      "new appointment with a fractional duration",
      raw({ ...NEW_APPOINTMENT, duration_minutes: 4.5 }),
    ],
    [
      "new appointment carrying a previous time",
      raw({ ...NEW_APPOINTMENT, previous_date: "2026-12-01" }),
    ],
    ["new appointment carrying a suspicion", raw({ ...NEW_APPOINTMENT, suspicion: "scam" })],
    [
      "reschedule without the previous date",
      raw({ ...NEW_APPOINTMENT, change: "reschedule", previous_title: "x" }),
    ],
    [
      "cancel carrying a new time",
      raw({
        kind: "appointment",
        change: "cancel",
        previous_date: "2026-12-02",
        previous_title: "x",
        time: "10:00",
      }),
    ],
    ["senior info without a note", raw({ kind: "senior_info", topic: "delivery" })],
    [
      "senior info with an unknown topic",
      raw({ kind: "senior_info", topic: "money", note: "Hi." }),
    ],
    [
      "senior info carrying an appointment",
      raw({ kind: "senior_info", topic: "delivery", note: "Hi.", date: "2026-12-01" }),
    ],
    ["needs decision without a reason", raw({ kind: "needs_decision" })],
    ["suspicious with an unknown suspicion", raw({ kind: "suspicious", suspicion: "phishing" })],
    [
      "suspicious carrying a note",
      raw({ kind: "suspicious", suspicion: "scam", note: "Pay now." }),
    ],
  ])("rejects %s", (_, input) => {
    expect(parseVerdict(input)).toBeNull();
  });
});
