// lib/twilio.test.ts
// Purpose: Tests for lib/twilio.ts with a stubbed global fetch (Twilio is never called):
// E.164 normalization, the Twilio environment (missing variables, bad sender), the send
// request shape, the mapping of Twilio responses to { ok, retryable } (2xx, 4xx, 429, 5xx,
// network error, timeout), phone number redaction in error text, X-Twilio-Signature
// computation and validation (valid, tampered, missing, URL and token sensitivity, repeated
// parameters), and TwiML escaping.
//
// Last modified: 2026-10-29

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  DEFAULT_WEBHOOK_URL,
  escapeXml,
  isE164,
  normalizePhone,
  sendTwilioSms,
  twilioConfig,
  twilioSignature,
  twiml,
  validateTwilioSignature,
  webhookUrl,
} from "./twilio";
import type { TwilioConfig } from "./twilio";

const CONFIG: TwilioConfig = {
  accountSid: "AC123",
  authToken: "secret-token",
  fromNumber: "+15550001111",
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("normalizePhone", () => {
  const table: [string, string | null][] = [
    ["5551234567", "+15551234567"],
    ["(555) 123-4567", "+15551234567"],
    ["555.123.4567", "+15551234567"],
    ["  555 123 4567 ", "+15551234567"],
    ["+15551234567", "+15551234567"],
    ["+1 (555) 123-4567", "+15551234567"],
    ["+442071838750", "+442071838750"],
    ["+44 20 7183 8750", "+442071838750"],
    ["15551234567", null],
    ["1234567890", null],
    ["055 123 4567", null],
    ["555123456", null],
    ["55512345678", null],
    ["+0123456789", null],
    ["+1234567", null],
    ["+1234567890123456", null],
    ["555-CALL-NOW", null],
    ["", null],
    ["+", null],
    ["tel:+15551234567", null],
  ];
  test.each(table)("normalizes %j to %j", (input, expected) => {
    expect(normalizePhone(input)).toBe(expected);
  });

  test("isE164 matches only plus-prefixed numbers", () => {
    expect(isE164("+15551234567")).toBe(true);
    expect(isE164("15551234567")).toBe(false);
    expect(isE164("+0555123456")).toBe(false);
  });
});

describe("twilioConfig and webhookUrl", () => {
  test("returns the configuration when all variables are set", () => {
    vi.stubEnv("TWILIO_ACCOUNT_SID", "AC1");
    vi.stubEnv("TWILIO_AUTH_TOKEN", "tok");
    vi.stubEnv("TWILIO_FROM_NUMBER", "+15550001111");
    expect(twilioConfig()).toEqual({
      accountSid: "AC1",
      authToken: "tok",
      fromNumber: "+15550001111",
    });
  });

  test("names every missing variable in an error that starts with the contract text", () => {
    vi.stubEnv("TWILIO_ACCOUNT_SID", "");
    vi.stubEnv("TWILIO_AUTH_TOKEN", "");
    vi.stubEnv("TWILIO_FROM_NUMBER", "+15550001111");
    expect(() => twilioConfig()).toThrow(
      /^SMS is not configured: set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN$/,
    );
  });

  test("rejects a sender number that is not E.164", () => {
    vi.stubEnv("TWILIO_ACCOUNT_SID", "AC1");
    vi.stubEnv("TWILIO_AUTH_TOKEN", "tok");
    vi.stubEnv("TWILIO_FROM_NUMBER", "5550001111");
    expect(() => twilioConfig()).toThrow(/^SMS is not configured: TWILIO_FROM_NUMBER/);
  });

  test("webhookUrl defaults and can be overridden", () => {
    vi.stubEnv("TWILIO_WEBHOOK_URL", "");
    expect(webhookUrl()).toBe(DEFAULT_WEBHOOK_URL);
    vi.stubEnv("TWILIO_WEBHOOK_URL", "https://example.test/twilio/sms");
    expect(webhookUrl()).toBe("https://example.test/twilio/sms");
  });
});

describe("sendTwilioSms", () => {
  /** Stub fetch to answer with a JSON body and status; returns the mock for inspection. */
  function stubFetch(status: number, body: unknown) {
    const mock = vi.fn(async () => Response.json(body, { status }));
    vi.stubGlobal("fetch", mock);
    return mock;
  }

  test("posts a form body with basic auth and returns the sid", async () => {
    const mock = stubFetch(201, { sid: "SM123" });
    const result = await sendTwilioSms(CONFIG, "+15551234567", "Hello there");
    expect(result).toEqual({ ok: true, sid: "SM123" });
    const [url, init] = mock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.twilio.com/2010-04-01/Accounts/AC123/Messages.json");
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe(`Basic ${btoa("AC123:secret-token")}`);
    expect(headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
    const form = init.body as URLSearchParams;
    expect(form.get("To")).toBe("+15551234567");
    expect(form.get("From")).toBe("+15550001111");
    expect(form.get("Body")).toBe("Hello there");
  });

  test("a 400 is not retryable and keeps the Twilio code and a redacted message", async () => {
    stubFetch(400, { code: 21211, message: "The 'To' number +15551234567 is not valid" });
    const result = await sendTwilioSms(CONFIG, "+15551234567", "x");
    expect(result).toEqual({
      ok: false,
      retryable: false,
      error: "Twilio 400 (code 21211): The 'To' number [number] is not valid",
    });
  });

  test("a 401 is not retryable", async () => {
    stubFetch(401, { code: 20003, message: "Authenticate" });
    const result = await sendTwilioSms(CONFIG, "+15551234567", "x");
    expect(result).toMatchObject({ ok: false, retryable: false });
  });

  test("a 429 is retryable", async () => {
    stubFetch(429, { code: 20429, message: "Too many requests" });
    const result = await sendTwilioSms(CONFIG, "+15551234567", "x");
    expect(result).toMatchObject({ ok: false, retryable: true });
  });

  test("a 500 and a 503 are retryable", async () => {
    for (const status of [500, 503]) {
      stubFetch(status, {});
      const result = await sendTwilioSms(CONFIG, "+15551234567", "x");
      expect(result).toMatchObject({ ok: false, retryable: true });
    }
  });

  test("a non-JSON error body still maps by status", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("<html>bad gateway</html>", { status: 502 })),
    );
    const result = await sendTwilioSms(CONFIG, "+15551234567", "x");
    expect(result).toEqual({ ok: false, retryable: true, error: "Twilio 502" });
  });

  test("a network error is retryable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Promise.reject(new TypeError("fetch failed"))),
    );
    const result = await sendTwilioSms(CONFIG, "+15551234567", "x");
    expect(result).toEqual({
      ok: false,
      retryable: true,
      error: "Twilio request failed: TypeError",
    });
  });

  test("a hung request times out and is retryable", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener("abort", () =>
              reject(new DOMException("aborted", "AbortError")),
            );
          }),
      ),
    );
    const pending = sendTwilioSms(CONFIG, "+15551234567", "x");
    await vi.advanceTimersByTimeAsync(10_001);
    expect(await pending).toEqual({
      ok: false,
      retryable: true,
      error: "Twilio did not answer in time",
    });
  });

  test("a 2xx without a sid is a non-retryable failure", async () => {
    stubFetch(201, {});
    const result = await sendTwilioSms(CONFIG, "+15551234567", "x");
    expect(result).toMatchObject({ ok: false, retryable: false });
  });

  test("a destination that is not E.164 is rejected without calling Twilio", async () => {
    const mock = stubFetch(201, { sid: "SM1" });
    const result = await sendTwilioSms(CONFIG, "5551234567", "x");
    expect(result).toMatchObject({ ok: false, retryable: false });
    expect(mock).not.toHaveBeenCalled();
  });
});

