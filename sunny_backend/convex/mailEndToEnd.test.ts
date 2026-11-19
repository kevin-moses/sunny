import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { internal } from "./_generated/api";
import { toBase64 } from "./lib/base64";
import { encryptSecret } from "./lib/secretBox";
import {
  ANTHROPIC_URL,
  JEV_URL,
  MAILBOX,
  jevReply,
  rawEmail,
  summaryReply,
} from "./mailMocks.helpers";
import { createFamilyHousehold, makeBackend } from "./testing.helpers";

const NOW = Date.parse("2026-11-18T14:00:00Z");

const ENV: Record<string, string> = {
  CALENDAR_TOKEN_KEY: toBase64(new Uint8Array(32).fill(7)),
  GOOGLE_CLIENT_ID: "client-id",
  GOOGLE_CLIENT_SECRET: "client-secret",
  TYPESAFE_API_KEY: "test-key",
  ANTHROPIC_API_KEY: "test-key",
};

const MESSAGE = rawEmail({
  id: "e2e-1",
  from: "Lakeside Eye Care <appointments@lakesideeye.example>",
  subject: "Your appointment is confirmed",
  text: "Your eye exam with Dr. Rivera is confirmed for December 10 at 2:15 PM.",
  receivedAt: NOW - 30 * 60_000,
});

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

const requests: string[] = [];

function network(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const url = new URL(input instanceof Request ? input.url : String(input));
  requests.push(`${url.host}${url.pathname}`);
  if (url.href === "https://oauth2.googleapis.com/token") {
    return Promise.resolve(json({ access_token: "access-1", expires_in: 3600 }));
  }
  if (url.pathname === "/gmail/v1/users/me/messages/e2e-1") return Promise.resolve(json(MESSAGE));
  if (url.href === ANTHROPIC_URL) {
    return summaryReply("Lakeside Eye Care confirmed an eye exam on December 10 at 2:15 PM.", init);
  }
  if (url.href === JEV_URL) {
    return Promise.resolve(
      jevReply(
        {
          yes: ["confirms_appointment"],
          kind: "eye_doctor",
          when: { date: "2026-12-10", time: "14:15" },
        },
        init,
      ),
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
  const mailboxId = await t.run(async (ctx) =>
    ctx.db.insert("mailboxes", {
      householdId,
      connectedBy: "pat",
      accountEmail: MAILBOX,
      refreshToken,
      status: "active",
      historyId: "100",
    }),
  );

  await t.mutation(internal.gmail.recordNew, {
    mailboxId,
    ids: ["e2e-1"],
    expectedHistoryId: "100",
    lastHistoryId: "101",
  });
  const state = async () =>
    (await t.run(
      async (ctx) =>
        await ctx.db
          .query("mailItems")
          .withIndex("by_household_account_gmail", (q) =>
            q.eq("householdId", householdId).eq("account", MAILBOX).eq("gmailId", "e2e-1"),
          )
          .unique(),
    ))!.state;
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
    title: "Eye exam",
    startsOn: "2026-12-10",
    startTime: "14:15",
  });
  const posts = await t.run(async (ctx) => await ctx.db.query("chatPosts").collect());
  expect(posts).toHaveLength(1);
  expect(posts[0]).toMatchObject({ kind: "mail" });
  expect(posts[0]!.body).toContain(
    "From: Lakeside Eye Care <appointments@lakesideeye.example> (verified sender)",
  );
  expect(posts[0]!.body).toContain(
    "Sunny added Eye exam, Thursday, December 10 at 2:15 PM, to the calendar.\nLakeside Eye Care confirmed an eye exam on December 10 at 2:15 PM.",
  );
  expect(requests).toEqual([
    "oauth2.googleapis.com/token",
    "gmail.googleapis.com/gmail/v1/users/me/messages/e2e-1",
    "api.typesafe.ai/v1/systemone",
    "api.anthropic.com/v1/messages",
  ]);
  const mailbox = await t.run(async (ctx) => await ctx.db.get(mailboxId));
  expect(mailbox!.accessToken).toBeDefined();
  expect(mailbox!.accessToken).not.toContain("access-1");
});
