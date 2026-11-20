import { afterEach, beforeEach, vi } from "vitest";
import { api, internal } from "./_generated/api";
import { resetGoogleMocks } from "./googleMocks.helpers";
import { mailPool } from "./lib/mailPool";
import { jevCalls, mailHousehold, summaryCalls } from "./mailMocks.helpers";
import type { JevSays, MailHousehold, RawEmail } from "./mailMocks.helpers";
import { makeBackend } from "./testing.helpers";

export const NOW = Date.parse("2026-11-18T14:00:00Z");
export const MINUTE = 60_000;
export const DAY = 24 * 60 * MINUTE;

export function useTriageClock(): void {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    resetGoogleMocks();
    jevCalls.length = 0;
    summaryCalls.length = 0;
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });
}

let sequence = 0;

export function clinic(overrides: Partial<RawEmail> = {}): RawEmail {
  sequence += 1;
  return {
    id: `m${sequence}`,
    from: "Lakeside Eye Care <appointments@lakesideeye.example>",
    subject: "Your appointment is confirmed",
    text: "Your eye exam with Dr. Rivera is confirmed for December 10 at 2:15 PM.",
    receivedAt: NOW - 30 * MINUTE,
    ...overrides,
  };
}

export const EYE_EXAM: JevSays = {
  yes: ["confirms_appointment"],
  kind: "eye_doctor",
  when: { date: "2026-12-10", time: "14:15" },
};

export const MOVED_EYE_EXAM: JevSays = {
  yes: ["appointment_moved"],
  kind: "eye_doctor",
  when: { date: "2026-12-12", time: "10:00" },
  before: { date: "2026-12-10", time: "14:15" },
};

export function invite(lines: string[], uid = "visit-42@lakesideeye.example"): string {
  return [
    "BEGIN:VCALENDAR",
    "METHOD:REQUEST",
    "BEGIN:VEVENT",
    `UID:${uid}`,
    "DURATION:PT30M",
    "SUMMARY:Eye exam",
    ...lines,
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");
}

export const PHISHING: JevSays = { yes: ["asks_hard_to_trace_payment"] };

export const DELIVERY: JevSays = { yes: ["about_package"] };

export async function setup(): Promise<MailHousehold> {
  return await mailHousehold(makeBackend());
}

export async function threadAsPat(h: MailHousehold) {
  return await h.t
    .withIdentity({ subject: "pat" })
    .query(api.agentRequests.transcript, { householdId: h.householdId });
}

export function poolFinishesEveryJob(): void {
  vi.spyOn(mailPool, "status").mockResolvedValue({ state: "finished" });
}

export async function reconnectAs(h: MailHousehold, accountEmail: string): Promise<void> {
  await h.t.mutation(internal.gmail.saveMailbox, {
    householdId: h.householdId,
    userId: "pat",
    accountEmail,
    refreshToken: "box:refresh-2",
    historyId: "900",
    ids: [],
  });
}

export function kinds<T extends { kind: string }>(list: T[]): string[] {
  return list.map((r) => r.kind);
}
