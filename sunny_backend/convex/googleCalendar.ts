import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import {
  action,
  httpAction,
  internalAction,
  internalMutation,
  internalQuery,
  mutation,
  query,
} from "./_generated/server";
import type { ActionCtx, MutationCtx } from "./_generated/server";
import {
  isDeviceIdentity,
  loadHousehold,
  requireCaregiverAccount,
  requireCaregiverMember,
  SYSTEM_ACTOR,
} from "./lib/access";
import { audit } from "./lib/audit";
import {
  deleteLinks,
  dropConnection,
  queueConnectionBackfill,
  scheduleGrantRevoke,
} from "./lib/calendarSync";
import { appError, errorText, isAppError } from "./lib/errors";
import {
  CALENDAR_SCOPE,
  calendarExists,
  consentUrl,
  createSunnyCalendar,
  exchangeCode,
  revokeRefreshToken,
  signState,
  startUrl,
  verifyState,
} from "./lib/google";
import {
  OAUTH_FLOW_TTL_MS,
  OAUTH_TICKET_TTL_MS,
  clearedFlowCookie,
  flowCookie,
  readFlowCookie,
  sha256Base64Url,
} from "./lib/oauthFlow";
import { NO_STORE } from "./lib/httpResponse";
import { constantTimeEqual, decryptSecret, encryptSecret, randomToken } from "./lib/secretBox";
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
    const ticket = randomToken();
    const url = startUrl(ticket);
    await ctx.runMutation(internal.googleCalendar.createOauthFlow, {
      ticketHash: await sha256Base64Url(ticket),
      userId: identity.subject,
      householdId,
    });
    return url;
  },
});

const OAUTH_SWEEP_BATCH = 200;

type ConnectRefusal =
  | "ticket_reused"
  | "ticket_expired"
  | "flow_used"
  | "flow_expired"
  | "flow_not_started"
  | "no_browser_cookie"
  | "wrong_browser"
  | "code_rejected";

interface ClaimedFlow {
  userId: string;
  householdId: Id<"households">;
  codeVerifier: string;
}

async function auditRefusal(
  ctx: MutationCtx,
  flow: { householdId: Id<"households">; userId: string },
  reason: ConnectRefusal,
): Promise<void> {
  await audit(ctx, {
    householdId: flow.householdId,
    actor: SYSTEM_ACTOR,
    action: "connect_refused",
    entity: "calendarConnection",
    detail: { userId: flow.userId, reason },
  });
}

function checkClaim(
  flow: Doc<"oauthFlows">,
  browserHash: string | null,
  now: number,
): { codeVerifier: string } | { refused: ConnectRefusal } {
  if (flow.consumedAt !== undefined) return { refused: "flow_used" };
  if (flow.expiresAt < now) return { refused: "flow_expired" };
  if (!flow.started) return { refused: "flow_not_started" };
  if (browserHash === null) return { refused: "no_browser_cookie" };
  if (!constantTimeEqual(flow.started.browserHash, browserHash)) {
    return { refused: "wrong_browser" };
  }
  return { codeVerifier: flow.started.codeVerifier };
}

export const createOauthFlow = internalMutation({
  args: { ticketHash: v.string(), userId: v.string(), householdId: v.id("households") },
  handler: async (ctx, args): Promise<null> => {
    await ctx.db.insert("oauthFlows", { ...args, expiresAt: Date.now() + OAUTH_TICKET_TTL_MS });
    return null;
  },
});

export const startOauthFlow = internalMutation({
  args: { ticketHash: v.string(), browserHash: v.string(), codeVerifier: v.string() },
  handler: async (ctx, { ticketHash, ...started }): Promise<Id<"oauthFlows"> | null> => {
    const flow = await ctx.db
      .query("oauthFlows")
      .withIndex("by_ticket", (q) => q.eq("ticketHash", ticketHash))
      .unique();
    if (!flow) return null;
    const now = Date.now();
    if (flow.started) {
      await auditRefusal(ctx, flow, "ticket_reused");
      return null;
    }
    if (flow.expiresAt < now) {
      await auditRefusal(ctx, flow, "ticket_expired");
      return null;
    }
    await ctx.db.patch(flow._id, { started, expiresAt: now + OAUTH_FLOW_TTL_MS });
    return flow._id;
  },
});

