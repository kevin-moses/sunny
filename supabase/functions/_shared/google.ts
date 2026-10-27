// _shared/google.ts
// Purpose: Google OAuth and Calendar API helpers for Sunny's calendar sync. Sunny asks
// only for the calendar.app.created scope, creates its own secondary calendar in each
// caregiver's Google account ("Mom (Sunny)") and pushes events into it. Covers the
// consent URL, code exchange, access-token refresh, calendar creation, event
// insert/update/delete, the mapping from get_event_sync_payload to a Google event, and a
// signed OAuth state so the public callback can trust who started the flow. Google event
// ids are derived from Sunny's event id, so a retried create can never duplicate an
// event, and every request has a timeout.
// Reads GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI and
// GOOGLE_OAUTH_STATE_SECRET.
//
// Last modified: 2026-10-27

import { safeEqual } from "./admin.ts";

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const CALENDAR_API = "https://www.googleapis.com/calendar/v3";
export const CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar.app.created";
const STATE_TTL_SECONDS = 15 * 60;
const REQUEST_TIMEOUT_MS = 15_000;

/** The event as returned by the get_event_sync_payload RPC. */
export interface EventSyncPayload {
  event_id: string;
  household_id: string;
  cancelled: boolean;
  title: string;
  place: string | null;
  notes: string | null;
  visitor_name: string | null;
  label: string;
  senior_preferred_name: string;
  time_zone: string;
  start_local: string;
  end_local: string;
  rrule: string | null;
  reminder_minutes: number;
  external_event_id: string | null;
}

/** A Google Calendar API error; `retryable` for rate limits and server errors, `gone`
 *  when the calendar or event no longer exists. */
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
    this.status = status;
    this.retryable = status === 429 || status >= 500;
    this.gone = status === 404 || status === 410;
  }
}

/** The caregiver revoked Sunny's access (or the refresh token expired). */
export class GoogleAccessRevoked extends Error {}

/**
 * purpose: Read a required environment variable.
 * @param name: (string) Variable name.
 * @return: (string) Its value.
 */
function env(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`Missing env var ${name}`);
  return value;
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
  const res = await fetch(TOKEN_URL, {
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env("GOOGLE_CLIENT_ID"),
      client_secret: env("GOOGLE_CLIENT_SECRET"),
      ...form,
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (body.error === "invalid_grant") throw new GoogleAccessRevoked(String(body.error_description ?? ""));
    throw new GoogleApiError(res.status, JSON.stringify(body));
  }
  return body;
}

/**
 * purpose: Exchange an authorization code for tokens and the account email.
 * @param code: (string) Code from the OAuth callback.
 * @return: (Promise<{refreshToken, accessToken, email, scopes}>) Tokens, the Google
 *         account email (from the ID token) and the scopes actually granted.
 */
export async function exchangeCode(
  code: string,
): Promise<{ refreshToken: string; accessToken: string; email: string | null; scopes: string[] }> {
  const body = await tokenRequest({
    code,
    grant_type: "authorization_code",
    redirect_uri: env("GOOGLE_REDIRECT_URI"),
  });
  if (typeof body.refresh_token !== "string") {
    throw new GoogleApiError(400, "No refresh token returned");
  }
  return {
    refreshToken: body.refresh_token,
    accessToken: String(body.access_token),
    email: emailFromIdToken(typeof body.id_token === "string" ? body.id_token : null),
    scopes: String(body.scope ?? "").split(" ").filter(Boolean),
  };
}

/**
 * purpose: Read the email claim from an ID token received directly from Google's token
 *          endpoint over TLS (so the signature does not need re-checking here).
 * @param idToken: (string | null) JWT from the token response.
 * @return: (string | null) Email, or null when absent.
 */
function emailFromIdToken(idToken: string | null): string | null {
  if (!idToken) return null;
  try {
    const claims = JSON.parse(b64urlDecode(idToken.split(".")[1]));
    return typeof claims.email === "string" ? claims.email : null;
  } catch {
    return null;
  }
}

/**
 * purpose: Get a fresh access token from a stored refresh token.
 * @param refreshToken: (string) Refresh token from Vault.
 * @return: (Promise<{accessToken, expiresAt}>) Access token and when it expires (epoch ms).
 * @raises GoogleAccessRevoked when the caregiver revoked access.
 */
