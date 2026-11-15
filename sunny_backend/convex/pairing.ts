import { MINUTE, RateLimiter } from "@convex-dev/rate-limiter";
import { v } from "convex/values";
import { components, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { httpAction, internalAction, internalMutation } from "./_generated/server";
import type { ActionCtx } from "./_generated/server";
import {
  convexErrorResponse,
  errorResponse,
  ipKey,
  jsonResponse,
  rateLimitedResponse,
} from "./lib/httpResponse";
import type { DeviceKind } from "./lib/validators";

const CLERK_API = "https://api.clerk.com/v1";
const SIGN_IN_TOKEN_TTL_SECONDS = 600;
const MAX_DEVICE_NAME_LENGTH = 100;
const MIN_NONCE_LENGTH = 16;
const MAX_NONCE_LENGTH = 128;
const CLERK_TIMEOUT_MS = 8000;
const USERNAME_PREFIX = "device_";
const USERNAME_TAKEN_CODE = "form_identifier_exists";

const rateLimiter = new RateLimiter(components.rateLimiter, {
  pairOverall: { kind: "token bucket", rate: 300, period: MINUTE, capacity: 300 },
  pairFailedGlobal: { kind: "token bucket", rate: 30, period: MINUTE, capacity: 30 },
  pairFailedPerIp: { kind: "token bucket", rate: 10, period: MINUTE, capacity: 10 },
});

interface PairRequest {
  code: string;
  name?: string;
  pairingNonce?: string;
}

interface PairResult {
  householdId: Id<"households">;
  deviceId: Id<"devices">;
  kind: DeviceKind;
}

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

function newDeviceUsername(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${USERNAME_PREFIX}${hex}`;
}

async function isUsernameTaken(res: Response): Promise<boolean> {
  if (res.status !== 422) return false;
  try {
    const body = (await res.clone().json()) as { errors?: Array<{ code?: unknown }> };
    return (body.errors ?? []).some((e) => e.code === USERNAME_TAKEN_CODE);
  } catch {
    return false;
  }
}

async function postDeviceUser(secret: string): Promise<Response> {
  return await clerkFetch(secret, "POST", "/users", {
    external_id: `device-${crypto.randomUUID()}`,
    username: newDeviceUsername(),
    public_metadata: { sunny_kind: "device" },
    skip_password_requirement: true,
  });
}

async function createDeviceUser(secret: string): Promise<string> {
  let res = await postDeviceUser(secret);
  if (await isUsernameTaken(res)) res = await postDeviceUser(secret);
  if (!res.ok) throw new Error(`Clerk create user failed with status ${res.status}`);
  const user = (await res.json()) as { id?: unknown };
  if (typeof user.id !== "string") throw new Error("Clerk create user returned no id");
  return user.id;
}

async function ensureDeviceUsername(secret: string, userId: string): Promise<void> {
  const path = `/users/${encodeURIComponent(userId)}`;
  const got = await clerkFetch(secret, "GET", path);
  if (!got.ok) throw new Error(`Clerk get user failed with status ${got.status}`);
  const user = (await got.json()) as { username?: unknown };
  if (typeof user.username === "string" && user.username !== "") return;
  let res = await clerkFetch(secret, "PATCH", path, { username: newDeviceUsername() });
  if (await isUsernameTaken(res)) {
    res = await clerkFetch(secret, "PATCH", path, { username: newDeviceUsername() });
  }
  if (!res.ok) throw new Error(`Clerk set username failed with status ${res.status}`);
}

async function deleteUser(secret: string, userId: string): Promise<void> {
  const res = await clerkFetch(secret, "DELETE", `/users/${encodeURIComponent(userId)}`);
  if (!res.ok && res.status !== 404) {
    throw new Error(`Clerk delete user failed with status ${res.status}`);
  }
}

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

async function deleteUserQuietly(secret: string, userId: string): Promise<void> {
  try {
    await deleteUser(secret, userId);
  } catch (e) {
    console.error(`pairing: could not delete Clerk user ${userId}: ${String(e)}`);
  }
}

async function overallRetryAfter(ctx: ActionCtx): Promise<number | null> {
  const overall = await rateLimiter.limit(ctx, "pairOverall");
  return overall.ok ? null : overall.retryAfter;
}

async function failedAttemptRetryAfter(ctx: ActionCtx, key: string | null): Promise<number | null> {
  const global = await rateLimiter.check(ctx, "pairFailedGlobal");
  if (!global.ok) return global.retryAfter;
  if (key !== null) {
    const perIp = await rateLimiter.check(ctx, "pairFailedPerIp", { key });
    if (!perIp.ok) return perIp.retryAfter;
  }
  return null;
}

async function recordFailedAttempt(ctx: ActionCtx, key: string | null): Promise<void> {
  await rateLimiter.limit(ctx, "pairFailedGlobal");
  if (key !== null) await rateLimiter.limit(ctx, "pairFailedPerIp", { key });
}

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
    await ensureDeviceUsername(secret, found.userId);
    const ticket = await createSignInToken(secret, found.userId);
    const { userId: _userId, ...paired } = found;
    return jsonResponse({ ticket, ...paired });
  } catch (e) {
    console.error(`pairing: ${String(e)}`);
    return errorResponse(502, "upstream_error", "Could not sign the device in");
  }
}

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
    return convexErrorResponse(e, "pairing", "Pairing failed");
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
    return convexErrorResponse(e, "pairing", "Pairing failed");
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
