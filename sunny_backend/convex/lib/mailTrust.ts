import type Anthropic from "@anthropic-ai/sdk";
import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { actorUserId } from "./access";
import { audit } from "./audit";
import { appError } from "./errors";
import { localDate } from "./time";
import { idField, rejectUnknownKeys } from "./toolInput";
import type { ToolHandler } from "./toolInput";

export const MAX_TRUSTED_SENDERS = 100;

const ENTITY = "mailTrustedSender";

export async function trustedSender(
  ctx: QueryCtx,
  householdId: Id<"households">,
  address: string,
): Promise<Doc<"mailTrustedSenders"> | null> {
  return await ctx.db
    .query("mailTrustedSenders")
    .withIndex("by_household_address", (q) =>
      q.eq("householdId", householdId).eq("address", address.toLowerCase()),
    )
    .first();
}

async function trustedSenders(
  ctx: QueryCtx,
  householdId: Id<"households">,
): Promise<Doc<"mailTrustedSenders">[]> {
  return await ctx.db
    .query("mailTrustedSenders")
    .withIndex("by_household_address", (q) => q.eq("householdId", householdId))
    .take(MAX_TRUSTED_SENDERS);
}

function senderForModel(row: Doc<"mailTrustedSenders">, timezone: string): Record<string, unknown> {
  return {
    trusted_sender_id: row._id,
    address: row.address,
    added_on: localDate(row.addedAt, timezone),
  };
}

async function timezoneOf(ctx: QueryCtx, householdId: Id<"households">): Promise<string> {
  const household = await ctx.db.get(householdId);
  if (!household) throw appError("not_found", "Household not found");
  return household.timezone;
}

export const MAIL_TRUST_TOOLS: NonNullable<Anthropic.Beta.Agents.AgentCreateParams["tools"]> = [
  {
    type: "custom",
    name: "trust_mail_sender",
    description:
      "Trust the sender of an email Sunny escalated, when the caregiver says to. Takes the mail_item_id from the briefing; Sunny trusts that email's exact sender address, never a whole domain. From then on Sunny adds appointments, moves appointments and passes on short news from that address by itself, when Gmail verifies the sender. Mail already waiting is not sorted again: add its appointment with add_event. The result has status trusted or already_trusted and the trusted sender.",
    input_schema: {
      type: "object",
      properties: {
        mail_item_id: { type: "string", description: "The mail_item_id from the briefing." },
      },
      required: ["mail_item_id"],
    },
  },
  {
    type: "custom",
    name: "untrust_mail_sender",
    description:
      "Stop trusting a sender address, when the caregiver asks. Takes a trusted_sender_id from list_trusted_mail_senders. The result is the removed sender.",
    input_schema: {
      type: "object",
      properties: {
        trusted_sender_id: {
          type: "string",
          description: "The trusted_sender_id from list_trusted_mail_senders.",
        },
      },
      required: ["trusted_sender_id"],
    },
  },
  {
    type: "custom",
    name: "list_trusted_mail_senders",
    description:
      "List the email addresses the caregivers trust, each with its trusted_sender_id and the local date it was added.",
    input_schema: { type: "object", properties: {} },
  },
];

export type MailTrustToolName =
  "trust_mail_sender" | "untrust_mail_sender" | "list_trusted_mail_senders";

export const MAIL_TRUST_HANDLERS: Record<MailTrustToolName, ToolHandler> = {
  trust_mail_sender: async (ctx, { householdId, actor, now }, input) => {
    rejectUnknownKeys(input, ["mail_item_id"]);
    const itemId = idField(ctx, "mailItems", input.mail_item_id, "mail_item_id", "the briefing");
    const item = await ctx.db.get(itemId);
    if (!item || item.householdId !== householdId) throw appError("not_found", "Email not found");
    if (item.sender === undefined) throw appError("invalid", "Sunny has no sender for that email");
    const timezone = await timezoneOf(ctx, householdId);
    const existing = await trustedSender(ctx, householdId, item.sender.address);
    if (existing !== null) {
      return { status: "already_trusted", trusted_sender: senderForModel(existing, timezone) };
    }
    if ((await trustedSenders(ctx, householdId)).length >= MAX_TRUSTED_SENDERS) {
      throw appError("limit", `A household trusts at most ${MAX_TRUSTED_SENDERS} senders`);
    }
    const addedBy = actorUserId(actor);
    if (addedBy === undefined) throw appError("forbidden", "Not allowed");
    const address = item.sender.address.toLowerCase();
    const id = await ctx.db.insert("mailTrustedSenders", {
      householdId,
      address,
      addedBy,
      addedAt: now,
      mailItemId: itemId,
    });
    await audit(ctx, {
      householdId,
      actor,
      action: "trust",
      entity: ENTITY,
      entityId: id,
      detail: { address, mailItemId: itemId },
    });
    const row = await ctx.db.get(id);
    if (!row) throw appError("not_found", "Trusted sender not found");
    return { status: "trusted", trusted_sender: senderForModel(row, timezone) };
  },
  untrust_mail_sender: async (ctx, { householdId, actor }, input) => {
    rejectUnknownKeys(input, ["trusted_sender_id"]);
    const id = idField(
      ctx,
      "mailTrustedSenders",
      input.trusted_sender_id,
      "trusted_sender_id",
      "list_trusted_mail_senders",
    );
    const row = await ctx.db.get(id);
    if (!row || row.householdId !== householdId) {
      throw appError("not_found", "Trusted sender not found");
    }
    await ctx.db.delete(id);
    await audit(ctx, {
      householdId,
      actor,
      action: "untrust",
      entity: ENTITY,
      entityId: id,
      detail: { address: row.address },
    });
    return { removed: senderForModel(row, await timezoneOf(ctx, householdId)) };
  },
  list_trusted_mail_senders: async (ctx, { householdId }, input) => {
    rejectUnknownKeys(input, []);
    const timezone = await timezoneOf(ctx, householdId);
    const rows = await trustedSenders(ctx, householdId);
    return { trusted_senders: rows.map((row) => senderForModel(row, timezone)) };
  },
};
