import { vi } from "vitest";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { gmailMocks } from "./googleMocks.helpers";
import { toBase64Url } from "./lib/base64";
import { JEV_MODEL } from "./lib/mailJudge";
import type { Flag } from "./lib/mailJudge";
import type { AppointmentKind } from "./lib/mailTypes";
import { isRecord } from "./lib/http";
import { weekdayName } from "./lib/time";
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

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

export interface JevSays {
  yes?: Flag[];
  unsure?: Flag[];
  kind?: AppointmentKind;
  when?: { date: string; time: string | null };
  before?: { date: string; time: string | null };
}

interface WireQuestion {
  type: string;
  criteria?: object | null;
}

function slotChoices(prefix: string, slot: JevSays["when"]): Record<string, string> {
  if (slot === undefined) return {};
  const [year, month, day] = slot.date.split("-");
  const choices: Record<string, string> = {
    [`${prefix}_date_form`]: "calendar_date",
    [`${prefix}_month`]: MONTHS[Number(month) - 1] ?? "",
    [`${prefix}_day`]: String(Number(day)),
    [`${prefix}_year`]: year ?? "",
    [`${prefix}_weekday`]: weekdayName(slot.date),
  };
  if (slot.time === null) return choices;
  const [hour, minute] = slot.time.split(":").map(Number);
  return {
    ...choices,
    [`${prefix}_hour`]: String((((hour ?? 0) + 11) % 12) + 1),
    [`${prefix}_minute`]: String(minute ?? 0).padStart(2, "0"),
    [`${prefix}_half`]: (hour ?? 0) >= 12 ? "pm" : "am",
  };
}

const CHOICE_DEFAULTS = ["not_stated", "unqualified", "00", "am", "other"];

export function jevAnswers(
  says: JevSays,
  questions: Record<string, WireQuestion>,
): Record<string, unknown> {
  const choices: Record<string, string> = {
    appointment_kind: says.kind ?? "other",
    ...slotChoices("when", says.when),
    ...slotChoices("before", says.before),
  };
  return Object.fromEntries(
    Object.entries(questions).map(([name, q]) => {
      if (q.type === "noul") {
        const p = says.yes?.some((f) => f === name)
          ? 0.95
          : says.unsure?.some((f) => f === name)
            ? 0.5
            : 0.02;
        return [name, { type: "noul", noul: p }];
      }
      const options = Object.keys(q.criteria ?? {});
      const picked = choices[name] ?? CHOICE_DEFAULTS.find((d) => options.includes(d)) ?? "";
      return [
        name,
        { type: "choice", choice: picked, confidence: 0.9, probabilities: { [picked]: 0.95 } },
      ];
    }),
  );
}

const NOW_FOR_TRUST = Date.parse("2026-11-01T12:00:00Z");

export const JEV_URL = "https://api.typesafe.ai/v1/systemone";

export const jevCalls: Array<{ state: unknown; questions: Record<string, WireQuestion> }> = [];

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function wireQuestions(value: unknown): Record<string, WireQuestion> {
  if (!isRecord(value)) throw new Error("Jev request without questions");
  return Object.fromEntries(
    Object.entries(value).map(([name, q]) => {
      if (!isRecord(q) || typeof q.type !== "string") throw new Error(`Bad question ${name}`);
      return [name, { type: q.type, criteria: isRecord(q.criteria) ? q.criteria : undefined }];
    }),
  );
}

export function jevReply(says: JevSays, init: RequestInit | undefined): Response {
  const body: unknown = JSON.parse(String(init?.body));
  if (!isRecord(body)) throw new Error("Jev request is not an object");
  const questions = wireQuestions(body.questions);
  jevCalls.push({ state: body.state, questions });
  return json({
    model: JEV_MODEL,
    answers: jevAnswers(says, questions),
    usage: { input_tokens: 4200, output_tokens: 310 },
  });
}

export const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";

export const DEFAULT_SUMMARY = "Lakeside Eye Care wrote about an eye exam.";

export const summaryCalls: unknown[] = [];

export type SummarySays = string | { status: number } | "hang";

export function summaryReply(says: SummarySays, init: RequestInit | undefined): Promise<Response> {
  summaryCalls.push(JSON.parse(String(init?.body)));
  if (says === "hang") {
    return new Promise((_, reject) => {
      init?.signal?.addEventListener("abort", () =>
        reject(new DOMException("aborted", "AbortError")),
      );
    });
  }
  if (typeof says !== "string") {
    return Promise.resolve(json({ type: "error", error: { type: "api_error" } }, says.status));
  }
  return Promise.resolve(
    json({
      id: "msg_1",
      type: "message",
      role: "assistant",
      model: "claude-haiku-5-5",
      content: [{ type: "text", text: says }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 900, output_tokens: 30 },
    }),
  );
}

export function jevSays(
  says: JevSays | { status: number },
  summary: SummarySays = DEFAULT_SUMMARY,
): void {
  vi.stubEnv("TYPESAFE_API_KEY", "test-key");
  vi.stubEnv("ANTHROPIC_API_KEY", "test-key");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url) === ANTHROPIC_URL) return await summaryReply(summary, init);
      if (String(url) !== JEV_URL) throw new Error(`unexpected fetch ${String(url)}`);
      if ("status" in says) return json({ detail: "refused" }, says.status);
      return jevReply(says, init);
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
  says?: JevSays,
): Promise<Doc<"mailItems">> {
  if (says !== undefined) jevSays(says);
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
