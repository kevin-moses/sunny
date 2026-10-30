// calendarPush.test.ts
// Purpose: Tests for the push action (calendarPush.ts). Google is mocked
// (googleMocks.helpers.ts); the action runs directly through t.action. Covers: create, update
// and delete paths and the link and lastSyncedAt records; the access token cache (stored
// encrypted with its expiry, reused while valid, refreshed within 60 seconds of expiry,
// refreshed once per burst of pushes, refreshed after a 401 and then rethrown on a second 401,
// cleared on revoke and reconnect); revoked and deleted-calendar handling; non-retryable errors
// ending quietly and retryable ones thrown; a paused household, an inactive connection, a
// caregiver who left, another household's event and a removed row each ending without calling
// Google.
//
// Last modified: 2026-10-29

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { googleMocks, resetGoogleMocks } from "./googleMocks.helpers";
import {
  addCalendarEvent,
  createHousehold,
  makeBackend,
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

const { GoogleAccessRevoked, GoogleApiError } = await import("./lib/google");
const { ConfigError } = await import("./lib/errors");

let errorSpy: ReturnType<typeof vi.spyOn>;
let logSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.useFakeTimers();
  resetGoogleMocks();
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
  logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
});

afterEach(() => {
  errorSpy.mockRestore();
  logSpy.mockRestore();
  vi.useRealTimers();
});

/**
 * purpose: Run the push action for the first sync row.
 * @param t: (TestConvex) Harness.
 * @return: The push outcome.
 */
async function runPush(t: TestConvex) {
  const [row] = await syncRows(t);
  return await t.action(internal.calendarPush.push, { syncId: row!._id });
}

/**
 * purpose: Read a connection row.
 * @param t: (TestConvex) Harness.
 * @param id: (Id<"calendarConnections">) The connection id.
 * @return: The row.
 */
async function connectionRow(t: TestConvex, id: Id<"calendarConnections">) {
  return await t.run(async (ctx) => await ctx.db.get(id));
}

describe("event paths", () => {
  test("creates the event, records the link and lastSyncedAt", async () => {
    const t = makeBackend();
    const { connectionId, eventId } = await setupSynced(t);
    expect(await runPush(t)).toBe("created");
    expect(googleMocks.refreshAccessToken).toHaveBeenCalledWith("refresh-1");
    expect(googleMocks.upsertEvent).toHaveBeenCalledWith(
      "access-1",
      "cal1",
      `g${eventId.toLowerCase()}`,
      { summary: "Dentist" },
    );
    const state = await t.run(async (ctx) => ({
      links: await ctx.db.query("calendarEventLinks").collect(),
      connection: await ctx.db.get(connectionId),
      sync: (await ctx.db.query("calendarSyncs").collect())[0],
    }));
    expect(state.links).toHaveLength(1);
    expect(state.links[0]).toMatchObject({ externalEventId: "gext1", etag: "etag-1", eventId });
    expect(state.connection?.lastSyncedAt).toBeTypeOf("number");
    expect(state.sync?.state).toBe("running");
  });

  test("updating a linked event replaces the link in place", async () => {
    const t = makeBackend();
    await setupSynced(t);
    await runPush(t);
    googleMocks.upsertEvent.mockResolvedValue({ id: "gext1", etag: "etag-2", created: false });
    expect(await runPush(t)).toBe("updated");
    const links = await t.run(async (ctx) => await ctx.db.query("calendarEventLinks").collect());
    expect(links).toHaveLength(1);
    expect(links[0]?.etag).toBe("etag-2");
  });

  test("deleting a cancelled event removes it from Google and drops the link", async () => {
    const t = makeBackend();
    const { householdId, eventId } = await setupSynced(t);
    await runPush(t);
    await t
      .withIdentity({ subject: "user_a" })
      .mutation(api.calendar.cancelEvent, { householdId, eventId });
    expect(await runPush(t)).toBe("deleted");
    expect(googleMocks.deleteEvent).toHaveBeenCalledWith("access-1", "cal1", "gext1");
    expect(
      await t.run(async (ctx) => await ctx.db.query("calendarEventLinks").collect()),
    ).toHaveLength(0);
  });

  test("deleting an unlinked cancelled event uses the derived Google id", async () => {
    const t = makeBackend();
    const { householdId, eventId } = await setupSynced(t);
    await t
      .withIdentity({ subject: "user_a" })
      .mutation(api.calendar.cancelEvent, { householdId, eventId });
    expect(await runPush(t)).toBe("deleted");
    expect(googleMocks.deleteEvent).toHaveBeenCalledWith(
      "access-1",
      "cal1",
      `g${eventId.toLowerCase()}`,
    );
  });
});

