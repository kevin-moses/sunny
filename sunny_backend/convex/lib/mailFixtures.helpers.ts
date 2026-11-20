import type { JevSays } from "../mailMocks.helpers";
import { judgeQuestions } from "./jevQuestions";
import type { ParsedEmail } from "./mailTypes";
import { zonedInstant } from "./time";

export const NY = "America/New_York";
export const CLOCK = { now: zonedInstant("2026-11-18", "09:00", NY), timezone: NY };
export const ANCHOR = "2026-11-18";
export const DEC_10 = { date: "2026-12-10", time: "14:15" };

export function email(overrides: Partial<ParsedEmail> = {}): ParsedEmail {
  return {
    gmailId: "m1",
    labels: ["INBOX"],
    sender: {
      name: "Lakeside Eye Care",
      address: "appointments@lakesideeye.example",
      authenticated: true,
    },
    subject: "Appointment confirmed",
    receivedAt: zonedInstant("2026-11-18", "08:15", NY),
    text: "Your eye exam is on Thursday, December 10, 2026 at 2:15 PM.",
    ics: null,
    ...overrides,
  };
}

export const QUESTIONS = judgeQuestions(2026, NY);

export const EYE_EXAM: JevSays = {
  yes: ["confirms_appointment"],
  kind: "eye_doctor",
  when: DEC_10,
};
