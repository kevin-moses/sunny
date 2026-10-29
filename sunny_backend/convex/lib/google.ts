// lib/google.ts
// Purpose: Google OAuth and Calendar API client for Sunny's calendar sync, using fetch and
// WebCrypto only (Convex default runtime). Sunny asks for the calendar.app.created scope,
// creates its own secondary calendar in each caregiver's Google account ("Mom (Sunny)") and
// pushes events into it. Covers the consent URL, code exchange, access-token refresh,
// calendar creation, event upsert/delete, error mapping (retryable, gone, revoked), and an
// HMAC-signed OAuth state so the public callback can trust who started the flow. Every
// request has a 15 second timeout. Environment variables are read at call time:
// GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI, GOOGLE_OAUTH_STATE_SECRET.
// Exports: CALENDAR_SCOPE, GoogleApiError, GoogleAccessRevoked, consentUrl, exchangeCode,
// refreshAccessToken, createSunnyCalendar, calendarExists, upsertEvent, deleteEvent,
// signState, verifyState.
//
// Last modified: 2026-10-29

import type { GoogleEvent } from "./googleEvent";

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo";
const CALENDAR_API = "https://www.googleapis.com/calendar/v3";
export const CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar.app.created";
const STATE_TTL_SECONDS = 15 * 60;
const REQUEST_TIMEOUT_MS = 15_000;
const RATE_LIMIT_REASONS = /rateLimitExceeded|userRateLimitExceeded|quotaExceeded/i;

/** A Google API error; `retryable` for rate limits and server errors, `gone` when the
 *  calendar or event no longer exists (404 or 410). */
export class GoogleApiError extends Error {
  status: number;
  retryable: boolean;
  gone: boolean;

  /**
   * purpose: Wrap a failed Google API response.
   * @param status: (number) HTTP status from Google.
   * @param message: (string) Response body or summary.
   */
  constructor(status: number, message: string) {
    super(`Google API ${status}: ${message}`);
    this.name = "GoogleApiError";
    this.status = status;
    // 403 is a permission failure unless Google says it is a rate limit or quota.
    this.retryable =
      status === 429 || status >= 500 || (status === 403 && RATE_LIMIT_REASONS.test(message));
    this.gone = status === 404 || status === 410;
  }
}

/** The caregiver revoked Sunny's access (or the refresh token expired). */
export class GoogleAccessRevoked extends Error {
  /**
   * purpose: Signal that Google no longer honors the stored refresh token.
   * @param message: (string) Google's error description.
   */
  constructor(message: string) {
    super(message);
    this.name = "GoogleAccessRevoked";
  }
}

/**
 * purpose: Read a required environment variable at call time.
 * @param name: (string) Variable name.
 * @return: (string) Its value.
 * @raises Error when unset or empty.
 */
