import { vi } from "vitest";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { gmailMocks } from "./googleMocks.helpers";
import { toBase64Url } from "./lib/base64";
import { MAIL_MODEL } from "./lib/mailClassify";
import { createFamilyHousehold } from "./testing.helpers";
import type { TestConvex } from "./testing.helpers";

export const MAILBOX = "mom@example.com";

export const TRUSTED_SENDERS = [
  "appointments@lakesideeye.example",
  "reminders@lakesideeye.example",
  "rx@northgate.example",
];

export interface RawEmail {
  id: string;
  from: string;
  subject: string;
  text: string;
  receivedAt: number;
  verified?: boolean;
  labels?: string[];
  ics?: string;
}

function encode(text: string): string {
  return toBase64Url(new TextEncoder().encode(text));
}

function part(mimeType: string, text: string) {
  return {
    partId: "1",
    mimeType,
    filename: "",
    headers: [{ name: "Content-Type", value: `${mimeType}; charset="UTF-8"` }],
    body: { size: text.length, data: encode(text) },
  };
}

export function rawEmail(email: RawEmail): Record<string, unknown> {
  const domain = email.from.slice(email.from.lastIndexOf("@") + 1).replace(/>$/, "");
  const headers = [
    ...(email.verified === false
      ? []
      : [
          {
            name: "Authentication-Results",
            value: `mx.google.com; dkim=pass header.i=@${domain} header.s=s1; dmarc=pass header.from=${domain}`,
          },
        ]),
    { name: "From", value: email.from },
    { name: "To", value: `Mom <${MAILBOX}>` },
    { name: "Subject", value: email.subject },
  ];
  const payload =
    email.ics === undefined
      ? {
          ...part("text/plain", email.text),
          partId: "",
          headers: [...headers, ...part("text/plain", "").headers],
        }
      : {
          partId: "",
          mimeType: "multipart/mixed",
          filename: "",
          headers,
          body: { size: 0 },
          parts: [part("text/plain", email.text), part("text/calendar", email.ics)],
        };
  return {
    id: email.id,
    threadId: email.id,
    labelIds: email.labels ?? ["INBOX", "UNREAD"],
    internalDate: String(email.receivedAt),
    payload,
  };
}

const EMPTY_VERDICT = {
  change: null,
  title: null,
  date: null,
  time: null,
  duration_minutes: null,
  place: null,
  previous_date: null,
  previous_time: null,
  previous_title: null,
  topic: null,
  note: null,
  reason: null,
  suspicion: null,
};

export function verdict(fields: Record<string, unknown>): Record<string, unknown> {
  return { ...EMPTY_VERDICT, ...fields };
}

const NOW_FOR_TRUST = Date.parse("2026-11-01T12:00:00Z");

export const modelCalls: unknown[] = [];

export function replyWith(raw: unknown): void {
  vi.stubEnv("ANTHROPIC_API_KEY", "test-key");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      if (!String(url).startsWith("https://api.anthropic.com/")) {
        throw new Error(`unexpected fetch ${String(url)}`);
      }
      modelCalls.push(JSON.parse(String(init.body)));
      return new Response(
        JSON.stringify({
          id: "msg_1",
          type: "message",
          role: "assistant",
          model: MAIL_MODEL,
          content: [{ type: "text", text: JSON.stringify(raw) }],
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 1200, output_tokens: 90, cache_read_input_tokens: 0 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }),
  );
}

export interface MailHousehold {
  t: TestConvex;
  householdId: Id<"households">;
  mailboxId: Id<"mailboxes">;
  phoneId: Id<"devices">;
  displayId: Id<"devices">;
}

export async function mailHousehold(t: TestConvex): Promise<MailHousehold> {
  const householdId = await createFamilyHousehold(t);
  const ids = await t.run(async (ctx) => {
    const phone = (await ctx.db
      .query("devices")
      .withIndex("by_household", (q) => q.eq("householdId", householdId))
      .first())!;
    const displayId = await ctx.db.insert("devices", {
      householdId,
      userId: "display",
      kind: "home_display",
    });
    for (const userId of ["pat", "max", "val", "phone", "display"]) {
      await ctx.db.insert("pushTokens", { userId, token: `tok-${userId}` });
    }
    const mailboxId = await ctx.db.insert("mailboxes", {
      householdId,
      connectedBy: "pat",
      accountEmail: MAILBOX,
      refreshToken: "box:refresh-1",
      status: "active",
      historyId: "100",
    });
    for (const address of TRUSTED_SENDERS) {
      await ctx.db.insert("mailTrustedSenders", {
        householdId,
        address,
        addedBy: "pat",
        addedAt: NOW_FOR_TRUST,
      });
    }
    return { mailboxId, phoneId: phone._id, displayId };
  });
  return { t, householdId, ...ids };
}

export async function receive(h: MailHousehold, email: RawEmail): Promise<Id<"mailItems">> {
  gmailMocks.getMessage.mockResolvedValue(rawEmail(email));
  await h.t.mutation(internal.gmail.recordNew, {
    mailboxId: h.mailboxId,
    ids: [email.id],
    expectedHistoryId: "none",
    lastHistoryId: "none",
  });
  return await itemFor(h, email.id);
}

export async function itemFor(h: MailHousehold, gmailId: string): Promise<Id<"mailItems">> {
  return await h.t.run(async (ctx) => {
    const row = await ctx.db
      .query("mailItems")
      .withIndex("by_household_account_gmail", (q) =>
        q.eq("householdId", h.householdId).eq("account", MAILBOX).eq("gmailId", gmailId),
      )
      .unique();
    return row!._id;
  });
}

export async function triageEmail(
  h: MailHousehold,
  email: RawEmail,
  modelVerdict?: unknown,
): Promise<Doc<"mailItems">> {
  if (modelVerdict !== undefined) replyWith(modelVerdict);
  const itemId = await receive(h, email);
  await h.t.action(internal.mailTriage.triage, { itemId });
  return await item(h, itemId);
}

export async function item(h: MailHousehold, itemId: Id<"mailItems">): Promise<Doc<"mailItems">> {
  return (await h.t.run(async (ctx) => await ctx.db.get(itemId)))!;
}

export async function rows<
  T extends "events" | "mailEventLinks" | "chatPosts" | "notificationOutbox" | "seniorNotes",
>(h: MailHousehold, table: T): Promise<Doc<T>[]> {
  return await h.t.run(async (ctx) => await ctx.db.query(table).collect());
}
