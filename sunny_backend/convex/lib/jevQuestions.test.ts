import { describe, expect, test } from "vitest";
import { MAX_JEV_BODY, judgeState } from "./jevQuestions";
import { email } from "./mailFixtures.helpers";
import type { IcsEvent } from "./mailTypes";

describe("the state Jev reads", () => {
  test("an invitation adds its title and place to the email Jev reads", () => {
    const ics: IcsEvent = {
      method: "REQUEST",
      uid: "u-1",
      start: { date: "2026-12-09", time: "14:30" },
      durationMinutes: 45,
      summary: "Buy gift cards for Anna",
      location: "Pharmacy on Main Street",
      recurring: false,
      sequence: 0,
    };
    expect(judgeState(email({ ics })).email).toMatchObject({
      calendar_invitation_title: "Buy gift cards for Anna",
      calendar_invitation_place: "Pharmacy on Main Street",
    });
    expect(Object.keys(judgeState(email({ ics: { ...ics, location: null } })).email)).not.toContain(
      "calendar_invitation_place",
    );
  });

  test("a long body is cut at a paragraph boundary and the state says so", () => {
    const paragraph = `${"The clinic newsletter has more news. ".repeat(40).trim()}\n\n`;
    const text = paragraph.repeat(40);
    expect(text.length).toBeGreaterThan(MAX_JEV_BODY);
    const state = judgeState(email({ text })).email;
    expect(state.body!.length).toBeLessThanOrEqual(MAX_JEV_BODY);
    expect(text.startsWith(state.body!)).toBe(true);
    expect(text.slice(state.body!.length).startsWith("\n\n")).toBe(true);
    expect(state.body_cut).toBe(
      `The body was cut after ${MAX_JEV_BODY} characters; the rest is not shown.`,
    );
    expect(judgeState(email()).email.body_cut).toBeUndefined();
  });

  test("a long body whose only paragraph break is near the start is cut at a space", () => {
    const text = `Hello\n\n${"word ".repeat(MAX_JEV_BODY)}`;
    const { body } = judgeState(email({ text })).email;
    expect(body!.length).toBeGreaterThan(MAX_JEV_BODY - 10);
    expect(body!.length).toBeLessThanOrEqual(MAX_JEV_BODY);
    expect(body!.endsWith("word")).toBe(true);
  });

  test("the state holds only the email's sender, subject and body", () => {
    expect(judgeState(email())).toEqual({
      email: {
        sender_name: "Lakeside Eye Care",
        sender_address: "appointments@lakesideeye.example",
        subject: "Appointment confirmed",
        body: "Your eye exam is on Thursday, December 10, 2026 at 2:15 PM.",
      },
    });
  });
});
