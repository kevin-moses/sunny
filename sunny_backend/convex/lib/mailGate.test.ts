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
    recurring: false,
    sequence: 0,
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
    expect(gate(email({ labels: ["UNREAD", label], ics: invite() }), null)).toMatchObject({
      stage: "gate",
      verdict: { kind: "ignore" },
      rule: `gate:label:${label}`,
      answers: null,
    });
  });

  test.each(["REQUEST", "CANCEL", "OTHER"] as const)(
    "settles a %s for a repeating event as a decision for the caregivers",
    (method) => {
      for (const known of [null, { sequence: 0 }]) {
        expect(gate(email({ ics: invite({ method, recurring: true }) }), known)).toMatchObject({
          verdict: { kind: "needs_decision", reason: "other" },
          rule: "gate:ics:recurring",
        });
      }
    },
  );

  test("ignores an invitation older than the one Sunny already linked", () => {
    expect(gate(email({ ics: invite({ sequence: 1 }) }), { sequence: 2 })).toMatchObject({
      verdict: { kind: "ignore" },
      rule: "gate:ics:older_sequence",
    });
    expect(gate(email({ ics: invite({ sequence: 2 }) }), { sequence: 2 })).toBeNull();
  });

  test("ignores replies to invitations", () => {
    expect(gate(email({ ics: invite({ method: "REPLY" }) }), { sequence: 0 })).toMatchObject({
      verdict: { kind: "ignore" },
      rule: "gate:ics:reply",
    });
  });

  test("leaves plain mail and every invitation or cancellation to Jev", () => {
    expect(gate(email(), null)).toBeNull();
    for (const method of ["REQUEST", "CANCEL", "OTHER"] as const) {
      for (const known of [null, { sequence: 0 }]) {
        expect(gate(email({ ics: invite({ method }) }), known)).toBeNull();
      }
    }
  });
});
