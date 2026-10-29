// lib/google.test.ts
// Purpose: Tests for the Google OAuth and Calendar client with global fetch mocked (no
// network): consent URL, signed OAuth state (round trip, tampered, expired, wrong secret),
// error mapping (401, 403 forbidden vs rate limit, 404/410 gone, 429/5xx retryable,
// invalid_grant to GoogleAccessRevoked), code exchange parsing, token refresh, calendar
// creation and existence, event upsert (replace vs create vs concurrent create), delete of a
// missing event, request timeouts and missing environment variables.
//
// Last modified: 2026-10-29

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  CALENDAR_SCOPE,
  GoogleAccessRevoked,
  GoogleApiError,
  calendarExists,
  consentUrl,
  createSunnyCalendar,
  deleteEvent,
  exchangeCode,
  refreshAccessToken,
  signState,
  upsertEvent,
  verifyState,
} from "./google";

const ENV_NAMES = [
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "GOOGLE_REDIRECT_URI",
  "GOOGLE_OAUTH_STATE_SECRET",
] as const;
const saved: Record<string, string | undefined> = {};
const fetchMock = vi.fn();

/**
 * purpose: A JSON Response for the fetch mock.
 * @param status: (number) HTTP status.
 * @param body: (unknown) JSON body.
 * @return: (Response) The response.
 */
function json(status: number, body: unknown = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * purpose: An unsigned JWT carrying the given claims, like an ID token.
 * @param claims: (Record<string, unknown>) Payload claims.
 * @return: (string) "header.payload.signature".
 */
function idToken(claims: Record<string, unknown>): string {
  const payload = btoa(JSON.stringify(claims))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  return `e30.${payload}.sig`;
}

/**
 * purpose: The error thrown by a promise expected to reject.
 * @param promise: (Promise<unknown>) The call under test.
 * @return: (Promise<unknown>) The rejection reason.
 */
async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (e) {
    return e;
  }
  throw new Error("expected rejection");
}

beforeEach(() => {
  for (const name of ENV_NAMES) saved[name] = process.env[name];
  process.env.GOOGLE_CLIENT_ID = "client-id";
  process.env.GOOGLE_CLIENT_SECRET = "client-secret";
  process.env.GOOGLE_REDIRECT_URI = "https://example.test/google/callback";
  process.env.GOOGLE_OAUTH_STATE_SECRET = "state-secret";
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  for (const name of ENV_NAMES) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
  vi.unstubAllGlobals();
});

describe("consentUrl", () => {
  test("asks for offline access, consent, and the calendar scope", () => {
    const url = new URL(consentUrl("the-state"));
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(url.searchParams.get("client_id")).toBe("client-id");
    expect(url.searchParams.get("redirect_uri")).toBe("https://example.test/google/callback");
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toBe("consent");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("state")).toBe("the-state");
    expect(url.searchParams.get("scope")).toBe(`openid email ${CALENDAR_SCOPE}`);
  });

  test("names the missing variable", () => {
    delete process.env.GOOGLE_CLIENT_ID;
    expect(() => consentUrl("s")).toThrow("Missing env var GOOGLE_CLIENT_ID");
  });
});

