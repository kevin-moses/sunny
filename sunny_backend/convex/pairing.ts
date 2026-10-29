// convex/pairing.ts
// Purpose: Device pairing over HTTP. A signed-out senior device POSTs a join code to /pair
// (routed in http.ts) and gets back a Clerk sign-in ticket for a freshly created device
// user. Flow: overall rate limit -> failed-attempt limit check -> check the code is a
// redeemable device code (so bad codes never cost a Clerk call) -> create the Clerk user ->
// households.pairDevice -> create a sign-in token. Any failure after the Clerk user exists
// deletes it again, and a failure after pairing rolls the pairing back (a failing rollback is
// logged and the Clerk user is still deleted). Also holds the best-effort action that
// deletes a device's Clerk user on unpairing. Every /pair response carries
// Cache-Control: no-store, and every Clerk call times out after 8 seconds.
//
// Lost response: the client may send a random `pairingNonce` (16 to 128 characters). It is
// stored on the device row with the pairing time. If the response is lost and the client
// retries with the same code and nonce within 10 minutes, /pair answers with a fresh sign-in
// token for the same device user (same 200 body) instead of 404. A missing or different
// nonce, a deleted device or a late retry keeps the 404.
//
// Rate limits: an overall bucket (300/min) is spent on every request. Failed code checks
// spend a strict failed-attempt bucket (30/min global, 10/min per client IP when an IP is
// known); once that bucket is empty /pair answers 429 before looking at the code. Convex
// documents no client IP header for HTTP actions: clientIp reads the rightmost
// x-forwarded-for entry, else x-real-ip, which may be absent or spoofable, so the global
// failed-attempt bucket is the real limit and the per-IP bucket is only a courtesy. The IP
// key is truncated to 64 characters.
//
// Clerk Backend API (Bearer CLERK_SECRET_KEY):
//   POST   https://api.clerk.com/v1/users            create a user; fields used: public_metadata
//          { sunny_kind: "device" }, external_id, skip_password_requirement. No email,
//          phone, username or password. See https://clerk.com/docs/reference/backend/user/create-user
//   DELETE https://api.clerk.com/v1/users/{user_id}  delete a user
//   POST   https://api.clerk.com/v1/sign_in_tokens   { user_id, expires_in_seconds }; the
//          response token is the "ticket" for the app's ticket sign-in strategy. See
//          https://clerk.com/docs/reference/backend/sign-in-tokens/create-sign-in-token
//
// Env: CLERK_SECRET_KEY (missing -> 500 from /pair).
//
// Last modified: 2026-10-29

import { MINUTE, RateLimiter } from "@convex-dev/rate-limiter";
import { ConvexError, v } from "convex/values";
import { components, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { httpAction, internalAction, internalMutation } from "./_generated/server";
import type { ActionCtx } from "./_generated/server";
import type { AppErrorData } from "./lib/errors";
import type { DeviceKind } from "./lib/validators";

const CLERK_API = "https://api.clerk.com/v1";
const SIGN_IN_TOKEN_TTL_SECONDS = 600;
const MAX_DEVICE_NAME_LENGTH = 100;
const MIN_NONCE_LENGTH = 16;
const MAX_NONCE_LENGTH = 128;
const MAX_IP_KEY_LENGTH = 64;
const CLERK_TIMEOUT_MS = 8000;

/**
 * Requests per minute: every request spends pairOverall; only failed code checks spend the
 * failed-attempt buckets (global, and per client IP when one is known).
 */
const rateLimiter = new RateLimiter(components.rateLimiter, {
  pairOverall: { kind: "token bucket", rate: 300, period: MINUTE, capacity: 300 },
  pairFailedGlobal: { kind: "token bucket", rate: 30, period: MINUTE, capacity: 30 },
  pairFailedPerIp: { kind: "token bucket", rate: 10, period: MINUTE, capacity: 10 },
});

/** Headers on every /pair response. */
const NO_STORE = { "Cache-Control": "no-store" };

/** HTTP status for each application error code. */
const HTTP_STATUS: Record<AppErrorData["code"], number> = {
  not_found: 404,
  invalid: 400,
  forbidden: 403,
  unauthenticated: 401,
  limit: 429,
};

/** The JSON body /pair accepts. */
interface PairRequest {
  code: string;
  name?: string;
  pairingNonce?: string;
}

/** The successful /pair body, apart from the ticket. */
interface PairResult {
  householdId: Id<"households">;
  deviceId: Id<"devices">;
  kind: DeviceKind;
}

/**
 * purpose: A JSON error response in the shape { error: { code, message } }.
 * @param status: (number) HTTP status.
 * @param code: (string) Machine-readable code.
 * @param message: (string) Message safe to show.
 * @param headers: (Record<string, string>, optional) Extra headers.
 * @return: (Response) The response.
 */
function errorResponse(
  status: number,
  code: string,
  message: string,
  headers: Record<string, string> = {},
): Response {
  return jsonResponse({ error: { code, message } }, status, headers);
}

/**
 * purpose: A JSON response that must never be cached.
 * @param body: (unknown) JSON body.
 * @param status: (number, optional) HTTP status; default 200.
 * @param headers: (Record<string, string>, optional) Extra headers.
 * @return: (Response) The response.
 */
function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return Response.json(body, { status, headers: { ...NO_STORE, ...headers } });
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
 * purpose: Validate the JSON body of a /pair request.
 * @param request: (Request) The HTTP request.
 * @return: (Promise<PairRequest | string>) The parsed body, or an error message.
 */
async function parsePairRequest(request: Request): Promise<PairRequest | string> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return "The request body must be JSON";
  }
  if (typeof body !== "object" || body === null) return "The request body must be a JSON object";
  const { code, name, pairingNonce } = body as Record<string, unknown>;
  if (typeof code !== "string" || code.trim() === "") return "A code is required";
  if (name !== undefined && name !== null && typeof name !== "string") {
    return "The name must be a string";
  }
  const trimmed = typeof name === "string" ? name.trim() : "";
  if (trimmed.length > MAX_DEVICE_NAME_LENGTH) return "The name is too long";
  const parsed: PairRequest = trimmed === "" ? { code } : { code, name: trimmed };
  if (pairingNonce !== undefined && pairingNonce !== null) {
    if (
      typeof pairingNonce !== "string" ||
      pairingNonce.length < MIN_NONCE_LENGTH ||
      pairingNonce.length > MAX_NONCE_LENGTH
    ) {
      return `The pairingNonce must be ${MIN_NONCE_LENGTH} to ${MAX_NONCE_LENGTH} characters`;
    }
    parsed.pairingNonce = pairingNonce;
  }
  return parsed;
}

