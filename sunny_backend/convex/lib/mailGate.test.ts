import { describe, expect, test } from "vitest";
import { gate } from "./mailGate";
import type { IcsEvent, ParsedEmail } from "./mailTypes";

function email(overrides: Partial<ParsedEmail> = {}): ParsedEmail {
  return {
    gmailId: "m1",
    labels: ["INBOX", "CATEGORY_PERSONAL"],
    sender: { name: "Anna Ellis", address: "anna.ellis@example.net", authenticated: true },
    subject: "Thanksgiving",
    receivedAt: Date.parse("2026-11-18T14:00:00Z"),
    text: "Dinner at our place.",
    ics: null,
    ...overrides,
  };
}

function invite(overrides: Partial<IcsEvent> = {}): IcsEvent {
  return {
    method: "REQUEST",
    uid: "thanksgiving-2026@example.net",
    start: { date: "2026-11-26", time: "16:00" },
    durationMinutes: 180,
    summary: "Thanksgiving dinner at Anna's",
    location: "12 Birch Lane",
    ...overrides,
  };
}

describe("gate", () => {
  test.each([
    "SPAM",
    "TRASH",
    "SENT",
    "DRAFT",
    "CATEGORY_PROMOTIONS",
    "CATEGORY_SOCIAL",
    "CATEGORY_FORUMS",
  ])("ignores mail Gmail filed as %s, invite or not", (label) => {
    const result = gate(email({ labels: ["UNREAD", label], ics: invite() }), false);
    expect(result).toEqual({
      kind: "settled",
      triaged: {
        stage: "gate",
        verdict: expect.objectContaining({ kind: "ignore" }),
        rule: `label:${label}`,
      },
    });
  });

  test("sends plain mail to the classifier", () => {
    expect(gate(email(), false)).toEqual({ kind: "classify" });
  });

  test("ignores replies to invitations", () => {
    const result = gate(email({ ics: invite({ method: "REPLY" }) }), true);
    expect(result.kind === "settled" && result.triaged.verdict.kind).toBe("ignore");
  });

  test("turns an invitation with an unknown UID into a new appointment", () => {
    const result = gate(email({ ics: invite() }), false);
    expect(result.kind === "settled" && result.triaged.verdict).toEqual({
      kind: "appointment",
      change: "new",
      appointment: {
        title: "Thanksgiving dinner at Anna's",
        date: "2026-11-26",
        time: "16:00",
        durationMinutes: 180,
        place: "12 Birch Lane",
      },
      summary: "Calendar invitation: Thanksgiving dinner at Anna's on 2026-11-26 at 16:00.",
    });
  });

  test("turns an invitation with a known UID into a reschedule", () => {
    const result = gate(
      email({ ics: invite({ start: { date: "2026-11-26", time: "17:00" } }) }),
      true,
    );
    expect(result.kind === "settled" && result.triaged.verdict).toMatchObject({
      kind: "appointment",
      change: "reschedule",
      appointment: { date: "2026-11-26", time: "17:00" },
    });
  });

  test("turns a cancelled invitation into a cancel, known UID or not", () => {
    for (const known of [true, false]) {
      const result = gate(email({ ics: invite({ method: "CANCEL" }) }), known);
      expect(result.kind === "settled" && result.triaged.verdict).toMatchObject({
        kind: "appointment",
        change: "cancel",
        previous: { date: "2026-11-26", time: "16:00", title: "Thanksgiving dinner at Anna's" },
      });
    }
  });

  test("leaves invitations without a usable start, or with other methods, to the classifier", () => {
    expect(gate(email({ ics: invite({ start: null }) }), false)).toEqual({ kind: "classify" });
    expect(gate(email({ ics: invite({ method: "CANCEL", start: null }) }), true)).toEqual({
      kind: "classify",
    });
    expect(gate(email({ ics: invite({ method: "OTHER" }) }), false)).toEqual({ kind: "classify" });
  });
});
