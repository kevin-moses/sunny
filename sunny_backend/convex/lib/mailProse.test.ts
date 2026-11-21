import { describe, expect, test } from "vitest";
import { caregiverText, displayHeader } from "./mailProse";
import { NY } from "./mailFixtures.helpers";
import { facts } from "./mailPolicyFixtures.helpers";
import { zonedInstant } from "./time";

const SCAM = facts({
  sender: {
    name: "Medicare Help www.medicare-help.example",
    address: "help@medicare-help.example",
    authenticated: false,
  },
  subject: `Urgent: ${"benefits ".repeat(20)}`,
  receivedAt: zonedInstant("2026-11-18", "07:05", NY),
});

describe("caregiverText", () => {
  test("holds only Sunny's lines and the summary, with links and long numbers removed", () => {
    const text = caregiverText([
      "Sunny thinks this may be a scam.",
      "Asks her to call 1-888-555-0199 and visit https://medicare-help.example/verify now.",
    ]);
    expect(text.split("\n")).toEqual([
      "Sunny thinks this may be a scam.",
      "Asks her to call [number removed] and visit [link removed] now.",
    ]);
  });

  test("drops blank lines and clips the body", () => {
    expect(caregiverText(["One.", "  ", "Two."])).toBe("One.\nTwo.");
    expect(caregiverText(["x".repeat(900)])).toHaveLength(600);
  });
});

describe("displayHeader", () => {
  test("scrubs the sender name and subject and gives the received time in the household's zone", () => {
    const header = displayHeader(SCAM);
    expect(header).toMatchObject({
      senderName: "Medicare Help [link removed]",
      senderAddress: "help@medicare-help.example",
      senderVerified: false,
      receivedDate: "2026-11-18",
      receivedTime: "07:05",
    });
    expect(header.subject.length).toBeLessThanOrEqual(120);
    expect(header.subject.endsWith("...")).toBe(true);
  });

  test("marks a verified sender and has no name when the name is blank", () => {
    expect(displayHeader(facts())).toMatchObject({
      senderName: "Lakeside Eye Care",
      senderVerified: true,
      subject: "Your appointment",
    });
    const unnamed = displayHeader(
      facts({ sender: { name: " ", address: "a@b.example", authenticated: true } }),
    );
    expect(unnamed).toMatchObject({ senderName: null, senderAddress: "a@b.example" });
  });
});
