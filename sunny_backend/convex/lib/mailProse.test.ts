import { describe, expect, test } from "vitest";
import { caregiverText } from "./mailProse";
import { NY, facts } from "./mailPolicyFixtures.helpers";
import { zonedInstant } from "./time";

describe("caregiverText", () => {
  test("starts with a header Sunny builds and removes links and long numbers from email text", () => {
    const text = caregiverText(
      facts({
        sender: {
          name: "Medicare Help www.medicare-help.example",
          address: "help@medicare-help.example",
          authenticated: false,
        },
        subject: `Urgent: ${"benefits ".repeat(20)}`,
        receivedAt: zonedInstant("2026-11-18", "07:05", NY),
      }),
      [
        "Sunny thinks this may be a scam.",
        "Asks her to call 1-888-555-0199 and visit https://medicare-help.example/verify now.",
      ],
    );
    const [from, subject, received, blank, ...body] = text.split("\n");
    expect(from).toBe(
      "From: Medicare Help [link removed] <help@medicare-help.example> (sender not verified)",
    );
    expect(subject?.length).toBeLessThanOrEqual("Subject: ".length + 120);
    expect(subject?.endsWith("...")).toBe(true);
    expect(received).toBe("Received: Wednesday, November 18 at 7:05 AM");
    expect(blank).toBe("");
    expect(body).toEqual([
      "Sunny thinks this may be a scam.",
      "Asks her to call [number removed] and visit [link removed] now.",
    ]);
  });

  test("marks a verified sender and clips the body", () => {
    const text = caregiverText(facts(), ["x".repeat(900)]);
    expect(text.split("\n")[0]).toBe(
      "From: Lakeside Eye Care <appointments@lakesideeye.example> (verified sender)",
    );
    expect(text.split("\n")[4]?.length).toBe(600);
  });
});
