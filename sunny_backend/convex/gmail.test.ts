import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { finish, startFlow } from "./googleFlow.helpers";
import { gmailMocks, googleMocks, resetGoogleMocks } from "./googleMocks.helpers";
import { ConfigError } from "./lib/errors";
import { GMAIL_SCOPE, GoogleAccessRevoked, GoogleApiError } from "./lib/google";
import { CALENDAR_SCOPE } from "./lib/google";
import { DAY_MS } from "./lib/time";
import {
  addConnection,
  addMember,
  createHousehold,
  makeBackend,
  pendingScheduled,
} from "./testing.helpers";
import type { TestConvex } from "./testing.helpers";

vi.mock("./lib/google", async (original) =>
  (await import("./googleMocks.helpers")).googleMock(await original()),
);
vi.mock("./lib/gmailApi", async (original) =>
  (await import("./googleMocks.helpers")).gmailMock(await original()),
);
vi.mock("./lib/secretBox", async (original) =>
  (await import("./googleMocks.helpers")).secretBoxMock(await original()),
);

const TEST_ENV: Record<string, string> = {
  GOOGLE_CLIENT_ID: "client-id",
  GOOGLE_REDIRECT_URI: "https://sunny.test/google/callback",
  GOOGLE_OAUTH_STATE_SECRET: "state-secret",
};
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  vi.useFakeTimers();
  resetGoogleMocks();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  for (const [name, value] of Object.entries(TEST_ENV)) {
    savedEnv[name] = process.env[name];
    process.env[name] = value;
  }
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  for (const name of Object.keys(TEST_ENV)) {
    if (savedEnv[name] === undefined) delete process.env[name];
    else process.env[name] = savedEnv[name];
  }
});

const DAILY_LIMIT =
  '{"error":{"code":403,"errors":[{"domain":"usageLimits","reason":"dailyLimitExceeded","message":"Daily Limit Exceeded"}]}}';
const API_DISABLED =
  '{"error":{"code":403,"errors":[{"domain":"usageLimits","reason":"accessNotConfigured","message":"Gmail API has not been used in project 123 before or it is disabled."}],"status":"PERMISSION_DENIED"}}';
const DOMAIN_POLICY =
  '{"error":{"code":403,"errors":[{"domain":"global","reason":"domainPolicy","message":"The domain administrators have disabled Gmail apps."}]}}';

function grant(scopes: string[]) {
  return { accessToken: "acc", refreshToken: "refresh-new", scopes, email: "someone@example.com" };
}

async function mailboxRows(t: TestConvex): Promise<Doc<"mailboxes">[]> {
  return await t.run(async (ctx) => await ctx.db.query("mailboxes").collect());
}

async function itemRows(t: TestConvex): Promise<Doc<"mailItems">[]> {
  return await t.run(async (ctx) => await ctx.db.query("mailItems").collect());
}

async function addMailbox(
  t: TestConvex,
  householdId: Id<"households">,
  fields: Partial<Doc<"mailboxes">> = {},
): Promise<Id<"mailboxes">> {
  return await t.run(async (ctx) => {
    return await ctx.db.insert("mailboxes", {
      householdId,
      connectedBy: "user_a",
      accountEmail: "margaret@example.com",
      refreshToken: "box:refresh-1",
      status: "active",
      historyId: "100",
      ...fields,
    });
  });
}

async function setPaused(t: TestConvex, householdId: Id<"households">, paused: boolean) {
  await t.run(async (ctx) => ctx.db.patch(householdId, { backgroundPaused: paused }));
}

function history(ids: string[], lastHistoryId: string | null, next: string | null = null) {
  return { ids, lastHistoryId, next };
}

