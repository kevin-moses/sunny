import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { internalMutation, internalQuery, mutation, query } from "./_generated/server";
import type { ActionCtx } from "./_generated/server";
import {
  loadHousehold,
  requireCaregiverAccount,
  requireCaregiverMember,
  SYSTEM_ACTOR,
} from "./lib/access";
import { audit } from "./lib/audit";
import { deleteLinks, dropConnection, queueConnectionBackfill } from "./lib/calendarSync";
import { appError } from "./lib/errors";
import { CALENDAR_SCOPE, calendarExists, createSunnyCalendar } from "./lib/google";
import type { GoogleGrant } from "./lib/google";
import { googleAccount, revokeUnusedGrant, scheduleGrantRevoke } from "./lib/googleTokens";
import { oauthPage } from "./lib/oauthFlow";
import type { FlowOwner } from "./lib/oauthFlow";
import { encryptSecret } from "./lib/secretBox";
import type { CalendarConnectionStatus } from "./lib/validators";

interface ConnectionView {
  lastError: string | null;
  id: Id<"calendarConnections">;
  accountEmail: string | null;
  status: CalendarConnectionStatus;
  error: string | null;
  lastSyncedAt: number | null;
}

interface CallbackContext {
  seniorPreferredName: string;
  timezone: string;
  existingCalendarId: string | null;
}

export const callbackContext = internalQuery({
  args: { householdId: v.id("households"), userId: v.string() },
  handler: async (ctx, { householdId, userId }): Promise<CallbackContext> => {
    await requireCaregiverMember(ctx, householdId, userId);
    const household = await loadHousehold(ctx, householdId);
    const existing = await ctx.db
      .query("calendarConnections")
      .withIndex("by_household_user", (q) => q.eq("householdId", householdId).eq("userId", userId))
      .unique();
    return {
      seniorPreferredName: household.seniorPreferredName,
      timezone: household.timezone,
      existingCalendarId: existing?.externalCalendarId ?? null,
    };
  },
});

export const saveConnection = internalMutation({
  args: {
    householdId: v.id("households"),
    userId: v.string(),
    accountEmail: v.union(v.null(), v.string()),
    externalCalendarId: v.string(),
    refreshToken: v.string(),
  },
  handler: async (ctx, args): Promise<Id<"calendarConnections">> => {
    await requireCaregiverMember(ctx, args.householdId, args.userId);
    const fields = {
      accountEmail: args.accountEmail === null ? undefined : googleAccount(args.accountEmail),
      externalCalendarId: args.externalCalendarId,
      refreshToken: args.refreshToken,
      status: "active" as const,
      error: undefined,
      accessToken: undefined,
      accessTokenExpiresAt: undefined,
    };
    const existing = await ctx.db
      .query("calendarConnections")
      .withIndex("by_household_user", (q) =>
        q.eq("householdId", args.householdId).eq("userId", args.userId),
      )
      .unique();
    let connectionId: Id<"calendarConnections">;
    if (existing) {
      if (existing.externalCalendarId !== args.externalCalendarId) {
        await deleteLinks(ctx, existing._id);
      }
      await ctx.db.patch(existing._id, fields);
      if (existing.refreshToken !== args.refreshToken) {
        await scheduleGrantRevoke(ctx, existing.refreshToken, existing.accountEmail ?? null);
      }
      connectionId = existing._id;
    } else {
      connectionId = await ctx.db.insert("calendarConnections", {
        householdId: args.householdId,
        userId: args.userId,
        provider: "google",
        ...fields,
      });
    }
    await audit(ctx, {
      householdId: args.householdId,
      actor: SYSTEM_ACTOR,
      action: "connect",
      entity: "calendarConnection",
      entityId: connectionId,
      detail: { userId: args.userId },
    });
    await queueConnectionBackfill(ctx, (await ctx.db.get(connectionId))!);
    return connectionId;
  },
});

export async function finishCalendar(
  ctx: ActionCtx,
  flow: FlowOwner,
  tokens: GoogleGrant,
): Promise<Response> {
  if (!tokens.scopes.includes(CALENDAR_SCOPE)) {
    await revokeUnusedGrant(ctx, tokens.refreshToken, tokens.email);
    return oauthPage(
      "Permission needed",
      "Sunny needs permission to manage the calendar it creates. Start again and allow it.",
      400,
    );
  }
  const known = await ctx.runQuery(internal.googleCalendar.callbackContext, flow);
  const calendarId =
    known.existingCalendarId && (await calendarExists(tokens.accessToken, known.existingCalendarId))
      ? known.existingCalendarId
      : await createSunnyCalendar(tokens.accessToken, known.seniorPreferredName, known.timezone);
  await ctx.runMutation(internal.googleCalendar.saveConnection, {
    ...flow,
    accountEmail: tokens.email,
    externalCalendarId: calendarId,
    refreshToken: await encryptSecret(tokens.refreshToken),
  });
  return oauthPage(
    "Google Calendar connected",
    `"${known.seniorPreferredName} (Sunny)" is now in your Google Calendar and stays up to date. You can close this page.`,
  );
}

export const myConnections = query({
  args: { householdId: v.id("households") },
  handler: async (ctx, { householdId }): Promise<ConnectionView[]> => {
    const userId = await requireCaregiverAccount(ctx);
    await requireCaregiverMember(ctx, householdId, userId);
    const rows = await ctx.db
      .query("calendarConnections")
      .withIndex("by_household_user", (q) => q.eq("householdId", householdId).eq("userId", userId))
      .collect();
    return rows.map((c) => ({
      id: c._id,
      accountEmail: c.accountEmail ?? null,
      status: c.status,
      error: c.error ?? null,
      lastSyncedAt: c.lastSyncedAt ?? null,
      lastError: c.lastError ?? null,
    }));
  },
});

export const disconnect = mutation({
  args: { connectionId: v.id("calendarConnections") },
  handler: async (ctx, { connectionId }): Promise<null> => {
    const userId = await requireCaregiverAccount(ctx);
    const connection = await ctx.db.get(connectionId);
    if (!connection || connection.userId !== userId) {
      throw appError("not_found", "Connection not found");
    }
    await audit(ctx, {
      householdId: connection.householdId,
      actor: SYSTEM_ACTOR,
      action: "disconnect",
      entity: "calendarConnection",
      entityId: connectionId,
      detail: { userId },
    });
    await dropConnection(ctx, connectionId);
    return null;
  },
});
