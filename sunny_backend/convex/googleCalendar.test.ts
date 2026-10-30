// googleCalendar.test.ts
// Purpose: Tests for googleCalendar.ts: the OAuth callback (happy path with an encrypted token
// and queued pushes, reusing or replacing the calendar, bad or expired state, a missing scope,
// Google errors, a caregiver who left, escaped output, and a reconnect clearing the cached
// access token), connectUrl permissions (devices, non-members, signed-out), myConnections
// (own connections only, no token fields) and disconnect (own connection only, links and syncs
// removed). Google is mocked (googleMocks.helpers.ts).
//
// Last modified: 2026-10-29

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { googleMocks, resetGoogleMocks } from "./googleMocks.helpers";
import {
  addCalendarEvent,
  addConnection,
  addMember,
  createHousehold,
  makeBackend,
  pendingScheduled,
  runFanOut,
  setupSynced,
  syncRows,
} from "./testing.helpers";
import type { TestConvex } from "./testing.helpers";

vi.mock("./lib/google", async (original) =>
  (await import("./googleMocks.helpers")).googleMock(await original()),
);
vi.mock("./lib/googleEvent", async () => (await import("./googleMocks.helpers")).googleEventMock);
vi.mock("./lib/secretBox", async (original) =>
  (await import("./googleMocks.helpers")).secretBoxMock(await original()),
);

