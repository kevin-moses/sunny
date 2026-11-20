import { describe, expect, test } from "vitest";
import { appointmentFields, appointmentKey, linkKey, matchEvent } from "./mailLinks";
import { CLOCK, EVENTS, appointment, invite, newAppointment } from "./mailPolicyFixtures.helpers";
import type { AppointmentRef } from "./mailTypes";

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

describe("keys and matching", () => {
  test("appointmentKey prefers the invitation UID and otherwise uses Sunny's title", () => {
    expect(appointmentKey(appointment(), null)).toBe("appt:2026-12-10:14:15:hearing appointment");
    expect(appointmentKey(appointment(), invite({ uid: "u-9" }))).toBe("ics:u-9");
  });

  test("linkKey gives the key to look up for each verdict", () => {
    expect(linkKey(newAppointment(), null)).toBe("appt:2026-12-10:14:15:hearing appointment");
    expect(linkKey({ kind: "ignore" }, null)).toBeNull();
    expect(linkKey({ kind: "ignore" }, invite({ method: "CANCEL", uid: "u-2" }))).toBe("ics:u-2");
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
});
