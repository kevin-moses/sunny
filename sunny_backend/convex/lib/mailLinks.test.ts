import { describe, expect, test } from "vitest";
import { appointmentKey, linkKey } from "./mailLinks";
import { appointment, invite, newAppointment } from "./mailPolicyFixtures.helpers";

describe("keys", () => {
  test("appointmentKey prefers the invitation UID and otherwise uses Sunny's title", () => {
    expect(appointmentKey(appointment(), null)).toBe("appt:2026-12-10:14:15:hearing appointment");
    expect(appointmentKey(appointment(), invite({ uid: "u-9" }))).toBe("ics:u-9");
  });

  test("linkKey gives the key to look up for each verdict", () => {
    expect(linkKey(newAppointment(), null)).toBe("appt:2026-12-10:14:15:hearing appointment");
    expect(linkKey({ kind: "ignore" }, null)).toBeNull();
    expect(linkKey({ kind: "ignore" }, invite({ method: "CANCEL", uid: "u-2" }))).toBe("ics:u-2");
  });
});
