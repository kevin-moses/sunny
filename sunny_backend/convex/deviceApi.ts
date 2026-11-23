import { HOUR, MINUTE, RateLimiter } from "@convex-dev/rate-limiter";
import { v } from "convex/values";
import { components, internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import {
  action,
  httpAction,
  internalMutation,
  internalQuery,
  mutation,
  query,
} from "./_generated/server";
import type { PublicHttpAction } from "convex/server";
import type { ActionCtx, MutationCtx, QueryCtx } from "./_generated/server";
import { NO_SUCH_TASK, confirmPressedInstance, undoPressedInstance } from "./instances";
import type { ConfirmTransport, PressResult, UndoPressResult } from "./instances";
import { DEVICES_ONLY, deviceActor, findDevice, requireDeviceActor } from "./lib/access";
import type { Actor, DeviceActor } from "./lib/access";
import { audit } from "./lib/audit";
import { NOT_DUE_YET, PRESS_ID_NOT_VALID, isPressId } from "./lib/confirmRule";
import { frameDoneTarget, loadDeviceState } from "./lib/deviceState";
import type { DeviceState } from "./lib/deviceState";
import { generateDeviceToken, hashDeviceToken, parseBearerToken } from "./lib/deviceToken";
import { isOpenState } from "./lib/escalation";
import { phoneRevoked } from "./lib/liveActivitySync";
import { loadPhoneTimeline } from "./lib/phoneTimeline";
import type { PhoneTimeline } from "./lib/phoneTimeline";
import { appError, isAppError } from "./lib/errors";
import { isJsonObject } from "./lib/http";
import {
  NO_STORE,
  convexErrorResponse,
  errorResponse,
  ipKey,
  jsonResponse,
  rateLimitedResponse,
} from "./lib/httpResponse";
import { STEP_NOT_VALID, isStepIndex } from "./lib/taskSteps";
import { DAY_MS, minutes } from "./lib/time";
import { DEVICE_VIAS, deviceScreen, deviceVia } from "./lib/validators";
import type { DeviceScreen, DeviceVia } from "./lib/validators";

export const DONE_INSTANCE_HEADER = "Sunny-Done-Instance";

export const DONE_STEP_HEADER = "Sunny-Done-Step";

const LAST_SEEN_INTERVAL_MS = minutes(5);

const MAX_BODY_CHARS = 4096;

const MAX_INSTANCE_ID_LENGTH = 128;

const MAX_PRESS_AGE_MS = 7 * DAY_MS;

const MAX_FIRMWARE_LENGTH = 40;

const SCREEN_SIDE = { min: 1, max: 10_000 };
const SCREEN_GREYS = { min: 2, max: 256 };

const REFUSED = {
  unreadable: "The press could not be read",
  undoUnreadable: "The undo could not be read",
  badId: "The task id is not valid",
  tooOld: "The press is too old",
  notHere: "The task is not in this household",
  notDue: NOT_DUE_YET,
} as const;

const BUTTON_EARLY_GRACE_MS = minutes(5);

async function pressedBeforeDue(
  ctx: MutationCtx,
  device: Doc<"devices">,
  press: { instanceId: Id<"taskInstances">; pressedAgoMs: number },
  now: number,
): Promise<boolean> {
  if (press.pressedAgoMs < 0) return false;
  const instance = await ctx.db.get(press.instanceId);
  if (instance === null || instance.householdId !== device.householdId) return false;
  const pressedAt = now - press.pressedAgoMs;
  return isOpenState(instance.state) && pressedAt < instance.windowStart - BUTTON_EARLY_GRACE_MS;
}

const BAD_ID_MESSAGE = "instanceId must be a task instance id";

export const TOKEN_REVOKED =
  "A family member turned off this device's token. Pair the device again to get a new one.";

const rateLimiter = new RateLimiter(components.rateLimiter, {
  tokenIssues: { kind: "token bucket", rate: 10, period: HOUR, capacity: 10 },
  tokenRevokes: { kind: "token bucket", rate: 10, period: HOUR, capacity: 10 },
  refusedPresses: { kind: "token bucket", rate: 20, period: HOUR, capacity: 20 },
  deviceRequests: { kind: "token bucket", rate: 120, period: MINUTE, capacity: 120 },
  deviceAuthFailedGlobal: { kind: "token bucket", rate: 60, period: MINUTE, capacity: 60 },
  deviceAuthFailedPerIp: { kind: "token bucket", rate: 10, period: MINUTE, capacity: 10 },
});

interface ConfirmRequest {
  instanceId: string;
  pressedAgoMs: number;
  via: DeviceVia;
  step?: number;
  pressId?: string;
}

interface UndoRequest {
  instanceId: string;
  pressId: string;
  undoneAgoMs: number;
}

interface InfoRequest {
  screen?: DeviceScreen;
  firmware?: string;
}

type Admission = { kind: "unknown" } | { kind: "limited"; retryAfter: number } | { kind: "ok" };

interface RefusedRequest {
  message: string;
  reason: string;
  pressedAgoMs: number | null;
  via: DeviceVia | null;
}

interface RefusedUndo {
  message: string;
  reason: string;
  undoneAgoMs: number | null;
  pressId: string | null;
}

type PressStatus = PressResult["status"];

type UndoStatus = UndoPressResult["status"];

type ConfirmOutcome =
  | { kind: "unauthorized" }
  | { kind: "bad_instance" }
  | { kind: "done"; status: PressStatus; reason: string | null; answeredPresses: number };

type UndoOutcome =
  | { kind: "unauthorized" }
  | { kind: "bad_instance" }
  | { kind: "done"; status: UndoStatus; answeredPresses: number };

export async function findDeviceByTokenHash(
  ctx: QueryCtx,
  tokenHash: string,
): Promise<Doc<"devices"> | null> {
  return await ctx.db
    .query("devices")
    .withIndex("by_token_hash", (q) => q.eq("tokenHash", tokenHash))
    .unique();
}

function seenLongAgo(lastSeenAt: number | null | undefined, now: number): boolean {
  return lastSeenAt == null || now - lastSeenAt > LAST_SEEN_INTERVAL_MS;
}

export async function revokeTokenOf(
  ctx: MutationCtx,
  actor: Actor,
  device: Doc<"devices">,
): Promise<void> {
  await ctx.db.patch(device._id, { tokenHash: undefined, tokenIssuedAt: undefined });
  await phoneRevoked(ctx, device._id);
  await audit(ctx, {
    householdId: device.householdId,
    actor,
    action: "revoke_device_token",
    entity: "device",
    entityId: device._id,
    detail: { hadToken: device.tokenHash !== undefined },
  });
}

export const revokeOwnToken = mutation({
  args: {},
  handler: async (ctx): Promise<null> => {
    const actor = await requireDeviceActor(ctx);
    const limit = await rateLimiter.limit(ctx, "tokenRevokes", { key: actor.device._id });
    if (!limit.ok) throw appError("limit", "Too many device token revokes. Try again later.");
    await revokeTokenOf(ctx, actor, actor.device);
    return null;
  },
});

export const storeTokenHash = internalMutation({
  args: { userId: v.string(), tokenHash: v.string() },
  handler: async (ctx, args): Promise<null> => {
    const device = await findDevice(ctx, args.userId);
    if (!device) throw appError("forbidden", DEVICES_ONLY);
    if (device.tokenRevokedAt !== undefined) throw appError("forbidden", TOKEN_REVOKED);
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

export const state = query({
  args: { minute: v.optional(v.number()) },
  handler: async (ctx): Promise<DeviceState> => {
    const actor = await requireDeviceActor(ctx);
    return await loadDeviceState(ctx, actor.householdId, Date.now());
  },
});

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

export const stateByToken = internalQuery({
  args: { tokenHash: v.string() },
  handler: async (ctx, args): Promise<DeviceState | null> => {
    const device = await findDeviceByTokenHash(ctx, args.tokenHash);
    if (device === null) return null;
    return await loadDeviceState(ctx, device.householdId, Date.now());
  },
});

export const timelineByToken = internalQuery({
  args: { tokenHash: v.string() },
  handler: async (ctx, args): Promise<PhoneTimeline | null> => {
    const device = await findDeviceByTokenHash(ctx, args.tokenHash);
    if (device === null) return null;
    return await loadPhoneTimeline(ctx, device.householdId, Date.now());
  },
});

type Sent = Record<string, number | string | null>;

function sentPress(press: { pressedAgoMs: number | null; via: DeviceVia | null }): Sent {
  return { pressedAgoMs: press.pressedAgoMs, via: press.via };
}

function sentUndo(tap: { undoneAgoMs: number | null; pressId: string | null }): Sent {
  return { undoneAgoMs: tap.undoneAgoMs, pressId: tap.pressId };
}

async function auditRefusal(
  ctx: MutationCtx,
  device: Doc<"devices">,
  action: "press_not_applied" | "undo_not_applied",
  reason: string,
  sent: Sent,
): Promise<void> {
  const limit = await rateLimiter.limit(ctx, "refusedPresses", { key: device._id });
  if (!limit.ok) return;
  const detail: Record<string, unknown> = {
    reason,
    receivedAt: Date.now(),
    transport: "device_api" satisfies ConfirmTransport,
  };
  for (const [key, value] of Object.entries(sent)) {
    if (value !== null) detail[key] = value;
  }
  await audit(ctx, {
    householdId: device.householdId,
    actor: deviceActor(device),
    action,
    entity: "task_instance",
    detail,
  });
}

async function countAnswer(ctx: MutationCtx, device: Doc<"devices">): Promise<number> {
  const answeredPresses = (device.answeredPresses ?? 0) + 1;
  await ctx.db.patch(device._id, { answeredPresses });
  return answeredPresses;
}

async function confirmForDevice(
  ctx: MutationCtx,
  actor: DeviceActor,
  args: {
    instanceId: Id<"taskInstances">;
    via: DeviceVia;
    pressedAgoMs: number;
    step?: number;
    pressId?: string;
  },
  now: number,
): Promise<{ status: PressStatus; reason: string | null }> {
  if (args.via === "button" && (await pressedBeforeDue(ctx, actor.device, args, now))) {
    await auditRefusal(ctx, actor.device, "press_not_applied", REFUSED.notDue, sentPress(args));
    return { status: "rejected", reason: REFUSED.notDue };
  }
  const budget = { key: actor.device._id };
  const room = (await rateLimiter.check(ctx, "refusedPresses", budget)).ok;
  let result: PressResult;
  try {
    result = await confirmPressedInstance(ctx, actor, { ...args, transport: "device_api" }, now, {
      recordRefusal: room,
    });
  } catch (e) {
    if (!isAppError(e, "forbidden")) throw e;
    await auditRefusal(ctx, actor.device, "press_not_applied", REFUSED.notHere, sentPress(args));
    return { status: "rejected", reason: NO_SUCH_TASK };
  }
  if (result.status !== "rejected") return { status: result.status, reason: null };
  if (room) await rateLimiter.limit(ctx, "refusedPresses", budget);
  return { status: "rejected", reason: result.reason };
}

async function undoForDevice(
  ctx: MutationCtx,
  actor: DeviceActor,
  args: { instanceId: Id<"taskInstances">; pressId: string; undoneAgoMs: number },
  now: number,
): Promise<UndoStatus> {
  const budget = { key: actor.device._id };
  const room = (await rateLimiter.check(ctx, "refusedPresses", budget)).ok;
  let result: UndoPressResult;
  try {
    result = await undoPressedInstance(ctx, actor, { ...args, transport: "device_api" }, now, {
      recordRefusal: room,
    });
  } catch (e) {
    if (!isAppError(e, "forbidden")) throw e;
    await auditRefusal(ctx, actor.device, "undo_not_applied", REFUSED.notHere, sentUndo(args));
    return "too_late";
  }
  if (result.status === "too_late" && room) await rateLimiter.limit(ctx, "refusedPresses", budget);
  return result.status;
}

export const confirmByToken = internalMutation({
  args: {
    tokenHash: v.string(),
    instanceId: v.string(),
    via: deviceVia,
    pressedAgoMs: v.number(),
    step: v.optional(v.number()),
    pressId: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<ConfirmOutcome> => {
    const device = await findDeviceByTokenHash(ctx, args.tokenHash);
    if (device === null) return { kind: "unauthorized" };
    const instanceId = ctx.db.normalizeId("taskInstances", args.instanceId);
    if (instanceId === null) {
      await auditRefusal(ctx, device, "press_not_applied", REFUSED.badId, sentPress(args));
      return { kind: "bad_instance" };
    }
    const { via, pressedAgoMs, step, pressId } = args;
    const result = await confirmForDevice(
      ctx,
      deviceActor(device),
      { instanceId, via, pressedAgoMs, step, pressId },
      Date.now(),
    );
    return { kind: "done", ...result, answeredPresses: await countAnswer(ctx, device) };
  },
});

export const undoByToken = internalMutation({
  args: {
    tokenHash: v.string(),
    instanceId: v.string(),
    pressId: v.string(),
    undoneAgoMs: v.number(),
  },
  handler: async (ctx, args): Promise<UndoOutcome> => {
    const device = await findDeviceByTokenHash(ctx, args.tokenHash);
    if (device === null) return { kind: "unauthorized" };
    const instanceId = ctx.db.normalizeId("taskInstances", args.instanceId);
    if (instanceId === null) {
      await auditRefusal(ctx, device, "undo_not_applied", REFUSED.badId, sentUndo(args));
      return { kind: "bad_instance" };
    }
    const status = await undoForDevice(
      ctx,
      deviceActor(device),
      { instanceId, pressId: args.pressId, undoneAgoMs: args.undoneAgoMs },
      Date.now(),
    );
    return { kind: "done", status, answeredPresses: await countAnswer(ctx, device) };
  },
});

export const refusePressByToken = internalMutation({
  args: {
    tokenHash: v.string(),
    reason: v.string(),
    pressedAgoMs: v.union(v.number(), v.null()),
    via: v.union(deviceVia, v.null()),
  },
  handler: async (ctx, args): Promise<null> => {
    const device = await findDeviceByTokenHash(ctx, args.tokenHash);
    if (device !== null) {
      await auditRefusal(ctx, device, "press_not_applied", args.reason, sentPress(args));
    }
    return null;
  },
});

export const refuseUndoByToken = internalMutation({
  args: {
    tokenHash: v.string(),
    reason: v.string(),
    undoneAgoMs: v.union(v.number(), v.null()),
    pressId: v.union(v.string(), v.null()),
  },
  handler: async (ctx, args): Promise<null> => {
    const device = await findDeviceByTokenHash(ctx, args.tokenHash);
    if (device !== null) {
      await auditRefusal(ctx, device, "undo_not_applied", args.reason, sentUndo(args));
    }
    return null;
  },
});

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

export function unauthorizedResponse(): Response {
  return errorResponse(401, "unauthenticated", "A valid device token is required", {
    "WWW-Authenticate": "Bearer",
  });
}

async function refuseAuthentication(ctx: ActionCtx, request: Request): Promise<Response> {
  const global = await rateLimiter.limit(ctx, "deviceAuthFailedGlobal");
  if (!global.ok) return rateLimitedResponse(global.retryAfter);
  const key = ipKey(request);
  if (key !== null) {
    const perIp = await rateLimiter.limit(ctx, "deviceAuthFailedPerIp", { key });
    if (!perIp.ok) return rateLimitedResponse(perIp.retryAfter);
  }
  return unauthorizedResponse();
}

export async function gate(ctx: ActionCtx, request: Request): Promise<string | Response> {
  const token = parseBearerToken(request.headers.get("Authorization"));
  if (token === null) return await refuseAuthentication(ctx, request);
  const tokenHash = await hashDeviceToken(token);
  const admission = await ctx.runMutation(internal.deviceApi.admit, { tokenHash });
  if (admission.kind === "unknown") return await refuseAuthentication(ctx, request);
  if (admission.kind === "limited") return rateLimitedResponse(admission.retryAfter);
  return tokenHash;
}

export async function readJsonObject(request: Request): Promise<Record<string, unknown> | string> {
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
  return isJsonObject(body) ? body : "The request body must be a JSON object";
}

export function unknownKey(
  body: Record<string, unknown>,
  allowed: readonly string[],
): string | null {
  const extra = Object.keys(body).find((k) => !allowed.includes(k));
  return extra === undefined ? null : `Unknown field ${extra}`;
}

function refusedRequest(
  message: string,
  reason: string,
  body: Record<string, unknown> | null,
): RefusedRequest {
  const age = body?.pressedAgoMs;
  const via = body?.via;
  return {
    message,
    reason,
    pressedAgoMs: typeof age === "number" && Number.isFinite(age) ? age : null,
    via:
      typeof via === "string" && (DEVICE_VIAS as readonly string[]).includes(via)
        ? (via as DeviceVia)
        : null,
  };
}

function isInstanceIdText(value: unknown): value is string {
  return typeof value === "string" && value !== "" && value.length <= MAX_INSTANCE_ID_LENGTH;
}

function isAge(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isPressIdText(value: unknown): value is string {
  return typeof value === "string" && isPressId(value);
}

function parseConfirmRequest(body: Record<string, unknown>): ConfirmRequest | RefusedRequest {
  const extra = unknownKey(body, ["instanceId", "pressedAgoMs", "via", "step", "pressId"]);
  if (extra !== null) return refusedRequest(extra, REFUSED.unreadable, body);
  const { instanceId, pressedAgoMs, via, step, pressId } = body;
  if (!isInstanceIdText(instanceId)) return refusedRequest(BAD_ID_MESSAGE, REFUSED.badId, body);
  const ageMessage = `pressedAgoMs must be a number from 0 to ${MAX_PRESS_AGE_MS}`;
  if (!isAge(pressedAgoMs)) return refusedRequest(ageMessage, REFUSED.unreadable, body);
  if (pressedAgoMs > MAX_PRESS_AGE_MS) return refusedRequest(ageMessage, REFUSED.tooOld, body);
  if (typeof via !== "string" || !(DEVICE_VIAS as readonly string[]).includes(via)) {
    return refusedRequest(`via must be one of ${DEVICE_VIAS.join(", ")}`, REFUSED.unreadable, body);
  }
  if (step !== undefined && (typeof step !== "number" || !isStepIndex(step))) {
    return refusedRequest(STEP_NOT_VALID, REFUSED.unreadable, body);
  }
  if (pressId !== undefined && !isPressIdText(pressId)) {
    return refusedRequest(PRESS_ID_NOT_VALID, REFUSED.unreadable, body);
  }
  return {
    instanceId,
    pressedAgoMs,
    via: via as DeviceVia,
    ...(step === undefined ? {} : { step }),
    ...(pressId === undefined ? {} : { pressId }),
  };
}

function refusedUndo(
  message: string,
  reason: string,
  body: Record<string, unknown> | null,
): RefusedUndo {
  return {
    message,
    reason,
    undoneAgoMs: isAge(body?.undoneAgoMs) ? body.undoneAgoMs : null,
    pressId: isPressIdText(body?.pressId) ? body.pressId : null,
  };
}

function parseUndoRequest(body: Record<string, unknown>): UndoRequest | RefusedUndo {
  const extra = unknownKey(body, ["instanceId", "pressId", "undoneAgoMs"]);
  if (extra !== null) return refusedUndo(extra, REFUSED.undoUnreadable, body);
  const { instanceId, pressId, undoneAgoMs } = body;
  if (!isInstanceIdText(instanceId)) return refusedUndo(BAD_ID_MESSAGE, REFUSED.badId, body);
  if (!isPressIdText(pressId)) {
    return refusedUndo(PRESS_ID_NOT_VALID, REFUSED.undoUnreadable, body);
  }
  if (!isAge(undoneAgoMs) || undoneAgoMs > MAX_PRESS_AGE_MS) {
    return refusedUndo(
      `undoneAgoMs must be a number from 0 to ${MAX_PRESS_AGE_MS}`,
      REFUSED.undoUnreadable,
      body,
    );
  }
  return { instanceId, pressId, undoneAgoMs };
}

function isIntIn(value: unknown, bounds: { min: number; max: number }): value is number {
  return (
    Number.isInteger(value) && (value as number) >= bounds.min && (value as number) <= bounds.max
  );
}

function parseInfoRequest(body: Record<string, unknown>): InfoRequest | string {
  const extra = unknownKey(body, ["screen", "firmware"]);
  if (extra !== null) return extra;
  const info: InfoRequest = {};
  if (body.screen !== undefined) {
    const screen = body.screen;
    const sideMessage = `screen width and height must be whole numbers from ${SCREEN_SIDE.min} to ${SCREEN_SIDE.max}`;
    if (!isJsonObject(screen)) return "screen must be an object";
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

function etagMatches(header: string | null, etag: string): boolean {
  if (header === null) return false;
  return header
    .split(",")
    .map((t) => t.trim().replace(/^W\//, ""))
    .some((t) => t === etag || t === "*");
}

export function notModified(
  request: Request,
  etag: string,
  headers: Record<string, string> = {},
): Response | null {
  if (!etagMatches(request.headers.get("If-None-Match"), etag)) return null;
  return new Response(null, { status: 304, headers: { ...NO_STORE, ...headers, ETag: etag } });
}

function etagOf(versioned: { version: string }): string {
  return `"${versioned.version}"`;
}

export function doneHeaders(state: DeviceState): Record<string, string> {
  const target = frameDoneTarget(state);
  if (target === null) return {};
  return { [DONE_INSTANCE_HEADER]: target.instanceId, [DONE_STEP_HEADER]: String(target.step) };
}

export function deviceRoute(
  fallback: string,
  handle: (ctx: ActionCtx, request: Request) => Promise<Response>,
): PublicHttpAction {
  return httpAction(async (ctx, request) => {
    try {
      return await handle(ctx, request);
    } catch (e) {
      return convexErrorResponse(e, "deviceApi", fallback);
    }
  });
}

async function stateAfterPress(ctx: ActionCtx, tokenHash: string): Promise<DeviceState | null> {
  try {
    return await ctx.runQuery(internal.deviceApi.stateByToken, { tokenHash });
  } catch (e) {
    console.error(`deviceApi: state after a press could not be read: ${String(e)}`);
    return null;
  }
}

async function answerWithState(
  ctx: ActionCtx,
  tokenHash: string,
  answer: { status: PressStatus | UndoStatus; reason?: string | null; answeredPresses: number },
): Promise<Response> {
  const state = await stateAfterPress(ctx, tokenHash);
  const headers = state ? { ...doneHeaders(state), ETag: etagOf(state) } : {};
  return jsonResponse({ ...answer, state }, 200, headers);
}

export const getState = deviceRoute("Could not load the device state", async (ctx, request) => {
  const tokenHash = await gate(ctx, request);
  if (tokenHash instanceof Response) return tokenHash;
  const state = await ctx.runQuery(internal.deviceApi.stateByToken, { tokenHash });
  if (state === null) return unauthorizedResponse();
  const etag = etagOf(state);
  const done = doneHeaders(state);
  const cached = notModified(request, etag, done);
  if (cached !== null) return cached;
  return jsonResponse(state, 200, { ...done, ETag: etag });
});

export const getTimeline = deviceRoute("Could not load the timeline", async (ctx, request) => {
  const tokenHash = await gate(ctx, request);
  if (tokenHash instanceof Response) return tokenHash;
  const timeline = await ctx.runQuery(internal.deviceApi.timelineByToken, { tokenHash });
  if (timeline === null) return unauthorizedResponse();
  const etag = etagOf(timeline);
  return notModified(request, etag) ?? jsonResponse(timeline, 200, { ETag: etag });
});

export const confirm = deviceRoute("Could not confirm the task", async (ctx, request) => {
  const tokenHash = await gate(ctx, request);
  if (tokenHash instanceof Response) return tokenHash;
  const body = await readJsonObject(request);
  const press =
    typeof body === "string"
      ? refusedRequest(body, REFUSED.unreadable, null)
      : parseConfirmRequest(body);
  if ("message" in press) {
    const { message, ...refusal } = press;
    await ctx.runMutation(internal.deviceApi.refusePressByToken, { tokenHash, ...refusal });
    return errorResponse(400, "invalid", message);
  }
  const outcome = await ctx.runMutation(internal.deviceApi.confirmByToken, {
    tokenHash,
    ...press,
  });
  if (outcome.kind === "unauthorized") return unauthorizedResponse();
  if (outcome.kind === "bad_instance") return errorResponse(400, "invalid", BAD_ID_MESSAGE);
  const { status, reason, answeredPresses } = outcome;
  return await answerWithState(ctx, tokenHash, { status, reason, answeredPresses });
});

export const undo = deviceRoute("Could not undo the press", async (ctx, request) => {
  const tokenHash = await gate(ctx, request);
  if (tokenHash instanceof Response) return tokenHash;
  const body = await readJsonObject(request);
  const tap =
    typeof body === "string"
      ? refusedUndo(body, REFUSED.undoUnreadable, null)
      : parseUndoRequest(body);
  if ("message" in tap) {
    const { message, ...refusal } = tap;
    await ctx.runMutation(internal.deviceApi.refuseUndoByToken, { tokenHash, ...refusal });
    return errorResponse(400, "invalid", message);
  }
  const outcome = await ctx.runMutation(internal.deviceApi.undoByToken, { tokenHash, ...tap });
  if (outcome.kind === "unauthorized") return unauthorizedResponse();
  if (outcome.kind === "bad_instance") return errorResponse(400, "invalid", BAD_ID_MESSAGE);
  const { status, answeredPresses } = outcome;
  return await answerWithState(ctx, tokenHash, { status, answeredPresses });
});

export const putInfo = deviceRoute("Could not store the device info", async (ctx, request) => {
  const tokenHash = await gate(ctx, request);
  if (tokenHash instanceof Response) return tokenHash;
  const body = await readJsonObject(request);
  const info = typeof body === "string" ? body : parseInfoRequest(body);
  if (typeof info === "string") return errorResponse(400, "invalid", info);
  const stored = await ctx.runMutation(internal.deviceApi.updateInfoByToken, {
    tokenHash,
    ...info,
  });
  return stored ? new Response(null, { status: 204, headers: NO_STORE }) : unauthorizedResponse();
});