function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing env var ${name}`);
  return value;
}

/**
 * purpose: fetch with the standard request timeout.
 * @param url: (string) Request URL.
 * @param init: (RequestInit) fetch options.
 * @return: (Promise<Response>) The response.
 */
function timedFetch(url: string, init: RequestInit = {}): Promise<Response> {
  return fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
}

/**
 * purpose: Google consent URL asking for offline access to calendars Sunny creates.
 * @param state: (string) Signed state from signState.
 * @return: (string) URL to open in the caregiver's browser.
 */
export function consentUrl(state: string): string {
  const params = new URLSearchParams({
    client_id: env("GOOGLE_CLIENT_ID"),
    redirect_uri: env("GOOGLE_REDIRECT_URI"),
    response_type: "code",
    scope: `openid email ${CALENDAR_SCOPE}`,
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "false",
    state,
  });
  return `${AUTH_URL}?${params}`;
}

/**
 * purpose: POST a form to Google's token endpoint.
 * @param form: (Record<string, string>) Form fields besides the client credentials.
 * @return: (Promise<Record<string, unknown>>) Parsed JSON response.
 * @raises GoogleAccessRevoked on invalid_grant; GoogleApiError on other failures.
 */
async function tokenRequest(form: Record<string, string>): Promise<Record<string, unknown>> {
  const res = await timedFetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env("GOOGLE_CLIENT_ID"),
      client_secret: env("GOOGLE_CLIENT_SECRET"),
      ...form,
    }),
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    if (body.error === "invalid_grant") {
      throw new GoogleAccessRevoked(String(body.error_description ?? "invalid_grant"));
    }
    throw new GoogleApiError(res.status, JSON.stringify(body));
  }
  return body;
}

/**
 * purpose: Read the email claim from an ID token received directly from Google's token
 *          endpoint over TLS (so the signature does not need re-checking here).
 * @param idToken: (string | null) JWT from the token response.
 * @return: (string | null) Email, or null when absent or unreadable.
 */
function emailFromIdToken(idToken: string | null): string | null {
  if (!idToken) return null;
  try {
    const claims = JSON.parse(b64urlDecode(idToken.split(".")[1]!)) as { email?: unknown };
    return typeof claims.email === "string" ? claims.email : null;
  } catch {
    return null;
  }
}

/**
 * purpose: Fetch the account email from the userinfo endpoint; null on any failure.
 * @param accessToken: (string) OAuth access token with the email scope.
 * @return: (Promise<string | null>) Email, or null.
 */
async function emailFromUserinfo(accessToken: string): Promise<string | null> {
  try {
    const res = await timedFetch(USERINFO_URL, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) return null;
    const info = (await res.json()) as { email?: unknown };
    return typeof info.email === "string" ? info.email : null;
  } catch {
    return null;
  }
}

/**
 * purpose: Exchange an authorization code for tokens and the account email.
 * @param code: (string) Code from the OAuth callback.
 * @return: (Promise<{accessToken, refreshToken, scopes, email}>) Tokens, the scopes
 *          actually granted, and the Google account email (from the ID token, else the
 *          userinfo endpoint, else null).
 * @raises GoogleApiError when Google returns no refresh token.
 */
export async function exchangeCode(
  code: string,
): Promise<{ accessToken: string; refreshToken: string; scopes: string[]; email: string | null }> {
  const body = await tokenRequest({
    code,
    grant_type: "authorization_code",
    redirect_uri: env("GOOGLE_REDIRECT_URI"),
  });
  if (typeof body.refresh_token !== "string") {
    throw new GoogleApiError(400, "No refresh token returned");
  }
  const accessToken = String(body.access_token);
  const email =
    emailFromIdToken(typeof body.id_token === "string" ? body.id_token : null) ??
    (await emailFromUserinfo(accessToken));
  return {
    accessToken,
    refreshToken: body.refresh_token,
    scopes: String(body.scope ?? "")
      .split(" ")
      .filter(Boolean),
    email,
  };
}

/**
 * purpose: Get a fresh access token from a stored refresh token.
 * @param refreshToken: (string) The caregiver's refresh token.
 * @return: (Promise<{accessToken, expiresAt}>) Access token and when it expires (epoch ms).
 * @raises GoogleAccessRevoked when the caregiver revoked access.
 */
export async function refreshAccessToken(
  refreshToken: string,
): Promise<{ accessToken: string; expiresAt: number }> {
  const body = await tokenRequest({ refresh_token: refreshToken, grant_type: "refresh_token" });
  return {
    accessToken: String(body.access_token),
    expiresAt: Date.now() + Number(body.expires_in ?? 3600) * 1000,
  };
}

/**
 * purpose: Call the Calendar API with JSON in and out.
 * @param accessToken: (string) OAuth access token.
 * @param method: (string) HTTP method.
 * @param path: (string) Path under /calendar/v3.
 * @param body: (unknown) JSON body, if any.
 * @return: (Promise<Record<string, unknown> | null>) Parsed response, null for 204.
 * @raises GoogleApiError on a non-2xx response.
 */
async function calendarRequest(
  accessToken: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<Record<string, unknown> | null> {
  const res = await timedFetch(`${CALENDAR_API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new GoogleApiError(res.status, await res.text());
  return res.status === 204 ? null : ((await res.json()) as Record<string, unknown>);
}

/**
 * purpose: Create Sunny's secondary calendar in the caregiver's account.
 * @param accessToken: (string) OAuth access token.
 * @param seniorName: (string) The senior's preferred name, used in the calendar title.
 * @param timeZone: (string) Household IANA timezone.
 * @return: (Promise<string>) The new calendar's id.
 */
export async function createSunnyCalendar(
  accessToken: string,
  seniorName: string,
  timeZone: string,
): Promise<string> {
  const created = await calendarRequest(accessToken, "POST", "/calendars", {
    summary: `${seniorName} (Sunny)`,
    description: `${seniorName}'s calendar, kept by Sunny. Add or change events through Sunny.`,
    timeZone,
  });
  return String(created?.id);
}

/**
 * purpose: Check that a calendar Sunny created earlier still exists and is reachable.
 * @param accessToken: (string) OAuth access token.
 * @param calendarId: (string) Calendar id.
 * @return: (Promise<boolean>) False when Google answers 404 or 410.
 */
export async function calendarExists(accessToken: string, calendarId: string): Promise<boolean> {
  try {
    await calendarRequest(accessToken, "GET", `/calendars/${encodeURIComponent(calendarId)}`);
    return true;
  } catch (e) {
    if (e instanceof GoogleApiError && e.gone) return false;
    throw e;
  }
}

