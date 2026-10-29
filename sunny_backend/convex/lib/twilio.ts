// lib/twilio.ts
// Purpose: The Twilio side of Sunny's SMS channel, without any Convex database access, so it
// can be unit tested directly. Contents: phone number normalization to E.164; the Twilio
// environment (TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER, and the optional
// TWILIO_WEBHOOK_URL); sending one SMS through Twilio's REST API with a timeout and a result
// that says whether a failure is worth retrying; validating the X-Twilio-Signature header of
// an inbound webhook (HMAC-SHA1 over the exact URL plus the sorted POST parameters,
// base64, constant-time compare); and TwiML reply building with XML escaping.
//
// Why not @convex-dev/twilio: the component has no X-Twilio-Signature validation, stores every
// message body (phone numbers and caregiver replies) in its own tables, and reports send
// failures without a retryable signal. REST plus our own validation covers the whole flow
// in about a hundred lines.
//
// Twilio REST: POST https://api.twilio.com/2010-04-01/Accounts/{SID}/Messages.json with HTTP
// basic auth (SID:token) and a form body To, From, Body. See
// https://www.twilio.com/docs/messaging/api/message-resource#create-a-message-resource
// Signature: https://www.twilio.com/docs/usage/security#validating-requests
//
// Last modified: 2026-10-29

import { ConfigError } from "./errors";

const TWILIO_API = "https://api.twilio.com/2010-04-01";
const SEND_TIMEOUT_MS = 10_000;

/** The URL Twilio calls for inbound SMS unless TWILIO_WEBHOOK_URL overrides it. */
export const DEFAULT_WEBHOOK_URL = "https://enduring-ostrich-959.convex.site/twilio/sms";

/** Outcome of sending one SMS: the Twilio message sid, or why it failed and whether to retry. */
export type SmsResult =
  { ok: true; sid: string } | { ok: false; retryable: boolean; error: string };

/** The Twilio credentials and sender number. */
export interface TwilioConfig {
  accountSid: string;
  authToken: string;
  fromNumber: string;
}

/**
 * purpose: Normalize a phone number to E.164. A 10-digit US number (any common formatting:
 *          spaces, dashes, dots, parentheses) gets +1; a number that already starts with +
 *          must be 8 to 15 digits with no leading zero. Everything else is rejected.
 * @param raw: (string) The number as typed.
 * @return: (string | null) The E.164 number, or null when it cannot be normalized.
 */
export function normalizePhone(raw: string): string | null {
  const trimmed = raw.trim();
  if (!/^\+?[\d\s().-]+$/.test(trimmed)) return null;
  const digits = trimmed.replace(/\D/g, "");
  if (trimmed.startsWith("+")) {
    return /^[1-9]\d{7,14}$/.test(digits) ? `+${digits}` : null;
  }
  return /^[2-9]\d{9}$/.test(digits) ? `+1${digits}` : null;
}

/**
 * purpose: True when a string is exactly an E.164 number.
 * @param value: (string) Candidate.
 * @return: (boolean) Whether it is a "+" followed by 8 to 15 digits, no leading zero.
 */
export function isE164(value: string): boolean {
  return /^\+[1-9]\d{7,14}$/.test(value);
}

/**
 * purpose: Read the Twilio environment needed to send.
 * @return: (TwilioConfig) The credentials and sender number.
 * @raises ConfigError (message starts "SMS is not configured") when a variable is missing or
 *         the sender number is not E.164.
 */
export function twilioConfig(): TwilioConfig {
  const accountSid = process.env["TWILIO_ACCOUNT_SID"];
  const authToken = process.env["TWILIO_AUTH_TOKEN"];
  const fromNumber = process.env["TWILIO_FROM_NUMBER"];
  const missing = [
    ["TWILIO_ACCOUNT_SID", accountSid],
    ["TWILIO_AUTH_TOKEN", authToken],
    ["TWILIO_FROM_NUMBER", fromNumber],
  ]
    .filter(([, value]) => !value)
    .map(([name]) => name);
  if (missing.length > 0 || !accountSid || !authToken || !fromNumber) {
    throw new ConfigError(`SMS is not configured: set ${missing.join(", ")}`);
  }
  if (!isE164(fromNumber)) {
    throw new ConfigError("SMS is not configured: TWILIO_FROM_NUMBER must be E.164");
  }
  return { accountSid, authToken, fromNumber };
}

/**
 * purpose: The exact public URL Twilio calls, which signature validation needs.
 * @return: (string) TWILIO_WEBHOOK_URL, else the default Convex site URL.
 */
export function webhookUrl(): string {
  return process.env["TWILIO_WEBHOOK_URL"] || DEFAULT_WEBHOOK_URL;
}

/**
 * purpose: Strip long digit runs (phone numbers) from a Twilio error message before it is
 *          logged or stored.
 * @param text: (string) Message text.
 * @return: (string) Text with numbers replaced by "[number]".
 */
function redactNumbers(text: string): string {
  return text.replace(/\+?\d[\d\s().-]{6,}\d/g, "[number]");
}