/**
 * purpose: Call the Clerk Backend API.
 * @param secret: (string) Clerk secret key.
 * @param method: (string) HTTP method.
 * @param path: (string) Path under /v1.
 * @param body: (unknown, optional) JSON body.
 * @return: (Promise<Response>) The Clerk response.
 * @raises Error on a network failure or when Clerk does not answer within 8 seconds.
 */
async function clerkFetch(
  secret: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  return await fetch(`${CLERK_API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(CLERK_TIMEOUT_MS),
  });
}

/**
 * purpose: Create the Clerk user for a device: no identifiers, tagged sunny_kind "device".
 * @param secret: (string) Clerk secret key.
 * @return: (Promise<string>) The new Clerk user id.
 * @raises Error when Clerk rejects the request.
 */
async function createDeviceUser(secret: string): Promise<string> {
  const res = await clerkFetch(secret, "POST", "/users", {
    external_id: `device-${crypto.randomUUID()}`,
    public_metadata: { sunny_kind: "device" },
    skip_password_requirement: true,
  });
  if (!res.ok) throw new Error(`Clerk create user failed with status ${res.status}`);
  const user = (await res.json()) as { id?: unknown };
  if (typeof user.id !== "string") throw new Error("Clerk create user returned no id");
  return user.id;
}

/**
 * purpose: Delete a Clerk user. A user that is already gone (404) counts as deleted.
 * @param secret: (string) Clerk secret key.
 * @param userId: (string) Clerk user id.
 * @return: (Promise<void>)
 * @raises Error when Clerk fails for another reason.
 */
async function deleteUser(secret: string, userId: string): Promise<void> {
  const res = await clerkFetch(secret, "DELETE", `/users/${encodeURIComponent(userId)}`);
  if (!res.ok && res.status !== 404) {
    throw new Error(`Clerk delete user failed with status ${res.status}`);
  }
}

/**
 * purpose: Create a short-lived sign-in token for the app's ticket sign-in.
 * @param secret: (string) Clerk secret key.
 * @param userId: (string) Clerk user id.
 * @return: (Promise<string>) The ticket.
 * @raises Error when Clerk rejects the request.
 */
async function createSignInToken(secret: string, userId: string): Promise<string> {
  const res = await clerkFetch(secret, "POST", "/sign_in_tokens", {
    user_id: userId,
    expires_in_seconds: SIGN_IN_TOKEN_TTL_SECONDS,
  });
  if (!res.ok) throw new Error(`Clerk sign-in token failed with status ${res.status}`);
  const token = (await res.json()) as { token?: unknown };
  if (typeof token.token !== "string") throw new Error("Clerk sign-in token returned no token");
  return token.token;
}

/**
 * purpose: Delete a Clerk user during rollback, logging instead of throwing so the original
 *          error is the one reported.
 * @param secret: (string) Clerk secret key.
 * @param userId: (string) Clerk user id.
 * @return: (Promise<void>)
 */
async function deleteUserQuietly(secret: string, userId: string): Promise<void> {
  try {
    await deleteUser(secret, userId);
  } catch (e) {
    console.error(`pairing: could not delete Clerk user ${userId}: ${String(e)}`);
  }
}

/**
 * purpose: The per-IP rate limit key: the client IP truncated to 64 characters, so a forged
 *          header cannot create unbounded keys.
 * @param request: (Request) The HTTP request.
 * @return: (string | null) The key, or null when no IP is known.
 */
function ipKey(request: Request): string | null {
  const ip = clientIp(request);
  return ip === null ? null : ip.slice(0, MAX_IP_KEY_LENGTH);
}

/**
 * purpose: Spend one request from the overall bucket.
 * @param ctx: (ActionCtx) Action context.
 * @return: (Promise<number | null>) Milliseconds to wait when limited, else null.
 */
async function overallRetryAfter(ctx: ActionCtx): Promise<number | null> {
  const overall = await rateLimiter.limit(ctx, "pairOverall");
  return overall.ok ? null : overall.retryAfter;
}

/**
 * purpose: Check, without spending, whether the failed-attempt buckets (global and per-IP)
 *          still have room.
 * @param ctx: (ActionCtx) Action context.
 * @param key: (string | null) Per-IP key, or null when no IP is known.
 * @return: (Promise<number | null>) Milliseconds to wait when exhausted, else null.
 */
async function failedAttemptRetryAfter(ctx: ActionCtx, key: string | null): Promise<number | null> {
  const global = await rateLimiter.check(ctx, "pairFailedGlobal");
  if (!global.ok) return global.retryAfter;
  if (key !== null) {
    const perIp = await rateLimiter.check(ctx, "pairFailedPerIp", { key });
    if (!perIp.ok) return perIp.retryAfter;
  }
  return null;
}

/**
 * purpose: Spend one failed attempt from the global bucket and the per-IP bucket.
 * @param ctx: (ActionCtx) Action context.
 * @param key: (string | null) Per-IP key, or null when no IP is known.
 * @return: (Promise<void>)
 */
async function recordFailedAttempt(ctx: ActionCtx, key: string | null): Promise<void> {
  await rateLimiter.limit(ctx, "pairFailedGlobal");
  if (key !== null) await rateLimiter.limit(ctx, "pairFailedPerIp", { key });
}

/**
 * purpose: A 429 response with Retry-After.
 * @param retryAfter: (number) Milliseconds to wait.
 * @return: (Response) The response.
 */
function rateLimitedResponse(retryAfter: number): Response {
  return errorResponse(429, "rate_limited", "Too many attempts. Try again shortly.", {
    "Retry-After": String(Math.max(1, Math.ceil(retryAfter / 1000))),
  });
}

/**
 * purpose: Map a failure from a Convex function to an HTTP error response. Application
 *          errors keep their code and message; anything else is a generic 500.
 * @param e: (unknown) The caught error.
 * @return: (Response) The response.
 */
function convexErrorResponse(e: unknown): Response {
  if (e instanceof ConvexError) {
    const data = e.data as Partial<AppErrorData>;
    const status = data.code === undefined ? undefined : HTTP_STATUS[data.code];
    if (status !== undefined && typeof data.message === "string") {
      return errorResponse(status, data.code!, data.message);
    }
  }
  console.error(`pairing: unexpected error: ${String(e)}`);
  return errorResponse(500, "server_error", "Pairing failed");
}

/**
 * purpose: Answer a /pair retry whose first response was lost: when the code was already
 *          redeemed by a device with the same pairingNonce within 10 minutes, mint a fresh
 *          sign-in token for that device's existing Clerk user. Creates no user or device.
 * @param ctx: (ActionCtx) Action context.
 * @param secret: (string) Clerk secret key.
 * @param parsed: (PairRequest) The request.
 * @return: (Promise<Response | null>) The 200 (or 502) response, or null when the request has
 *          no nonce or no recent pairing matches.
 */
async function retryLostPairing(
  ctx: ActionCtx,
  secret: string,
  parsed: PairRequest,
): Promise<Response | null> {
  if (parsed.pairingNonce === undefined) return null;
  const found = await ctx.runQuery(internal.households.findRecentPairing, {
    code: parsed.code,
    pairingNonce: parsed.pairingNonce,
  });
  if (found === null) return null;
  try {
    const ticket = await createSignInToken(secret, found.userId);
    const { userId: _userId, ...paired } = found;
    return jsonResponse({ ticket, ...paired });
  } catch (e) {
    console.error(`pairing: ${String(e)}`);
    return errorResponse(502, "upstream_error", "Could not sign the device in");
  }
}

/**
 * purpose: Undo a pairing after a sign-in token failure and delete the device's Clerk user.
 *          A failing rollback is logged and the Clerk user is deleted anyway.
 * @param ctx: (ActionCtx) Action context.
 * @param secret: (string) Clerk secret key.
 * @param code: (string) The redeemed code.
 * @param userId: (string) The device's Clerk user id.
 * @param deviceId: (Id<"devices">) The device row to remove.
 * @return: (Promise<void>)
 */
async function undoPairing(
  ctx: ActionCtx,
  secret: string,
  code: string,
  userId: string,
  deviceId: Id<"devices">,
): Promise<void> {
  try {
    await ctx.runMutation(internal.pairing.rollbackPairing, { code, deviceId });
  } catch (e) {
    console.error(`pairing: rollback failed for device ${deviceId}: ${String(e)}`);
  }
  await deleteUserQuietly(secret, userId);
}

/**
 * purpose: Pair a device. Unauthenticated: POST { code, name?, pairingNonce? }. Responds 200
 *          { ticket, householdId, deviceId, kind }; 400 bad body; 404 invalid, used, expired
 *          or non-device code (unless a retry matches, see the file header); 429 rate
 *          limited (with Retry-After); 500 server not configured; 502 Clerk failure.
 * @param ctx: (ActionCtx) Action context.
 * @param request: (Request) The HTTP request.
 * @return: (Response) The JSON response.
 */
export const pair = httpAction(async (ctx, request) => {
  const overall = await overallRetryAfter(ctx);
  if (overall !== null) return rateLimitedResponse(overall);
  const parsed = await parsePairRequest(request);
  if (typeof parsed === "string") return errorResponse(400, "invalid", parsed);

  const key = ipKey(request);
  const exhausted = await failedAttemptRetryAfter(ctx, key);
  if (exhausted !== null) return rateLimitedResponse(exhausted);

  const secret = process.env.CLERK_SECRET_KEY;
  try {
    await ctx.runQuery(internal.households.checkDeviceCode, { code: parsed.code });
  } catch (e) {
    if (secret) {
      const retried = await retryLostPairing(ctx, secret, parsed);
      if (retried !== null) return retried;
    }
    await recordFailedAttempt(ctx, key);
    return convexErrorResponse(e);
  }

  if (!secret) {
    console.error("pairing: CLERK_SECRET_KEY is not set");
    return errorResponse(500, "server_misconfigured", "Pairing is not configured");
  }

  let userId: string;
  try {
    userId = await createDeviceUser(secret);
  } catch (e) {
    console.error(`pairing: ${String(e)}`);
    return errorResponse(502, "upstream_error", "Could not create the device account");
  }

  let paired: PairResult;
  try {
    paired = await ctx.runMutation(internal.households.pairDevice, {
      code: parsed.code,
      userId,
      name: parsed.name,
      pairingNonce: parsed.pairingNonce,
    });
  } catch (e) {
    await deleteUserQuietly(secret, userId);
    return convexErrorResponse(e);
  }

  try {
    const ticket = await createSignInToken(secret, userId);
    return jsonResponse({ ticket, ...paired });
  } catch (e) {
    console.error(`pairing: ${String(e)}`);
    await undoPairing(ctx, secret, parsed.code, userId, paired.deviceId);
    return errorResponse(502, "upstream_error", "Could not sign the device in");
  }
});

/**
 * purpose: Undo a pairing whose sign-in token could not be created: delete the device row and
 *          make the code redeemable again. Internal.
 * @param code: (string) The code that was redeemed.
 * @param deviceId: (Id<"devices">) The device row pairDevice created.
 * @return: (null)
 */
export const rollbackPairing = internalMutation({
  args: { code: v.string(), deviceId: v.id("devices") },
  handler: async (ctx, args): Promise<null> => {
    await ctx.db.delete(args.deviceId);
    const row = await ctx.db
      .query("joinCodes")
      .withIndex("by_code", (q) => q.eq("code", args.code.trim().toUpperCase()))
      .unique();
    if (row) await ctx.db.patch(row._id, { redeemedBy: undefined, redeemedAt: undefined });
    return null;
  },
});

/**
 * purpose: Delete a device's Clerk user after the device is unpaired. Best effort: a missing
 *          secret or a Clerk failure is logged, never thrown (the device row is already gone,
 *          so the orphaned Clerk user cannot act as anything). Internal.
 * @param userId: (string) Clerk user id of the removed device.
 * @return: (null)
 */
export const deleteClerkUser = internalAction({
  args: { userId: v.string() },
  handler: async (_ctx, args): Promise<null> => {
    const secret = process.env.CLERK_SECRET_KEY;
    if (!secret) {
      console.error(`pairing: CLERK_SECRET_KEY not set; Clerk user ${args.userId} not deleted`);
      return null;
    }
    await deleteUserQuietly(secret, args.userId);
    return null;
  },
});
