import { describe, expect, test } from "vitest";
import { knownInvite, policyFacts } from "./mailFacts";
import type { FactInputs, LinkFact } from "./mailFacts";

const OVER: LinkFact["event"] = { occurs: false, date: "2026-12-01", time: "11:00" };

function inputs(link: LinkFact | null): FactInputs {
  return {
    header: {
      sender: { name: "Rosa", address: "rosa@hairbyrosa.example", authenticated: true },
      subject: "Your haircut",
      receivedAt: 1_000,
    },
    clock: { now: 2_000, timezone: "America/New_York" },
    ics: null,
    events: [],
    link,
    calendarChangesToday: 2,
    seniorNotesToday: 1,
  };
}

describe("policyFacts", () => {
  test("copies the header, clock and counts", () => {
    expect(policyFacts(inputs(null))).toEqual({
      now: 2_000,
      timezone: "America/New_York",
      sender: { name: "Rosa", address: "rosa@hairbyrosa.example", authenticated: true },
      subject: "Your haircut",
      receivedAt: 1_000,
      ics: null,
      events: [],
      linked: null,
      calendarChangesToday: 2,
      seniorNotesToday: 1,
    });
  });

  test("a linked event that can still occur carries no maker", () => {
    const link: LinkFact = {
      eventId: "e1",
      senderAddress: "desk@hairbyrosa.example",
      event: { occurs: true },
    };
    expect(policyFacts(inputs(link)).linked).toEqual({ eventId: "e1", occurs: true });
  });

  test("an event that is over was made by this address when the link holds the sender's address", () => {
    const link = { eventId: "e1", senderAddress: "rosa@hairbyrosa.example", event: OVER };
    expect(policyFacts(inputs(link)).linked).toEqual({
      eventId: "e1",
      occurs: false,
      date: "2026-12-01",
      time: "11:00",
      madeBy: "this_address",
    });
  });

  test("an event that is over was made by another address when the link holds a different one", () => {
    const link = { eventId: "e1", senderAddress: "desk@hairbyrosa.example", event: OVER };
    expect(policyFacts(inputs(link)).linked).toMatchObject({ madeBy: "another_address" });
  });
});

describe("knownInvite", () => {
  test("has no sequence without a link, the link's sequence, or 0 when the link has none", () => {
    expect(knownInvite(null)).toBeNull();
    expect(knownInvite({ sequence: 3 })).toEqual({ sequence: 3 });
    expect(knownInvite({})).toEqual({ sequence: 0 });
  });
});