/**
 * purpose: Describe a failed Twilio response without echoing phone numbers.
 * @param response: (Response) The non-2xx response.
 * @return: (Promise<string>) For example "Twilio 400 (code 21211): The 'To' number [number] ...".
 */
async function describeFailure(response: Response): Promise<string> {
  let detail = "";
  try {
    const body = (await response.json()) as { code?: unknown; message?: unknown };
    const code = typeof body.code === "number" ? ` (code ${body.code})` : "";
    const message = typeof body.message === "string" ? `: ${redactNumbers(body.message)}` : "";
    detail = `${code}${message}`;
  } catch {
    detail = "";
  }
  return `Twilio ${response.status}${detail}`;
}

/**
 * purpose: The name of a caught value, for log text that must not contain request details.
 * @param e: (unknown) Caught value.
 * @return: (string) The error name, or "error".
 */
function errorName(e: unknown): string {
  return e instanceof Error ? e.name : "error";
}

/**
 * purpose: Send one SMS through Twilio's REST API. Never throws for a Twilio or network
 *          failure; those come back as { ok: false } with retryable true for a network error,
 *          timeout, 429 or 5xx, and false for any other status (bad number, bad credentials).
 * @param config: (TwilioConfig) Credentials and sender.
 * @param to: (string) Destination, E.164.
 * @param body: (string) Message text.
 * @return: (Promise<SmsResult>) The message sid, or the failure.
 */
export async function sendTwilioSms(
  config: TwilioConfig,
  to: string,
  body: string,
): Promise<SmsResult> {
  if (!isE164(to)) return { ok: false, retryable: false, error: "Destination is not E.164" };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);
  try {
    const response = await fetch(
      `${TWILIO_API}/Accounts/${encodeURIComponent(config.accountSid)}/Messages.json`,
      {
        method: "POST",
        headers: {
          Authorization: `Basic ${btoa(`${config.accountSid}:${config.authToken}`)}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ To: to, From: config.fromNumber, Body: body }),
        signal: controller.signal,
      },
    );
    if (!response.ok) {
      const retryable = response.status === 429 || response.status >= 500;
      return { ok: false, retryable, error: await describeFailure(response) };
    }
    const json = (await response.json()) as { sid?: unknown };
    if (typeof json.sid !== "string") {
      return { ok: false, retryable: false, error: "Twilio accepted the message without a sid" };
    }
    return { ok: true, sid: json.sid };
  } catch (e) {
    return {
      ok: false,
      retryable: true,
      error: controller.signal.aborted
        ? "Twilio did not answer in time"
        : `Twilio request failed: ${errorName(e)}`,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * purpose: Compute the X-Twilio-Signature for a request: HMAC-SHA1, keyed by the auth token,
 *          over the full URL followed by each POST parameter name and value, parameters sorted
 *          by name (values of a repeated name sorted too), base64 encoded.
 * @param url: (string) The exact URL Twilio called.
 * @param params: (URLSearchParams) The form-encoded POST parameters.
 * @param authToken: (string) TWILIO_AUTH_TOKEN.
 * @return: (Promise<string>) Base64 signature.
 */
export async function twilioSignature(
  url: string,
  params: URLSearchParams,
  authToken: string,
): Promise<string> {
  const names = [...new Set(params.keys())].sort();
  let data = url;
  for (const name of names) {
    for (const value of params.getAll(name).sort()) data += name + value;
  }
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(authToken),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data)));
  return btoa(String.fromCharCode(...mac));
}

/**
 * purpose: Compare two strings without leaking where they differ.
 * @param a: (string) First string.
 * @param b: (string) Second string.
 * @return: (boolean) True when equal.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  }
  return diff === 0;
}

/**
 * purpose: Check an inbound webhook's X-Twilio-Signature.
 * @param signature: (string | null) The header value; null or empty fails.
 * @param url: (string) The exact URL Twilio called (the signature covers it).
 * @param params: (URLSearchParams) The form-encoded POST parameters.
 * @param authToken: (string) TWILIO_AUTH_TOKEN.
 * @return: (Promise<boolean>) True when the signature matches.
 */
export async function validateTwilioSignature(
  signature: string | null,
  url: string,
  params: URLSearchParams,
  authToken: string,
): Promise<boolean> {
  if (!signature) return false;
  return constantTimeEqual(signature, await twilioSignature(url, params, authToken));
}

/**
 * purpose: Escape text for an XML element body.
 * @param text: (string) Raw text.
 * @return: (string) Text with & < > " ' escaped.
 */
export function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * purpose: Build a TwiML document.
 * @param message: (string | null) Reply text, escaped here; null for an empty response that
 *        sends nothing.
 * @return: (string) The XML.
 */
export function twiml(message: string | null): string {
  const inner = message === null ? "" : `<Message>${escapeXml(message)}</Message>`;
  return `<?xml version="1.0" encoding="UTF-8"?><Response>${inner}</Response>`;
}
