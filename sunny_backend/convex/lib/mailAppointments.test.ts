import { describe, expect, test } from "vitest";
import { appointmentFields, checked, matchEvent } from "./mailAppointments";
import { CLOCK, EVENTS, appointment } from "./mailPolicyFixtures.helpers";
import type { AppointmentRef } from "./mailTypes";

describe("checked", () => {
  test.each([
    ["a malformed date", { date: "12/10/2026" }],
    ["a malformed time", { time: "2:15 PM" }],
  ])("throws on %s", (_, overrides) => {
    expect(() => checked(appointment(overrides))).toThrow("which is not a date and a time");
  });
});

describe("appointmentFields", () => {
  test("accepts a future appointment and the edges of the ranges", () => {
    expect(appointmentFields(checked(appointment()), CLOCK)).toEqual(appointment());
    expect(
      appointmentFields(checked(appointment({ date: "2027-12-23", durationMinutes: 480 })), CLOCK),
    ).not.toBeNull();
    expect(
      appointmentFields(
        checked(appointment({ date: "2026-11-18", time: "09:00", durationMinutes: 5 })),
        CLOCK,
      ),
    ).not.toBeNull();
  });

  test.each([
    ["a time already past", { date: "2026-11-18", time: "08:59" }],
    ["a date over 400 days out", { date: "2027-12-24" }],
    ["a duration under 5 minutes", { durationMinutes: 4 }],
    ["a duration over 480 minutes", { durationMinutes: 481 }],
  ])("rejects %s", (_, overrides) => {
    expect(appointmentFields(checked(appointment(overrides)), CLOCK)).toBeNull();
  });
});

describe("matching", () => {
  test("matchEvent needs a word shared with Sunny's title for the kind and uses the time when given", () => {
    const ids = (ref: AppointmentRef) => matchEvent(ref, EVENTS).map((e) => e.eventId);
    expect(ids({ kind: "eye_doctor", date: "2026-11-24", time: "10:30" })).toEqual(["evt_eye"]);
    expect(ids({ kind: "eye_doctor", date: "2026-11-24", time: null })).toEqual(["evt_eye"]);
    expect(ids({ kind: "hair", date: "2026-11-24", time: "10:30" })).toEqual([]);
    expect(ids({ kind: "other", date: "2026-11-24", time: null })).toEqual([]);
    expect(ids({ kind: "eye_doctor", date: "2026-11-24", time: "11:00" })).toEqual([]);
    expect(ids({ kind: "eye_doctor", date: "2026-11-25", time: "10:30" })).toEqual([]);
  });
});