describe("access token cache", () => {
  test("a refreshed token is stored encrypted with its expiry", async () => {
    const t = makeBackend();
    const { connectionId } = await setupSynced(t);
    await runPush(t);
    const connection = await connectionRow(t, connectionId);
    expect(connection).toMatchObject({
      accessToken: "box:access-1",
      accessTokenExpiresAt: Date.now() + 3_600_000,
    });
  });

  test("a burst of pushes refreshes once", async () => {
    const t = makeBackend();
    const { householdId } = await setupSynced(t);
    for (const title of ["B", "C", "D"]) await addCalendarEvent(t, householdId, title);
    for (const row of await syncRows(t)) {
      await t.action(internal.calendarPush.push, { syncId: row._id });
    }
    expect(googleMocks.upsertEvent).toHaveBeenCalledTimes(4);
    expect(googleMocks.refreshAccessToken).toHaveBeenCalledTimes(1);
  });

  test("a token within 60 seconds of expiry is refreshed", async () => {
    const t = makeBackend();
    const { connectionId } = await setupSynced(t);
    await t.run(async (ctx) =>
      ctx.db.patch(connectionId, {
        accessToken: "box:old",
        accessTokenExpiresAt: Date.now() + 59_000,
      }),
    );
    await runPush(t);
    expect(googleMocks.refreshAccessToken).toHaveBeenCalledTimes(1);
    expect(googleMocks.upsertEvent.mock.calls[0]?.[0]).toBe("access-1");
  });

  test("a stored token that is still valid is used without refreshing", async () => {
    const t = makeBackend();
    const { connectionId } = await setupSynced(t);
    await t.run(async (ctx) =>
      ctx.db.patch(connectionId, {
        accessToken: "box:cached",
        accessTokenExpiresAt: Date.now() + 600_000,
      }),
    );
    await runPush(t);
    expect(googleMocks.refreshAccessToken).not.toHaveBeenCalled();
    expect(googleMocks.upsertEvent.mock.calls[0]?.[0]).toBe("cached");
  });

  test("a 401 refreshes the token once, stores the new one and retries", async () => {
    const t = makeBackend();
    const { connectionId } = await setupSynced(t);
    await t.run(async (ctx) =>
      ctx.db.patch(connectionId, {
        accessToken: "box:stale",
        accessTokenExpiresAt: Date.now() + 600_000,
      }),
    );
    googleMocks.upsertEvent
      .mockRejectedValueOnce(new GoogleApiError(401, "unauthorized"))
      .mockResolvedValueOnce({ id: "gext1", etag: "e", created: true });
    expect(await runPush(t)).toBe("created");
    expect(googleMocks.refreshAccessToken).toHaveBeenCalledTimes(1);
    expect(googleMocks.upsertEvent.mock.calls.map((c) => c[0])).toEqual(["stale", "access-1"]);
    expect((await connectionRow(t, connectionId))?.accessToken).toBe("box:access-1");
  });

  test("a second 401 is thrown so the workpool retries", async () => {
    const t = makeBackend();
    await setupSynced(t);
    googleMocks.upsertEvent.mockRejectedValue(new GoogleApiError(401, "unauthorized"));
    await expect(runPush(t)).rejects.toThrow("unauthorized");
    expect(googleMocks.refreshAccessToken).toHaveBeenCalledTimes(2);
  });

  test("revoked access marks the connection revoked and clears the token", async () => {
    const t = makeBackend();
    const { connectionId } = await setupSynced(t);
    await t.run(async (ctx) =>
      ctx.db.patch(connectionId, { accessToken: "box:stale", accessTokenExpiresAt: 1 }),
    );
    googleMocks.refreshAccessToken.mockRejectedValue(new GoogleAccessRevoked("invalid_grant"));
    expect(await runPush(t)).toBe("revoked");
    const connection = await connectionRow(t, connectionId);
    expect(connection).toMatchObject({
      status: "revoked",
      error: "Google access was revoked; reconnect Google Calendar.",
    });
    expect(connection?.accessToken).toBeUndefined();
    expect(connection?.accessTokenExpiresAt).toBeUndefined();
  });
});

