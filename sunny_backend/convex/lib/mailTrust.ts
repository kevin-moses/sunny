import type Anthropic from "@anthropic-ai/sdk";
import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { actorUserId, findMember, loadHousehold } from "./access";
import type { Actor } from "./access";
import { audit } from "./audit";
import { postMailbox } from "./chatPosts";
import { appError } from "./errors";
import { localDate } from "./time";
import { idField, rejectUnknownKeys } from "./toolInput";
import type { ToolHandler } from "./toolInput";
import type { StoredSender } from "./validators";

const MAX_TRUSTED_SENDERS = 100;

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

function senderForModel(
  row: Pick<Doc<"mailTrustedSenders">, "_id" | "address" | "addedAt">,
  timezone: string,
): Record<string, unknown> {
  return {
    trusted_sender_id: row._id,
    address: row.address,
    added_on: localDate(row.addedAt, timezone),
  };
}

function heldBackForTrust(item: Doc<"mailItems">): boolean {
  return (item.effects ?? []).some(
    (e) => (e.kind === "escalated" || e.kind === "told_caregivers") && e.senderNotTrusted === true,
  );
}

function trustableSender(item: Doc<"mailItems">): StoredSender {
  const { sender } = item;
  if (sender === undefined) throw appError("invalid", "Sunny has no sender for that email");
  if (!sender.authenticated) {
    throw appError(
      "invalid",
      "Gmail did not verify the sender of that email, so Sunny cannot trust it",
    );
  }
  if (item.verdict === "suspicious") {
    throw appError(
      "invalid",
      "Sunny thinks that email may be a scam, so it will not trust its sender",
    );
  }
  if (!heldBackForTrust(item)) {
    throw appError(
      "invalid",
      "Sunny held nothing back from that email for want of trust, so there is nothing to trust its sender for",
    );
  }
  return sender;
}

async function caregiverName(
  ctx: QueryCtx,
  householdId: Id<"households">,
  actor: Actor,
): Promise<string> {
  const userId = actorUserId(actor);
  const member = userId === undefined ? null : await findMember(ctx, householdId, userId);
  return member?.displayName ?? "A caregiver";
}

export const MAIL_TRUST_TOOLS: NonNullable<Anthropic.Beta.Agents.AgentCreateParams["tools"]> = [
  {
    type: "custom",
    name: "trust_mail_sender",
    description:
      "Trust the sender of an email Sunny escalated, when the caregiver says to. Takes the mail_item_id from the briefing; Sunny trusts that email's exact sender address, never a whole domain. From then on Sunny adds appointments, moves appointments and passes on short news from that address by itself, when Gmail verifies the sender. Mail already waiting is not sorted again: add its appointment with add_event. It refuses an email whose sender Gmail did not verify, one Sunny thinks may be a scam, and one Sunny held nothing back from because of its sender. The result has status trusted or already_trusted and the trusted sender with its full address.",
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
    const sender = trustableSender(item);
    const household = await loadHousehold(ctx, householdId);
    const existing = await trustedSender(ctx, householdId, sender.address);
    if (existing !== null) {
      return {
        status: "already_trusted",
        trusted_sender: senderForModel(existing, household.timezone),
      };
    }
    if ((await trustedSenders(ctx, householdId)).length >= MAX_TRUSTED_SENDERS) {
      throw appError("limit", `A household trusts at most ${MAX_TRUSTED_SENDERS} senders`);
    }
    const addedBy = actorUserId(actor);
    if (addedBy === undefined) throw appError("forbidden", "Not allowed");
    const address = sender.address.toLowerCase();
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
    const name = await caregiverName(ctx, householdId, actor);
    await postMailbox(ctx, household, `${name} told Sunny to trust mail from ${address}.`, now);
    return {
      status: "trusted",
      trusted_sender: senderForModel({ _id: id, address, addedAt: now }, household.timezone),
    };
  },
  untrust_mail_sender: async (ctx, { householdId, actor, now }, input) => {
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
    const household = await loadHousehold(ctx, householdId);
    const name = await caregiverName(ctx, householdId, actor);
    await postMailbox(
      ctx,
      household,
      `${name} told Sunny to stop trusting mail from ${row.address}.`,
      now,
    );
    return { removed: senderForModel(row, household.timezone) };
  },
  list_trusted_mail_senders: async (ctx, { householdId }, input) => {
    rejectUnknownKeys(input, []);
    const { timezone } = await loadHousehold(ctx, householdId);
    const rows = await trustedSenders(ctx, householdId);
    return { trusted_senders: rows.map((row) => senderForModel(row, timezone)) };
  },
};
