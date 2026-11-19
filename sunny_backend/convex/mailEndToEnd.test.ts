import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { internal } from "./_generated/api";
import { toBase64 } from "./lib/base64";
import { MAIL_MODEL } from "./lib/mailClassify";
import { encryptSecret } from "./lib/secretBox";
import { MAILBOX, rawEmail, verdict } from "./mailMocks.helpers";
import { createFamilyHousehold, makeBackend } from "./testing.helpers";

const NOW = Date.parse("2026-11-18T14:00:00Z");
const DAY = 86_400_000;

const ENV: Record<string, string> = {
  CALENDAR_TOKEN_KEY: toBase64(new Uint8Array(32).fill(7)),
  GOOGLE_CLIENT_ID: "client-id",
  GOOGLE_CLIENT_SECRET: "client-secret",
  ANTHROPIC_API_KEY: "test-key",
};

const MESSAGE = rawEmail({
  id: "e2e-1",
  from: "Lakeside Eye Care <appointments@lakesideeye.example>",
  subject: "Your appointment is confirmed",
  text: "Your eye exam with Dr. Rivera is confirmed for December 10 at 2:15 PM.",
  receivedAt: NOW - 30 * 60_000,
});

const VERDICT = verdict({
  kind: "appointment",
  change: "new",
  title: "Eye exam with Dr. Rivera",
  date: "2026-12-10",
  time: "14:15",
  duration_minutes: 30,
  place: "Lakeside Eye Care",
  summary: "The eye clinic confirmed an eye exam.",
});

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

const requests: string[] = [];

function network(input: string | URL | Request): Promise<Response> {
  const url = new URL(input instanceof Request ? input.url : String(input));
  requests.push(`${url.host}${url.pathname}`);
  if (url.href === "https://oauth2.googleapis.com/token") {
    return Promise.resolve(json({ access_token: "access-1", expires_in: 3600 }));
  }
  if (url.pathname === "/gmail/v1/users/me/messages/e2e-1") return Promise.resolve(json(MESSAGE));
  if (url.href === "https://api.anthropic.com/v1/messages") {
    return Promise.resolve(
      json({
        id: "msg_1",
        type: "message",
        role: "assistant",
        model: MAIL_MODEL,
        content: [{ type: "text", text: JSON.stringify(VERDICT) }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 1200, output_tokens: 90, cache_read_input_tokens: 0 },
      }),
    );
  }
  return Promise.reject(new Error(`unexpected request ${url.href}`));
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  for (const [name, value] of Object.entries(ENV)) vi.stubEnv(name, value);
  vi.stubGlobal("fetch", vi.fn(network));
  requests.length = 0;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

test("a polled message runs through the workpool to an event and a caregiver chat post", async () => {
  const t = makeBackend();
  const householdId = await createFamilyHousehold(t);
  const refreshToken = await encryptSecret("refresh-1");
  const mailboxId = await t.run(async (ctx) => {
    await ctx.db.insert("mailTrustedSenders", {
      householdId,
      address: "appointments@lakesideeye.example",
      addedBy: "pat",
      addedAt: NOW - DAY,
    });
    return await ctx.db.insert("mailboxes", {
      householdId,
      connectedBy: "pat",
      accountEmail: MAILBOX,
      refreshToken,
      status: "active",
      historyId: "100",
    });
  });

  await t.mutation(internal.gmail.recordNew, {
    mailboxId,
    ids: ["e2e-1"],
    expectedHistoryId: "100",
    lastHistoryId: "101",
  });
  const state = async () =>
    (await t.run(async (ctx) => await ctx.db.query("mailItems").first()))!.state;
  for (let i = 0; i < 50 && (await state()) !== "done"; i += 1) {
    let finished = false;
    void t.finishInProgressScheduledFunctions().then(() => {
      finished = true;
    });
    while (!finished) await vi.advanceTimersByTimeAsync(250);
    await vi.advanceTimersByTimeAsync(1_100);
  }

  expect(await state()).toBe("done");
  const [event] = await t.run(async (ctx) => await ctx.db.query("events").collect());
  expect(event).toMatchObject({
    title: "Eye exam with Dr. Rivera",
    startsOn: "2026-12-10",
    startTime: "14:15",
  });
  const posts = await t.run(async (ctx) => await ctx.db.query("chatPosts").collect());
  expect(posts).toHaveLength(1);
  expect(posts[0]).toMatchObject({ kind: "mail" });
  expect(posts[0]!.body).toContain(
    "From: Lakeside Eye Care <appointments@lakesideeye.example> (verified sender)",
  );
  expect(posts[0]!.body).toContain("Sunny added Eye exam with Dr. Rivera");
  expect(requests).toEqual([
    "oauth2.googleapis.com/token",
    "gmail.googleapis.com/gmail/v1/users/me/messages/e2e-1",
    "api.anthropic.com/v1/messages",
  ]);
  const mailbox = await t.run(async (ctx) => await ctx.db.get(mailboxId));
  expect(mailbox!.accessToken).toBeDefined();
  expect(mailbox!.accessToken).not.toContain("access-1");
});