describe("Connecting a mailbox", () => {
  test("a grant with the Gmail scope saves the mailbox and backfills the recent inbox", async () => {
    const t = makeBackend();
    const householdId = await createHousehold(t);
    googleMocks.exchangeCode.mockResolvedValue(grant([GMAIL_SCOPE]));
    gmailMocks.getProfile.mockResolvedValue({ email: "margaret@example.com", historyId: "777" });
    gmailMocks.listRecent.mockResolvedValue(["m1", "m2"]);

    const res = await finish(t, await startFlow(t, householdId, "user_a", "mailbox"));

    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Gmail connected");
    const [mailbox] = await mailboxRows(t);
    expect(mailbox).toMatchObject({
      householdId,
      connectedBy: "user_a",
      accountEmail: "margaret@example.com",
      refreshToken: "box:refresh-new",
      status: "active",
      historyId: "777",
    });
    expect((await itemRows(t)).map((i) => [i.gmailId, i.state, i.account, i.attempt])).toEqual([
      ["m1", "queued", "margaret@example.com", 0],
      ["m2", "queued", "margaret@example.com", 0],
    ]);
    const [token, since, max] = gmailMocks.listRecent.mock.calls[0]!;
    expect(token).toBe("acc");
    expect(max).toBe(50);
    expect(Date.now() - since).toBeGreaterThanOrEqual(7 * DAY_MS);
    expect(Date.now() - since).toBeLessThan(7 * DAY_MS + 1000);
    expect(gmailMocks.getProfile.mock.invocationCallOrder[0]).toBeLessThan(
      gmailMocks.listRecent.mock.invocationCallOrder[0]!,
    );
  });

  test("a profile address with capitals and padding still lets every backfilled message be claimed", async () => {
    const t = makeBackend();
    const householdId = await createHousehold(t);
    googleMocks.exchangeCode.mockResolvedValue(grant([GMAIL_SCOPE]));
    gmailMocks.getProfile.mockResolvedValue({
      email: "  Margaret@Example.COM ",
      historyId: "777",
    });
    gmailMocks.listRecent.mockResolvedValue(["m1", "m2"]);

    await finish(t, await startFlow(t, householdId, "user_a", "mailbox"));

    const [mailbox] = await mailboxRows(t);
    expect(mailbox!.accountEmail).toBe("margaret@example.com");
    const items = await itemRows(t);
    expect(items.map((i) => i.account)).toEqual(["margaret@example.com", "margaret@example.com"]);
    for (const item of items) {
      const claim = await t.mutation(internal.mailTriage.claimItem, { itemId: item._id });
      expect(claim).toMatchObject({ kind: "claimed", mailboxId: mailbox!._id });
    }
    expect((await itemRows(t)).map((i) => i.state)).toEqual(["triaging", "triaging"]);
  });

  test("the consent link asks for the Gmail scope for a mailbox and the calendar scope for a calendar", async () => {
    const t = makeBackend();
    const householdId = await createHousehold(t);
    const mailbox = await startFlow(t, householdId, "user_a", "mailbox");
    const calendar = await startFlow(t, householdId, "user_a", "calendar");
    const scope = (flow: { res: Response }) =>
      new URL(flow.res.headers.get("Location")!).searchParams.get("scope");
    expect(scope(mailbox)).toBe(`openid email ${GMAIL_SCOPE}`);
    expect(scope(calendar)).toBe(`openid email ${CALENDAR_SCOPE}`);
  });

  test("the mailbox consent link makes Google ask which account to connect", async () => {
    const t = makeBackend();
    const householdId = await createHousehold(t);
    const prompt = (flow: { res: Response }) =>
      new URL(flow.res.headers.get("Location")!).searchParams.get("prompt");
    expect(prompt(await startFlow(t, householdId, "user_a", "mailbox"))).toBe(
      "consent select_account",
    );
    expect(prompt(await startFlow(t, householdId, "user_a", "calendar"))).toBe("consent");
  });

  test("a grant without the Gmail scope is refused and revoked", async () => {
    const t = makeBackend();
    const householdId = await createHousehold(t);
    googleMocks.exchangeCode.mockResolvedValue(grant(["openid", "email"]));

    const res = await finish(t, await startFlow(t, householdId, "user_a", "mailbox"));

    expect(res.status).toBe(400);
    expect(await res.text()).toContain("Permission needed");
    expect(googleMocks.revokeRefreshToken).toHaveBeenCalledWith("refresh-new");
    expect(await mailboxRows(t)).toHaveLength(0);
    expect(gmailMocks.getProfile).not.toHaveBeenCalled();
  });

  test("a calendar-purpose flow cannot finish as a mailbox", async () => {
    const t = makeBackend();
    const householdId = await createHousehold(t);
    googleMocks.exchangeCode.mockResolvedValue(grant([GMAIL_SCOPE]));

    const res = await finish(t, await startFlow(t, householdId, "user_a", "calendar"));

    expect(res.status).toBe(400);
    expect(await mailboxRows(t)).toHaveLength(0);
    expect(gmailMocks.getProfile).not.toHaveBeenCalled();
    expect(googleMocks.revokeRefreshToken).toHaveBeenCalledWith("refresh-new");
  });

  test("a mailbox-purpose flow cannot finish as a calendar connection", async () => {
    const t = makeBackend();
    const householdId = await createHousehold(t);
    googleMocks.exchangeCode.mockResolvedValue(grant([CALENDAR_SCOPE]));

    const res = await finish(t, await startFlow(t, householdId, "user_a", "mailbox"));

    expect(res.status).toBe(400);
    expect(googleMocks.createSunnyCalendar).not.toHaveBeenCalled();
    expect(await mailboxRows(t)).toHaveLength(0);
    expect(
      await t.run(async (ctx) => await ctx.db.query("calendarConnections").collect()),
    ).toHaveLength(0);
  });

  test("a viewer cannot start a mailbox flow but a member can", async () => {
    const t = makeBackend();
    const householdId = await createHousehold(t);
    await addMember(t, householdId, "user_viewer", "viewer");
    await addMember(t, householdId, "user_member", "member");
    const connect = (userId: string, purpose: "calendar" | "mailbox") =>
      t
        .withIdentity({ subject: userId })
        .action(api.googleOauth.connectUrl, { householdId, purpose });

    await expect(connect("user_viewer", "mailbox")).rejects.toMatchObject({
      data: { code: "forbidden" },
    });
    await expect(connect("stranger", "mailbox")).rejects.toMatchObject({
      data: { code: "forbidden" },
    });
    expect(await connect("user_member", "mailbox")).toContain("/google/start?ticket=");
    expect(await connect("user_viewer", "calendar")).toContain("/google/start?ticket=");
  });

  test("a caregiver demoted to viewer mid-flow is refused and the grant revoked", async () => {
    const t = makeBackend();
    const householdId = await createHousehold(t);
    await addMember(t, householdId, "user_b", "member");
    googleMocks.exchangeCode.mockResolvedValue(grant([GMAIL_SCOPE]));
    const flow = await startFlow(t, householdId, "user_b", "mailbox");
    await t.run(async (ctx) => {
      const rows = await ctx.db.query("householdMembers").collect();
      await ctx.db.patch(rows.find((r) => r.userId === "user_b")!._id, { role: "viewer" });
    });

    const res = await finish(t, flow);

    expect(res.status).toBe(403);
    expect(googleMocks.revokeRefreshToken).toHaveBeenCalledWith("refresh-new");
    expect(await mailboxRows(t)).toHaveLength(0);
    expect(await itemRows(t)).toHaveLength(0);
  });

  test("a backfill that fails at Google saves nothing and revokes the grant", async () => {
    const t = makeBackend();
    const householdId = await createHousehold(t);
    googleMocks.exchangeCode.mockResolvedValue(grant([GMAIL_SCOPE]));
    gmailMocks.listRecent.mockRejectedValue(new GoogleApiError(500, "down"));

    const res = await finish(t, await startFlow(t, householdId, "user_a", "mailbox"));

    expect(res.status).toBe(500);
    expect(await mailboxRows(t)).toHaveLength(0);
    expect(googleMocks.revokeRefreshToken).toHaveBeenCalledWith("refresh-new");
  });

  test("connecting again keeps one mailbox, resets it and revokes the old grant", async () => {
    const t = makeBackend();
    const householdId = await createHousehold(t);
    const id = await addMailbox(t, householdId, {
      status: "revoked",
      error: "gone",
      lastError: "bad",
      accessToken: "box:old",
      accessTokenExpiresAt: 5,
      historyId: "5",
    });
    googleMocks.exchangeCode.mockResolvedValue(grant([GMAIL_SCOPE]));
    gmailMocks.getProfile.mockResolvedValue({ email: "margaret@example.com", historyId: "900" });

    await finish(t, await startFlow(t, householdId, "user_a", "mailbox"));

    const rows = await mailboxRows(t);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      _id: id,
      status: "active",
      historyId: "900",
      refreshToken: "box:refresh-new",
    });
    expect(rows[0]!.error).toBeUndefined();
    expect(rows[0]!.lastError).toBeUndefined();
    expect(rows[0]!.accessToken).toBeUndefined();
    expect(await pendingScheduled(t)).toContain("googleOauth:revokeGrant");
  });

  test("connecting posts in the caregiver chat which address Sunny now reads", async () => {
    const t = makeBackend();
    const householdId = await createHousehold(t);
    googleMocks.exchangeCode.mockResolvedValue(grant([GMAIL_SCOPE]));
    await finish(t, await startFlow(t, householdId, "user_a", "mailbox"));
    const posts = await t.run(async (ctx) => await ctx.db.query("chatPosts").collect());
    expect(posts.map((p) => [p.kind, p.body])).toEqual([
      ["mailbox", "Sunny now reads margaret@example.com."],
    ]);
    expect(await t.run(async (ctx) => await ctx.db.query("notificationOutbox").collect())).toEqual(
      [],
    );
  });

  test("connecting twice with overlapping backfills never duplicates a message", async () => {
    const t = makeBackend();
    const householdId = await createHousehold(t);
    googleMocks.exchangeCode.mockResolvedValue(grant([GMAIL_SCOPE]));
    gmailMocks.listRecent.mockResolvedValue(["m1", "m2"]);
    await finish(t, await startFlow(t, householdId, "user_a", "mailbox"));
    gmailMocks.listRecent.mockResolvedValue(["m2", "m3"]);
    await finish(t, await startFlow(t, householdId, "user_a", "mailbox"), "c2");
    expect((await itemRows(t)).map((i) => i.gmailId).sort()).toEqual(["m1", "m2", "m3"]);
  });
});