beforeEach(() => {
  vi.useFakeTimers();
  resetGoogleMocks();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

/**
 * purpose: Store a single-use OAuth nonce as connectUrl would.
 * @param t: (TestConvex) Harness.
 * @param householdId: (Id<"households">) Household.
 * @param nonce: (string) The nonce.
 * @param userId: (string) Caregiver it was issued to.
 * @return: (Promise<void>) Resolves when stored.
 */
async function issueNonce(
  t: TestConvex,
  householdId: Id<"households">,
  nonce: string,
  userId = "user_a",
): Promise<void> {
  await t.run(async (ctx) => {
    await ctx.db.insert("oauthStates", {
      nonce,
      userId,
      householdId,
      expiresAt: Date.now() + 600_000,
    });
  });
}

describe("OAuth callback", () => {
  /**
   * purpose: Set up the mocks for a successful callback and return the household.
   * @param t: (TestConvex) Harness.
   * @param seniorName: (string) The household's senior name.
   * @return: The household id.
   */
  async function readyHousehold(t: TestConvex, seniorName = "Margaret") {
    const householdId = await createHousehold(t, { seniorName });
    // States "good" and "good2" carry single-use nonces n1 and n2, both issued to user_a.
    const nonces: Record<string, string> = { good: "n1", good2: "n2" };
    googleMocks.verifyState.mockImplementation(async (state: string) =>
      nonces[state] ? { userId: "user_a", householdId, nonce: nonces[state] } : null,
    );
    for (const nonce of ["n1", "n2"]) await issueNonce(t, householdId, nonce);
    googleMocks.exchangeCode.mockResolvedValue({
      accessToken: "acc",
      refreshToken: "refresh-new",
      scopes: ["https://www.googleapis.com/auth/calendar.app.created"],
      email: "anna@example.com",
    });
    googleMocks.createSunnyCalendar.mockResolvedValue("cal-new");
    return householdId;
  }

  test("saves an encrypted connection and queues every live event and linked cancelled one", async () => {
    const t = makeBackend();
    const householdId = await readyHousehold(t);
    const live = await addCalendarEvent(t, householdId, "Live");
    const unlinkedCancelled = await addCalendarEvent(t, householdId, "Cancelled, never synced");
    const linkedCancelled = await addCalendarEvent(t, householdId, "Cancelled, synced");
    const asA = t.withIdentity({ subject: "user_a" });
    await asA.mutation(api.calendar.cancelEvent, { householdId, eventId: unlinkedCancelled });
    await asA.mutation(api.calendar.cancelEvent, { householdId, eventId: linkedCancelled });

    const res = await t.fetch("/google/callback?code=c1&state=good");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Google Calendar connected");
    expect(googleMocks.createSunnyCalendar).toHaveBeenCalledWith(
      "acc",
      "Margaret",
      "America/New_York",
    );

    const connection = await t.run(
      async (ctx) => (await ctx.db.query("calendarConnections").collect())[0],
    );
    expect(connection).toMatchObject({
      userId: "user_a",
      householdId,
      accountEmail: "anna@example.com",
      externalCalendarId: "cal-new",
      status: "active",
      refreshToken: "box:refresh-new",
    });
    // The backfill is scheduled, not run inside the callback.
    expect(await syncRows(t)).toHaveLength(0);
    expect(await pendingScheduled(t)).toContain("calendarFanOut:chunk");
    await runFanOut(t, householdId, connection!._id);
    // Both cancelled events are unlinked, so only the live one is queued.
    expect((await syncRows(t)).map((s) => s.eventId)).toEqual([live]);

    // Link one cancelled event, then connect again: it is queued too.
    await t.run(async (ctx) =>
      ctx.db.insert("calendarEventLinks", {
        eventId: linkedCancelled,
        connectionId: connection!._id,
        externalEventId: "gx",
        syncedAt: 1,
      }),
    );
    googleMocks.calendarExists.mockResolvedValue(true);
    await t.fetch("/google/callback?code=c2&state=good2");
    await runFanOut(t, householdId, connection!._id);
    const queued = (await syncRows(t)).map((s) => s.eventId).sort();
    expect(queued).toEqual([live, linkedCancelled].sort());
    expect(googleMocks.createSunnyCalendar).toHaveBeenCalledTimes(1);
  });

  test("reuses the existing calendar when it still exists and keeps the links", async () => {
    const t = makeBackend();
    const householdId = await readyHousehold(t);
    const connectionId = await addConnection(t, householdId, {
      status: "revoked",
      calendarId: "cal-old",
    });
    const eventId = await addCalendarEvent(t, householdId);
    await t.run(async (ctx) =>
      ctx.db.insert("calendarEventLinks", {
        eventId,
        connectionId,
        externalEventId: "gx",
        syncedAt: 1,
      }),
    );
    googleMocks.calendarExists.mockResolvedValue(true);
    const res = await t.fetch("/google/callback?code=c&state=good");
    expect(res.status).toBe(200);
    const state = await t.run(async (ctx) => ({
      connections: await ctx.db.query("calendarConnections").collect(),
      links: await ctx.db.query("calendarEventLinks").collect(),
    }));
    expect(state.connections).toHaveLength(1);
    expect(state.connections[0]).toMatchObject({
      externalCalendarId: "cal-old",
      status: "active",
      refreshToken: "box:refresh-new",
    });
    expect(state.connections[0]?.error).toBeUndefined();
    expect(state.links).toHaveLength(1);
    expect(googleMocks.createSunnyCalendar).not.toHaveBeenCalled();
  });

  test("creates a new calendar and drops old links when the old one is gone", async () => {
    const t = makeBackend();
    const householdId = await readyHousehold(t);
    const connectionId = await addConnection(t, householdId, { calendarId: "cal-old" });
    const eventId = await addCalendarEvent(t, householdId);
    await t.run(async (ctx) =>
      ctx.db.insert("calendarEventLinks", {
        eventId,
        connectionId,
        externalEventId: "gx",
        syncedAt: 1,
      }),
    );
    googleMocks.calendarExists.mockResolvedValue(false);
    await t.fetch("/google/callback?code=c&state=good");
    const state = await t.run(async (ctx) => ({
      connection: await ctx.db.get(connectionId),
      links: await ctx.db.query("calendarEventLinks").collect(),
    }));
    expect(state.connection?.externalCalendarId).toBe("cal-new");
    expect(state.links).toHaveLength(0);
  });

  test("reconnecting clears the cached access token", async () => {
    const t = makeBackend();
    const householdId = await readyHousehold(t);
    const connectionId = await addConnection(t, householdId, { calendarId: "cal-old" });
    await t.run(async (ctx) =>
      ctx.db.patch(connectionId, { accessToken: "box:old", accessTokenExpiresAt: 99 }),
    );
    googleMocks.calendarExists.mockResolvedValue(true);
    await t.fetch("/google/callback?code=c&state=good");
    const connection = await t.run(async (ctx) => await ctx.db.get(connectionId));
    expect(connection?.accessToken).toBeUndefined();
    expect(connection?.accessTokenExpiresAt).toBeUndefined();
    expect(connection?.refreshToken).toBe("box:refresh-new");
  });

  test.each([
    ["a bad state", "/google/callback?code=c&state=bad"],
    ["a missing state", "/google/callback?code=c"],
    ["a missing code", "/google/callback?state=good"],
  ])("%s answers a link expired page and saves nothing", async (_label, path) => {
    const t = makeBackend();
    await readyHousehold(t);
    const res = await t.fetch(path);
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("Link expired");
    expect(googleMocks.exchangeCode).not.toHaveBeenCalled();
  });

  test("a grant without the calendar scope is refused", async () => {
    const t = makeBackend();
    await readyHousehold(t);
    googleMocks.exchangeCode.mockResolvedValue({
      accessToken: "acc",
      refreshToken: "r",
      scopes: ["openid"],
      email: null,
    });
    const res = await t.fetch("/google/callback?code=c&state=good");
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("Permission needed");
    expect(googleMocks.revokeRefreshToken).toHaveBeenCalledWith("r");
    expect(
      await t.run(async (ctx) => await ctx.db.query("calendarConnections").collect()),
    ).toHaveLength(0);
  });

  test("Google reporting an error answers a not connected page", async () => {
    const t = makeBackend();
    await readyHousehold(t);
    const res = await t.fetch("/google/callback?error=access_denied&state=good");
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("Not connected");
  });

  test("a failed code exchange answers a generic error page", async () => {
    const t = makeBackend();
    await readyHousehold(t);
    googleMocks.exchangeCode.mockRejectedValue(new Error("secret detail"));
    const res = await t.fetch("/google/callback?code=c&state=good");
    expect(res.status).toBe(500);
    const body = await res.text();
    expect(body).toContain("Something went wrong");
    expect(body).not.toContain("secret detail");
  });

  test("a caregiver who left the household is refused", async () => {
    const t = makeBackend();
    const householdId = await readyHousehold(t);
    await issueNonce(t, householdId, "n3", "user_gone");
    googleMocks.verifyState.mockResolvedValue({ userId: "user_gone", householdId, nonce: "n3" });
    const res = await t.fetch("/google/callback?code=c&state=good");
    expect(res.status).toBe(403);
    expect(googleMocks.createSunnyCalendar).not.toHaveBeenCalled();
    // Google issued a grant for this request; it is not kept, so it is revoked.
    expect(googleMocks.revokeRefreshToken).toHaveBeenCalledWith("refresh-new");
  });

  test("a state can be used once: a replay shows the link expired page", async () => {
    const t = makeBackend();
    await readyHousehold(t);
    expect((await t.fetch("/google/callback?code=c&state=good")).status).toBe(200);
    const replay = await t.fetch("/google/callback?code=c&state=good");
    expect(replay.status).toBe(400);
    expect(await replay.text()).toContain("Link expired");
    expect(googleMocks.exchangeCode).toHaveBeenCalledTimes(1);
  });

  test("a nonce issued to someone else, an expired one and an unknown one are refused", async () => {
    const t = makeBackend();
    const householdId = await readyHousehold(t);
    await issueNonce(t, householdId, "n-other", "someone_else");
    await t.run(async (ctx) => {
      await ctx.db.insert("oauthStates", {
        nonce: "n-old",
        userId: "user_a",
        householdId,
        expiresAt: Date.now() - 1,
      });
    });
    for (const nonce of ["n-other", "n-old", "n-unknown"]) {
      googleMocks.verifyState.mockResolvedValue({ userId: "user_a", householdId, nonce });
      const res = await t.fetch("/google/callback?code=c&state=x");
      expect(res.status).toBe(400);
      expect(await res.text()).toContain("Link expired");
    }
    expect(googleMocks.exchangeCode).not.toHaveBeenCalled();
  });

  test("pages carry no-store, no-referrer and nosniff headers", async () => {
    const t = makeBackend();
    await readyHousehold(t);
    for (const path of ["/google/callback?code=c&state=good", "/google/callback?error=denied"]) {
      const res = await t.fetch(path);
      expect(res.headers.get("Cache-Control")).toBe("no-store");
      expect(res.headers.get("Referrer-Policy")).toBe("no-referrer");
      expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    }
  });

  test("a misconfiguration while verifying the state shows the generic error page", async () => {
    const t = makeBackend();
    await readyHousehold(t);
    googleMocks.verifyState.mockRejectedValue(
      new Error("Missing env var GOOGLE_OAUTH_STATE_SECRET"),
    );
    const res = await t.fetch("/google/callback?code=c&state=good");
    expect(res.status).toBe(500);
    const body = await res.text();
    expect(body).toContain("Something went wrong");
    expect(body).not.toContain("GOOGLE_OAUTH_STATE_SECRET");
  });

  test("a grant that could not be saved is revoked", async () => {
    const t = makeBackend();
    await readyHousehold(t);
    googleMocks.createSunnyCalendar.mockRejectedValue(new Error("calendar api down"));
    const res = await t.fetch("/google/callback?code=c&state=good");
    expect(res.status).toBe(500);
    expect(googleMocks.revokeRefreshToken).toHaveBeenCalledWith("refresh-new");
  });

  test("reconnecting with a new token revokes the old grant", async () => {
    const t = makeBackend();
    const householdId = await readyHousehold(t);
    await addConnection(t, householdId, { calendarId: "cal-old" });
    googleMocks.calendarExists.mockResolvedValue(true);
    await t.fetch("/google/callback?code=c&state=good");
    expect(await pendingScheduled(t)).toContain("googleCalendar:revokeGrant");
  });

  test("the senior's name is escaped in the success page", async () => {
    const t = makeBackend();
    await readyHousehold(t, "Mom <script>alert(1)</script>");
    const body = await (await t.fetch("/google/callback?code=c&state=good")).text();
    expect(body).not.toContain("<script>");
    expect(body).toContain("&#60;script&#62;");
  });
});

describe("connectUrl, myConnections and disconnect", () => {
  test("a member caregiver gets a consent URL with a signed state", async () => {
    const t = makeBackend();
    const householdId = await createHousehold(t);
    const url = await t
      .withIdentity({ subject: "user_a" })
      .action(api.googleCalendar.connectUrl, { householdId });
    const nonce = url.split("~")[2]!;
    expect(url).toBe(`https://consent.test/?state=user_a~${householdId}~${nonce}`);
    const rows = await t.run(async (ctx) => await ctx.db.query("oauthStates").collect());
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ nonce, userId: "user_a", householdId });
    expect(rows[0]!.expiresAt).toBe(Date.now() + 10 * 60_000);
    // Two flows get two different nonces.
    const second = await t
      .withIdentity({ subject: "user_a" })
      .action(api.googleCalendar.connectUrl, { householdId });
    expect(second.split("~")[2]).not.toBe(nonce);
  });

  test("a device is refused, with or without the device claim", async () => {
    const t = makeBackend();
    const householdId = await createHousehold(t);
    await t.run(async (ctx) => {
      await ctx.db.insert("devices", { householdId, userId: "dev_1", kind: "home_display" });
    });
    await expect(
      t
        .withIdentity({ subject: "dev_1", sunny_kind: "device" })
        .action(api.googleCalendar.connectUrl, { householdId }),
    ).rejects.toMatchObject({ data: { code: "forbidden" } });
    await expect(
      t.withIdentity({ subject: "dev_1" }).action(api.googleCalendar.connectUrl, { householdId }),
    ).rejects.toMatchObject({ data: { code: "forbidden" } });
  });

  test("a non-member and a signed-out caller are refused", async () => {
    const t = makeBackend();
    const householdId = await createHousehold(t);
    await expect(
      t
        .withIdentity({ subject: "stranger" })
        .action(api.googleCalendar.connectUrl, { householdId }),
    ).rejects.toMatchObject({ data: { code: "forbidden" } });
    await expect(t.action(api.googleCalendar.connectUrl, { householdId })).rejects.toMatchObject({
      data: { code: "unauthenticated" },
    });
  });

  test("myConnections returns only the caller's connections without token fields", async () => {
    const t = makeBackend();
    const householdId = await createHousehold(t);
    await addMember(t, householdId, "user_b");
    await addConnection(t, householdId);
    await addConnection(t, householdId, { userId: "user_b" });
    const mine = await t
      .withIdentity({ subject: "user_a" })
      .query(api.googleCalendar.myConnections, { householdId });
    expect(mine).toHaveLength(1);
    expect(Object.keys(mine[0]!).sort()).toEqual(
      ["accountEmail", "error", "id", "lastError", "lastSyncedAt", "status"].sort(),
    );
    expect(JSON.stringify(mine)).not.toContain("refresh-1");
  });

  test("myConnections refuses a non-member and a device", async () => {
    const t = makeBackend();
    const householdId = await createHousehold(t);
    await expect(
      t
        .withIdentity({ subject: "stranger" })
        .query(api.googleCalendar.myConnections, { householdId }),
    ).rejects.toMatchObject({ data: { code: "forbidden" } });
    await expect(
      t
        .withIdentity({ subject: "dev_1", sunny_kind: "device" })
        .query(api.googleCalendar.myConnections, { householdId }),
    ).rejects.toMatchObject({ data: { code: "forbidden" } });
  });

  test("disconnect removes the caller's connection, links and syncs", async () => {
    const t = makeBackend();
    const { connectionId, eventId } = await setupSynced(t);
    await t.run(async (ctx) =>
      ctx.db.insert("calendarEventLinks", {
        eventId,
        connectionId,
        externalEventId: "gx",
        syncedAt: 1,
      }),
    );
    await t
      .withIdentity({ subject: "user_a" })
      .mutation(api.googleCalendar.disconnect, { connectionId });
    const left = await t.run(async (ctx) => ({
      connections: await ctx.db.query("calendarConnections").collect(),
      links: await ctx.db.query("calendarEventLinks").collect(),
      syncs: await ctx.db.query("calendarSyncs").collect(),
    }));
    expect(left.connections).toHaveLength(0);
    expect(left.links).toHaveLength(0);
    expect(left.syncs).toHaveLength(0);
  });

  test("disconnect refuses someone else's connection and a signed-out caller", async () => {
    const t = makeBackend();
    const householdId = await createHousehold(t);
    await addMember(t, householdId, "user_b");
    const bConnection = await addConnection(t, householdId, { userId: "user_b" });
    await expect(
      t.withIdentity({ subject: "user_a" }).mutation(api.googleCalendar.disconnect, {
        connectionId: bConnection,
      }),
    ).rejects.toMatchObject({ data: { code: "not_found" } });
    await expect(
      t.mutation(api.googleCalendar.disconnect, { connectionId: bConnection }),
    ).rejects.toMatchObject({ data: { code: "unauthenticated" } });
    expect(
      await t.run(async (ctx) => await ctx.db.query("calendarConnections").collect()),
    ).toHaveLength(1);
  });
});

