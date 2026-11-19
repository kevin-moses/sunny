import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import {
  action,
  httpAction,
  internalAction,
  internalMutation,
  internalQuery,
} from "./_generated/server";
import type { ActionCtx, MutationCtx } from "./_generated/server";
import { EDITOR_ROLES, isDeviceIdentity, requireCaregiverMember, SYSTEM_ACTOR } from "./lib/access";
import { audit } from "./lib/audit";
import { appError, errorText, isAppError } from "./lib/errors";
import { finishMailbox } from "./gmail";
import { finishCalendar } from "./googleCalendar";
import {
  CALENDAR_SCOPE,
  GMAIL_SCOPE,
  consentUrl,
  exchangeCode,
  signState,
  startUrl,
  verifyState,
} from "./lib/google";
import type { GoogleGrant } from "./lib/google";
import { revokeUnusedGrant } from "./lib/googleTokens";
import {
  OAUTH_FLOW_TTL_MS,
  OAUTH_TICKET_TTL_MS,
  SECURITY_HEADERS,
  clearedFlowCookie,
  errorPage,
  expiredPage,
  flowCookie,
  oauthPage,
  readFlowCookie,
  sha256Base64Url,
} from "./lib/oauthFlow";
import { constantTimeEqual, decryptSecret, encryptSecret, randomToken } from "./lib/secretBox";
import { oauthPurpose } from "./lib/validators";
import type { OAuthPurpose } from "./lib/validators";

export interface FlowOwner {
  userId: string;
  householdId: Id<"households">;
}

interface PurposeConfig {
  scope: string;
  prompt: string;
  finish(ctx: ActionCtx, flow: FlowOwner, tokens: GoogleGrant): Promise<Response>;
}

export const GOOGLE_PURPOSES: Record<OAuthPurpose, PurposeConfig> = {
  calendar: { scope: CALENDAR_SCOPE, prompt: "consent", finish: finishCalendar },
  mailbox: { scope: GMAIL_SCOPE, prompt: "consent select_account", finish: finishMailbox },
};

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

interface ClaimedFlow extends FlowOwner {
  purpose: OAuthPurpose;
  codeVerifier: string;
}

export const assertMayConnect = internalQuery({
  args: { householdId: v.id("households"), userId: v.string(), purpose: oauthPurpose },
  handler: async (ctx, { householdId, userId, purpose }): Promise<null> => {
    const member = await requireCaregiverMember(ctx, householdId, userId);
    if (purpose === "mailbox" && !EDITOR_ROLES.includes(member.role)) {
      throw appError("forbidden", "Only a primary caregiver or member can connect the mailbox");
    }
    return null;
  },
});

export const connectUrl = action({
  args: { householdId: v.id("households"), purpose: oauthPurpose },
  handler: async (ctx, { householdId, purpose }): Promise<string> => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw appError("unauthenticated", "Sign in first");
    if (isDeviceIdentity(identity)) {
      throw appError("forbidden", "Only a caregiver of this household can connect Google");
    }
    await ctx.runQuery(internal.googleOauth.assertMayConnect, {
      householdId,
      userId: identity.subject,
      purpose,
    });
    const ticket = randomToken();
    const url = startUrl(ticket);
    await ctx.runMutation(internal.googleOauth.createOauthFlow, {
      ticketHash: await sha256Base64Url(ticket),
      userId: identity.subject,
      householdId,
      purpose,
    });
    return url;
  },
});

