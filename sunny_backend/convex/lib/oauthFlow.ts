import { toBase64Url } from "./base64";
import { minutes } from "./time";

export const OAUTH_TICKET_TTL_MS = minutes(5);
export const OAUTH_FLOW_TTL_MS = minutes(10);
export const FLOW_COOKIE = "__Host-sunny_google_flow";
const COOKIE_ATTRIBUTES = "Path=/; Secure; HttpOnly; SameSite=Lax";

export async function sha256Base64Url(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return toBase64Url(new Uint8Array(digest));
}

export function flowCookie(value: string): string {
  return `${FLOW_COOKIE}=${value}; Max-Age=${OAUTH_FLOW_TTL_MS / 1000}; ${COOKIE_ATTRIBUTES}`;
}

export function clearedFlowCookie(): string {
  return `${FLOW_COOKIE}=; Max-Age=0; ${COOKIE_ATTRIBUTES}`;
}

export function readFlowCookie(request: Request): string | null {
  for (const pair of (request.headers.get("Cookie") ?? "").split(";")) {
    const separator = pair.indexOf("=");
    if (separator > 0 && pair.slice(0, separator).trim() === FLOW_COOKIE) {
      return pair.slice(separator + 1).trim() || null;
    }
  }
  return null;
}
