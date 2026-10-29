// sms.ts
// STUB: Part B (the Twilio SMS channel) replaces this file at merge. It exists only so the
// delivery code (delivery.ts) compiles and is tested against the agreed contract:
//   internal.sms.send({ to, body }) -> { ok: true, sid } or { ok: false, retryable, error };
//   throws only for configuration ("SMS is not configured...").
// This stub reports every message as sent.
//
// Last modified: 2026-10-29

import { v } from "convex/values";
import { internalAction } from "./_generated/server";

/** The outcome of one SMS send. */
export type SmsResult =
  { ok: true; sid: string } | { ok: false; retryable: boolean; error: string };

/**
 * purpose: STUB of the SMS send: reports success.
 * @param to: (string) Destination phone number.
 * @param body: (string) Message text.
 * @return: (SmsResult) The outcome.
 */
export const send = internalAction({
  args: { to: v.string(), body: v.string() },
  handler: async (): Promise<SmsResult> => {
    return { ok: true, sid: "STUB" };
  },
});