async function reconnectAs(
  t: TestConvex,
  householdId: Id<"households">,
  email: string,
): Promise<void> {
  googleMocks.exchangeCode.mockResolvedValue({ ...grant([GMAIL_SCOPE]), email });
  gmailMocks.getProfile.mockResolvedValue({ email, historyId: "900" });
  await finish(t, await startFlow(t, householdId, "user_a", "mailbox"));
}

async function watchPushes(t: TestConvex): Promise<void> {
  await t.run(async (ctx) => ctx.db.insert("pushTokens", { userId: "user_a", token: "tok-a" }));
}

async function caregiverNotices(t: TestConvex): Promise<{ posts: string[]; pushes: string[] }> {
  return await t.run(async (ctx) => ({
    posts: (await ctx.db.query("chatPosts").collect()).map((p) => p.body),
    pushes: (await ctx.db.query("notificationOutbox").collect()).map((p) => p.title),
  }));
}

describe("Polling", () => {
  test("a poll inserts unseen ids once and a repeated poll inserts nothing", async () => {
    const t = makeBackend();
    const householdId = await createHousehold(t);
    const mailboxId = await addMailbox(t, householdId);
    gmailMocks.listHistory.mockResolvedValue(history(["a", "b"], "150"));

    expect(await t.action(internal.gmail.poll, { mailboxId })).toBe("polled");
    expect((await itemRows(t)).map((i) => [i.gmailId, i.state])).toEqual([
      ["a", "queued"],
      ["b", "queued"],
    ]);
    expect((await mailboxRows(t))[0]).toMatchObject({ historyId: "150" });

    expect(await t.action(internal.gmail.poll, { mailboxId })).toBe("polled");
    expect(await itemRows(t)).toHaveLength(2);
    expect(gmailMocks.listHistory.mock.calls[0]![1]).toBe("100");
    expect(gmailMocks.listHistory.mock.calls[1]![1]).toBe("150");
  });

  test("a poll over a cursor that did not move still inserts nothing twice", async () => {
    const t = makeBackend();
    const householdId = await createHousehold(t);
    const mailboxId = await addMailbox(t, householdId);
    gmailMocks.listHistory.mockResolvedValue(history(["a"], "100"));
    await t.action(internal.gmail.poll, { mailboxId });
    await t.action(internal.gmail.poll, { mailboxId });
    expect(await itemRows(t)).toHaveLength(1);
  });

  test("two recordNew calls with the same expected cursor move the cursor once", async () => {
    const t = makeBackend();
    const householdId = await createHousehold(t);
    const mailboxId = await addMailbox(t, householdId);

    const first = await t.mutation(internal.gmail.recordNew, {
      mailboxId,
      refreshToken: "box:refresh-1",
      ids: ["a", "b"],
      expectedHistoryId: "100",
      lastHistoryId: "150",
    });
    const second = await t.mutation(internal.gmail.recordNew, {
      mailboxId,
      refreshToken: "box:refresh-1",
      ids: ["b", "c"],
      expectedHistoryId: "100",
      lastHistoryId: "160",
    });

    expect(first).toEqual({ inserted: 2, moved: true });
    expect(second).toEqual({ inserted: 1, moved: false });
    expect((await mailboxRows(t))[0]!.historyId).toBe("150");
    expect((await itemRows(t)).map((i) => i.gmailId).sort()).toEqual(["a", "b", "c"]);
  });

  test("recordNew repeated with the same arguments changes nothing", async () => {
    const t = makeBackend();
    const householdId = await createHousehold(t);
    const mailboxId = await addMailbox(t, householdId);
    const args = {
      mailboxId,
      refreshToken: "box:refresh-1",
      ids: ["a"],
      expectedHistoryId: "100",
      lastHistoryId: "150",
    };
    await t.mutation(internal.gmail.recordNew, args);
    const again = await t.mutation(internal.gmail.recordNew, args);
    expect(again).toEqual({ inserted: 0, moved: false });
    expect(await itemRows(t)).toHaveLength(1);
    expect((await mailboxRows(t))[0]!.historyId).toBe("150");
  });

  test("recordNew records nothing for a mailbox that is revoked or gone", async () => {
    const t = makeBackend();
    const householdId = await createHousehold(t);
    const revoked = await addMailbox(t, householdId, { status: "revoked" });
    const args = {
      refreshToken: "box:refresh-1",
      ids: ["a"],
      expectedHistoryId: "100",
      lastHistoryId: "150",
    };
    expect(await t.mutation(internal.gmail.recordNew, { mailboxId: revoked, ...args })).toEqual({
      inserted: 0,
      moved: false,
    });
    await t.run(async (ctx) => ctx.db.delete(revoked));
    expect(await t.mutation(internal.gmail.recordNew, { mailboxId: revoked, ...args })).toEqual({
      inserted: 0,
      moved: false,
    });
    expect(await itemRows(t)).toHaveLength(0);
  });

  test("an expired history cursor falls back to the recent list and restarts the cursor", async () => {
    const t = makeBackend();
    const householdId = await createHousehold(t);
    const mailboxId = await addMailbox(t, householdId, {
      lastPolledAt: Date.now() - 30 * DAY_MS,
    });
    gmailMocks.listHistory.mockResolvedValue("expired");
    gmailMocks.getProfile.mockResolvedValue({ email: "margaret@example.com", historyId: "300" });
    gmailMocks.listRecent.mockResolvedValue(["r1", "r2"]);

    expect(await t.action(internal.gmail.poll, { mailboxId })).toBe("recovered");

    expect((await itemRows(t)).map((i) => i.gmailId)).toEqual(["r1", "r2"]);
    expect((await mailboxRows(t))[0]!.historyId).toBe("300");
    const [, since, max] = gmailMocks.listRecent.mock.calls[0]!;
    expect(Date.now() - since).toBeLessThan(7 * DAY_MS + 1000);
    expect(max).toBe(100);
  });

  test("an expired cursor after a recent poll asks only for the time since that poll", async () => {
    const t = makeBackend();
    const householdId = await createHousehold(t);
    const polledAt = Date.now() - 2 * DAY_MS;
    const mailboxId = await addMailbox(t, householdId, { lastPolledAt: polledAt });
    gmailMocks.listHistory.mockResolvedValue("expired");
    await t.action(internal.gmail.poll, { mailboxId });
    expect(gmailMocks.listRecent.mock.calls[0]![1]).toBe(polledAt);
  });

  test("a poll reads at most three history pages and moves the cursor to where it stopped", async () => {
    const t = makeBackend();
    const householdId = await createHousehold(t);
    const mailboxId = await addMailbox(t, householdId);
    let page = 0;
    gmailMocks.listHistory.mockImplementation(async () => {
      page += 1;
      return history([`p${page}`], `10${page}`, `token-${page}`);
    });

    await t.action(internal.gmail.poll, { mailboxId });

    expect(gmailMocks.listHistory).toHaveBeenCalledTimes(3);
    expect(gmailMocks.listHistory.mock.calls.map((c) => c[2])).toEqual([
      undefined,
      "token-1",
      "token-2",
    ]);
    expect((await itemRows(t)).map((i) => i.gmailId)).toEqual(["p1", "p2", "p3"]);
    expect((await mailboxRows(t))[0]!.historyId).toBe("103");
  });

  test("empty pages with more to read leave the cursor at the last record read", async () => {
    const t = makeBackend();
    const householdId = await createHousehold(t);
    const mailboxId = await addMailbox(t, householdId);
    gmailMocks.listHistory
      .mockResolvedValueOnce(history(["a"], "120", "token-1"))
      .mockResolvedValueOnce(history([], null, "token-2"))
      .mockResolvedValueOnce(history([], null, "token-3"));

    await t.action(internal.gmail.poll, { mailboxId });

    expect((await itemRows(t)).map((i) => i.gmailId)).toEqual(["a"]);
    expect((await mailboxRows(t))[0]!.historyId).toBe("120");
  });

  test("a poll that reads only empty pages recovers from the recent list instead of stalling", async () => {
    const t = makeBackend();
    const householdId = await createHousehold(t);
    const mailboxId = await addMailbox(t, householdId, { lastPolledAt: Date.now() - DAY_MS });
    gmailMocks.listHistory.mockResolvedValue(history([], null, "more"));
    gmailMocks.getProfile.mockResolvedValue({ email: "margaret@example.com", historyId: "500" });
    gmailMocks.listRecent.mockResolvedValue(["r1"]);

    expect(await t.action(internal.gmail.poll, { mailboxId })).toBe("recovered");

    expect(gmailMocks.listHistory).toHaveBeenCalledTimes(3);
    expect((await itemRows(t)).map((i) => i.gmailId)).toEqual(["r1"]);
    expect((await mailboxRows(t))[0]!.historyId).toBe("500");
  });

  test("a poll stops paging once it holds 100 ids", async () => {
    const t = makeBackend();
    const householdId = await createHousehold(t);
    const mailboxId = await addMailbox(t, householdId);
    const ids = Array.from({ length: 100 }, (_, i) => `m${i}`);
    gmailMocks.listHistory.mockResolvedValue(history(ids, "180", "more"));

    await t.action(internal.gmail.poll, { mailboxId });

    expect(gmailMocks.listHistory).toHaveBeenCalledTimes(1);
    expect(await itemRows(t)).toHaveLength(100);
    expect((await mailboxRows(t))[0]!.historyId).toBe("180");
  });

  test("a poll that dies before recording changes nothing and the next poll finds the mail", async () => {
    const t = makeBackend();
    const householdId = await createHousehold(t);
    const mailboxId = await addMailbox(t, householdId);
    gmailMocks.listHistory.mockResolvedValueOnce(history(["a"], "120", "next"));
    gmailMocks.listHistory.mockRejectedValueOnce(new GoogleApiError(503, "unavailable"));

    await expect(t.action(internal.gmail.poll, { mailboxId })).rejects.toThrow("503");
    expect(await itemRows(t)).toHaveLength(0);
    expect((await mailboxRows(t))[0]!.historyId).toBe("100");

    gmailMocks.listHistory.mockResolvedValue(history(["a", "b"], "130"));
    expect(await t.action(internal.gmail.poll, { mailboxId })).toBe("polled");
    expect((await itemRows(t)).map((i) => i.gmailId)).toEqual(["a", "b"]);
    expect((await mailboxRows(t))[0]!.historyId).toBe("130");
  });

  test("the access token is cached encrypted and reused by the next poll", async () => {
    const t = makeBackend();
    const householdId = await createHousehold(t);
    const mailboxId = await addMailbox(t, householdId);
    await t.action(internal.gmail.poll, { mailboxId });
    await t.action(internal.gmail.poll, { mailboxId });
    expect(googleMocks.refreshAccessToken).toHaveBeenCalledTimes(1);
    expect(googleMocks.refreshAccessToken).toHaveBeenCalledWith("refresh-1");
    expect((await mailboxRows(t))[0]!.accessToken).toBe("box:access-1");
    expect(gmailMocks.listHistory.mock.calls[1]![0]).toBe("access-1");
  });

  test("a 401 refreshes the token once and retries the call", async () => {
    const t = makeBackend();
    const householdId = await createHousehold(t);
    const mailboxId = await addMailbox(t, householdId);
    googleMocks.refreshAccessToken
      .mockResolvedValueOnce({ accessToken: "stale", expiresAt: Date.now() + 3_600_000 })
      .mockResolvedValueOnce({ accessToken: "fresh", expiresAt: Date.now() + 3_600_000 });
    gmailMocks.listHistory
      .mockRejectedValueOnce(new GoogleApiError(401, "expired"))
      .mockResolvedValueOnce(history(["a"], "110"));

    expect(await t.action(internal.gmail.poll, { mailboxId })).toBe("polled");

    expect(gmailMocks.listHistory.mock.calls.map((c) => c[0])).toEqual(["stale", "fresh"]);
    expect(await itemRows(t)).toHaveLength(1);
  });

  test("a household that is paused is not polled", async () => {
    const t = makeBackend();
    const householdId = await createHousehold(t);
    const mailboxId = await addMailbox(t, householdId);
    await setPaused(t, householdId, true);

    expect(await t.mutation(internal.gmail.pollAll, {})).toBe(0);
    expect(await t.action(internal.gmail.poll, { mailboxId })).toBe("skipped");
    expect(gmailMocks.listHistory).not.toHaveBeenCalled();

    await setPaused(t, householdId, false);
    expect(await t.mutation(internal.gmail.pollAll, {})).toBe(1);
  });

  test("pollAll skips a mailbox whose last poll still waits in the pool and polls it once that job ends", async () => {
    const t = makeBackend();
    const householdId = await createHousehold(t);
    await addMailbox(t, householdId);

    expect(await t.mutation(internal.gmail.pollAll, {})).toBe(1);
    const firstJob = (await mailboxRows(t))[0]!.pollJobId;
    expect(firstJob).toBeDefined();
    expect(await t.mutation(internal.gmail.pollAll, {})).toBe(0);

    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(gmailMocks.listHistory).toHaveBeenCalledTimes(1);
    expect(await t.mutation(internal.gmail.pollAll, {})).toBe(1);
    expect((await mailboxRows(t))[0]!.pollJobId).not.toBe(firstJob);
  });

  test("pollAll queues active mailboxes only", async () => {
    const t = makeBackend();
    const householdId = await createHousehold(t);
    await addMailbox(t, householdId, { status: "revoked" });
    expect(await t.mutation(internal.gmail.pollAll, {})).toBe(0);
    const other = await createHousehold(t, { subject: "user_z" });
    await addMailbox(t, other);
    expect(await t.mutation(internal.gmail.pollAll, {})).toBe(1);
  });

  test("invalid_grant marks the mailbox revoked and stops polling", async () => {
    const t = makeBackend();
    const householdId = await createHousehold(t);
    await watchPushes(t);
    const mailboxId = await addMailbox(t, householdId, {
      accessToken: "box:old",
      accessTokenExpiresAt: 1,
    });
    googleMocks.refreshAccessToken.mockRejectedValue(new GoogleAccessRevoked("invalid_grant"));

    expect(await t.action(internal.gmail.poll, { mailboxId })).toBe("revoked");

    const [mailbox] = await mailboxRows(t);
    expect(mailbox).toMatchObject({ status: "revoked" });
    expect(mailbox!.error).toContain("reconnect");
    expect(mailbox!.accessToken).toBeUndefined();
    expect(await caregiverNotices(t)).toEqual({
      posts: [
        "Sunny can no longer read margaret@example.com. Reconnect Gmail to keep mail coming in.",
      ],
      pushes: ["Reconnect Gmail for Margaret"],
    });
    expect(await t.mutation(internal.gmail.pollAll, {})).toBe(0);
    expect(await t.action(internal.gmail.poll, { mailboxId })).toBe("skipped");
    expect(googleMocks.refreshAccessToken).toHaveBeenCalledTimes(1);
  });

  test("an unreadable saved token marks the mailbox as an error", async () => {
    const t = makeBackend();
    const householdId = await createHousehold(t);
    const mailboxId = await addMailbox(t, householdId, { refreshToken: "garbage" });
    expect(await t.action(internal.gmail.poll, { mailboxId })).toBe("failed");
    expect((await mailboxRows(t))[0]).toMatchObject({ status: "error" });
  });

  test("Google denying access marks the mailbox as an error", async () => {
    const t = makeBackend();
    const householdId = await createHousehold(t);
    const mailboxId = await addMailbox(t, householdId);
    gmailMocks.listHistory.mockRejectedValue(new GoogleApiError(403, "insufficientPermissions"));
    expect(await t.action(internal.gmail.poll, { mailboxId })).toBe("failed");
    expect((await mailboxRows(t))[0]).toMatchObject({ status: "error" });
  });

  test("a deployment setup error ends the poll without a retry and leaves the mailbox active", async () => {
    const t = makeBackend();
    const householdId = await createHousehold(t);
    const mailboxId = await addMailbox(t, householdId);
    gmailMocks.listHistory.mockRejectedValue(new ConfigError("Missing env var GOOGLE_CLIENT_ID"));
    await expect(t.action(internal.gmail.poll, { mailboxId })).rejects.toMatchObject({
      name: "NonRetryableError",
    });
    expect((await mailboxRows(t))[0]).toMatchObject({ status: "active" });
  });

  test.each([
    ["a project quota error", DAILY_LIMIT],
    ["an API disabled for the project", API_DISABLED],
  ])(
    "%s ends the poll without a retry, leaves the mailbox active and tells nobody",
    async (_name, body) => {
      const t = makeBackend();
      const householdId = await createHousehold(t);
      await watchPushes(t);
      const mailboxId = await addMailbox(t, householdId);
      gmailMocks.listHistory.mockRejectedValue(new GoogleApiError(403, body));
      await expect(t.action(internal.gmail.poll, { mailboxId })).rejects.toMatchObject({
        name: "NonRetryableError",
      });
      expect((await mailboxRows(t))[0]).toMatchObject({ status: "active", historyId: "100" });
      expect(await caregiverNotices(t)).toEqual({ posts: [], pushes: [] });
    },
  );

  test("a Workspace domain policy marks the mailbox as an error", async () => {
    const t = makeBackend();
    const householdId = await createHousehold(t);
    const mailboxId = await addMailbox(t, householdId);
    gmailMocks.listHistory.mockRejectedValue(new GoogleApiError(403, DOMAIN_POLICY));
    expect(await t.action(internal.gmail.poll, { mailboxId })).toBe("failed");
    expect((await mailboxRows(t))[0]).toMatchObject({
      status: "error",
      error: "Google denied Sunny access to the mailbox; reconnect Gmail.",
    });
  });

  test("a transient Google error is rethrown for the pool to retry and leaves the mailbox active", async () => {
    const t = makeBackend();
    const householdId = await createHousehold(t);
    const mailboxId = await addMailbox(t, householdId);
    gmailMocks.listHistory.mockRejectedValue(new GoogleApiError(500, "backend error"));
    await expect(t.action(internal.gmail.poll, { mailboxId })).rejects.toThrow("500");
    expect((await mailboxRows(t))[0]).toMatchObject({ status: "active", historyId: "100" });
  });

  test("a poll that exhausts its retries records a retry notice and a later poll clears it", async () => {
    const t = makeBackend();
    const householdId = await createHousehold(t);
    const mailboxId = await addMailbox(t, householdId);
    await t.mutation(internal.gmail.onPollComplete, {
      workId: "w" as never,
      context: { mailboxId },
      result: { kind: "failed", error: "boom" },
    });
    expect((await mailboxRows(t))[0]!.lastError).toContain("try again");
    await t.action(internal.gmail.poll, { mailboxId });
    expect((await mailboxRows(t))[0]!.lastError).toBeUndefined();
  });

  test("no token reaches the logs", async () => {
    const t = makeBackend();
    const householdId = await createHousehold(t);
    const mailboxId = await addMailbox(t, householdId);
    const logged: unknown[] = [];
    for (const level of ["log", "info", "warn", "error"] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        logged.push(...args);
      });
    }
    gmailMocks.listHistory.mockRejectedValue(new GoogleApiError(400, "bad request"));
    await t.action(internal.gmail.poll, { mailboxId });
    const text = logged.map(String).join("\n");
    expect(text).toContain("400");
    for (const secret of ["refresh-1", "access-1"]) expect(text).not.toContain(secret);
  });
});