/**
 * purpose: Create or replace an event in Sunny's calendar under a fixed id: replace it, or
 *          create it with that id when Google does not have it (409 on create means a
 *          concurrent create won, so replace it). Safe to repeat, so a retried create
 *          never duplicates.
 * @param accessToken: (string) OAuth access token.
 * @param calendarId: (string) Sunny calendar id.
 * @param googleId: (string) Google event id (googleEventId of the Sunny event).
 * @param event: (GoogleEvent) Body from buildGoogleEvent.
 * @return: (Promise<{id, etag, created}>) Google event id, etag, and whether newly created.
 * @raises GoogleApiError with gone = true when the calendar itself no longer exists.
 */
export async function upsertEvent(
  accessToken: string,
  calendarId: string,
  googleId: string,
  event: GoogleEvent,
): Promise<{ id: string; etag: string; created: boolean }> {
  const base = `/calendars/${encodeURIComponent(calendarId)}/events`;
  const put = () =>
    calendarRequest(accessToken, "PUT", `${base}/${encodeURIComponent(googleId)}`, event);
  let saved: Record<string, unknown> | null;
  let created = false;
  try {
    saved = await put();
  } catch (e) {
    if (!(e instanceof GoogleApiError && e.gone)) throw e;
    try {
      saved = await calendarRequest(accessToken, "POST", base, { ...event, id: googleId });
      created = true;
    } catch (inner) {
      if (!(inner instanceof GoogleApiError && inner.status === 409)) throw inner;
      saved = await put();
    }
  }
  return {
    id: String(saved?.id ?? googleId),
    etag: typeof saved?.etag === "string" ? saved.etag : "",
    created,
  };
}

/**
 * purpose: Delete an event from Sunny's calendar; already-gone events (404 or 410) count
 *          as deleted.
 * @param accessToken: (string) OAuth access token.
 * @param calendarId: (string) Sunny calendar id.
 * @param googleId: (string) Google event id.
 * @return: (Promise<void>) Resolves when the event no longer exists.
 */
export async function deleteEvent(
  accessToken: string,
  calendarId: string,
  googleId: string,
): Promise<void> {
  try {
    await calendarRequest(
      accessToken,
      "DELETE",
      `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(googleId)}`,
    );
  } catch (e) {
    if (!(e instanceof GoogleApiError && e.gone)) throw e;
  }
}

// ---------------------------------------------------------------------------
// Signed OAuth state
// ---------------------------------------------------------------------------

/**
 * purpose: Base64url-encode bytes without padding.
 * @param bytes: (Uint8Array) Input bytes.
 * @return: (string) Base64url text.
 */
function b64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/**
 * purpose: Decode base64url text (padding optional) to a UTF-8 string.
 * @param text: (string) Base64url input.
 * @return: (string) Decoded text.
 * @raises Error when the input is not valid base64.
 */
function b64urlDecode(text: string): string {
  const b64 = text.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64.padEnd(b64.length + ((4 - (b64.length % 4)) % 4), "="));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

/**
 * purpose: HMAC-SHA256 of a message with GOOGLE_OAUTH_STATE_SECRET.
 * @param message: (string) Text to sign.
 * @return: (Promise<string>) Base64url signature.
 */
async function hmac(message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(env("GOOGLE_OAUTH_STATE_SECRET")),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return b64url(new Uint8Array(sig));
}

/**
 * purpose: Constant-time string comparison (length is not secret).
 * @param a: (string) First value.
 * @param b: (string) Second value.
 * @return: (boolean) Whether they are equal.
 */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * purpose: Sign the caregiver and household into a short-lived OAuth state.
 * @param userId: (string) Caregiver's user id.
 * @param householdId: (string) Household id.
 * @param now: (number) Current time in ms (tests pass a fixed clock).
 * @return: (Promise<string>) "payload.signature", valid for 15 minutes.
 */
export async function signState(
  userId: string,
  householdId: string,
  now: number = Date.now(),
): Promise<string> {
  const payload = b64url(
    new TextEncoder().encode(
      JSON.stringify({ u: userId, h: householdId, e: Math.floor(now / 1000) + STATE_TTL_SECONDS }),
    ),
  );
  return `${payload}.${await hmac(payload)}`;
}

/**
 * purpose: Verify a state from the OAuth callback.
 * @param state: (string) State parameter returned by Google.
 * @param now: (number) Current time in ms.
 * @return: (Promise<{userId, householdId} | null>) Decoded state, or null if forged,
 *          malformed or expired.
 */
export async function verifyState(
  state: string,
  now: number = Date.now(),
): Promise<{ userId: string; householdId: string } | null> {
  const [payload, signature, extra] = state.split(".");
  if (!payload || !signature || extra !== undefined) return null;
  if (!safeEqual(await hmac(payload), signature)) return null;
  try {
    const data = JSON.parse(b64urlDecode(payload)) as { u?: unknown; h?: unknown; e?: unknown };
    if (typeof data.e !== "number" || data.e * 1000 < now) return null;
    if (typeof data.u !== "string" || typeof data.h !== "string") return null;
    return { userId: data.u, householdId: data.h };
  } catch {
    return null;
  }
}
