// lib/google.ts
// STUB: minimal exports matching the part B contract so calendar sync (part C) compiles and
// its tests can mock this module. The lead replaces this file with part B's real Google
// client at merge. Nothing here talks to Google.
//
// Last modified: 2026-10-29

/** The only OAuth scope Sunny needs: create and edit calendars it made. */
export const CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar.app.created";

/** An error response from the Google API. */
export class GoogleApiError extends Error {
  status: number;
  retryable: boolean;
  gone: boolean;

  /**
   * purpose: Build a Google API error.
   * @param message: (string) What went wrong.
   * @param status: (number) HTTP status.
   * @param retryable: (boolean) Whether a retry may succeed.
   * @param gone: (boolean) Whether the calendar no longer exists.
   */
  constructor(message: string, status: number, retryable = false, gone = false) {
    super(message);
    this.status = status;
    this.retryable = retryable;
    this.gone = gone;
  }
}

/** The caregiver revoked Sunny's access (invalid_grant). */
export class GoogleAccessRevoked extends Error {}

/**
 * purpose: STUB. The consent page URL.
 * @param state: (string) Signed state.
 * @return: (string) URL.
 */
export function consentUrl(state: string): string {
  return `https://accounts.google.com/stub?state=${encodeURIComponent(state)}`;
}

/**
 * purpose: STUB. Exchange an authorization code for tokens.
 * @param _code: (string) Code.
 * @return: (Promise<object>) Tokens.
 */
export async function exchangeCode(_code: string): Promise<{
  accessToken: string;
  refreshToken: string;
  scopes: string[];
  email: string | null;
}> {
  throw new Error("google.ts is a stub");
}

/**
 * purpose: STUB. Refresh an access token.
 * @param _refreshToken: (string) Refresh token.
 * @return: (Promise<object>) Token and expiry (epoch ms).
 */
export async function refreshAccessToken(
  _refreshToken: string,
): Promise<{ accessToken: string; expiresAt: number }> {
  throw new Error("google.ts is a stub");
}

/**
 * purpose: STUB. Create the Sunny calendar.
 * @param _accessToken: (string) Access token.
 * @param _seniorName: (string) Senior's preferred name.
 * @param _timeZone: (string) IANA zone.
 * @return: (Promise<string>) Calendar id.
 */
export async function createSunnyCalendar(
  _accessToken: string,
  _seniorName: string,
  _timeZone: string,
): Promise<string> {
  throw new Error("google.ts is a stub");
}

/**
 * purpose: STUB. Whether a calendar still exists.
 * @param _accessToken: (string) Access token.
 * @param _calendarId: (string) Calendar id.
 * @return: (Promise<boolean>) True when it exists.
 */
export async function calendarExists(_accessToken: string, _calendarId: string): Promise<boolean> {
  throw new Error("google.ts is a stub");
}

/**
 * purpose: STUB. Create or replace an event.
 * @param _accessToken: (string) Access token.
 * @param _calendarId: (string) Calendar id.
 * @param _googleId: (string) Google event id.
 * @param _event: (object) Event body.
 * @return: (Promise<object>) Saved event id, etag, and whether it was created.
 */
export async function upsertEvent(
  _accessToken: string,
  _calendarId: string,
  _googleId: string,
  _event: unknown,
): Promise<{ id: string; etag: string; created: boolean }> {
  throw new Error("google.ts is a stub");
}

/**
 * purpose: STUB. Delete an event (already gone is fine).
 * @param _accessToken: (string) Access token.
 * @param _calendarId: (string) Calendar id.
 * @param _googleId: (string) Google event id.
 * @return: (Promise<void>) Resolves when deleted.
 */
export async function deleteEvent(
  _accessToken: string,
  _calendarId: string,
  _googleId: string,
): Promise<void> {
  throw new Error("google.ts is a stub");
}

/**
 * purpose: STUB. Sign an OAuth state.
 * @param userId: (string) Clerk user id.
 * @param householdId: (string) Household id.
 * @param _now: (number | undefined) Epoch ms.
 * @return: (Promise<string>) State string.
 */
export async function signState(
  userId: string,
  householdId: string,
  _now?: number,
): Promise<string> {
  return `${userId}|${householdId}`;
}

/**
 * purpose: STUB. Verify an OAuth state.
 * @param state: (string) State string.
 * @param _now: (number | undefined) Epoch ms.
 * @return: (Promise<object | null>) The caregiver and household, or null.
 */
export async function verifyState(
  state: string,
  _now?: number,
): Promise<{ userId: string; householdId: string } | null> {
  const [userId, householdId] = state.split("|");
  return userId && householdId ? { userId, householdId } : null;
}