export async function refreshAccessToken(refreshToken: string): Promise<{ accessToken: string; expiresAt: number }> {
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
  const res = await fetch(`${CALENDAR_API}${path}`, {
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    method,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new GoogleApiError(res.status, await res.text());
  return res.status === 204 ? null : await res.json();
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
 * purpose: Map Sunny's sync payload to a Google Calendar event resource: local times in
 *          the household timezone, a weekly RRULE, a popup reminder on the morning of
 *          the event, and Sunny's event id in private extended properties.
 * @param p: (EventSyncPayload) Result of get_event_sync_payload.
 * @return: (Record<string, unknown>) Google event body.
 */
export function buildGoogleEvent(p: EventSyncPayload): Record<string, unknown> {
  const description = [
    p.notes,
    p.visitor_name ? `With ${p.visitor_name}.` : null,
    p.label !== p.title ? `Shown to ${p.senior_preferred_name} as "${p.label}".` : null,
    "Kept by Sunny: make changes in Sunny, edits here are not synced back yet.",
  ].filter(Boolean).join("\n\n");
  return {
    summary: p.title,
    location: p.place ?? undefined,
    description,
    start: { dateTime: p.start_local, timeZone: p.time_zone },
    end: { dateTime: p.end_local, timeZone: p.time_zone },
    recurrence: p.rrule ? [p.rrule] : undefined,
    reminders: { useDefault: false, overrides: [{ method: "popup", minutes: p.reminder_minutes }] },
    extendedProperties: { private: { sunny_event_id: p.event_id } },
    // Restores the event if it was deleted in Google (deleted ids stay reserved there).
    status: "confirmed",
  };
}

/**
 * purpose: The Google event id for a Sunny event. Google accepts 5-1024 characters of
 *          base32hex (0-9, a-v); a UUID without dashes is lowercase hex, which fits, and
 *          each Sunny calendar belongs to one connection, so the id is unique there.
 * @param eventId: (string) Sunny event UUID.
 * @return: (string) Google event id.
 */
export function googleEventId(eventId: string): string {
  return eventId.replace(/-/g, "").toLowerCase();
}

/**
 * purpose: Create or replace an event in Sunny's calendar under a fixed id: replace it,
 *          or create it with that id when Google does not have it (409 on create means a
 *          concurrent create won, so replace it). Safe to repeat.
 * @param accessToken: (string) OAuth access token.
 * @param calendarId: (string) Sunny calendar id.
 * @param eventId: (string) Google event id (googleEventId of the Sunny event).
 * @param event: (Record<string, unknown>) Body from buildGoogleEvent.
 * @return: (Promise<{id: string, etag: string | null, created: boolean}>) The Google event
 *         id and etag, and whether it was newly created.
 * @raises GoogleApiError with gone = true when the calendar itself no longer exists.
 */
export async function upsertEvent(
  accessToken: string,
  calendarId: string,
  eventId: string,
  event: Record<string, unknown>,
): Promise<{ id: string; etag: string | null; created: boolean }> {
  const base = `/calendars/${encodeURIComponent(calendarId)}/events`;
  const put = () => calendarRequest(accessToken, "PUT", `${base}/${encodeURIComponent(eventId)}`, event);
  let saved: Record<string, unknown> | null;
  let created = false;
  try {
    saved = await put();
  } catch (e) {
    if (!(e instanceof GoogleApiError && e.gone)) throw e;
    try {
      saved = await calendarRequest(accessToken, "POST", base, { ...event, id: eventId });
      created = true;
    } catch (inner) {
      if (!(inner instanceof GoogleApiError && inner.status === 409)) throw inner;
      saved = await put();
    }
  }
  return { id: String(saved?.id), etag: typeof saved?.etag === "string" ? saved.etag : null, created };
}

/**
 * purpose: Delete an event from Sunny's calendar; already-gone events count as deleted.
 * @param accessToken: (string) OAuth access token.
 * @param calendarId: (string) Sunny calendar id.
 * @param externalId: (string) Google event id.
 */
export async function deleteEvent(accessToken: string, calendarId: string, externalId: string): Promise<void> {
  try {
    await calendarRequest(
      accessToken,
      "DELETE",
      `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(externalId)}`,
    );
  } catch (e) {
    if (!(e instanceof GoogleApiError && e.gone)) throw e;
  }
}

// ---------------------------------------------------------------------------
// Signed OAuth state
// ---------------------------------------------------------------------------

/** Who started the OAuth flow, carried through Google in the state parameter. */
export interface OAuthState {
  userId: string;
  householdId: string;
  expiresAt: number;
}

/**
 * purpose: Base64url-encode bytes without padding.
 * @param bytes: (Uint8Array) Input bytes.
 * @return: (string) Base64url text.
 */
function b64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * purpose: Decode base64url text (padding optional) to a string.
 * @param text: (string) Base64url input.
 * @return: (string) Decoded text.
 */
function b64urlDecode(text: string): string {
  const b64 = text.replace(/-/g, "+").replace(/_/g, "/");
  return atob(b64.padEnd(b64.length + ((4 - b64.length % 4) % 4), "="));
}

/**
 * purpose: HMAC-SHA256 of a message with GOOGLE_OAUTH_STATE_SECRET (or the given secret).
 * @param message: (string) Text to sign.
 * @param secret: (string | undefined) Secret override for tests.
 * @return: (Promise<string>) Base64url signature.
 */
async function hmac(message: string, secret?: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret ?? env("GOOGLE_OAUTH_STATE_SECRET")),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return b64url(new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message))));
}

/**
 * purpose: Sign the caregiver and household into a short-lived OAuth state.
 * @param userId: (string) Caregiver's user id.
 * @param householdId: (string) Household id.
 * @param now: (number) Current time in ms (tests pass a fixed clock).
 * @param secret: (string | undefined) Secret override for tests.
 * @return: (Promise<string>) "payload.signature".
 */
export async function signState(
  userId: string,
  householdId: string,
  now = Date.now(),
  secret?: string,
): Promise<string> {
  const payload = b64url(new TextEncoder().encode(JSON.stringify({
    u: userId,
    h: householdId,
    e: Math.floor(now / 1000) + STATE_TTL_SECONDS,
  })));
  return `${payload}.${await hmac(payload, secret)}`;
}

/**
 * purpose: Verify a state from the OAuth callback.
 * @param state: (string) State parameter returned by Google.
 * @param now: (number) Current time in ms.
 * @param secret: (string | undefined) Secret override for tests.
 * @return: (Promise<OAuthState | null>) Decoded state, or null if forged or expired.
 */
export async function verifyState(state: string, now = Date.now(), secret?: string): Promise<OAuthState | null> {
  const [payload, signature] = state.split(".");
  if (!payload || !signature) return null;
  if (!safeEqual(await hmac(payload, secret), signature)) return null;
  try {
    const data = JSON.parse(b64urlDecode(payload));
    if (typeof data.e !== "number" || data.e * 1000 < now) return null;
    return { userId: String(data.u), householdId: String(data.h), expiresAt: data.e };
  } catch {
    return null;
  }
}
