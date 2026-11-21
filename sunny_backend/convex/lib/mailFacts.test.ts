import { describe, expect, test } from "vitest";
import { knownInvite, linkedEvent } from "./mailFacts";
import type { MailSender } from "./mailTypes";

const ROSA: MailSender = { name: "Rosa", address: "rosa@hairbyrosa.example", authenticated: true };
const ENDED = { date: "2026-12-01", time: "11:00" };

describe("linkedEvent", () => {
  test("a linked event that can still occur carries no maker", () => {
    const link = { eventId: "e1", senderAddress: "desk@hairbyrosa.example" };
    expect(linkedEvent(link, null, ROSA)).toEqual({ eventId: "e1", occurs: true });
  });

  test("an event that is over was made by this address when the link holds the sender's address", () => {
    const link = { eventId: "e1", senderAddress: "rosa@hairbyrosa.example" };
    expect(linkedEvent(link, ENDED, ROSA)).toEqual({
      eventId: "e1",
      occurs: false,
      date: "2026-12-01",
      time: "11:00",
      madeBy: "this_address",
    });
  });

  test("an event that is over was made by another address when the link holds a different one", () => {
    const link = { eventId: "e1", senderAddress: "desk@hairbyrosa.example" };
    expect(linkedEvent(link, ENDED, ROSA)).toMatchObject({ madeBy: "another_address" });
  });
});

describe("knownInvite", () => {
  test("has no sequence without a link, the link's sequence, or 0 when the link has none", () => {
    expect(knownInvite(null)).toBeNull();
    expect(knownInvite({ sequence: 3 })).toEqual({ sequence: 3 });
    expect(knownInvite({})).toEqual({ sequence: 0 });
  });
});
