import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import {
  action,
  httpAction,
  internalAction,
  internalMutation,
  internalQuery,
  mutation,
  query,
} from "./_generated/server";
import {
  isDeviceIdentity,
  loadHousehold,
  requireCaregiverAccount,
  requireCaregiverMember,
  SYSTEM_ACTOR,
} from "./lib/access";
import { toBase64Url } from "./lib/base64";
import { audit } from "./lib/audit";
import {
  deleteLinks,
  dropConnection,
  queueConnectionBackfill,
  scheduleGrantRevoke,
} from "./lib/calendarSync";
import { appError, isAppError } from "./lib/errors";
import {
  CALENDAR_SCOPE,
  OAUTH_FLOW_TTL_MS,
  calendarExists,
  consentUrl,
  createSunnyCalendar,
  exchangeCode,
  revokeRefreshToken,
  signState,
  verifyState,
} from "./lib/google";
import { decryptSecret, encryptSecret } from "./lib/secretBox";
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

export const assertCaregiver = internalQuery({
  args: { householdId: v.id("households"), userId: v.string() },
  handler: async (ctx, { householdId, userId }): Promise<null> => {
    await requireCaregiverMember(ctx, householdId, userId);
    return null;
  },
});

export const connectUrl = action({
  args: { householdId: v.id("households") },
  handler: async (ctx, { householdId }): Promise<string> => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw appError("unauthenticated", "Sign in first");
    if (isDeviceIdentity(identity)) {
      throw appError("forbidden", "Only a caregiver of this household can connect Google");
    }
    await ctx.runQuery(internal.googleCalendar.assertCaregiver, {
      householdId,
      userId: identity.subject,
    });
    const nonce = toBase64Url(crypto.getRandomValues(new Uint8Array(24)));
    await ctx.runMutation(internal.googleCalendar.createOauthState, {
      nonce,
      userId: identity.subject,
      householdId,
    });
    return consentUrl(await signState(identity.subject, householdId, nonce));
  },
});

const OAUTH_SWEEP_BATCH = 200;

export const createOauthState = internalMutation({
  args: { nonce: v.string(), userId: v.string(), householdId: v.id("households") },
  handler: async (ctx, args): Promise<null> => {
    await ctx.db.insert("oauthStates", { ...args, expiresAt: Date.now() + OAUTH_FLOW_TTL_MS });
    return null;
  },
});

export const consumeOauthState = internalMutation({
  args: { nonce: v.string(), userId: v.string(), householdId: v.id("households") },
  handler: async (ctx, { nonce, userId, householdId }): Promise<boolean> => {
    const row = await ctx.db
      .query("oauthStates")
      .withIndex("by_nonce", (q) => q.eq("nonce", nonce))
      .unique();
    if (!row) return false;
    await ctx.db.delete(row._id);
    return row.userId === userId && row.householdId === householdId && row.expiresAt >= Date.now();
  },
});

export const sweepOauthStates = internalMutation({
  args: {},
  handler: async (ctx): Promise<number> => {
    const expired = await ctx.db
      .query("oauthStates")
      .withIndex("by_expires", (q) => q.lt("expiresAt", Date.now()))
      .take(OAUTH_SWEEP_BATCH);
    for (const row of expired) await ctx.db.delete(row._id);
    return expired.length;
  },
});

export const revokeGrant = internalAction({
  args: { refreshToken: v.string() },
  handler: async (_ctx, { refreshToken }): Promise<boolean> => {
    try {
      return await revokeRefreshToken(await decryptSecret(refreshToken));
    } catch (e) {
      console.error(`Could not revoke Google grant: ${e instanceof Error ? e.message : String(e)}`);
      return false;
    }
  },
});

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
      accountEmail: args.accountEmail ?? undefined,
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
        await scheduleGrantRevoke(ctx, existing.refreshToken);
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

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function page(title: string, message: string, status = 200): Response {
  const body =
    `<!doctype html><html><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<title>${escapeHtml(title)}</title></head>` +
    `<body style="font-family:-apple-system,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem">` +
    `<h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p></body></html>`;
  return new Response(body, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

export const callback = httpAction(async (ctx, request) => {
  const url = new URL(request.url);
  if (url.searchParams.get("error")) {
    return page(
      "Not connected",
      "Google Calendar was not connected. You can try again from the Sunny app.",
      400,
    );
  }
  let unusedGrant: string | null = null;
  try {
    const state = await verifyState(url.searchParams.get("state") ?? "");
    const code = url.searchParams.get("code");
    if (!state || !code) {
      return page("Link expired", "This link has expired. Start again from the Sunny app.", 400);
    }
    const householdId = state.householdId as Id<"households">;
    const fresh = await ctx.runMutation(internal.googleCalendar.consumeOauthState, {
      nonce: state.nonce,
      userId: state.userId,
      householdId,
    });
    if (!fresh) {
      return page("Link expired", "This link has expired. Start again from the Sunny app.", 400);
    }

    const tokens = await exchangeCode(code);
    unusedGrant = tokens.refreshToken;
    if (!tokens.scopes.includes(CALENDAR_SCOPE)) {
      await revokeRefreshToken(tokens.refreshToken);
      unusedGrant = null;
      return page(
        "Permission needed",
        "Sunny needs permission to manage the calendar it creates. Start again and allow it.",
        400,
      );
    }
    const known = await ctx.runQuery(internal.googleCalendar.callbackContext, {
      householdId,
      userId: state.userId,
    });
    const calendarId =
      known.existingCalendarId &&
      (await calendarExists(tokens.accessToken, known.existingCalendarId))
        ? known.existingCalendarId
        : await createSunnyCalendar(tokens.accessToken, known.seniorPreferredName, known.timezone);
    await ctx.runMutation(internal.googleCalendar.saveConnection, {
      householdId,
      userId: state.userId,
      accountEmail: tokens.email,
      externalCalendarId: calendarId,
      refreshToken: await encryptSecret(tokens.refreshToken),
    });
    unusedGrant = null;
    return page(
      "Google Calendar connected",
      `"${known.seniorPreferredName} (Sunny)" is now in your Google Calendar and stays up to date. You can close this page.`,
    );
  } catch (e) {
    if (unusedGrant !== null) await revokeRefreshToken(unusedGrant);
    if (isAppError(e, "forbidden") || isAppError(e, "not_found")) {
      return page("Not allowed", "You are not a caregiver in this household.", 403);
    }
    console.error(`google callback failed: ${e instanceof Error ? e.message : String(e)}`);
    return page(
      "Something went wrong",
      "Google Calendar could not be connected. Please try again.",
      500,
    );
  }
});

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