describe("OAuth state housekeeping and grant revocation", () => {
  test("the sweeper deletes only expired nonces", async () => {
    const t = makeBackend();
    const householdId = await createHousehold(t);
    await issueNonce(t, householdId, "fresh");
    await t.run(async (ctx) => {
      await ctx.db.insert("oauthStates", {
        nonce: "old",
        userId: "user_a",
        householdId,
        expiresAt: Date.now() - 1,
      });
    });
    expect(await t.mutation(internal.googleCalendar.sweepOauthStates, {})).toBe(1);
    const left = await t.run(async (ctx) => await ctx.db.query("oauthStates").collect());
    expect(left.map((r) => r.nonce)).toEqual(["fresh"]);
  });

  test("revokeGrant decrypts the stored token and revokes it at Google", async () => {
    const t = makeBackend();
    expect(await t.action(internal.googleCalendar.revokeGrant, { refreshToken: "box:rt-1" })).toBe(
      true,
    );
    expect(googleMocks.revokeRefreshToken).toHaveBeenCalledWith("rt-1");
  });

  test("revokeGrant never throws when the token cannot be read", async () => {
    const t = makeBackend();
    expect(await t.action(internal.googleCalendar.revokeGrant, { refreshToken: "garbage" })).toBe(
      false,
    );
    expect(googleMocks.revokeRefreshToken).not.toHaveBeenCalled();
  });

  test("disconnect schedules the grant revocation", async () => {
    const t = makeBackend();
    const { connectionId } = await setupSynced(t);
    await t
      .withIdentity({ subject: "user_a" })
      .mutation(api.googleCalendar.disconnect, { connectionId });
    expect(await pendingScheduled(t)).toContain("googleCalendar:revokeGrant");
  });

  test("myConnections shows the sync error", async () => {
    const t = makeBackend();
    const { householdId, connectionId } = await setupSynced(t);
    await t.run(async (ctx) => ctx.db.patch(connectionId, { lastError: "Some events failed" }));
    const mine = await t
      .withIdentity({ subject: "user_a" })
      .query(api.googleCalendar.myConnections, { householdId });
    expect(mine[0]?.lastError).toBe("Some events failed");
  });
});
