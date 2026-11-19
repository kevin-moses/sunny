import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { internalAction, internalMutation, internalQuery } from "./_generated/server";
import type { ActionCtx, MutationCtx } from "./_generated/server";
import {
  deviceRoute,
  findDeviceByTokenHash,
  gate,
  readJsonObject,
  unauthorizedResponse,
  unknownKey,
} from "./deviceApi";
import {
  backgroundRefreshMessage,
  isValidDeviceToken,
  refusedTokens,
  widgetReloadMessage,
} from "./lib/apnsPayload";
import type { ApnsSendResult } from "./lib/apnsPayload";
import { errorResponse, jsonResponse } from "./lib/httpResponse";
import { applyActivityReport, findPhonePush } from "./lib/liveActivity";
import type { ActivityDirective } from "./lib/liveActivity";
import { syncActivity } from "./lib/liveActivitySync";
import { REPORTED_ACTIVITY_STATES, pushStateReport } from "./lib/validators";
import { sendWidgetRefresh } from "./lib/widgetRefresh";
import type { PushStateReport, ReportedActivity, ReportedActivityState } from "./lib/validators";

export const MAX_REPORTED_ACTIVITIES = 8;

const MAX_ACTIVITY_KEY_LENGTH = 64;

const MAX_REFRESH_TOKENS = 20;

interface RefreshTarget {
  kind: "widgets" | "background";
  tokens: string[];
}

const NOT_A_PHONE = "Only the senior's phone reports push state";

type PushStateResult =
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

type TokenField = "liveActivityStart" | "widgetPush";

function reportedTokens(report: PushStateReport): [TokenField, string | null][] {
  const tokens: [TokenField, string | null][] = [];
  const start = report.liveActivityStart;
  if (start !== undefined) tokens.push(["liveActivityStart", start.enabled ? start.token : null]);
  if (report.widgetPush !== undefined) tokens.push(["widgetPush", report.widgetPush.token]);
  return tokens;
}

async function takeTokenFromOtherPhones(
  ctx: MutationCtx,
  deviceId: Id<"devices">,
  field: TokenField,
  token: string,
): Promise<void> {
  const holders =
    field === "liveActivityStart"
      ? ctx.db
          .query("phonePush")
          .withIndex("by_start_token", (q) => q.eq("liveActivityStart.token", token))
      : ctx.db
          .query("phonePush")
          .withIndex("by_widget_token", (q) => q.eq("widgetPush.token", token));
  for (const row of await holders.collect()) {
    if (row.deviceId !== deviceId) await ctx.db.patch(row._id, { [field]: undefined });
  }
}

async function storeReportedTokens(
  ctx: MutationCtx,
  device: Doc<"devices">,
  report: PushStateReport,
): Promise<void> {
  const existing = await findPhonePush(ctx, device._id);
  const patch: Partial<Pick<Doc<"phonePush">, "blindSince" | TokenField>> = {};
  if (existing?.blindSince !== undefined) patch.blindSince = undefined;
  for (const [field, token] of reportedTokens(report)) {
    if ((existing?.[field]?.token ?? null) === token) continue;
    if (token !== null) await takeTokenFromOtherPhones(ctx, device._id, field, token);
    patch[field] = token === null ? undefined : { token };
  }
  if (existing === null) await ctx.db.insert("phonePush", { deviceId: device._id, ...patch });
  else if (Object.keys(patch).length > 0) await ctx.db.patch(existing._id, patch);
}

export const reportByToken = internalMutation({
  args: { tokenHash: v.string(), report: pushStateReport },
  handler: async (ctx, args): Promise<PushStateResult> => {
    const device = await findDeviceByTokenHash(ctx, args.tokenHash);
    if (device === null) return { kind: "unauthorized" };
    if (device.kind !== "senior_phone") return { kind: "not_a_phone" };
    const now = Date.now();
    await storeReportedTokens(ctx, device, args.report);
    const { activities } = args.report;
    if (activities === undefined) return { kind: "ok", activities: [] };
    const { directives, behind } = await applyActivityReport(ctx, device, activities, now);
    const rule = { kind: "by_view", changedOn: device._id, startingEndsAs: null } as const;
    for (const { row, view } of behind) await syncActivity(ctx, row, now, rule, view);
    return { kind: "ok", activities: directives };
  },
});

export const dropStartToken = internalMutation({
  args: { deviceId: v.id("devices"), token: v.string() },
  handler: async (ctx, args): Promise<null> => {
    const row = await findPhonePush(ctx, args.deviceId);
    if (row !== null && row.liveActivityStart?.token === args.token) {
      await ctx.db.patch(row._id, { liveActivityStart: undefined });
    }
    return null;
  },
});

export const dropWidgetToken = internalMutation({
  args: { deviceId: v.id("devices"), token: v.string() },
  handler: async (ctx, args): Promise<null> => {
    const row = await findPhonePush(ctx, args.deviceId);
    if (row !== null && row.widgetPush?.token === args.token) {
      await ctx.db.patch(row._id, { widgetPush: undefined });
    }
    return null;
  },
});

export const trailingRefresh = internalMutation({
  args: { deviceId: v.id("devices") },
  handler: async (ctx, args): Promise<null> => {
    const row = await findPhonePush(ctx, args.deviceId);
    const trailingAt = row?.widgetRefresh?.trailingAt ?? null;
    const now = Date.now();
    if (row === null || trailingAt === null || now < trailingAt) return null;
    await sendWidgetRefresh(ctx, row, now);
    return null;
  },
});

export const refreshTarget = internalQuery({
  args: { deviceId: v.id("devices"), wakesApp: v.boolean() },
  handler: async (ctx, args): Promise<RefreshTarget | null> => {
    const device = await ctx.db.get(args.deviceId);
    const row = await findPhonePush(ctx, args.deviceId);
    if (device === null || device.kind !== "senior_phone" || row === null) return null;
    if (!args.wakesApp && row.widgetPush !== undefined) {
      return { kind: "widgets", tokens: [row.widgetPush.token] };
    }
    const alertTokens = await ctx.db
      .query("pushTokens")
      .withIndex("by_user", (q) => q.eq("userId", device.userId))
      .take(MAX_REFRESH_TOKENS);
    return { kind: "background", tokens: alertTokens.map((t) => t.token) };
  },
});

async function sendRefresh(
  ctx: ActionCtx,
  deviceId: Id<"devices">,
  wakesApp: boolean,
): Promise<null> {
  const target: RefreshTarget | null = await ctx.runQuery(internal.phonePush.refreshTarget, {
    deviceId,
    wakesApp,
  });
  if (target === null || target.tokens.length === 0) return null;
  const message = target.kind === "widgets" ? widgetReloadMessage() : backgroundRefreshMessage();
  const { results }: ApnsSendResult = await ctx.runAction(internal.apns.send, {
    sends: target.tokens.map((token) => ({ token, message })),
  });
  const dead = refusedTokens(results);
  if (dead.length === 0) return null;
  if (target.kind === "background") {
    await ctx.runMutation(internal.apnsTokens.deleteTokens, { tokens: dead });
    return null;
  }
  for (const token of dead) {
    await ctx.runMutation(internal.phonePush.dropWidgetToken, { deviceId, token });
  }
  return null;
}

export const refreshWidgets = internalAction({
  args: { deviceId: v.id("devices") },
  handler: async (ctx, args): Promise<null> => await sendRefresh(ctx, args.deviceId, false),
});

export const wakeToReport = internalAction({
  args: { deviceId: v.id("devices") },
  handler: async (ctx, args): Promise<null> => await sendRefresh(ctx, args.deviceId, true),
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