describe("errors", () => {
  test("a confirmed missing Sunny calendar marks the connection in error", async () => {
    const t = makeBackend();
    const { connectionId } = await setupSynced(t);
    googleMocks.upsertEvent.mockRejectedValue(new GoogleApiError(404, "not found"));
    googleMocks.calendarExists.mockResolvedValue(false);
    expect(await runPush(t)).toBe("calendar_missing");
    expect(googleMocks.calendarExists).toHaveBeenCalledWith("access-1", "cal1");
    expect(await connectionRow(t, connectionId)).toMatchObject({
      status: "error",
      error: "The Sunny calendar was deleted in Google; reconnect.",
    });
  });

  test("a 404 for one event in an existing calendar does not disable the connection", async () => {
    const t = makeBackend();
    const { connectionId } = await setupSynced(t);
    googleMocks.upsertEvent.mockRejectedValue(new GoogleApiError(404, "event not found"));
    googleMocks.calendarExists.mockResolvedValue(true);
    expect(await runPush(t)).toBe("failed");
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("event not found"));
    expect((await connectionRow(t, connectionId))?.status).toBe("active");
  });

  test("a permanent 403 marks the connection in error without retrying", async () => {
    const t = makeBackend();
    const { connectionId } = await setupSynced(t);
    googleMocks.upsertEvent.mockRejectedValue(new GoogleApiError(403, "forbidden"));
    expect(await runPush(t)).toBe("failed");
    expect(await connectionRow(t, connectionId)).toMatchObject({
      status: "error",
      error: "Google denied Sunny access to the Sunny calendar; reconnect Google Calendar.",
    });
  });

  test("a rate limit 403 is thrown so the workpool retries", async () => {
    const t = makeBackend();
    await setupSynced(t);
    googleMocks.upsertEvent.mockRejectedValue(new GoogleApiError(403, "rateLimitExceeded"));
    await expect(runPush(t)).rejects.toThrow("rateLimitExceeded");
  });

  test("an unreadable refresh token marks the connection in error without retrying", async () => {
    const t = makeBackend();
    const { connectionId } = await setupSynced(t);
    await t.run(async (ctx) => ctx.db.patch(connectionId, { refreshToken: "not-a-box" }));
    expect(await runPush(t)).toBe("failed");
    expect(await connectionRow(t, connectionId)).toMatchObject({
      status: "error",
      error: "Reconnect Google Calendar: Sunny could not read the saved Google sign-in.",
    });
    expect(googleMocks.upsertEvent).not.toHaveBeenCalled();
  });

  test("an unreadable stored access token is replaced by a refresh", async () => {
    const t = makeBackend();
    const { connectionId } = await setupSynced(t);
    await t.run(async (ctx) =>
      ctx.db.patch(connectionId, {
        accessToken: "garbage",
        accessTokenExpiresAt: Date.now() + 600_000,
      }),
    );
    expect(await runPush(t)).toBe("created");
    expect(googleMocks.refreshAccessToken).toHaveBeenCalledTimes(1);
  });

  test("a configuration error is not retried (workpool NonRetryableError)", async () => {
    const t = makeBackend();
    await setupSynced(t);
    googleMocks.refreshAccessToken.mockRejectedValue(
      new ConfigError("Missing env var GOOGLE_CLIENT_ID"),
    );
    const failure = await runPush(t).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(Error);
    expect(String((failure as Error).message)).toContain("Missing env var GOOGLE_CLIENT_ID");
    expect(JSON.stringify((failure as { data?: unknown }).data ?? "")).toContain(
      "__convexWorkpoolNonRetryable",
    );
  });

  test("a successful push clears the connection's sync error", async () => {
    const t = makeBackend();
    const { connectionId } = await setupSynced(t);
    await t.run(async (ctx) => ctx.db.patch(connectionId, { lastError: "Some events failed" }));
    await runPush(t);
    expect((await connectionRow(t, connectionId))?.lastError).toBeUndefined();
  });

  test("a non-retryable Google error ends quietly and logs the reason", async () => {
    const t = makeBackend();
    const { connectionId } = await setupSynced(t);
    googleMocks.upsertEvent.mockRejectedValue(new GoogleApiError(400, "bad request"));
    expect(await runPush(t)).toBe("failed");
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("bad request"));
    expect((await connectionRow(t, connectionId))?.status).toBe("active");
  });

  test("a retryable Google error is thrown so the workpool retries", async () => {
    const t = makeBackend();
    await setupSynced(t);
    googleMocks.upsertEvent.mockRejectedValue(new GoogleApiError(503, "unavailable"));
    await expect(runPush(t)).rejects.toThrow("unavailable");
  });
});

