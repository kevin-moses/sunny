import { toBase64 } from "./base64";
import { ConfigError } from "./errors";
import { isTimeoutError, parseJsonObject, timedFetch } from "./http";
import type { TimedResponse } from "./http";
import { constantTimeEqual } from "./secretBox";

const TWILIO_API = "https://api.twilio.com/2010-04-01";
const SEND_TIMEOUT_MS = 10_000;

export type SmsResult =
  | { ok: true; sid: string }
  | {
      ok: false;
      retryable: boolean;
      error: string;
      twilioCode?: number;
      config?: true;
      timedOut?: true;
    };

export interface TwilioConfig {
  accountSid: string;
  authToken: string;
  fromNumber: string;
}

export function normalizePhone(raw: string): string | null {
  const trimmed = raw.trim();
  if (!/^\+?[\d\s().-]+$/.test(trimmed)) return null;
  const digits = trimmed.replace(/\D/g, "");
  if (trimmed.startsWith("+")) {
    return /^[1-9]\d{7,14}$/.test(digits) ? `+${digits}` : null;
  }
  return /^[2-9]\d{9}$/.test(digits) ? `+1${digits}` : null;
}

export function isE164(value: string): boolean {
  return /^\+[1-9]\d{7,14}$/.test(value);
}

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

export function webhookUrl(): string | null {
  return process.env["TWILIO_WEBHOOK_URL"] || null;
}

function allowedCountryCodes(): string[] {
  const raw: string = process.env["SMS_ALLOWED_COUNTRY_CODES"] || "1";
  return raw
    .split(",")
    .map((code: string) => code.trim().replace(/^\+/, ""))
    .filter((code: string) => /^\d+$/.test(code));
}

export function isAllowedCountry(phone: string): boolean {
  return allowedCountryCodes().some((code) => phone.startsWith(`+${code}`));
}

function redactNumbers(text: string): string {
  return text.replace(/\+?\d[\d\s().-]{6,}\d/g, "[number]");
}

function describeFailure(response: TimedResponse): { error: string; twilioCode?: number } {
  const body = parseJsonObject(response.text) ?? {};
  const twilioCode = typeof body.code === "number" ? body.code : undefined;
  const code = twilioCode === undefined ? "" : ` (code ${twilioCode})`;
  const message = typeof body.message === "string" ? `: ${redactNumbers(body.message)}` : "";
  const error = `Twilio ${response.status}${code}${message}`;
  return twilioCode === undefined ? { error } : { error, twilioCode };
}

function errorName(e: unknown): string {
  return e instanceof Error ? e.name : "error";
}

export async function sendTwilioSms(
  config: TwilioConfig,
  to: string,
  body: string,
): Promise<SmsResult> {
  if (!isE164(to)) return { ok: false, retryable: false, error: "Destination is not E.164" };
  try {
    const response = await timedFetch(
      `${TWILIO_API}/Accounts/${encodeURIComponent(config.accountSid)}/Messages.json`,
      {
        method: "POST",
        headers: {
          Authorization: `Basic ${btoa(`${config.accountSid}:${config.authToken}`)}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ To: to, From: config.fromNumber, Body: body }),
      },
      SEND_TIMEOUT_MS,
    );
    if (!response.ok) {
      const retryable = response.status === 429 || response.status >= 500;
      return { ok: false, retryable, ...describeFailure(response) };
    }
    const json = response.json() as { sid?: unknown };
    if (typeof json.sid !== "string") {
      return { ok: false, retryable: false, error: "Twilio accepted the message without a sid" };
    }
    return { ok: true, sid: json.sid };
  } catch (e) {
    if (isTimeoutError(e)) {
      return { ok: false, retryable: true, timedOut: true, error: "Twilio did not answer in time" };
    }
    return { ok: false, retryable: true, error: `Twilio request failed: ${errorName(e)}` };
  }
}

export async function sendSmsFromEnv(to: string, body: string): Promise<SmsResult> {
  let config: TwilioConfig;
  try {
    config = twilioConfig();
  } catch (e) {
    if (e instanceof ConfigError) {
      return { ok: false, retryable: false, config: true, error: e.message };
    }
    throw e;
  }
  return await sendTwilioSms(config, to, body);
}

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
  return toBase64(mac);
}

export async function validateTwilioSignature(
  signature: string | null,
  url: string,
  params: URLSearchParams,
  authToken: string,
): Promise<boolean> {
  if (!signature) return false;
  return constantTimeEqual(signature, await twilioSignature(url, params, authToken));
}

function stripControlChars(text: string): string {
  return Array.from(text)
    .filter((ch) => {
      const code = ch.codePointAt(0) ?? 0;
      return code === 9 || code === 10 || code === 13 || (code >= 32 && code !== 127);
    })
    .join("");
}

export function escapeXml(text: string): string {
  return stripControlChars(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function twiml(message: string | null): string {
  const inner = message === null ? "" : `<Message>${escapeXml(message)}</Message>`;
  return `<?xml version="1.0" encoding="UTF-8"?><Response>${inner}</Response>`;
}
