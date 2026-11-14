// convex/deviceApi.ts
// Purpose: The device API for senior surfaces that cannot hold a Clerk session (the iOS widget
// and Live Activity extensions, the e-ink home display's firmware), plus the same device state
// as a Convex query for the signed-in React Native app.
//
// Device token (lib/deviceToken.ts): a signed-in senior device calls issueToken (an action, so
// the token is drawn from real randomness) and gets { deviceToken } once. Only the token's
// SHA-256 digest is stored on its devices row (tokenHash, tokenIssuedAt); issuing again
// replaces it, so the previous token stops working, and households.removeDevice deletes the row,
// which revokes the token at once. The issue is audited ("issue_device_token"), never the token,
// and limited to 10 an hour per device user.
//
// HTTP routes (http.ts), every request with `Authorization: Bearer <deviceToken>`, every
// response Cache-Control: no-store:
//   GET  /device/state    200 the device state (lib/deviceState.ts) with ETag "<version>";
//                         304 with no body when If-None-Match matches.
//   POST /device/confirm  { instanceId, pressedAgoMs, via } with via button, widget,
//                         live_activity or phone_app: instances.confirmPressedInstance as the
//                         token's DeviceActor; 200 { status: "confirmed" | "rejected", reason
//                         (null when confirmed), state } and the state's ETag. An instance of
//                         another household gets exactly the answer a deleted one gets (nothing
//                         is confirmed and nothing says whether it exists). pressedAgoMs is 0
//                         to 7 days; a body is at most 4096 characters.
//   PUT  /device/info     { screen?: { width, height, greys }, firmware? }: stored on the row;
//                         204. Only those two fields can be changed.
// A missing, malformed or unknown token is 401 with one fixed body. A bad body or instance id
// is 400 (checked only after the token, so validation never answers an unauthenticated caller).
// Each internal function resolves the device from the token hash again inside its own
// transaction, so a device removed mid-request can do nothing more.
//
// Rate limits (@convex-dev/rate-limiter, as pairing.ts): an authenticated request spends the
// device's own bucket (120 a minute); a failed authentication spends a strict global bucket and
// a per-IP courtesy bucket (lib/httpResponse.ts clientIp, spoofable). A valid token is looked up
// before any failed-attempt bucket is consulted, so a flood of bad tokens cannot lock out real
// devices; the failed buckets only turn the 401 of a failing caller into 429 with Retry-After.
// The token lookup, the device's bucket and lastSeenAt are one internal mutation (admit), so an
// authenticated request costs two function calls. lastSeenAt is written only when it is more
// than 5 minutes old (the rate limiter's bucket is still written on every request).
//
// The token grants exactly what a paired senior device has, nothing caregiver-only: its own
// household's device state and confirming that household's tasks.
//
// Last modified: 2026-11-14

