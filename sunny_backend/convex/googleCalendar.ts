// googleCalendar.ts
// Purpose: A caregiver's Google Calendar connection, ported from the google-oauth Edge
// Function and the connection RPCs. `connectUrl` (a public action, member caregivers only,
// never a device) returns Google's consent URL carrying a signed state naming the caregiver
// and household. Google redirects the browser to GET /google/callback (routed in http.ts):
// `callback` verifies the state, exchanges the code, requires CALENDAR_SCOPE, reuses the
// caregiver's existing Sunny calendar if it still exists (else creates one), encrypts the
// refresh token, saves the connection through the internal `saveConnection` mutation (which
// reactivates it and queues a push of every live event, plus cancelled events still linked),
// and answers with a small HTML page. `myConnections` lists the caller's own connections
// without any token field; `disconnect` removes the caller's own connection, its links and
// pending syncs, and leaves the Google calendar as it is.
// The refresh token is encrypted in the callback action (lib/secretBox.ts) and the mutation
// stores the box: mutations must be deterministic and cannot rely on WebCrypto.
// Env (read by lib/google.ts): GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI,
// GOOGLE_OAUTH_STATE_SECRET; CALENDAR_TOKEN_KEY (read by lib/secretBox.ts).
//
// Last modified: 2026-10-29

import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import {
  action,
  httpAction,
  internalMutation,
  internalQuery,
  mutation,
  query,
} from "./_generated/server";
import { findDevice, findMember, isDeviceIdentity, requireCaregiverAccount } from "./lib/access";
import { audit } from "./lib/audit";
import { dropConnection, queueConnectionBackfill } from "./lib/calendarSync";
import { appError } from "./lib/errors";
import {
  CALENDAR_SCOPE,
  calendarExists,
  consentUrl,
  createSunnyCalendar,
  exchangeCode,
  signState,
  verifyState,
} from "./lib/google";
import { encryptSecret } from "./lib/secretBox";
import type { CalendarConnectionStatus } from "./lib/validators";

/** A connection as shown to its owner; no token fields. */
export interface ConnectionView {
  id: Id<"calendarConnections">;
  accountEmail: string | null;
  status: CalendarConnectionStatus;
  error: string | null;
  lastSyncedAt: number | null;
}

/** What the callback needs to know before it talks to Google. */
interface CallbackContext {
  seniorPreferredName: string;
  timezone: string;
  existingCalendarId: string | null;
}

/**
 * purpose: Check that a user is a caregiver (not a device) of the household.
 * @param householdId: (Id<"households">) Household.
 * @param userId: (string) Clerk user id.
 * @return: (null)
 * @raises forbidden for a device or a non-member.
 */
export const assertCaregiver = internalQuery({
  args: { householdId: v.id("households"), userId: v.string() },
  handler: async (ctx, { householdId, userId }): Promise<null> => {
    if ((await findDevice(ctx, userId)) || !(await findMember(ctx, householdId, userId))) {
      throw appError("forbidden", "Only a caregiver of this household can connect Google");
    }
    return null;
  },
});

/**
 * purpose: Start the Google connect flow for the signed-in caregiver.
 * @param householdId: (Id<"households">) Household to connect.
 * @return: (string) Google's consent URL, with a signed state valid for 15 minutes.
 * @raises unauthenticated when signed out; forbidden for a device or a non-member.
 */
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
    return consentUrl(await signState(identity.subject, householdId));
  },
});

/**
 * purpose: The facts the callback needs: the household's name and zone, and the caregiver's
 *          existing Sunny calendar id.
 * @param householdId: (Id<"households">) Household.
 * @param userId: (string) Caregiver.
 * @return: (CallbackContext | null) Null when the household is gone or the user is not a
 *          member (state tokens outlive membership by up to 15 minutes).
 */
