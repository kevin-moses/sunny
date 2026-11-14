// lib/httpResponse.ts
// Purpose: Response helpers shared by the backend's HTTP actions for native clients (pairing.ts
// /pair, deviceApi.ts /device/*): JSON bodies and errors in the shape
// { error: { code, message } }, every response marked Cache-Control: no-store, a 429 with
// Retry-After in whole seconds, the mapping of an application error (lib/errors.ts) to its HTTP
// status, and the client IP as far as the request headers reveal it (for courtesy rate-limit
// keys; Convex documents no client IP header for HTTP actions, so it may be absent or spoofed).
//
// Last modified: 2026-11-13

import { ConvexError } from "convex/values";
import type { AppErrorData } from "./errors";

/** Headers on every response: nothing here may be cached. */
export const NO_STORE: Readonly<Record<string, string>> = Object.freeze({
  "Cache-Control": "no-store",
});

/** Longest per-IP rate-limit key, so a forged header cannot create unbounded keys. */
const MAX_IP_KEY_LENGTH = 64;

/** HTTP status for each application error code. */
const HTTP_STATUS: Record<AppErrorData["code"], number> = {
  not_found: 404,
  invalid: 400,
  forbidden: 403,
  unauthenticated: 401,
  limit: 429,
};

/**
 * purpose: A JSON response that must never be cached.
 * @param body: (unknown) JSON body.
 * @param status: (number, optional) HTTP status; default 200.
 * @param headers: (Record<string, string>, optional) Extra headers.
 * @return: (Response) The response.
 */
export function jsonResponse(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return Response.json(body, { status, headers: { ...NO_STORE, ...headers } });
}

/**
 * purpose: A JSON error response in the shape { error: { code, message } }.
 * @param status: (number) HTTP status.
 * @param code: (string) Machine-readable code.
 * @param message: (string) Message safe to show.
 * @param headers: (Record<string, string>, optional) Extra headers.
 * @return: (Response) The response.
 */
export function errorResponse(
  status: number,
  code: string,
  message: string,
  headers: Record<string, string> = {},
): Response {
  return jsonResponse({ error: { code, message } }, status, headers);
}

/**
 * purpose: A 429 response with Retry-After.
 * @param retryAfter: (number) Milliseconds to wait.
 * @return: (Response) The response.
 */
export function rateLimitedResponse(retryAfter: number): Response {
  return errorResponse(429, "rate_limited", "Too many attempts. Try again shortly.", {
    "Retry-After": String(Math.max(1, Math.ceil(retryAfter / 1000))),
  });
}

/**
 * purpose: Map a failure from a Convex function to an HTTP error response. Application errors
 *          keep their code and message; anything else is logged and becomes a generic 500.
 * @param e: (unknown) The caught error.
 * @param label: (string) Log prefix naming the route, e.g. "pairing".
 * @param fallback: (string) The 500 message.
 * @return: (Response) The response.
 */
export function convexErrorResponse(e: unknown, label: string, fallback: string): Response {
  if (e instanceof ConvexError) {
    const data = e.data as Partial<AppErrorData>;
    const status = data.code === undefined ? undefined : HTTP_STATUS[data.code];
    if (status !== undefined && typeof data.message === "string") {
      return errorResponse(status, data.code!, data.message);
    }
  }
  console.error(`${label}: unexpected error: ${String(e)}`);
  return errorResponse(500, "server_error", fallback);
}

/**
 * purpose: The client IP as far as the request headers reveal it: the rightmost
 *          x-forwarded-for entry (the one appended by the nearest proxy), else x-real-ip.
 * @param request: (Request) The HTTP request.
 * @return: (string | null) The address, or null when no header carries one.
 */
export function clientIp(request: Request): string | null {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) {
    const last = forwarded.split(",").pop()?.trim();
    if (last) return last;
  }
  return request.headers.get("x-real-ip")?.trim() || null;
}

/**
 * purpose: The per-IP rate limit key: the client IP truncated to 64 characters.
 * @param request: (Request) The HTTP request.
 * @return: (string | null) The key, or null when no IP is known.
 */
export function ipKey(request: Request): string | null {
  const ip = clientIp(request);
  return ip === null ? null : ip.slice(0, MAX_IP_KEY_LENGTH);
}