describe("Reconnecting another account while a job of the old one runs", () => {
  test("a poll of the old account that finds its access revoked leaves the new account connected and quiet", async () => {
    const t = makeBackend();
    const householdId = await createHousehold(t);
    await watchPushes(t);
    const mailboxId = await addMailbox(t, householdId);
    let reconnected = false;
    googleMocks.refreshAccessToken.mockImplementation(async (refresh: string) => {
      if (reconnected && refresh === "refresh-1") throw new GoogleAccessRevoked("invalid_grant");
      return { accessToken: `access-for-${refresh}`, expiresAt: Date.now() + 3_600_000 };
    });
    gmailMocks.listHistory.mockImplementationOnce(async () => {
      await reconnectAs(t, householdId, "mom@example.com");
      reconnected = true;
      throw new GoogleApiError(401, "unauthorized");
    });

    await t.action(internal.gmail.poll, { mailboxId });

    const [mailbox] = await mailboxRows(t);
    expect(mailbox).toMatchObject({ accountEmail: "mom@example.com", status: "active" });
    expect(mailbox!.error).toBeUndefined();
    expect(await caregiverNotices(t)).toEqual({
      posts: ["Sunny now reads mom@example.com."],
      pushes: [],
    });
    expect(await t.mutation(internal.gmail.pollAll, {})).toBe(1);
  });

  test("a token refresh by a job of the old account leaves the next poll reading the new account", async () => {
    const t = makeBackend();
    const householdId = await createHousehold(t);
    const mailboxId = await addMailbox(t, householdId);
    let reconnected = false;
    googleMocks.refreshAccessToken.mockImplementation(async (refresh: string) => {
      if (!reconnected) {
        reconnected = true;
        await reconnectAs(t, householdId, "mom@example.com");
      }
      return { accessToken: `access-for-${refresh}`, expiresAt: Date.now() + 3_600_000 };
    });

    await t.action(internal.gmail.poll, { mailboxId });
    await t.action(internal.gmail.poll, { mailboxId });

    expect(gmailMocks.listHistory.mock.calls.map((c) => c[0])).toEqual([
      "access-for-refresh-1",
      "access-for-refresh-new",
    ]);
    expect((await mailboxRows(t))[0]!.accessToken).toBe("box:access-for-refresh-new");
  });

  test("a poll of the old account that finishes after the reconnect files nothing under the new account", async () => {
    const t = makeBackend();
    const householdId = await createHousehold(t);
    const mailboxId = await addMailbox(t, householdId);
    let reconnected: Doc<"mailboxes"> | undefined;
    gmailMocks.listHistory.mockImplementationOnce(async () => {
      await reconnectAs(t, householdId, "mom@example.com");
      [reconnected] = await mailboxRows(t);
      vi.setSystemTime(Date.now() + 60_000);
      return history(["old1", "old2"], "150");
    });

    await t.action(internal.gmail.poll, { mailboxId });

    expect(await itemRows(t)).toEqual([]);
    expect((await mailboxRows(t))[0]).toMatchObject({
      accountEmail: "mom@example.com",
      historyId: "900",
      lastPolledAt: reconnected!.lastPolledAt,
    });
  });
});