async function auditRefusal(
  ctx: MutationCtx,
  flow: { householdId: Id<"households">; userId: string; purpose: OAuthPurpose },
  reason: ConnectRefusal,
): Promise<void> {
  await audit(ctx, {
    householdId: flow.householdId,
    actor: SYSTEM_ACTOR,
    action: "connect_refused",
    entity: "oauthFlow",
    detail: { userId: flow.userId, purpose: flow.purpose, reason },
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
  args: {
    ticketHash: v.string(),
    userId: v.string(),
    householdId: v.id("households"),
    purpose: oauthPurpose,
  },
  handler: async (ctx, args): Promise<null> => {
    await ctx.db.insert("oauthFlows", { ...args, expiresAt: Date.now() + OAUTH_TICKET_TTL_MS });
    return null;
  },
});

export const startOauthFlow = internalMutation({
  args: { ticketHash: v.string(), browserHash: v.string(), codeVerifier: v.string() },
  handler: async (
    ctx,
    { ticketHash, ...started },
  ): Promise<{ flowId: Id<"oauthFlows">; purpose: OAuthPurpose } | null> => {
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
    return { flowId: flow._id, purpose: flow.purpose };
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
    return {
      userId: flow.userId,
      householdId: flow.householdId,
      purpose: flow.purpose,
      ...result,
    };
  },
});

export const recordCodeRejected = internalMutation({
  args: { householdId: v.id("households"), userId: v.string(), purpose: oauthPurpose },
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

export const accountInUse = internalQuery({
  args: { accountEmail: v.string() },
  handler: async (ctx, { accountEmail }): Promise<boolean> => {
    const mailbox = await ctx.db
      .query("mailboxes")
      .withIndex("by_account", (q) => q.eq("accountEmail", accountEmail))
      .first();
    const calendar = await ctx.db
      .query("calendarConnections")
      .withIndex("by_account", (q) => q.eq("accountEmail", accountEmail))
      .first();
    return mailbox !== null || calendar !== null;
  },
});

export const revokeGrant = internalAction({
  args: { refreshToken: v.string(), accountEmail: v.union(v.null(), v.string()) },
  handler: async (ctx, { refreshToken, accountEmail }): Promise<boolean> => {
    try {
      return await revokeUnusedGrant(ctx, await decryptSecret(refreshToken), accountEmail);
    } catch (e) {
      console.error(`Could not revoke Google grant: ${errorText(e)}`);
      return false;
    }
  },
});

export const start = httpAction(async (ctx, request) => {
  const ticket = new URL(request.url).searchParams.get("ticket");
  if (!ticket) return expiredPage();
  try {
    const browserSecret = randomToken();
    const codeVerifier = randomToken();
    const started = await ctx.runMutation(internal.googleOauth.startOauthFlow, {
      ticketHash: await sha256Base64Url(ticket),
      browserHash: await sha256Base64Url(browserSecret),
      codeVerifier: await encryptSecret(codeVerifier),
    });
    if (!started) return expiredPage();
    return new Response(null, {
      status: 302,
      headers: {
        Location: consentUrl(
          await signState(started.flowId),
          await sha256Base64Url(codeVerifier),
          GOOGLE_PURPOSES[started.purpose],
        ),
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
    return oauthPage(
      "Not connected",
      "Google was not connected. You can try again from the Sunny app.",
      400,
    );
  }
  let unusedGrant: GoogleGrant | null = null;
  try {
    const flowId = await verifyState(url.searchParams.get("state") ?? "");
    const code = url.searchParams.get("code");
    if (!flowId) console.warn("google callback: refused a state that did not verify");
    if (!flowId || !code) return expiredPage();
    const browserSecret = readFlowCookie(request);
    const flow = await ctx.runMutation(internal.googleOauth.consumeOauthFlow, {
      flowId,
      browserHash: browserSecret === null ? null : await sha256Base64Url(browserSecret),
    });
    if (!flow) return expiredPage();
    const { householdId, userId, purpose } = flow;

    const tokens = await exchangeCode(code, await decryptSecret(flow.codeVerifier));
    if (!tokens) {
      await ctx.runMutation(internal.googleOauth.recordCodeRejected, {
        householdId,
        userId,
        purpose,
      });
      return expiredPage();
    }
    unusedGrant = tokens;
    const response = await GOOGLE_PURPOSES[purpose].finish(ctx, { householdId, userId }, tokens);
    unusedGrant = null;
    return response;
  } catch (e) {
    if (unusedGrant !== null) {
      await revokeUnusedGrant(ctx, unusedGrant.refreshToken, unusedGrant.email);
    }
    if (isAppError(e, "forbidden") || isAppError(e, "not_found")) {
      return oauthPage(
        "Not allowed",
        "You are not allowed to connect Google for this household.",
        403,
      );
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
