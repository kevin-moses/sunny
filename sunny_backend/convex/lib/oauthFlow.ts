import { toBase64Url } from "./base64";
import { NO_STORE } from "./httpResponse";
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

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

export const SECURITY_HEADERS = {
  ...NO_STORE,
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
};

export function oauthPage(title: string, message: string, status = 200): Response {
  const body =
    `<!doctype html><html><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<title>${escapeHtml(title)}</title></head>` +
    `<body style="font-family:-apple-system,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem">` +
    `<h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p></body></html>`;
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8", ...SECURITY_HEADERS },
  });
}

export function expiredPage(): Response {
  return oauthPage("Link expired", "This link has expired. Start again from the Sunny app.", 400);
}

export function errorPage(): Response {
  return oauthPage("Something went wrong", "Google could not be connected. Please try again.", 500);
}