describe("mailboxStatus and disconnect", () => {
  test("mailboxStatus shows the mailbox without token fields to a caregiver", async () => {
    const t = makeBackend();
    const householdId = await createHousehold(t);
    await addMemberViewer(t, householdId);
    await addMailbox(t, householdId, { lastPolledAt: 5, lastError: "x" });
    const view = await t
      .withIdentity({ subject: "user_viewer" })
      .query(api.gmail.mailboxStatus, { householdId });
    expect(Object.keys(view!).sort()).toEqual(
      ["accountEmail", "error", "id", "lastError", "lastPolledAt", "status"].sort(),
    );
    expect(JSON.stringify(view)).not.toContain("refresh-1");
    expect(view).toMatchObject({ accountEmail: "margaret@example.com", status: "active" });
  });

  test("mailboxStatus is null with no mailbox and refuses strangers and devices", async () => {
    const t = makeBackend();
    const householdId = await createHousehold(t);
    expect(
      await t.withIdentity({ subject: "user_a" }).query(api.gmail.mailboxStatus, { householdId }),
    ).toBeNull();
    await expect(
      t.withIdentity({ subject: "stranger" }).query(api.gmail.mailboxStatus, { householdId }),
    ).rejects.toMatchObject({ data: { code: "forbidden" } });
    await expect(
      t
        .withIdentity({ subject: "dev_1", sunny_kind: "device" })
        .query(api.gmail.mailboxStatus, { householdId }),
    ).rejects.toMatchObject({ data: { code: "forbidden" } });
  });

  test("disconnect removes the mailbox and schedules the grant revocation", async () => {
    const t = makeBackend();
    const householdId = await createHousehold(t);
    const mailboxId = await addMailbox(t, householdId);
    await t.withIdentity({ subject: "user_a" }).mutation(api.gmail.disconnect, { mailboxId });
    expect(await mailboxRows(t)).toHaveLength(0);
    expect(await pendingScheduled(t)).toContain("googleOauth:revokeGrant");
    expect(await t.mutation(internal.gmail.pollAll, {})).toBe(0);
  });

  test("disconnect refuses a viewer, a stranger and a signed-out caller and keeps the mailbox", async () => {
    const t = makeBackend();
    const householdId = await createHousehold(t);
    await addMemberViewer(t, householdId);
    const mailboxId = await addMailbox(t, householdId);
    await expect(
      t.withIdentity({ subject: "user_viewer" }).mutation(api.gmail.disconnect, { mailboxId }),
    ).rejects.toMatchObject({ data: { code: "forbidden" } });
    await expect(
      t.withIdentity({ subject: "stranger" }).mutation(api.gmail.disconnect, { mailboxId }),
    ).rejects.toMatchObject({ data: { code: "forbidden" } });
    await expect(t.mutation(api.gmail.disconnect, { mailboxId })).rejects.toMatchObject({
      data: { code: "unauthenticated" },
    });
    expect(await mailboxRows(t)).toHaveLength(1);
    expect(googleMocks.revokeRefreshToken).not.toHaveBeenCalled();
  });

  test("disconnect keeps the mail items so a reconnect does not triage them again", async () => {
    const t = makeBackend();
    const householdId = await createHousehold(t);
    const mailboxId = await addMailbox(t, householdId);
    await t.mutation(internal.gmail.recordNew, {
      mailboxId,
      refreshToken: "box:refresh-1",
      ids: ["a"],
      expectedHistoryId: "100",
      lastHistoryId: "110",
    });
    await t.withIdentity({ subject: "user_a" }).mutation(api.gmail.disconnect, { mailboxId });
    expect((await itemRows(t)).map((i) => i.gmailId)).toEqual(["a"]);
    const again = await addMailbox(t, householdId);
    await t.mutation(internal.gmail.recordNew, {
      mailboxId: again,
      refreshToken: "box:refresh-1",
      ids: ["a", "b"],
      expectedHistoryId: "100",
      lastHistoryId: "120",
    });
    expect((await itemRows(t)).map((i) => i.gmailId)).toEqual(["a", "b"]);
  });

  test("disconnecting the mailbox leaves the caregiver's calendar connection alone", async () => {
    const t = makeBackend();
    const householdId = await createHousehold(t);
    await addConnection(t, householdId);
    const mailboxId = await addMailbox(t, householdId);
    await t.withIdentity({ subject: "user_a" }).mutation(api.gmail.disconnect, { mailboxId });
    expect(
      await t.run(async (ctx) => await ctx.db.query("calendarConnections").collect()),
    ).toHaveLength(1);
  });
});

