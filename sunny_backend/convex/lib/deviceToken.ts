// lib/deviceToken.ts
// Purpose: The long-lived device token that clients which cannot sign in with Clerk (the iOS
// widget and Live Activity extensions, the e-ink home display's firmware) send as
// `Authorization: Bearer <token>` to the HTTP device API (deviceApi.ts). A token is an opaque
// random secret: "sunny_dev_" followed by 32 random bytes in base64url without padding (43
// characters). Only its SHA-256 hex digest is stored (devices.tokenHash); the plaintext is
// returned once to the device that asked for it and never logged, stored, scheduled or audited.
// generateDeviceToken must only run where real randomness is available (an action or an HTTP
// action): Convex queries and mutations are deterministic, and their random numbers are not
// secret. parseBearerToken accepts only a well-formed token, so a malformed header never costs
// a database lookup.
//
// Last modified: 2026-11-14

import { toBase64Url } from "./base64";

/** Every device token starts with this, so a leaked token is recognizable in a scan. */
export const DEVICE_TOKEN_PREFIX = "sunny_dev_";

/** Random bytes in a device token. */
const TOKEN_BYTES = 32;

/** A well-formed token: the prefix, then 43 base64url characters (32 bytes, no padding). */
const TOKEN_PATTERN = new RegExp(`^${DEVICE_TOKEN_PREFIX}[A-Za-z0-9_-]{43}$`);

/** "Bearer <token>", the scheme case-insensitive, one or more spaces between. */
const BEARER_PATTERN = /^Bearer +(\S+)$/i;

/**
 * purpose: A new device token. Call only from an action or HTTP action, where
 *          crypto.getRandomValues is a real random source.
 * @return: (string) "sunny_dev_" and 43 base64url characters.
 */
export function generateDeviceToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(TOKEN_BYTES));
  return `${DEVICE_TOKEN_PREFIX}${toBase64Url(bytes)}`;
}

/**
 * purpose: The digest stored for a token and looked up through devices.by_token_hash.
 * @param token: (string) The plaintext token.
 * @return: (Promise<string>) Lowercase hex SHA-256 of the token's UTF-8 bytes (64 characters).
 */
export async function hashDeviceToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * purpose: The device token in an Authorization header, when the header is exactly a Bearer
 *          credential holding a well-formed token.
 * @param header: (string | null) The Authorization header, or null when absent.
 * @return: (string | null) The token, or null for a missing or malformed header or token.
 */
export function parseBearerToken(header: string | null): string | null {
  const match = header === null ? null : BEARER_PATTERN.exec(header.trim());
  const token = match?.[1];
  return token !== undefined && TOKEN_PATTERN.test(token) ? token : null;
}
