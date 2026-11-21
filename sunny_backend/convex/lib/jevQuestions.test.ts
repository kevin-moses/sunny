import { describe, expect, test } from "vitest";
import { judgeState } from "./jevQuestions";
import { MAX_BODY_CHARS, shownBody } from "./mailBody";
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

  test("a long body goes to Jev cut, with a note that the rest is not shown", () => {
    const text = "word ".repeat(MAX_BODY_CHARS);
    const state = judgeState(email({ text })).email;
    expect(state.body).toBe(shownBody(text).text);
    expect(state.body_cut).toBe(shownBody(text).cutNote);
    expect(judgeState(email()).email.body_cut).toBeUndefined();
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
