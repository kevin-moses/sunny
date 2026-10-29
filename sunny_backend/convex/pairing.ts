// convex/pairing.ts
// Purpose: Device pairing over HTTP. A signed-out senior device POSTs a join code to /pair
// (routed in http.ts) and gets back a Clerk sign-in ticket for a freshly created device
// user. Flow: rate limit (global bucket, plus a per-IP bucket when a client IP header is
// present) -> check the code is a redeemable device code (so bad codes never cost a Clerk
// call) -> create the Clerk user -> households.pairDevice -> create a sign-in token. Any
// failure after the Clerk user exists deletes it again, and a failure after pairing rolls
// the pairing back. Also holds the best-effort action that deletes a device's Clerk user on
// unpairing.
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
// Client IP: Convex documents no client IP header for HTTP actions. clientIp reads the
// rightmost x-forwarded-for entry, else x-real-ip, and the per-IP bucket is skipped when
// neither exists; the global bucket is the backstop either way.
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

/** Attempts per minute across all callers, and per client IP when one is known. */
const rateLimiter = new RateLimiter(components.rateLimiter, {
  pairGlobal: { kind: "token bucket", rate: 30, period: MINUTE, capacity: 30 },
  pairPerIp: { kind: "token bucket", rate: 10, period: MINUTE, capacity: 10 },
});

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
  return Response.json({ error: { code, message } }, { status, headers });
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
  const { code, name } = body as Record<string, unknown>;
  if (typeof code !== "string" || code.trim() === "") return "A code is required";
  if (name !== undefined && name !== null && typeof name !== "string") {
    return "The name must be a string";
  }
  const trimmed = typeof name === "string" ? name.trim() : "";
  if (trimmed.length > MAX_DEVICE_NAME_LENGTH) return "The name is too long";
  return trimmed === "" ? { code } : { code, name: trimmed };
}

/**
 * purpose: Call the Clerk Backend API.
 * @param secret: (string) Clerk secret key.
 * @param method: (string) HTTP method.
 * @param path: (string) Path under /v1.
 * @param body: (unknown, optional) JSON body.
 * @return: (Promise<Response>) The Clerk response.
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
 * purpose: Spend one attempt from the global bucket and, when the client IP is known, from
 *          that IP's bucket.
 * @param ctx: (ActionCtx) Action context.
 * @param request: (Request) The HTTP request.
 * @return: (Promise<number | null>) Milliseconds to wait when limited, else null.
 */
async function rateLimitRetryAfter(ctx: ActionCtx, request: Request): Promise<number | null> {
  const global = await rateLimiter.limit(ctx, "pairGlobal");
  if (!global.ok) return global.retryAfter;
  const ip = clientIp(request);
  if (ip !== null) {
    const perIp = await rateLimiter.limit(ctx, "pairPerIp", { key: ip });
    if (!perIp.ok) return perIp.retryAfter;
  }
  return null;
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
 * purpose: Pair a device. Unauthenticated: POST { code, name? }. Responds 200
 *          { ticket, householdId, deviceId, kind }; 400 bad body; 404 invalid, used, expired
 *          or non-device code; 429 rate limited (with Retry-After); 500 server not
 *          configured; 502 Clerk failure.
 * @param ctx: (ActionCtx) Action context.
 * @param request: (Request) The HTTP request.
 * @return: (Response) The JSON response.
 */
export const pair = httpAction(async (ctx, request) => {
  const retryAfter = await rateLimitRetryAfter(ctx, request);
  if (retryAfter !== null) {
    return errorResponse(429, "rate_limited", "Too many attempts. Try again shortly.", {
      "Retry-After": String(Math.max(1, Math.ceil(retryAfter / 1000))),
    });
  }
  const parsed = await parsePairRequest(request);
  if (typeof parsed === "string") return errorResponse(400, "invalid", parsed);

  try {
    await ctx.runQuery(internal.households.checkDeviceCode, { code: parsed.code });
  } catch (e) {
    return convexErrorResponse(e);
  }

  const secret = process.env.CLERK_SECRET_KEY;
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

  let paired: { householdId: Id<"households">; deviceId: Id<"devices">; kind: DeviceKind };
  try {
    paired = await ctx.runMutation(internal.households.pairDevice, {
      code: parsed.code,
      userId,
      name: parsed.name,
    });
  } catch (e) {
    await deleteUserQuietly(secret, userId);
    return convexErrorResponse(e);
  }

  try {
    const ticket = await createSignInToken(secret, userId);
    return Response.json({ ticket, ...paired });
  } catch (e) {
    console.error(`pairing: ${String(e)}`);
    await ctx.runMutation(internal.pairing.rollbackPairing, {
      code: parsed.code,
      deviceId: paired.deviceId,
    });
    await deleteUserQuietly(secret, userId);
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