export const consumeOauthFlow = internalMutation({
  args: { flowId: v.string(), browserHash: v.union(v.null(), v.string()) },
  handler: async (ctx, { flowId, browserHash }): Promise<ClaimedFlow | null> => {
    const id = ctx.db.normalizeId("oauthFlows", flowId);
    const flow = id === null ? null : await ctx.db.get(id);
    if (!flow) {
      console.warn("google callback: refused a flow that no longer exists");
      return null;
    }
    const now = Date.now();
    if (flow.consumedAt === undefined) await ctx.db.patch(flow._id, { consumedAt: now });
    const result = checkClaim(flow, browserHash, now);
    if ("refused" in result) {
      await auditRefusal(ctx, flow, result.refused);
      return null;
    }
    return { userId: flow.userId, householdId: flow.householdId, ...result };
  },
});

export const recordCodeRejected = internalMutation({
  args: { householdId: v.id("households"), userId: v.string() },
  handler: async (ctx, flow): Promise<null> => {
    await auditRefusal(ctx, flow, "code_rejected");
    return null;
  },
});

export const sweepOauthFlows = internalMutation({
  args: {},
  handler: async (ctx): Promise<number> => {
    const expired = await ctx.db
      .query("oauthFlows")
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
      console.error(`Could not revoke Google grant: ${errorText(e)}`);
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

const SECURITY_HEADERS = {
  ...NO_STORE,
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
};

function page(title: string, message: string, status = 200): Response {
  const body =
    `<!doctype html><html><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<title>${escapeHtml(title)}</title></head>` +
    `<body style="font-family:-apple-system,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem">` +
    `<h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p></body></html>`;
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8", ...SECURITY_HEADERS },
  });
}

function expiredPage(): Response {
  return page("Link expired", "This link has expired. Start again from the Sunny app.", 400);
}

function errorPage(): Response {
  return page(
    "Something went wrong",
    "Google Calendar could not be connected. Please try again.",
    500,
  );
}

export const start = httpAction(async (ctx, request) => {
  const ticket = new URL(request.url).searchParams.get("ticket");
  if (!ticket) return expiredPage();
  try {
    const browserSecret = randomToken();
    const codeVerifier = randomToken();
    const flowId = await ctx.runMutation(internal.googleCalendar.startOauthFlow, {
      ticketHash: await sha256Base64Url(ticket),
      browserHash: await sha256Base64Url(browserSecret),
      codeVerifier: await encryptSecret(codeVerifier),
    });
    if (!flowId) return expiredPage();
    return new Response(null, {
      status: 302,
      headers: {
        Location: consentUrl(await signState(flowId), await sha256Base64Url(codeVerifier)),
        "Set-Cookie": flowCookie(browserSecret),
        ...SECURITY_HEADERS,
      },
    });
  } catch (e) {
    console.error(`google start failed: ${errorText(e)}`);
    return errorPage();
  }
});

async function finishConnect(ctx: ActionCtx, request: Request): Promise<Response> {
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
    const flowId = await verifyState(url.searchParams.get("state") ?? "");
    const code = url.searchParams.get("code");
    if (!flowId) console.warn("google callback: refused a state that did not verify");
    if (!flowId || !code) return expiredPage();
    const browserSecret = readFlowCookie(request);
    const flow = await ctx.runMutation(internal.googleCalendar.consumeOauthFlow, {
      flowId,
      browserHash: browserSecret === null ? null : await sha256Base64Url(browserSecret),
    });
    if (!flow) return expiredPage();
    const { householdId, userId } = flow;

    const tokens = await exchangeCode(code, await decryptSecret(flow.codeVerifier));
    if (!tokens) {
      await ctx.runMutation(internal.googleCalendar.recordCodeRejected, { householdId, userId });
      return expiredPage();
    }
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
      userId,
    });
    const calendarId =
      known.existingCalendarId &&
      (await calendarExists(tokens.accessToken, known.existingCalendarId))
        ? known.existingCalendarId
        : await createSunnyCalendar(tokens.accessToken, known.seniorPreferredName, known.timezone);
    await ctx.runMutation(internal.googleCalendar.saveConnection, {
      householdId,
      userId,
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
    console.error(`google callback failed: ${errorText(e)}`);
    return errorPage();
  }
}

export const callback = httpAction(async (ctx, request) => {
  const response = await finishConnect(ctx, request);
  response.headers.append("Set-Cookie", clearedFlowCookie());
  return response;
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