describe("signState and verifyState", () => {
  const now = Date.UTC(2026, 9, 29, 12, 0, 0);

  test("round trips the user and household", async () => {
    const state = await signState("user_1", "house_1", now);
    expect(await verifyState(state, now + 1000)).toEqual({
      userId: "user_1",
      householdId: "house_1",
    });
  });

  test("is valid just under 15 minutes and expired after", async () => {
    const state = await signState("u", "h", now);
    expect(await verifyState(state, now + 14 * 60_000 + 59_000)).not.toBeNull();
    expect(await verifyState(state, now + 15 * 60_000 + 2000)).toBeNull();
  });

  test("a tampered payload is rejected", async () => {
    const [, sig] = (await signState("u", "h", now)).split(".");
    const forgedPayload = btoa(JSON.stringify({ u: "evil", h: "h", e: 9_999_999_999 }));
    expect(await verifyState(`${forgedPayload}.${sig}`, now)).toBeNull();
  });

  test("a tampered signature is rejected", async () => {
    const [payload, sig] = (await signState("u", "h", now)).split(".");
    const flipped = (sig![0] === "A" ? "B" : "A") + sig!.slice(1);
    expect(await verifyState(`${payload}.${flipped}`, now)).toBeNull();
  });

  test("a different secret is rejected", async () => {
    const state = await signState("u", "h", now);
    process.env.GOOGLE_OAUTH_STATE_SECRET = "another-secret";
    expect(await verifyState(state, now)).toBeNull();
  });

  test("malformed states are rejected", async () => {
    expect(await verifyState("", now)).toBeNull();
    expect(await verifyState("nodot", now)).toBeNull();
    expect(await verifyState("a.b.c", now)).toBeNull();
  });

  test("missing secret gives a clear error", async () => {
    delete process.env.GOOGLE_OAUTH_STATE_SECRET;
    await expect(signState("u", "h", now)).rejects.toThrow("GOOGLE_OAUTH_STATE_SECRET");
  });
});

describe("GoogleApiError", () => {
  test.each([
    [401, false, false],
    [403, false, false],
    [404, false, true],
    [410, false, true],
    [429, true, false],
    [500, true, false],
    [503, true, false],
    [400, false, false],
  ])("status %i: retryable %s, gone %s", (status, retryable, gone) => {
    const e = new GoogleApiError(status, "body");
    expect(e.status).toBe(status);
    expect(e.retryable).toBe(retryable);
    expect(e.gone).toBe(gone);
  });

  test("403 for a rate limit is retryable but a plain forbidden is not", () => {
    expect(new GoogleApiError(403, '{"errors":[{"reason":"rateLimitExceeded"}]}').retryable).toBe(
      true,
    );
    expect(
      new GoogleApiError(403, '{"errors":[{"reason":"userRateLimitExceeded"}]}').retryable,
    ).toBe(true);
    expect(new GoogleApiError(403, '{"errors":[{"reason":"forbidden"}]}').retryable).toBe(false);
  });
});