export const callbackContext = internalQuery({
  args: { householdId: v.id("households"), userId: v.string() },
  handler: async (ctx, { householdId, userId }): Promise<CallbackContext | null> => {
    const household = await ctx.db.get(householdId);
    if (!household || !(await findMember(ctx, householdId, userId))) return null;
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

/**
 * purpose: Save a caregiver's Google connection after OAuth (the port of
 *          save_calendar_connection): create it or reactivate the existing one with the new
 *          token and calendar, and queue a push of every live event (and of cancelled events
 *          still linked to it). A different calendar than before drops the old links.
 * @param householdId: (Id<"households">) Household.
 * @param userId: (string) Caregiver (must be a member).
 * @param accountEmail: (string | null) Google account shown to the caregiver.
 * @param externalCalendarId: (string) The Sunny calendar in the caregiver's account.
 * @param refreshToken: (string) The refresh token, already encrypted (lib/secretBox.ts).
 * @return: (Id<"calendarConnections">) The connection.
 * @raises forbidden when the user is not a member.
 */
export const saveConnection = internalMutation({
  args: {
    householdId: v.id("households"),
    userId: v.string(),
    accountEmail: v.union(v.null(), v.string()),
    externalCalendarId: v.string(),
    refreshToken: v.string(),
  },
  handler: async (ctx, args): Promise<Id<"calendarConnections">> => {
    if (!(await findMember(ctx, args.householdId, args.userId))) {
      throw appError("forbidden", "Not a caregiver in this household");
    }
    const fields = {
      accountEmail: args.accountEmail ?? undefined,
      externalCalendarId: args.externalCalendarId,
      refreshToken: args.refreshToken,
      status: "active" as const,
      error: undefined,
    };
    const existing = await ctx.db
      .query("calendarConnections")
      .withIndex("by_household_user", (q) =>
        q.eq("householdId", args.householdId).eq("userId", args.userId),
      )
      .unique();
    let connectionId: Id<"calendarConnections">;
    if (existing) {
      // A different calendar means the old links point nowhere.
      if (existing.externalCalendarId !== args.externalCalendarId) {
        const links = await ctx.db
          .query("calendarEventLinks")
          .withIndex("by_connection", (q) => q.eq("connectionId", existing._id))
          .collect();
        for (const link of links) await ctx.db.delete(link._id);
      }
      await ctx.db.patch(existing._id, fields);
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
      actor: { kind: "system" },
      action: "connect",
      entity: "calendarConnection",
      entityId: connectionId,
      detail: { userId: args.userId },
    });
    await queueConnectionBackfill(ctx, (await ctx.db.get(connectionId))!);
    return connectionId;
  },
});

/**
 * purpose: Escape text for HTML.
 * @param text: (string) Plain text.
 * @return: (string) Text safe inside an element or double-quoted attribute.
 */
function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/**
 * purpose: A minimal HTML page for the end of the browser flow.
 * @param title: (string) Heading.
 * @param message: (string) One sentence for the caregiver.
 * @param status: (number) HTTP status.
 * @return: (Response) HTML response.
 */
function page(title: string, message: string, status = 200): Response {
  const body =
    `<!doctype html><html><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<title>${escapeHtml(title)}</title></head>` +
    `<body style="font-family:-apple-system,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem">` +
    `<h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p></body></html>`;
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
  });
}

/**
 * purpose: Finish the connect flow after Google redirects back (GET /google/callback, public).
 * @param request: (Request) Callback request with code and state (or error) query parameters.
 * @return: (Response) An HTML page saying whether it worked.
 */
export const callback = httpAction(async (ctx, request) => {
  const url = new URL(request.url);
  if (url.searchParams.get("error")) {
    return page(
      "Not connected",
      "Google Calendar was not connected. You can try again from the Sunny app.",
      400,
    );
  }
  const state = await verifyState(url.searchParams.get("state") ?? "");
  const code = url.searchParams.get("code");
  if (!state || !code) {
    return page("Link expired", "This link has expired. Start again from the Sunny app.", 400);
  }

  try {
    const tokens = await exchangeCode(code);
    if (!tokens.scopes.includes(CALENDAR_SCOPE)) {
      return page(
        "Permission needed",
        "Sunny needs permission to manage the calendar it creates. Start again and allow it.",
        400,
      );
    }
    const householdId = state.householdId as Id<"households">;
    const known = await ctx.runQuery(internal.googleCalendar.callbackContext, {
      householdId,
      userId: state.userId,
    });
    if (!known) {
      return page("Not allowed", "You are not a caregiver in this household.", 403);
    }
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
    return page(
      "Google Calendar connected",
      `"${known.seniorPreferredName} (Sunny)" is now in your Google Calendar and stays up to date. You can close this page.`,
    );
  } catch (e) {
    console.error(`google callback failed: ${e instanceof Error ? e.message : String(e)}`);
    return page(
      "Something went wrong",
      "Google Calendar could not be connected. Please try again.",
      500,
    );
  }
});

/**
 * purpose: The signed-in caregiver's own Google connections in a household. Token fields are
 *          never returned.
 * @param householdId: (Id<"households">) Household.
 * @return: (ConnectionView[]) The caller's connections (at most one per household).
 * @raises forbidden for a device or a non-member.
 */
export const myConnections = query({
  args: { householdId: v.id("households") },
  handler: async (ctx, { householdId }): Promise<ConnectionView[]> => {
    const userId = await requireCaregiverAccount(ctx);
    if (!(await findMember(ctx, householdId, userId))) throw appError("forbidden", "Not allowed");
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
    }));
  },
});

/**
 * purpose: Disconnect the caller's own Google connection: deletes it with its stored token,
 *          event links and pending syncs. The Sunny calendar in Google is left as it is.
 * @param connectionId: (Id<"calendarConnections">) Connection to remove.
 * @return: (null)
 * @raises not_found when it does not exist or belongs to someone else.
 */
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
      actor: { kind: "system" },
      action: "disconnect",
      entity: "calendarConnection",
      entityId: connectionId,
      detail: { userId },
    });
    await dropConnection(ctx, connectionId);
    return null;
  },
});
