import { ConvexError } from "convex/values";
import type { AppErrorData } from "./errors";

export const NO_STORE: Readonly<Record<string, string>> = Object.freeze({
  "Cache-Control": "no-store",
});

const MAX_IP_KEY_LENGTH = 64;

const HTTP_STATUS: Record<AppErrorData["code"], number> = {
  not_found: 404,
  invalid: 400,
  forbidden: 403,
  unauthenticated: 401,
  limit: 429,
};

export function jsonResponse(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return Response.json(body, { status, headers: { ...NO_STORE, ...headers } });
}

export function errorResponse(
  status: number,
  code: string,
  message: string,
  headers: Record<string, string> = {},
): Response {
  return jsonResponse({ error: { code, message } }, status, headers);
}

export function rateLimitedResponse(retryAfter: number): Response {
  return errorResponse(429, "rate_limited", "Too many attempts. Try again shortly.", {
    "Retry-After": String(Math.max(1, Math.ceil(retryAfter / 1000))),
  });
}

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

export function clientIp(request: Request): string | null {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) {
    const last = forwarded.split(",").pop()?.trim();
    if (last) return last;
  }
  return request.headers.get("x-real-ip")?.trim() || null;
}

export function ipKey(request: Request): string | null {
  const ip = clientIp(request);
  return ip === null ? null : ip.slice(0, MAX_IP_KEY_LENGTH);
}