describe("exchangeCode", () => {
  test("parses tokens, scopes and the email from the id_token", async () => {
    fetchMock.mockResolvedValueOnce(
      json(200, {
        access_token: "at",
        refresh_token: "rt",
        scope: `openid email ${CALENDAR_SCOPE}`,
        id_token: idToken({ email: "pat@gmail.com" }),
      }),
    );
    expect(await exchangeCode("the-code")).toEqual({
      accessToken: "at",
      refreshToken: "rt",
      scopes: ["openid", "email", CALENDAR_SCOPE],
      email: "pat@gmail.com",
    });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://oauth2.googleapis.com/token");
    const form = new URLSearchParams(String(init.body));
    expect(form.get("code")).toBe("the-code");
    expect(form.get("grant_type")).toBe("authorization_code");
    expect(form.get("client_secret")).toBe("client-secret");
    expect(form.get("redirect_uri")).toBe("https://example.test/google/callback");
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  test("falls back to userinfo when the id_token has no email", async () => {
    fetchMock
      .mockResolvedValueOnce(
        json(200, { access_token: "at", refresh_token: "rt", scope: "openid", id_token: "x.y.z" }),
      )
      .mockResolvedValueOnce(json(200, { email: "kim@gmail.com" }));
    expect((await exchangeCode("c")).email).toBe("kim@gmail.com");
    expect(fetchMock.mock.calls[1]![0]).toBe("https://openidconnect.googleapis.com/v1/userinfo");
    expect(fetchMock.mock.calls[1]![1].headers.Authorization).toBe("Bearer at");
  });

  test("email is null when neither source has one", async () => {
    fetchMock
      .mockResolvedValueOnce(json(200, { access_token: "at", refresh_token: "rt" }))
      .mockResolvedValueOnce(json(401));
    const result = await exchangeCode("c");
    expect(result.email).toBeNull();
    expect(result.scopes).toEqual([]);
  });

  test("a response without a refresh token is an error", async () => {
    fetchMock.mockResolvedValueOnce(json(200, { access_token: "at" }));
    const e = await rejection(exchangeCode("c"));
    expect(e).toBeInstanceOf(GoogleApiError);
    expect((e as GoogleApiError).status).toBe(400);
  });

  test("invalid_grant means access revoked", async () => {
    fetchMock.mockResolvedValueOnce(
      json(400, { error: "invalid_grant", error_description: "Bad code" }),
    );
    expect(await rejection(exchangeCode("c"))).toBeInstanceOf(GoogleAccessRevoked);
  });

  test("other token errors are GoogleApiError", async () => {
    fetchMock.mockResolvedValueOnce(json(500, { error: "backend_error" }));
    const e = (await rejection(exchangeCode("c"))) as GoogleApiError;
    expect(e).toBeInstanceOf(GoogleApiError);
    expect(e.retryable).toBe(true);
  });
});

describe("refreshAccessToken", () => {
  test("returns the access token and its expiry", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    fetchMock.mockResolvedValueOnce(json(200, { access_token: "fresh", expires_in: 3600 }));
    expect(await refreshAccessToken("rt")).toEqual({
      accessToken: "fresh",
      expiresAt: 1_000_000 + 3_600_000,
    });
    const form = new URLSearchParams(String(fetchMock.mock.calls[0]![1].body));
    expect(form.get("grant_type")).toBe("refresh_token");
    expect(form.get("refresh_token")).toBe("rt");
    vi.restoreAllMocks();
  });

  test("invalid_grant becomes GoogleAccessRevoked", async () => {
    fetchMock.mockResolvedValueOnce(json(400, { error: "invalid_grant" }));
    expect(await rejection(refreshAccessToken("rt"))).toBeInstanceOf(GoogleAccessRevoked);
  });

  test("a non-JSON error body still maps to GoogleApiError", async () => {
    fetchMock.mockResolvedValueOnce(new Response("oops", { status: 502 }));
    const e = (await rejection(refreshAccessToken("rt"))) as GoogleApiError;
    expect(e.status).toBe(502);
    expect(e.retryable).toBe(true);
  });

  test("missing client secret names the variable", async () => {
    delete process.env.GOOGLE_CLIENT_SECRET;
    await expect(refreshAccessToken("rt")).rejects.toThrow("GOOGLE_CLIENT_SECRET");
  });
});

describe("calendar API", () => {
  test("createSunnyCalendar posts a titled calendar and returns its id", async () => {
    fetchMock.mockResolvedValueOnce(json(200, { id: "cal-1" }));
    expect(await createSunnyCalendar("at", "Mom", "America/New_York")).toBe("cal-1");
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://www.googleapis.com/calendar/v3/calendars");
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe("Bearer at");
    expect(JSON.parse(init.body)).toMatchObject({
      summary: "Mom (Sunny)",
      timeZone: "America/New_York",
    });
  });

  test("calendarExists is true on success and false on 404 or 410", async () => {
    fetchMock.mockResolvedValueOnce(json(200, { id: "c" }));
    expect(await calendarExists("at", "c")).toBe(true);
    fetchMock.mockResolvedValueOnce(json(404));
    expect(await calendarExists("at", "c")).toBe(false);
    fetchMock.mockResolvedValueOnce(json(410));
    expect(await calendarExists("at", "c")).toBe(false);
  });

  test("calendarExists rethrows other errors", async () => {
    fetchMock.mockResolvedValueOnce(json(401));
    const e = (await rejection(calendarExists("at", "c"))) as GoogleApiError;
    expect(e.status).toBe(401);
    expect(e.retryable).toBe(false);
  });

  test("calendar ids are URL-encoded", async () => {
    fetchMock.mockResolvedValueOnce(json(200, {}));
    await calendarExists("at", "abc@group.calendar.google.com");
    expect(fetchMock.mock.calls[0]![0]).toBe(
      "https://www.googleapis.com/calendar/v3/calendars/abc%40group.calendar.google.com",
    );
  });

  test("a 403 rate limit is retryable and a 403 forbidden is not", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response('{"error":{"errors":[{"reason":"rateLimitExceeded"}]}}', { status: 403 }),
    );
    expect(((await rejection(calendarExists("at", "c"))) as GoogleApiError).retryable).toBe(true);
    fetchMock.mockResolvedValueOnce(
      new Response('{"error":{"errors":[{"reason":"forbidden"}]}}', { status: 403 }),
    );
    expect(((await rejection(calendarExists("at", "c"))) as GoogleApiError).retryable).toBe(false);
  });
});

