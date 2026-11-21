import type { JevSays } from "../mailMocks.helpers";
import { judgeQuestions } from "./jevQuestions";
import type { MailSender, ParsedEmail } from "./mailTypes";
import { zonedInstant } from "./time";

export const NY = "America/New_York";
export const NOW = zonedInstant("2026-11-18", "09:00", NY);
export const CLOCK = { now: NOW, timezone: NY };
export const ANCHOR = "2026-11-18";
export const DEC_10 = { date: "2026-12-10", time: "14:15" };

export const CLINIC: MailSender = {
  name: "Lakeside Eye Care",
  address: "appointments@lakesideeye.example",
  authenticated: true,
};

export function email(overrides: Partial<ParsedEmail> = {}): ParsedEmail {
  return {
    gmailId: "m1",
    labels: ["INBOX"],
    sender: CLINIC,
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
