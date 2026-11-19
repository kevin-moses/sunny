import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import {
  deviceRoute,
  findDeviceByTokenHash,
  gate,
  readJsonObject,
  unauthorizedResponse,
  unknownKey,
} from "./deviceApi";
import { isValidDeviceToken } from "./lib/apnsPayload";
import { errorResponse, jsonResponse } from "./lib/httpResponse";
import { applyActivityReport } from "./lib/liveActivity";
import type { ActivityDirective } from "./lib/liveActivity";
import { REPORTED_ACTIVITY_STATES, pushStateReport } from "./lib/validators";
import type { PushStateReport, ReportedActivity, ReportedActivityState } from "./lib/validators";

export const MAX_REPORTED_ACTIVITIES = 8;

const MAX_ACTIVITY_KEY_LENGTH = 64;

const NOT_A_PHONE = "Only the senior's phone reports push state";

export type PushStateResult =
  | { kind: "unauthorized" }
  | { kind: "not_a_phone" }
  | { kind: "ok"; activities: ActivityDirective[] };

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function reportedToken(value: unknown): string | null | undefined {
  if (value === null) return null;
  return typeof value === "string" && isValidDeviceToken(value) ? value : undefined;
}

function tokenMessage(section: string): string {
  return `${section} token must be a hex push token or null`;
}

function parseSection(
  name: string,
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> | string {
  if (!isObject(value)) return `${name} must be an object`;
  const extra = unknownKey(value, keys);
  if (extra !== null) return `${name}: ${extra}`;
  const missing = keys.find((key) => !(key in value));
  return missing === undefined ? value : `${name} needs ${missing}`;
}

function parseActivity(value: unknown): ReportedActivity | string {
  const entry = parseSection("An activity", value, ["key", "token", "state"]);
  if (typeof entry === "string") return entry;
  const { key, state } = entry;
  if (typeof key !== "string" || key === "" || key.length > MAX_ACTIVITY_KEY_LENGTH) {
    return "An activity's key must be the activityKey from its start push";
  }
  const token = reportedToken(entry.token);
  if (token === undefined) return tokenMessage("An activity's");
  if (
    typeof state !== "string" ||
    !(REPORTED_ACTIVITY_STATES as readonly string[]).includes(state)
  ) {
    return `An activity's state must be one of ${REPORTED_ACTIVITY_STATES.join(", ")}`;
  }
  return { key, token, state: state as ReportedActivityState };
}

export function parsePushStateRequest(body: Record<string, unknown>): PushStateReport | string {
  const extra = unknownKey(body, ["liveActivityStart", "activities", "widgetPush"]);
  if (extra !== null) return extra;
  const report: PushStateReport = {};
  if (body.liveActivityStart !== undefined) {
    const section = parseSection("liveActivityStart", body.liveActivityStart, ["token", "enabled"]);
    if (typeof section === "string") return section;
    const token = reportedToken(section.token);
    if (token === undefined) return tokenMessage("liveActivityStart");
    if (typeof section.enabled !== "boolean") return "liveActivityStart enabled must be a boolean";
    report.liveActivityStart = { token, enabled: section.enabled };
  }
  if (body.activities !== undefined) {
    if (!Array.isArray(body.activities) || body.activities.length > MAX_REPORTED_ACTIVITIES) {
      return `activities must be a list of at most ${MAX_REPORTED_ACTIVITIES}`;
    }
    const activities: ReportedActivity[] = [];
    for (const value of body.activities as unknown[]) {
      const activity = parseActivity(value);
      if (typeof activity === "string") return activity;
      activities.push(activity);
    }
    report.activities = activities;
  }
  if (body.widgetPush !== undefined) {
    const section = parseSection("widgetPush", body.widgetPush, ["token"]);
    if (typeof section === "string") return section;
    const token = reportedToken(section.token);
    if (token === undefined) return tokenMessage("widgetPush");
    report.widgetPush = { token };
  }
  return report;
}

export async function findPhonePush(
  ctx: QueryCtx,
  deviceId: Id<"devices">,
): Promise<Doc<"phonePush"> | null> {
  return await ctx.db
    .query("phonePush")
    .withIndex("by_device", (q) => q.eq("deviceId", deviceId))
    .unique();
}

async function storeReportedTokens(
  ctx: MutationCtx,
  device: Doc<"devices">,
  report: PushStateReport,
  now: number,
): Promise<void> {
  const patch: Partial<Pick<Doc<"phonePush">, "blindSince" | "liveActivityStart" | "widgetPush">> =
    { blindSince: undefined };
  const start = report.liveActivityStart;
  if (start !== undefined) {
    patch.liveActivityStart =
      start.enabled && start.token !== null ? { token: start.token, reportedAt: now } : undefined;
  }
  const widget = report.widgetPush;
  if (widget !== undefined) {
    patch.widgetPush = widget.token === null ? undefined : { token: widget.token, reportedAt: now };
  }
  const existing = await findPhonePush(ctx, device._id);
  if (existing === null) await ctx.db.insert("phonePush", { deviceId: device._id, ...patch });
  else await ctx.db.patch(existing._id, patch);
}

export const reportByToken = internalMutation({
  args: { tokenHash: v.string(), report: pushStateReport },
  handler: async (ctx, args): Promise<PushStateResult> => {
    const device = await findDeviceByTokenHash(ctx, args.tokenHash);
    if (device === null) return { kind: "unauthorized" };
    if (device.kind !== "senior_phone") return { kind: "not_a_phone" };
    const now = Date.now();
    await storeReportedTokens(ctx, device, args.report, now);
    const { activities } = args.report;
    if (activities === undefined) return { kind: "ok", activities: [] };
    return { kind: "ok", activities: await applyActivityReport(ctx, device, activities, now) };
  },
});

export const putPushState = deviceRoute("Could not store the push state", async (ctx, request) => {
  const tokenHash = await gate(ctx, request);
  if (tokenHash instanceof Response) return tokenHash;
  const body = await readJsonObject(request);
  const report = typeof body === "string" ? body : parsePushStateRequest(body);
  if (typeof report === "string") return errorResponse(400, "invalid", report);
  const result = await ctx.runMutation(internal.phonePush.reportByToken, { tokenHash, report });
  if (result.kind === "unauthorized") return unauthorizedResponse();
  if (result.kind === "not_a_phone") return errorResponse(403, "forbidden", NOT_A_PHONE);
  return jsonResponse({ activities: result.activities });
});