describe("upsertEvent", () => {
  const body = { summary: "Walk" };

  test("replaces an existing event by id", async () => {
    fetchMock.mockResolvedValueOnce(json(200, { id: "abc", etag: '"1"' }));
    expect(await upsertEvent("at", "cal", "abc", body)).toEqual({
      id: "abc",
      etag: '"1"',
      created: false,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://www.googleapis.com/calendar/v3/calendars/cal/events/abc");
    expect(init.method).toBe("PUT");
  });

  test("inserts with that id when the event is missing", async () => {
    fetchMock
      .mockResolvedValueOnce(json(404))
      .mockResolvedValueOnce(json(200, { id: "abc", etag: '"2"' }));
    expect(await upsertEvent("at", "cal", "abc", body)).toEqual({
      id: "abc",
      etag: '"2"',
      created: true,
    });
    const [url, init] = fetchMock.mock.calls[1]!;
    expect(url).toBe("https://www.googleapis.com/calendar/v3/calendars/cal/events");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ summary: "Walk", id: "abc" });
  });

  test("a 409 on insert means a concurrent create won, so it replaces", async () => {
    fetchMock
      .mockResolvedValueOnce(json(404))
      .mockResolvedValueOnce(json(409))
      .mockResolvedValueOnce(json(200, { id: "abc", etag: '"3"' }));
    expect(await upsertEvent("at", "cal", "abc", body)).toEqual({
      id: "abc",
      etag: '"3"',
      created: false,
    });
    expect(fetchMock.mock.calls.map((c) => c[1].method)).toEqual(["PUT", "POST", "PUT"]);
  });

  test("a missing calendar surfaces as a gone error", async () => {
    fetchMock.mockResolvedValueOnce(json(404)).mockResolvedValueOnce(json(404));
    const e = (await rejection(upsertEvent("at", "cal", "abc", body))) as GoogleApiError;
    expect(e.gone).toBe(true);
  });

  test("other errors are not swallowed", async () => {
    fetchMock.mockResolvedValueOnce(json(401));
    expect(
      ((await rejection(upsertEvent("at", "cal", "abc", body))) as GoogleApiError).status,
    ).toBe(401);
    fetchMock.mockResolvedValueOnce(json(503));
    expect(
      ((await rejection(upsertEvent("at", "cal", "abc", body))) as GoogleApiError).retryable,
    ).toBe(true);
  });
});

describe("deleteEvent", () => {
  test("deletes by id", async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await deleteEvent("at", "cal", "abc");
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://www.googleapis.com/calendar/v3/calendars/cal/events/abc");
    expect(init.method).toBe("DELETE");
  });

  test("404 and 410 mean already gone", async () => {
    fetchMock.mockResolvedValueOnce(json(404));
    await expect(deleteEvent("at", "cal", "abc")).resolves.toBeUndefined();
    fetchMock.mockResolvedValueOnce(json(410));
    await expect(deleteEvent("at", "cal", "abc")).resolves.toBeUndefined();
  });

  test("other errors propagate", async () => {
    fetchMock.mockResolvedValueOnce(json(429));
    const e = (await rejection(deleteEvent("at", "cal", "abc"))) as GoogleApiError;
    expect(e.retryable).toBe(true);
  });
});
