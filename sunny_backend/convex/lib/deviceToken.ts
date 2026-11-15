import { toBase64Url } from "./base64";

export const DEVICE_TOKEN_PREFIX = "sunny_dev_";

const TOKEN_BYTES = 32;

const TOKEN_PATTERN = new RegExp(`^${DEVICE_TOKEN_PREFIX}[A-Za-z0-9_-]{43}$`);

const BEARER_PATTERN = /^Bearer +(\S+)$/i;

export function generateDeviceToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(TOKEN_BYTES));
  return `${DEVICE_TOKEN_PREFIX}${toBase64Url(bytes)}`;
}

export async function hashDeviceToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

export function parseBearerToken(header: string | null): string | null {
  const match = header === null ? null : BEARER_PATTERN.exec(header.trim());
  const token = match?.[1];
  return token !== undefined && TOKEN_PATTERN.test(token) ? token : null;
}