describe("skips", () => {
  test("a paused household never reaches Google and its row is removed on completion", async () => {
    const t = makeBackend();
    const { householdId } = await setupSynced(t);
    await t
      .withIdentity({ subject: "user_a" })
      .mutation(api.households.update, { householdId, backgroundPaused: true });
    const [row] = await syncRows(t);
    expect(await runPush(t)).toBe("skipped");
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("household paused"));
    expect(googleMocks.refreshAccessToken).not.toHaveBeenCalled();
    expect(googleMocks.upsertEvent).not.toHaveBeenCalled();
    await t.mutation(internal.calendarPush.onPushComplete, {
      workId: "w" as never,
      context: { syncId: row!._id },
      result: { kind: "success", returnValue: "skipped" },
    });
    expect(await syncRows(t)).toHaveLength(0);
  });

  test("a connection whose caregiver is no longer a member is skipped", async () => {
    const t = makeBackend();
    await setupSynced(t);
    await t.run(async (ctx) => {
      const member = await ctx.db.query("householdMembers").first();
      await ctx.db.delete(member!._id);
    });
    expect(await runPush(t)).toBe("skipped");
    expect(googleMocks.refreshAccessToken).not.toHaveBeenCalled();
  });

  test("an inactive connection is skipped", async () => {
    const t = makeBackend();
    const { connectionId } = await setupSynced(t);
    await t.run(async (ctx) => ctx.db.patch(connectionId, { status: "revoked" }));
    expect(await runPush(t)).toBe("skipped");
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("connection not active"));
  });

  test("an event of another household than the connection is skipped", async () => {
    const t = makeBackend();
    await setupSynced(t);
    const other = await createHousehold(t, { subject: "user_z" });
    const foreignEvent = await t
      .withIdentity({ subject: "user_z" })
      .mutation(api.calendar.addEvent, {
        householdId: other,
        title: "Other",
        onDate: "2099-06-01",
        startTime: "10:00",
      });
    const [row] = await syncRows(t);
    await t.run(async (ctx) => ctx.db.patch(row!._id, { eventId: foreignEvent.eventId }));
    expect(await runPush(t)).toBe("skipped");
    expect(googleMocks.upsertEvent).not.toHaveBeenCalled();
  });

  test("a row that was removed before the push started is skipped", async () => {
    const t = makeBackend();
    await setupSynced(t);
    const [row] = await syncRows(t);
    await t.run(async (ctx) => ctx.db.delete(row!._id));
    expect(await t.action(internal.calendarPush.push, { syncId: row!._id })).toBe("skipped");
  });
});
