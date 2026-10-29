// googleCalendar.ts
// Purpose: A caregiver's Google Calendar connection, ported from the google-oauth Edge
// Function and the connection RPCs. `connectUrl` (a public action, member caregivers only,
// never a device) returns Google's consent URL carrying a signed state naming the caregiver,
// the household and a single-use nonce (stored in oauthStates, 10 minute TTL, swept hourly).
// Google redirects the browser to GET /google/callback (routed in http.ts): `callback`
// verifies the state, consumes the nonce (a second use shows the "link expired" page),
// exchanges the code, requires CALENDAR_SCOPE, reuses the caregiver's existing Sunny calendar
// if it still exists (else creates one), encrypts the refresh token, saves the connection
// through the internal `saveConnection` mutation (which reactivates it and schedules a
// chunked push of the events that can still occur, plus cancelled events still linked), and
// answers with a small HTML page. Every failure, including misconfiguration, ends on a page.
// A grant that ends up unused (rejected callback, replaced or dropped connection) is revoked
// at Google by `revokeGrant`, best effort. `myConnections` lists the caller's own connections
// without any token field; `disconnect` removes the caller's own connection, its links and
// pending syncs, and leaves the Google calendar as it is.
// Known residue: the state is not bound to the browser that started the flow, so someone who
// is handed a fresh consent link and completes it connects their Google account to the
// caregiver who created the link; the nonce limits that to one use inside 10 minutes.
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

/** A connection as shown to its owner; no token fields. */
interface ConnectionView {
  lastError: string | null;
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
    await requireCaregiverMember(ctx, householdId, userId);
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
    const nonce = toBase64Url(crypto.getRandomValues(new Uint8Array(24)));
    await ctx.runMutation(internal.googleCalendar.createOauthState, {
      nonce,
      userId: identity.subject,
      householdId,
    });
    return consentUrl(await signState(identity.subject, householdId, nonce));
  },
});

/** How long a started connect flow stays valid. */
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

/** Expired oauthStates rows deleted per sweep. */
const OAUTH_SWEEP_BATCH = 200;

/**
 * purpose: Remember a single-use OAuth nonce for a connect flow that is starting.
 * @param nonce: (string) Random value signed into the state.
 * @param userId: (string) Caregiver who started the flow.
 * @param householdId: (Id<"households">) Household being connected.
 * @return: (null)
 */
export const createOauthState = internalMutation({
  args: { nonce: v.string(), userId: v.string(), householdId: v.id("households") },
  handler: async (ctx, args): Promise<null> => {
    await ctx.db.insert("oauthStates", { ...args, expiresAt: Date.now() + OAUTH_STATE_TTL_MS });
    return null;
  },
});

/**
 * purpose: Use up an OAuth nonce: deletes it and says whether it was valid, i.e. it exists, has
 *          not expired, and was issued to this caregiver for this household.
 * @param nonce: (string) Nonce from the verified state.
 * @param userId: (string) Caregiver named in the state.
 * @param householdId: (Id<"households">) Household named in the state.
 * @return: (boolean) True the first time within the TTL, false otherwise.
 */
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

/**
 * purpose: Cron entry: delete expired OAuth nonces (one batch per run).
 * @return: (number) Rows deleted.
 */
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

/**
 * purpose: Revoke a Google grant (best effort): decrypts the stored refresh token and asks
 *          Google to revoke it. Never throws; failures are logged.
 * @param refreshToken: (string) The encrypted refresh token of a dropped or replaced connection.
 * @return: (boolean) Whether Google accepted the revocation.
 */
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

/**
 * purpose: The facts the callback needs: the household's name and zone, and the caregiver's
 *          existing Sunny calendar id.
 * @param householdId: (Id<"households">) Household.
 * @param userId: (string) Caregiver.
 * @return: (CallbackContext) The facts.
 * @raises forbidden when the user is no longer a caregiver of the household (a state token
 *         outlives membership by up to 15 minutes); not_found when the household is gone.
 */
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
    await requireCaregiverMember(ctx, args.householdId, args.userId);
    const fields = {
      accountEmail: args.accountEmail ?? undefined,
      externalCalendarId: args.externalCalendarId,
      refreshToken: args.refreshToken,
      status: "active" as const,
      error: undefined,
      // A new grant: the cached access token belongs to the old one.
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
      // A different calendar means the old links point nowhere.
      if (existing.externalCalendarId !== args.externalCalendarId) {
        await deleteLinks(ctx, existing._id);
      }
      await ctx.db.patch(existing._id, fields);
      if (existing.refreshToken !== args.refreshToken) {
        // The new grant replaces the old one, which would otherwise stay valid at Google.
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
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
    },
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
  // A refresh token issued by Google that this request does not end up saving.
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