import { HOUR, MINUTE, RateLimiter } from "@convex-dev/rate-limiter";
import { v } from "convex/values";
import { components, internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { action, httpAction, internalMutation, internalQuery, query } from "./_generated/server";
import type { ActionCtx, MutationCtx, QueryCtx } from "./_generated/server";
import { confirmPressedInstance } from "./instances";
import { findDevice, requireUserId } from "./lib/access";
import type { DeviceActor } from "./lib/access";
import { audit } from "./lib/audit";
import { loadDeviceState } from "./lib/deviceState";
import type { DeviceState } from "./lib/deviceState";
import { generateDeviceToken, hashDeviceToken, parseBearerToken } from "./lib/deviceToken";
import { appError } from "./lib/errors";
import {
  NO_STORE,
  convexErrorResponse,
  errorResponse,
  ipKey,
  jsonResponse,
  rateLimitedResponse,
} from "./lib/httpResponse";
import { DAY_MS, minutes } from "./lib/time";
import { DEVICE_VIAS, deviceScreen, deviceVia } from "./lib/validators";
import type { DeviceScreen, DeviceVia } from "./lib/validators";

/** lastSeenAt is rewritten only once it is older than this (ms). */
const LAST_SEEN_INTERVAL_MS = minutes(5);

/** Longest request body read (characters); the bodies here are a few dozen. */
const MAX_BODY_CHARS = 4096;

/** Longest instance id accepted before it is even looked at. */
const MAX_INSTANCE_ID_LENGTH = 128;

/**
 * Oldest press accepted (ms): a week offline. Older presses could never be applied (a replay is
 * refused 3 hours after its window), so they are refused as a bad request.
 */
const MAX_PRESS_AGE_MS = 7 * DAY_MS;

/** Longest firmware version string, after trimming. */
const MAX_FIRMWARE_LENGTH = 40;

/** Bounds of a reported screen: pixels per side, and grey levels. */
const SCREEN_SIDE = { min: 1, max: 10_000 };
const SCREEN_GREYS = { min: 2, max: 256 };

/**
 * The reason confirmPressedInstance gives for an instance that no longer exists. An instance of
 * another household gets the same, so the two cannot be told apart (deviceApi.test.ts checks
 * that the bodies match).
 */
const NO_SUCH_TASK = "The task no longer exists";

/**
 * Requests per minute: each device's own bucket for authenticated requests; failed
 * authentications spend a global bucket and, when an IP is known, a per-IP bucket. Token issues:
 * 10 an hour per device user (each one revokes the previous token and writes an audit row).
 */
const rateLimiter = new RateLimiter(components.rateLimiter, {
  tokenIssues: { kind: "token bucket", rate: 10, period: HOUR, capacity: 10 },
  deviceRequests: { kind: "token bucket", rate: 120, period: MINUTE, capacity: 120 },
  deviceAuthFailedGlobal: { kind: "token bucket", rate: 60, period: MINUTE, capacity: 60 },
  deviceAuthFailedPerIp: { kind: "token bucket", rate: 10, period: MINUTE, capacity: 10 },
});

/** The body of POST /device/confirm. */
interface ConfirmRequest {
  instanceId: string;
  pressedAgoMs: number;
  via: DeviceVia;
}

/** The body of PUT /device/info. */
interface InfoRequest {
  screen?: DeviceScreen;
  firmware?: string;
}

/** What admit answers: the token is unknown, its device is over its limit, or it may go on. */
type Admission = { kind: "unknown" } | { kind: "limited"; retryAfter: number } | { kind: "ok" };

/** What confirmByToken answers. */
type ConfirmOutcome =
  | { kind: "unauthorized" }
  | { kind: "bad_instance" }
  | {
      kind: "done";
      status: "confirmed" | "rejected";
      reason: string | null;
      state: DeviceState;
    };

/**
 * purpose: The device a token hash belongs to.
 * @param ctx: (QueryCtx) Context.
 * @param tokenHash: (string) SHA-256 hex of the token.
 * @return: (Promise<Doc<"devices"> | null>) The device, or null for an unknown or revoked token.
 */
async function findDeviceByTokenHash(
  ctx: QueryCtx,
  tokenHash: string,
): Promise<Doc<"devices"> | null> {
  return await ctx.db
    .query("devices")
    .withIndex("by_token_hash", (q) => q.eq("tokenHash", tokenHash))
    .unique();
}

/**
 * purpose: The actor a device acts as: the senior device of its household.
 * @param device: (Doc<"devices">) The device row.
 * @return: (DeviceActor) The actor.
 */
function deviceActor(device: Doc<"devices">): DeviceActor {
  return { kind: "senior_device", userId: device.userId, householdId: device.householdId, device };
}

/**
 * purpose: Whether lastSeenAt is due to be rewritten.
 * @param lastSeenAt: (number | null | undefined) The stored value.
 * @param now: (number) Epoch ms.
 * @return: (boolean) True when absent or more than LAST_SEEN_INTERVAL_MS old.
 */
function seenLongAgo(lastSeenAt: number | null | undefined, now: number): boolean {
  return lastSeenAt == null || now - lastSeenAt > LAST_SEEN_INTERVAL_MS;
}

/**
 * purpose: Store a new token hash on the calling device's row, replacing any earlier one, and
 *          audit the issue (never the token or its hash). Internal: issueToken calls it.
 * @param userId: (string) The caller's Clerk user id.
 * @param tokenHash: (string) SHA-256 hex of the new token.
 * @return: (null)
 * @raises forbidden when the user is not a paired senior device.
 */
export const storeTokenHash = internalMutation({
  args: { userId: v.string(), tokenHash: v.string() },
  handler: async (ctx, args): Promise<null> => {
    const device = await findDevice(ctx, args.userId);
    if (!device) throw appError("forbidden", "Only the senior's devices can do this");
    await ctx.db.patch(device._id, { tokenHash: args.tokenHash, tokenIssuedAt: Date.now() });
    await audit(ctx, {
      householdId: device.householdId,
      actor: deviceActor(device),
      action: "issue_device_token",
      entity: "device",
      entityId: device._id,
      detail: { replaced: device.tokenHash !== undefined },
    });
    return null;
  },
});

/**
 * purpose: Issue a device token for the signed-in senior device. The previous token (if any)
 *          stops working, so a device should ask once and keep the token (two surfaces of one
 *          device must share it, and concurrent calls leave all but the last with a dead
 *          token). The token is returned only here and is never stored in plaintext. At most
 *          10 issues an hour per user.
 * @return: ({ deviceToken: string }) The new token.
 * @raises unauthenticated when signed out; limit after 10 issues in an hour; forbidden for any
 *         caller that is not a paired senior device (a caregiver included).
 */
export const issueToken = action({
  args: {},
  handler: async (ctx): Promise<{ deviceToken: string }> => {
    const identity = await ctx.auth.getUserIdentity();
    if (identity === null) throw appError("unauthenticated", "Sign in first");
    const limit = await rateLimiter.limit(ctx, "tokenIssues", { key: identity.subject });
    if (!limit.ok) throw appError("limit", "Too many new device tokens. Try again later.");
    const deviceToken = generateDeviceToken();
    const tokenHash = await hashDeviceToken(deviceToken);
    await ctx.runMutation(internal.deviceApi.storeTokenHash, {
      userId: identity.subject,
      tokenHash,
    });
    return { deviceToken };
  },
});

/**
 * purpose: The device state for the signed-in senior device's household (the same object GET
 *          /device/state returns). `minute` only varies the cache key so the state is never
 *          staler than the client's minute clock (as in calendar.dayView); it is ignored.
 * @param minute: (number, optional) Client minute counter.
 * @return: (DeviceState) The state.
 * @raises unauthenticated when signed out; forbidden for a caller that is not a paired device.
 */
export const state = query({
  args: { minute: v.optional(v.number()) },
  handler: async (ctx): Promise<DeviceState> => {
    const userId = await requireUserId(ctx);
    const device = await findDevice(ctx, userId);
    if (!device) throw appError("forbidden", "Only the senior's devices can do this");
    return await loadDeviceState(ctx, device.householdId, Date.now());
  },
});

/**
 * purpose: Admit a request in one transaction: resolve the token, spend the device's own rate
 *          limit bucket, and refresh lastSeenAt when it is more than LAST_SEEN_INTERVAL_MS old.
 *          Internal: the HTTP gate calls it.
 * @param tokenHash: (string) SHA-256 hex of the token.
 * @return: (Admission) unknown, limited (with milliseconds to wait) or ok.
 */
export const admit = internalMutation({
  args: { tokenHash: v.string() },
  handler: async (ctx, args): Promise<Admission> => {
    const device = await findDeviceByTokenHash(ctx, args.tokenHash);
    if (device === null) return { kind: "unknown" };
    const limit = await rateLimiter.limit(ctx, "deviceRequests", { key: device._id });
    if (!limit.ok) return { kind: "limited", retryAfter: limit.retryAfter };
    const now = Date.now();
    if (seenLongAgo(device.lastSeenAt, now)) await ctx.db.patch(device._id, { lastSeenAt: now });
    return { kind: "ok" };
  },
});

/**
 * purpose: The device state for the token's household. Internal.
 * @param tokenHash: (string) SHA-256 hex of the token.
 * @return: (DeviceState | null) The state, or null when the token no longer resolves.
 */
export const stateByToken = internalQuery({
  args: { tokenHash: v.string() },
  handler: async (ctx, args): Promise<DeviceState | null> => {
    const device = await findDeviceByTokenHash(ctx, args.tokenHash);
    if (device === null) return null;
    return await loadDeviceState(ctx, device.householdId, Date.now());
  },
});

/**
 * purpose: Confirm a press for a device: an instance of another household is answered exactly
 *          like a deleted one (rejected, NO_SUCH_TASK) and nothing is written; otherwise
 *          instances.confirmPressedInstance decides (and audits a press it cannot apply).
 * @param ctx: (MutationCtx) Context.
 * @param actor: (DeviceActor) The device.
 * @param args: ({ instanceId, via, pressedAgoMs }) The press.
 * @param now: (number) Epoch ms.
 * @return: (Promise<{ status, reason }>) confirmed (reason null) or rejected with the reason.
 */
async function confirmForDevice(
  ctx: MutationCtx,
  actor: DeviceActor,
  args: { instanceId: Id<"taskInstances">; via: DeviceVia; pressedAgoMs: number },
  now: number,
): Promise<{ status: "confirmed" | "rejected"; reason: string | null }> {
  const instance = await ctx.db.get(args.instanceId);
  if (instance !== null && instance.householdId !== actor.householdId) {
    console.warn(`deviceApi: device ${actor.device._id} pressed another household's task`);
    return { status: "rejected", reason: NO_SUCH_TASK };
  }
  const result = await confirmPressedInstance(ctx, actor, args, now);
  return result.status === "confirmed"
    ? { status: "confirmed", reason: null }
    : { status: "rejected", reason: result.reason };
}

/**
 * purpose: Confirm a press for the token's device and return the fresh device state in the same
 *          transaction. Internal.
 * @param tokenHash: (string) SHA-256 hex of the token.
 * @param instanceId: (string) The instance id as the device sent it.
 * @param via: (DeviceVia) The surface.
 * @param pressedAgoMs: (number) How long ago (ms) the press happened; zero or more.
 * @return: (ConfirmOutcome) unauthorized (token no longer resolves), bad_instance (not an
 *          instance id), or done with the status, reason and state.
 */
export const confirmByToken = internalMutation({
  args: { tokenHash: v.string(), instanceId: v.string(), via: deviceVia, pressedAgoMs: v.number() },
  handler: async (ctx, args): Promise<ConfirmOutcome> => {
    const device = await findDeviceByTokenHash(ctx, args.tokenHash);
    if (device === null) return { kind: "unauthorized" };
    const instanceId = ctx.db.normalizeId("taskInstances", args.instanceId);
    if (instanceId === null) return { kind: "bad_instance" };
    const now = Date.now();
    const result = await confirmForDevice(
      ctx,
      deviceActor(device),
      { instanceId, via: args.via, pressedAgoMs: args.pressedAgoMs },
      now,
    );
    return { kind: "done", ...result, state: await loadDeviceState(ctx, device.householdId, now) };
  },
});

/**
 * purpose: Store what a device reports about itself. Only screen and firmware are written; a
 *          field left out is unchanged. Internal: the HTTP route validates first.
 * @param tokenHash: (string) SHA-256 hex of the token.
 * @param screen: ({ width, height, greys }, optional) The panel.
 * @param firmware: (string, optional) Firmware version, trimmed, 1 to 40 characters.
 * @return: (boolean) False when the token no longer resolves.
 */
export const updateInfoByToken = internalMutation({
  args: {
    tokenHash: v.string(),
    screen: v.optional(deviceScreen),
    firmware: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<boolean> => {
    const device = await findDeviceByTokenHash(ctx, args.tokenHash);
    if (device === null) return false;
    const patch: Partial<Pick<Doc<"devices">, "screen" | "firmware">> = {};
    if (args.screen !== undefined) patch.screen = args.screen;
    if (args.firmware !== undefined) patch.firmware = args.firmware;
    if (Object.keys(patch).length > 0) await ctx.db.patch(device._id, patch);
    return true;
  },
});

/**
 * purpose: The one answer for a missing, malformed or unknown token.
 * @return: (Response) 401 with a fixed body.
 */
function unauthorizedResponse(): Response {
  return errorResponse(401, "unauthenticated", "A valid device token is required", {
    "WWW-Authenticate": "Bearer",
  });
}

/**
 * purpose: Answer a failed authentication: spend the global and per-IP failed buckets; 429 when
 *          either is empty, else 401.
 * @param ctx: (ActionCtx) Action context.
 * @param request: (Request) The HTTP request.
 * @return: (Promise<Response>) The response.
 */
async function refuseAuthentication(ctx: ActionCtx, request: Request): Promise<Response> {
  const waits: number[] = [];
  const global = await rateLimiter.limit(ctx, "deviceAuthFailedGlobal");
  if (!global.ok) waits.push(global.retryAfter);
  const key = ipKey(request);
  if (key !== null) {
    const perIp = await rateLimiter.limit(ctx, "deviceAuthFailedPerIp", { key });
    if (!perIp.ok) waits.push(perIp.retryAfter);
  }
  return waits.length > 0 ? rateLimitedResponse(Math.max(...waits)) : unauthorizedResponse();
}

/**
 * purpose: The gate every device request passes: the token resolves to a device, the device's
 *          bucket has room, and lastSeenAt is refreshed when stale (admit).
 * @param ctx: (ActionCtx) Action context.
 * @param request: (Request) The HTTP request.
 * @return: (Promise<string | Response>) The token hash, or the response to send (401 or 429).
 */
async function gate(ctx: ActionCtx, request: Request): Promise<string | Response> {
  const token = parseBearerToken(request.headers.get("Authorization"));
  if (token === null) return await refuseAuthentication(ctx, request);
  const tokenHash = await hashDeviceToken(token);
  const admission = await ctx.runMutation(internal.deviceApi.admit, { tokenHash });
  if (admission.kind === "unknown") return await refuseAuthentication(ctx, request);
  if (admission.kind === "limited") return rateLimitedResponse(admission.retryAfter);
  return tokenHash;
}

/**
 * purpose: Read a small JSON object body.
 * @param request: (Request) The HTTP request.
 * @return: (Promise<Record<string, unknown> | string>) The object, or an error message.
 */
async function readJsonObject(request: Request): Promise<Record<string, unknown> | string> {
  const tooLarge = "The request body is too large";
  if (Number(request.headers.get("content-length") ?? 0) > MAX_BODY_CHARS) return tooLarge;
  const text = await request.text();
  if (text.length > MAX_BODY_CHARS) return tooLarge;
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return "The request body must be JSON";
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return "The request body must be a JSON object";
  }
  return body as Record<string, unknown>;
}

/**
 * purpose: The first key of an object that is not allowed.
 * @param body: (Record<string, unknown>) The object.
 * @param allowed: (readonly string[]) The allowed keys.
 * @return: (string | null) An error message naming the key, or null when all are allowed.
 */
function unknownKey(body: Record<string, unknown>, allowed: readonly string[]): string | null {
  const extra = Object.keys(body).find((k) => !allowed.includes(k));
  return extra === undefined ? null : `Unknown field ${extra}`;
}

/**
 * purpose: Validate the body of POST /device/confirm.
 * @param body: (Record<string, unknown>) The JSON object.
 * @return: (ConfirmRequest | string) The press, or an error message.
 */
function parseConfirmRequest(body: Record<string, unknown>): ConfirmRequest | string {
  const extra = unknownKey(body, ["instanceId", "pressedAgoMs", "via"]);
  if (extra !== null) return extra;
  const { instanceId, pressedAgoMs, via } = body;
  if (
    typeof instanceId !== "string" ||
    instanceId === "" ||
    instanceId.length > MAX_INSTANCE_ID_LENGTH
  ) {
    return "instanceId must be a task instance id";
  }
  if (
    typeof pressedAgoMs !== "number" ||
    !Number.isFinite(pressedAgoMs) ||
    pressedAgoMs < 0 ||
    pressedAgoMs > MAX_PRESS_AGE_MS
  ) {
    return `pressedAgoMs must be a number from 0 to ${MAX_PRESS_AGE_MS}`;
  }
  if (typeof via !== "string" || !(DEVICE_VIAS as readonly string[]).includes(via)) {
    return `via must be one of ${DEVICE_VIAS.join(", ")}`;
  }
  return { instanceId, pressedAgoMs, via: via as DeviceVia };
}

/**
 * purpose: Whether a value is an integer within bounds.
 * @param value: (unknown) The value.
 * @param bounds: ({ min: number; max: number }) Inclusive bounds.
 * @return: (boolean) True for an integer in [min, max].
 */
function isIntIn(value: unknown, bounds: { min: number; max: number }): value is number {
  return (
    Number.isInteger(value) && (value as number) >= bounds.min && (value as number) <= bounds.max
  );
}

/**
 * purpose: Validate the body of PUT /device/info.
 * @param body: (Record<string, unknown>) The JSON object.
 * @return: (InfoRequest | string) The fields to store, or an error message.
 */
function parseInfoRequest(body: Record<string, unknown>): InfoRequest | string {
  const extra = unknownKey(body, ["screen", "firmware"]);
  if (extra !== null) return extra;
  const info: InfoRequest = {};
  if (body.screen !== undefined) {
    const screen = body.screen as Record<string, unknown> | null;
    const sideMessage = `screen width and height must be whole numbers from ${SCREEN_SIDE.min} to ${SCREEN_SIDE.max}`;
    if (typeof screen !== "object" || screen === null || Array.isArray(screen)) {
      return "screen must be an object";
    }
    const screenExtra = unknownKey(screen, ["width", "height", "greys"]);
    if (screenExtra !== null) return `screen: ${screenExtra}`;
    if (!isIntIn(screen.width, SCREEN_SIDE) || !isIntIn(screen.height, SCREEN_SIDE)) {
      return sideMessage;
    }
    if (!isIntIn(screen.greys, SCREEN_GREYS)) {
      return `screen greys must be a whole number from ${SCREEN_GREYS.min} to ${SCREEN_GREYS.max}`;
    }
    info.screen = { width: screen.width, height: screen.height, greys: screen.greys };
  }
  if (body.firmware !== undefined) {
    const firmware = typeof body.firmware === "string" ? body.firmware.trim() : null;
    if (
      firmware === null ||
      firmware === "" ||
      firmware.length > MAX_FIRMWARE_LENGTH ||
      /[\u0000-\u001f\u007f]/.test(firmware)
    ) {
      return `firmware must be text of 1 to ${MAX_FIRMWARE_LENGTH} characters`;
    }
    info.firmware = firmware;
  }
  return info;
}

/**
 * purpose: Whether an If-None-Match header matches an entity tag (weak tags compare equal, "*"
 *          matches anything).
 * @param header: (string | null) The If-None-Match header.
 * @param etag: (string) The quoted entity tag.
 * @return: (boolean) True when the client already has this version.
 */
function etagMatches(header: string | null, etag: string): boolean {
  if (header === null) return false;
  return header
    .split(",")
    .map((t) => t.trim().replace(/^W\//, ""))
    .some((t) => t === etag || t === "*");
}

/**
 * purpose: The quoted entity tag of a state.
 * @param state: (DeviceState) The state.
 * @return: (string) "\"<version>\"".
 */
function etagOf(state: DeviceState): string {
  return `"${state.version}"`;
}

/**
 * purpose: GET /device/state: the token's device state with its ETag; 304 when If-None-Match
 *          matches; 401 bad token; 429 rate limited.
 * @param ctx: (ActionCtx) Action context.
 * @param request: (Request) The HTTP request.
 * @return: (Response) The response.
 */
export const getState = httpAction(async (ctx, request) => {
  const tokenHash = await gate(ctx, request);
  if (tokenHash instanceof Response) return tokenHash;
  try {
    const state = await ctx.runQuery(internal.deviceApi.stateByToken, { tokenHash });
    if (state === null) return unauthorizedResponse();
    const etag = etagOf(state);
    if (etagMatches(request.headers.get("If-None-Match"), etag)) {
      return new Response(null, { status: 304, headers: { ...NO_STORE, ETag: etag } });
    }
    return jsonResponse(state, 200, { ETag: etag });
  } catch (e) {
    return convexErrorResponse(e, "deviceApi", "Could not load the device state");
  }
});

/**
 * purpose: POST /device/confirm: confirm a press as the token's device. 200 { status, reason,
 *          state } with the state's ETag; 400 bad body or instance id; 401 bad token; 429 rate
 *          limited.
 * @param ctx: (ActionCtx) Action context.
 * @param request: (Request) The HTTP request.
 * @return: (Response) The response.
 */
export const confirm = httpAction(async (ctx, request) => {
  const tokenHash = await gate(ctx, request);
  if (tokenHash instanceof Response) return tokenHash;
  const body = await readJsonObject(request);
  const press = typeof body === "string" ? body : parseConfirmRequest(body);
  if (typeof press === "string") return errorResponse(400, "invalid", press);
  try {
    const outcome = await ctx.runMutation(internal.deviceApi.confirmByToken, {
      tokenHash,
      ...press,
    });
    if (outcome.kind === "unauthorized") return unauthorizedResponse();
    if (outcome.kind === "bad_instance") {
      return errorResponse(400, "invalid", "instanceId must be a task instance id");
    }
    const { status, reason, state } = outcome;
    return jsonResponse({ status, reason, state }, 200, { ETag: etagOf(state) });
  } catch (e) {
    return convexErrorResponse(e, "deviceApi", "Could not confirm the task");
  }
});

/**
 * purpose: PUT /device/info: store the device's screen and firmware. 204; 400 bad body; 401 bad
 *          token; 429 rate limited.
 * @param ctx: (ActionCtx) Action context.
 * @param request: (Request) The HTTP request.
 * @return: (Response) The response.
 */
export const putInfo = httpAction(async (ctx, request) => {
  const tokenHash = await gate(ctx, request);
  if (tokenHash instanceof Response) return tokenHash;
  const body = await readJsonObject(request);
  const info = typeof body === "string" ? body : parseInfoRequest(body);
  if (typeof info === "string") return errorResponse(400, "invalid", info);
  try {
    const stored = await ctx.runMutation(internal.deviceApi.updateInfoByToken, {
      tokenHash,
      ...info,
    });
    return stored ? new Response(null, { status: 204, headers: NO_STORE }) : unauthorizedResponse();
  } catch (e) {
    return convexErrorResponse(e, "deviceApi", "Could not store the device info");
  }
});