async function runScheduledRevokes(t: TestConvex): Promise<void> {
  const pending = await t.run(async (ctx) =>
    (await ctx.db.system.query("_scheduled_functions").collect()).filter(
      (r) => r.state.kind === "pending" && r.name === "googleOauth:revokeGrant",
    ),
  );
  for (const row of pending) {
    await t.action(internal.googleOauth.revokeGrant, row.args[0]);
  }
}

describe("Revoking Google grants", () => {
  test("reconnecting the same Google account revokes nothing", async () => {
    const t = makeBackend();
    const householdId = await createHousehold(t);
    await addMailbox(t, householdId);
    googleMocks.exchangeCode.mockResolvedValue({
      ...grant([GMAIL_SCOPE]),
      email: "margaret@example.com",
    });
    await finish(t, await startFlow(t, householdId, "user_a", "mailbox"));
    await runScheduledRevokes(t);
    expect(googleMocks.revokeRefreshToken).not.toHaveBeenCalled();
  });

  test("reconnecting another Google account revokes the old grant", async () => {
    const t = makeBackend();
    const householdId = await createHousehold(t);
    await addMailbox(t, householdId);
    googleMocks.exchangeCode.mockResolvedValue({
      ...grant([GMAIL_SCOPE]),
      email: "mom@example.com",
    });
    gmailMocks.getProfile.mockResolvedValue({ email: "mom@example.com", historyId: "900" });
    await finish(t, await startFlow(t, householdId, "user_a", "mailbox"));
    await runScheduledRevokes(t);
    expect(googleMocks.revokeRefreshToken.mock.calls).toEqual([["refresh-1"]]);
  });

  test("a refused mailbox flow for an account that holds a calendar connection revokes nothing", async () => {
    const t = makeBackend();
    const householdId = await createHousehold(t);
    await addConnection(t, householdId);
    googleMocks.exchangeCode.mockResolvedValue({
      ...grant(["openid", "email"]),
      email: "anna@example.com",
    });
    const res = await finish(t, await startFlow(t, householdId, "user_a", "mailbox"));
    expect(res.status).toBe(400);
    expect(googleMocks.revokeRefreshToken).not.toHaveBeenCalled();
  });

  test("a refused grant whose account Sunny cannot tell is not revoked", async () => {
    const t = makeBackend();
    const householdId = await createHousehold(t);
    googleMocks.exchangeCode.mockResolvedValue({ ...grant(["openid"]), email: null });
    const res = await finish(t, await startFlow(t, householdId, "user_a", "mailbox"));
    expect(res.status).toBe(400);
    expect(googleMocks.revokeRefreshToken).not.toHaveBeenCalled();
  });

  test("disconnecting a mailbox whose account also holds a calendar connection revokes nothing", async () => {
    const t = makeBackend();
    const householdId = await createHousehold(t);
    await addConnection(t, householdId);
    const mailboxId = await addMailbox(t, householdId, { accountEmail: "Anna@Example.com" });
    await t.withIdentity({ subject: "user_a" }).mutation(api.gmail.disconnect, { mailboxId });
    await runScheduledRevokes(t);
    expect(googleMocks.revokeRefreshToken).not.toHaveBeenCalled();
  });

  test("disconnecting the last connection of an account revokes its grant", async () => {
    const t = makeBackend();
    const householdId = await createHousehold(t);
    const mailboxId = await addMailbox(t, householdId);
    await t.withIdentity({ subject: "user_a" }).mutation(api.gmail.disconnect, { mailboxId });
    await runScheduledRevokes(t);
    expect(googleMocks.revokeRefreshToken.mock.calls).toEqual([["refresh-1"]]);
  });

  test("reconnecting the calendar with the same Google account revokes nothing", async () => {
    const t = makeBackend();
    const householdId = await createHousehold(t);
    await addConnection(t, householdId);
    googleMocks.exchangeCode.mockResolvedValue({
      ...grant([CALENDAR_SCOPE]),
      email: "anna@example.com",
    });
    googleMocks.calendarExists.mockResolvedValue(true);
    await finish(t, await startFlow(t, householdId, "user_a", "calendar"));
    await runScheduledRevokes(t);
    expect(googleMocks.revokeRefreshToken).not.toHaveBeenCalled();
  });
});

async function addMemberViewer(t: TestConvex, householdId: Id<"households">): Promise<void> {
  await addMember(t, householdId, "user_viewer", "viewer");
}
