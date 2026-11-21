import { v } from "convex/values";
import type { Infer } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation } from "./_generated/server";
import type { ActionCtx, MutationCtx } from "./_generated/server";
import { postMailbox } from "./lib/chatPosts";
import { pushToCaregivers } from "./lib/delivery";
import { errorText } from "./lib/errors";
import { LOST_GRANT_STATUS, googleFailure } from "./lib/googleGrant";
import type { GoogleCause, GrantStatus, LostGrant } from "./lib/googleGrant";
import { AccessTokens, holdsGrant } from "./lib/googleTokens";
import type { StoredGrant } from "./lib/googleTokens";
import { mailFailure } from "./lib/mailFailure";
import type { MailCause } from "./lib/mailFailure";
import type { HoldService } from "./lib/serviceHolds";
import { openHold } from "./serviceHolds";

const MAX_STORED_ERROR = 2000;

const grantRow = v.union(
  v.object({ table: v.literal("mailboxes"), id: v.id("mailboxes") }),
  v.object({ table: v.literal("calendarConnections"), id: v.id("calendarConnections") }),
);

export type GrantRow = Infer<typeof grantRow>;

type GrantTable = GrantRow["table"];

interface GrantKind<T extends GrantTable> {
  service: HoldService;
  messages: Record<LostGrant, string>;
  classify: (e: unknown) => MailCause;
  onLost: (ctx: MutationCtx, row: Doc<T>) => Promise<void>;
}

async function tellMailboxLost(ctx: MutationCtx, mailbox: Doc<"mailboxes">): Promise<void> {
  const household = await ctx.db.get(mailbox.householdId);
  if (!household) return;
  const body = `Sunny can no longer read ${mailbox.accountEmail}. Reconnect Gmail to keep mail coming in.`;
  await postMailbox(ctx, household, body, Date.now());
  await pushToCaregivers(ctx, household, {
    kind: "mail_escalation",
    title: `Reconnect Gmail for ${household.seniorPreferredName}`,
    body,
    payload: { mailboxId: mailbox._id },
  });
}

async function tellNobody(): Promise<void> {}

const GRANT_KINDS: { [T in GrantTable]: GrantKind<T> } = {
  mailboxes: {
    service: "gmail",
    messages: {
      revoked: "Google access was revoked; reconnect the senior's Gmail.",
      unreadable: "Reconnect Gmail: Sunny could not read the saved Google sign-in.",
      forbidden: "Google denied Sunny access to the mailbox; reconnect Gmail.",
    },
    classify: mailFailure,
    onLost: tellMailboxLost,
  },
  calendarConnections: {
    service: "calendar",
    messages: {
      revoked: "Google access was revoked; reconnect Google Calendar.",
      unreadable: "Reconnect Google Calendar: Sunny could not read the saved Google sign-in.",
      forbidden: "Google denied Sunny access to the Sunny calendar; reconnect Google Calendar.",
    },
    classify: (e) => googleFailure(e) ?? "retry",
    onLost: tellNobody,
  },
};

export const saveToken = internalMutation({
  args: {
    row: grantRow,
    refreshToken: v.string(),
    accessToken: v.string(),
    expiresAt: v.number(),
  },
  handler: async (ctx, { row, refreshToken, accessToken, expiresAt }): Promise<null> => {
    if (holdsGrant(await ctx.db.get(row.id), refreshToken)) {
      await ctx.db.patch(row.id, { accessToken, accessTokenExpiresAt: expiresAt });
    }
    return null;
  },
});

async function markActiveRow<T extends GrantTable>(
  ctx: MutationCtx,
  table: T,
  id: Id<T>,
  refreshToken: string,
  lost: { status: GrantStatus; error: string },
): Promise<void> {
  const held = await ctx.db.get(id);
  if (held === null || held.refreshToken !== refreshToken || held.status !== "active") return;
  const grantId: Id<GrantTable> = id;
  await ctx.db.patch(grantId, {
    status: lost.status,
    error: lost.error.slice(0, MAX_STORED_ERROR),
    accessToken: undefined,
    accessTokenExpiresAt: undefined,
  });
  await GRANT_KINDS[table].onLost(ctx, held);
}

export const markGrant = internalMutation({
  args: {
    row: grantRow,
    refreshToken: v.string(),
    status: v.union(v.literal("revoked"), v.literal("error")),
    error: v.string(),
  },
  handler: async (ctx, { row, refreshToken, status, error }): Promise<null> => {
    await markActiveRow(ctx, row.table, row.id, refreshToken, { status, error });
    return null;
  },
});

export class GrantJob {
  constructor(
    private readonly ctx: ActionCtx,
    private readonly row: GrantRow,
    private readonly refreshToken: string,
    private readonly startedAt: number,
    readonly tokens: AccessTokens,
  ) {}

  async lose(status: GrantStatus, error: string): Promise<void> {
    await this.ctx.runMutation(internal.googleGrant.markGrant, {
      row: this.row,
      refreshToken: this.refreshToken,
      status,
      error,
    });
  }

  async settle(e: unknown): Promise<GoogleCause> {
    const kind = GRANT_KINDS[this.row.table];
    const cause = kind.classify(e);
    switch (cause) {
      case "revoked":
      case "unreadable":
      case "forbidden":
        await this.lose(LOST_GRANT_STATUS[cause], kind.messages[cause]);
        return cause;
      case "hold":
        await openHold(this.ctx, kind.service, errorText(e), this.startedAt);
        return "hold";
      case "jev_hold":
        await openHold(this.ctx, "jev", errorText(e), this.startedAt);
        return "hold";
      case "permanent":
      case "retry":
        return cause;
    }
  }
}

export async function tokensFor(
  ctx: ActionCtx,
  row: GrantRow,
  grant: StoredGrant,
  startedAt: number,
): Promise<GrantJob> {
  const tokens = await new AccessTokens(grant, async (accessToken, expiresAt) => {
    await ctx.runMutation(internal.googleGrant.saveToken, {
      row,
      refreshToken: grant.refreshToken,
      accessToken,
      expiresAt,
    });
  }).load();
  return new GrantJob(ctx, row, grant.refreshToken, startedAt, tokens);
}