describe("Twilio signature", () => {
  const URL_ = "https://example.convex.site/twilio/sms";
  const params = () => new URLSearchParams({ From: "+15551234567", Body: "1", To: "+15550001111" });

  test("matches an independent HMAC-SHA1 computation (openssl)", async () => {
    // printf URL+sorted name/value pairs | openssl dgst -sha1 -hmac 12345 -binary | base64
    const docParams = new URLSearchParams({
      CallSid: "CA1234567890ABCDE",
      Caller: "+12349013030",
      Digits: "1234",
      From: "+12349013030",
      To: "+18005551212",
    });
    const signature = await twilioSignature(
      "https://mycompany.com/myapp.php?foo=1&bar=2",
      docParams,
      "12345",
    );
    expect(signature).toBe("0/KCTR6DLpKmkAf8muzZqo1nDgQ=");
  });

  test("accepts the signature it computed", async () => {
    const sig = await twilioSignature(URL_, params(), "tok");
    expect(await validateTwilioSignature(sig, URL_, params(), "tok")).toBe(true);
  });

  test("does not depend on the order parameters arrive in", async () => {
    const sig = await twilioSignature(URL_, params(), "tok");
    const reordered = new URLSearchParams({ To: "+15550001111", Body: "1", From: "+15551234567" });
    expect(await validateTwilioSignature(sig, URL_, reordered, "tok")).toBe(true);
  });

  test("rejects a missing or empty signature", async () => {
    expect(await validateTwilioSignature(null, URL_, params(), "tok")).toBe(false);
    expect(await validateTwilioSignature("", URL_, params(), "tok")).toBe(false);
  });

  test("rejects a garbage signature", async () => {
    expect(await validateTwilioSignature("not-a-signature", URL_, params(), "tok")).toBe(false);
  });

  test("rejects a tampered parameter", async () => {
    const sig = await twilioSignature(URL_, params(), "tok");
    const tampered = params();
    tampered.set("Body", "2");
    expect(await validateTwilioSignature(sig, URL_, tampered, "tok")).toBe(false);
  });

  test("rejects an extra parameter", async () => {
    const sig = await twilioSignature(URL_, params(), "tok");
    const extra = params();
    extra.set("Extra", "x");
    expect(await validateTwilioSignature(sig, URL_, extra, "tok")).toBe(false);
  });

  test("is sensitive to the exact URL", async () => {
    const sig = await twilioSignature(URL_, params(), "tok");
    for (const other of [
      "https://example.convex.site/twilio/sms/",
      "http://example.convex.site/twilio/sms",
      "https://example.convex.site/twilio/sms?x=1",
      "https://other.convex.site/twilio/sms",
    ]) {
      expect(await validateTwilioSignature(sig, other, params(), "tok")).toBe(false);
    }
  });

  test("is sensitive to the auth token", async () => {
    const sig = await twilioSignature(URL_, params(), "tok");
    expect(await validateTwilioSignature(sig, URL_, params(), "other")).toBe(false);
  });

  test("handles a repeated parameter name deterministically", async () => {
    const a = new URLSearchParams([
      ["Media", "b"],
      ["Media", "a"],
    ]);
    const b = new URLSearchParams([
      ["Media", "a"],
      ["Media", "b"],
    ]);
    expect(await twilioSignature(URL_, a, "tok")).toBe(await twilioSignature(URL_, b, "tok"));
  });
});

describe("TwiML", () => {
  test("escapeXml escapes the five XML characters", () => {
    expect(escapeXml(`<a href="x">Tom & 'Jerry'</a>`)).toBe(
      "&lt;a href=&quot;x&quot;&gt;Tom &amp; &apos;Jerry&apos;&lt;/a&gt;",
    );
  });

  test("twiml wraps an escaped message", () => {
    expect(twiml("Thanks, <Anna> & Co.")).toBe(
      '<?xml version="1.0" encoding="UTF-8"?><Response><Message>Thanks, &lt;Anna&gt; &amp; Co.</Message></Response>',
    );
  });

  test("twiml with null is an empty response", () => {
    expect(twiml(null)).toBe('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
  });
});

beforeEach(() => {
  vi.unstubAllEnvs();
});
