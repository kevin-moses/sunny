import { fromBase64Url, toBase64Url } from "./base64";
import { ConfigError } from "./errors";
import { parseJsonObject, timedFetch } from "./http";
import type { TimedResponse } from "./http";
import type { GoogleEvent } from "./googleEvent";
import { constantTimeEqual } from "./secretBox";
import { minutes } from "./time";

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo";
const CALENDAR_API = "https://www.googleapis.com/calendar/v3";
export const CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar.app.created";
export const OAUTH_FLOW_TTL_MS = minutes(10);
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const REQUEST_TIMEOUT_MS = 15_000;
const RATE_LIMIT_REASONS = /rateLimitExceeded|userRateLimitExceeded|quotaExceeded/i;

export class GoogleApiError extends Error {
  status: number;
  retryable: boolean;
  gone: boolean;

  constructor(status: number, message: string) {
    super(`Google API ${status}: ${message}`);
    this.name = "GoogleApiError";
    this.status = status;
    this.retryable =
      status === 429 || status >= 500 || (status === 403 && RATE_LIMIT_REASONS.test(message));
    this.gone = status === 404 || status === 410;
  }
}

export class GoogleAccessRevoked extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GoogleAccessRevoked";
  }
}

function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new ConfigError(`Missing env var ${name}`);
  return value;
}

function googleFetch(url: string, init: RequestInit = {}): Promise<TimedResponse> {
  return timedFetch(url, init, REQUEST_TIMEOUT_MS);
}

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

async function tokenRequest(form: Record<string, string>): Promise<Record<string, unknown>> {
  const res = await googleFetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env("GOOGLE_CLIENT_ID"),
      client_secret: env("GOOGLE_CLIENT_SECRET"),
      ...form,
    }),
  });
  const body = parseJsonObject(res.text) ?? {};
  if (!res.ok) {
    if (body.error === "invalid_grant") {
      throw new GoogleAccessRevoked(String(body.error_description ?? "invalid_grant"));
    }
    throw new GoogleApiError(res.status, res.text);
  }
  return body;
}

function emailFromIdToken(idToken: string | null): string | null {
  if (!idToken) return null;
  try {
    const claims = JSON.parse(new TextDecoder().decode(fromBase64Url(idToken.split(".")[1]!))) as {
      email?: unknown;
    };
    return typeof claims.email === "string" ? claims.email : null;
  } catch {
    return null;
  }
}

async function emailFromUserinfo(accessToken: string): Promise<string | null> {
  try {
    const res = await googleFetch(USERINFO_URL, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) return null;
    const info = res.json() as { email?: unknown };
    return typeof info.email === "string" ? info.email : null;
  } catch {
    return null;
  }
}

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
  if (typeof body.access_token !== "string") {
    throw new GoogleApiError(502, "No access token returned");
  }
  const accessToken = body.access_token;
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

export async function refreshAccessToken(
  refreshToken: string,
): Promise<{ accessToken: string; expiresAt: number }> {
  const body = await tokenRequest({ refresh_token: refreshToken, grant_type: "refresh_token" });
  if (typeof body.access_token !== "string") {
    throw new GoogleApiError(502, "No access token returned");
  }
  return {
    accessToken: body.access_token,
    expiresAt: Date.now() + Number(body.expires_in ?? 3600) * 1000,
  };
}

export async function revokeRefreshToken(refreshToken: string): Promise<boolean> {
  try {
    const res = await googleFetch(REVOKE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: refreshToken }),
    });
    if (!res.ok) console.error(`Google token revoke answered ${res.status}`);
    return res.ok;
  } catch (e) {
    console.error(`Google token revoke failed: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}

async function calendarRequest(
  accessToken: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<Record<string, unknown> | null> {
  const res = await googleFetch(`${CALENDAR_API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new GoogleApiError(res.status, res.text);
  return res.status === 204 ? null : (res.json() as Record<string, unknown>);
}

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

export async function calendarExists(accessToken: string, calendarId: string): Promise<boolean> {
  try {
    await calendarRequest(accessToken, "GET", `/calendars/${encodeURIComponent(calendarId)}`);
    return true;
  } catch (e) {
    if (e instanceof GoogleApiError && e.gone) return false;
    throw e;
  }
}

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

async function hmac(message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(env("GOOGLE_OAUTH_STATE_SECRET")),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return toBase64Url(new Uint8Array(sig));
}

export async function signState(
  userId: string,
  householdId: string,
  nonce: string,
  now: number = Date.now(),
): Promise<string> {
  const payload = toBase64Url(
    new TextEncoder().encode(
      JSON.stringify({
        u: userId,
        h: householdId,
        n: nonce,
        e: Math.floor((now + OAUTH_FLOW_TTL_MS) / 1000),
      }),
    ),
  );
  return `${payload}.${await hmac(payload)}`;
}

export async function verifyState(
  state: string,
  now: number = Date.now(),
): Promise<{ userId: string; householdId: string; nonce: string } | null> {
  const [payload, signature, extra] = state.split(".");
  if (!payload || !signature || extra !== undefined) return null;
  if (!constantTimeEqual(await hmac(payload), signature)) return null;
  try {
    const data = JSON.parse(new TextDecoder().decode(fromBase64Url(payload))) as {
      u?: unknown;
      h?: unknown;
      n?: unknown;
      e?: unknown;
    };
    if (typeof data.e !== "number" || data.e * 1000 < now) return null;
    if (typeof data.u !== "string" || typeof data.h !== "string") return null;
    if (typeof data.n !== "string") return null;
    return { userId: data.u, householdId: data.h, nonce: data.n };
  } catch {
    return null;
  }
}
