// calendarSync.test.ts
// Purpose: Tests for Google Calendar push sync (lib/calendarSync.ts, calendarPush.ts,
// googleCalendar.ts and the hooks in calendar.ts and households.ts). lib/google.ts,
// lib/googleEvent.ts and lib/secretBox.ts are mocked, so Google is never called; the workpool
// component is registered but the clock is faked, so a queued push runs only when a test
// drives it (directly through the internal action, or by draining the pool in the end to end
// test). Covers: queueing and dedupe (queued merges, running goes dirty, one row per key),
// every calendar core queueing for active connections only, the household resync triggers,
// member removal, the push action (create, update, delete, 401 refresh once, revoked, gone,
// non-retryable and retryable errors, paused, non-member, wrong household), the completion
// handler, the OAuth callback (happy path, state and scope failures, Google errors, escaped
// output), connectUrl permissions, myConnections and disconnect.
//
// Last modified: 2026-10-29

import type { WorkId } from "@convex-dev/workpool";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { createHousehold, makeBackend } from "./testing.helpers";
import type { TestConvex } from "./testing.helpers";

const mocks = vi.hoisted(() => ({
  exchangeCode: vi.fn(),
  refreshAccessToken: vi.fn(),
  createSunnyCalendar: vi.fn(),
  calendarExists: vi.fn(),
  upsertEvent: vi.fn(),
  deleteEvent: vi.fn(),
  verifyState: vi.fn(),
  signState: vi.fn(),
}));

vi.mock("./lib/google", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./lib/google")>()),
  exchangeCode: mocks.exchangeCode,
  refreshAccessToken: mocks.refreshAccessToken,
  createSunnyCalendar: mocks.createSunnyCalendar,
  calendarExists: mocks.calendarExists,
  upsertEvent: mocks.upsertEvent,
  deleteEvent: mocks.deleteEvent,
  verifyState: mocks.verifyState,
  signState: mocks.signState,
  consentUrl: (state: string) => `https://consent.test/?state=${state}`,
}));

vi.mock("./lib/googleEvent", () => ({
  eventSyncPayload: (event: { deletedAt?: number; title: string }) => ({
    cancelled: event.deletedAt !== undefined,
    title: event.title,
  }),
  buildGoogleEvent: (p: { title: string }) => ({ summary: p.title }),
  googleEventId: (id: string) => `g${id.toLowerCase()}`,
}));

vi.mock("./lib/secretBox", () => ({
  encryptSecret: async (plain: string) => `box:${plain}`,
  decryptSecret: async (box: string) => box.replace(/^box:/, ""),
}));

const { GoogleAccessRevoked, GoogleApiError } = await import("./lib/google");

let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.useFakeTimers();
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.refreshAccessToken.mockResolvedValue({
    accessToken: "access-1",
    expiresAt: Date.now() + 3_600_000,
  });
  mocks.upsertEvent.mockResolvedValue({ id: "gext1", etag: "etag-1", created: true });
  mocks.deleteEvent.mockResolvedValue(undefined);
  mocks.signState.mockImplementation(
    async (userId: string, householdId: string) => `${userId}~${householdId}`,
  );
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  errorSpy.mockRestore();
  vi.useRealTimers();
});

const FUTURE = "2099-06-01";
const WORK_ID = "work_1" as WorkId;

/**
 * purpose: Insert a Google connection directly.
 * @param t: (TestConvex) Harness.
 * @param householdId: (Id<"households">) Household.
 * @param fields: (object) Overrides for userId, status and calendar id.
 * @return: (Promise<Id<"calendarConnections">>) The connection.
 */
async function addConnection(
  t: TestConvex,
  householdId: Id<"households">,
  fields: { userId?: string; status?: "active" | "revoked" | "error"; calendarId?: string } = {},
): Promise<Id<"calendarConnections">> {
  return await t.run(async (ctx) => {
    return await ctx.db.insert("calendarConnections", {
      householdId,
      userId: fields.userId ?? "user_a",
      provider: "google",
      accountEmail: "anna@example.com",
      externalCalendarId: fields.calendarId ?? "cal1",
      status: fields.status ?? "active",
      refreshToken: "box:refresh-1",
    });
  });
}

/**
 * purpose: Add a caregiver member row directly.
 * @param t: (TestConvex) Harness.
 * @param householdId: (Id<"households">) Household.
 * @param userId: (string) User id.
 * @return: (Promise<void>) Resolves when inserted.
 */
async function addMember(t: TestConvex, householdId: Id<"households">, userId: string) {
  await t.run(async (ctx) => {
    await ctx.db.insert("householdMembers", {
      householdId,
      userId,
      role: "member",
      displayName: userId,
    });
  });
}

/**
 * purpose: Add an event through the public mutation as user_a.
 * @param t: (TestConvex) Harness.
 * @param householdId: (Id<"households">) Household.
 * @param title: (string) Title.
 * @return: (Promise<Id<"events">>) The event id.
 */
async function addEvent(
  t: TestConvex,
  householdId: Id<"households">,
  title = "Dentist",
): Promise<Id<"events">> {
  const event = await t
    .withIdentity({ subject: "user_a" })
    .mutation(api.calendar.addEvent, { householdId, title, onDate: FUTURE, startTime: "10:00" });
  return event.eventId;
}

/**
 * purpose: All calendarSyncs rows.
 * @param t: (TestConvex) Harness.
 * @return: The rows.
 */
async function syncs(t: TestConvex) {
  return await t.run(async (ctx) => await ctx.db.query("calendarSyncs").collect());
}

/**
 * purpose: Set the state of every sync row.
 * @param t: (TestConvex) Harness.
 * @param state: ("queued" | "running") New state.
 * @return: (Promise<void>) Resolves when patched.
 */
async function setSyncState(t: TestConvex, state: "queued" | "running") {
  await t.run(async (ctx) => {
    for (const row of await ctx.db.query("calendarSyncs").collect()) {
      await ctx.db.patch(row._id, { state });
    }
  });
}

/**
 * purpose: Run the push action for the only sync row.
 * @param t: (TestConvex) Harness.
 * @return: The push result.
 */
async function runPush(t: TestConvex) {
  const [row] = await syncs(t);
  return await t.action(internal.calendarPush.push, { syncId: row!._id });
}

/**
 * purpose: A household with user_a as primary, one active connection and one event.
 * @param t: (TestConvex) Harness.
 * @return: (Promise<{ householdId, connectionId, eventId }>) The ids.
 */
async function setup(t: TestConvex) {
  const householdId = await createHousehold(t);
  const connectionId = await addConnection(t, householdId);
  const eventId = await addEvent(t, householdId);
  return { householdId, connectionId, eventId };
}

describe("queueing and dedupe", () => {
  test("adding an event queues one push per active connection", async () => {
    const t = makeBackend();
    const householdId = await createHousehold(t);
    await addMember(t, householdId, "user_b");
    await addConnection(t, householdId);
    await addConnection(t, householdId, { userId: "user_b" });
    await addEvent(t, householdId);
    const rows = await syncs(t);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.state === "queued" && !r.dirty)).toBe(true);
  });

  test("a household without connections queues nothing", async () => {
    const t = makeBackend();
    const householdId = await createHousehold(t);
    await addEvent(t, householdId);
    expect(await syncs(t)).toHaveLength(0);
  });

  test("revoked, error and other-household connections are not queued", async () => {
    const t = makeBackend();
    const householdId = await createHousehold(t);
    await addMember(t, householdId, "user_b");
    await addMember(t, householdId, "user_c");
    await addConnection(t, householdId, { status: "revoked" });
    await addConnection(t, householdId, { userId: "user_b", status: "error" });
    const other = await createHousehold(t, { subject: "user_z" });
    await addConnection(t, other, { userId: "user_z" });
    await addEvent(t, householdId);
    expect(await syncs(t)).toHaveLength(0);
  });

  test("repeat edits while queued merge into one row", async () => {
    const t = makeBackend();
    const { householdId, eventId } = await setup(t);
    const asA = t.withIdentity({ subject: "user_a" });
    for (const title of ["One", "Two", "Three"]) {
      await asA.mutation(api.calendar.updateEvent, { householdId, eventId, changes: { title } });
    }
    const rows = await syncs(t);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ state: "queued", dirty: false });
  });

  test("an edit while running sets dirty and keeps one row", async () => {
    const t = makeBackend();
    const { householdId, eventId } = await setup(t);
    await setSyncState(t, "running");
    const asA = t.withIdentity({ subject: "user_a" });
    await asA.mutation(api.calendar.updateEvent, {
      householdId,
      eventId,
      changes: { title: "New" },
    });
    await asA.mutation(api.calendar.updateEvent, {
      householdId,
      eventId,
      changes: { title: "Newer" },
    });
    const rows = await syncs(t);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ state: "running", dirty: true });
  });

  test("an update that changes nothing queues nothing", async () => {
    const t = makeBackend();
    const { householdId, eventId } = await setup(t);
    await t.run(async (ctx) => {
      for (const row of await ctx.db.query("calendarSyncs").collect()) await ctx.db.delete(row._id);
    });
    await t
      .withIdentity({ subject: "user_a" })
      .mutation(api.calendar.updateEvent, { householdId, eventId, changes: { title: "Dentist" } });
    expect(await syncs(t)).toHaveLength(0);
  });

  test("cancelling an event queues a push", async () => {
    const t = makeBackend();
    const { householdId, eventId } = await setup(t);
    await t.run(async (ctx) => {
      for (const row of await ctx.db.query("calendarSyncs").collect()) await ctx.db.delete(row._id);
    });
    await t
      .withIdentity({ subject: "user_a" })
      .mutation(api.calendar.cancelEvent, { householdId, eventId });
    expect(await syncs(t)).toHaveLength(1);
  });

  test("completion resets a dirty row to queued and deletes a clean one", async () => {
    const t = makeBackend();
    await setup(t);
    const [row] = await syncs(t);
    const done = { kind: "success" as const, returnValue: { outcome: "updated" } };
    const args = { workId: WORK_ID, context: { syncId: row!._id }, result: done };

    await t.run(async (ctx) => ctx.db.patch(row!._id, { state: "running", dirty: true }));
    await t.mutation(internal.calendarPush.onPushComplete, args);
    expect((await syncs(t))[0]).toMatchObject({ state: "queued", dirty: false });

    await t.run(async (ctx) => ctx.db.patch(row!._id, { state: "running" }));
    await t.mutation(internal.calendarPush.onPushComplete, args);
    expect(await syncs(t)).toHaveLength(0);

    // A completion for a row that is already gone is ignored.
    await t.mutation(internal.calendarPush.onPushComplete, args);
  });

  test("a failed or canceled run still finishes the row", async () => {
    const t = makeBackend();
    await setup(t);
    const [row] = await syncs(t);
    await t.mutation(internal.calendarPush.onPushComplete, {
      workId: WORK_ID,
      context: { syncId: row!._id },
      result: { kind: "failed", error: "boom" },
    });
    expect(await syncs(t)).toHaveLength(0);
    expect(errorSpy).toHaveBeenCalled();
  });

  test("a push runs end to end through the workpool", async () => {
    const t = makeBackend();
    await setup(t);
    for (let i = 0; i < 100 && (await syncs(t)).length > 0; i++) {
      let finished = false;
      void t.finishInProgressScheduledFunctions().then(() => {
        finished = true;
      });
      while (!finished) await vi.advanceTimersByTimeAsync(250);
      await vi.advanceTimersByTimeAsync(1_100);
    }
    expect(await syncs(t)).toHaveLength(0);
    expect(mocks.upsertEvent).toHaveBeenCalledTimes(1);
  });
});

describe("household hooks", () => {
  test.each([
    ["timezone", { timezone: "America/Chicago" }],
    ["eventNoticeTime", { eventNoticeTime: "07:30" }],
    ["seniorPreferredName", { seniorPreferredName: "Peggy" }],
  ])("changing %s re-pushes every live event only", async (_label, change) => {
    const t = makeBackend();
    const { householdId } = await setup(t);
    const second = await addEvent(t, householdId, "Lunch");
    const cancelled = await addEvent(t, householdId, "Gone");
    const asA = t.withIdentity({ subject: "user_a" });
    await asA.mutation(api.calendar.cancelEvent, { householdId, eventId: cancelled });
    await t.run(async (ctx) => {
      for (const row of await ctx.db.query("calendarSyncs").collect()) await ctx.db.delete(row._id);
    });
    await asA.mutation(api.households.update, { householdId, ...change });
    const rows = await syncs(t);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.eventId)).toContain(second);
    expect(rows.map((r) => r.eventId)).not.toContain(cancelled);
  });

  test.each([
    ["the same timezone", { timezone: "America/New_York" }],
    ["digestTime", { digestTime: "20:00" }],
    ["shareTranscripts", { shareTranscripts: true }],
    ["the same name", { seniorPreferredName: "Margaret" }],
  ])("%s does not re-push", async (_label, change) => {
    const t = makeBackend();
    const { householdId } = await setup(t);
    await t.run(async (ctx) => {
      for (const row of await ctx.db.query("calendarSyncs").collect()) await ctx.db.delete(row._id);
    });
    await t
      .withIdentity({ subject: "user_a" })
      .mutation(api.households.update, { householdId, ...change });
    expect(await syncs(t)).toHaveLength(0);
  });

  test("removing a member drops only their connections, links and syncs", async () => {
    const t = makeBackend();
    const { householdId, eventId } = await setup(t);
    await addMember(t, householdId, "user_b");
    const bConnection = await addConnection(t, householdId, { userId: "user_b" });
    await t.run(async (ctx) => {
      await ctx.db.insert("calendarEventLinks", {
        eventId,
        connectionId: bConnection,
        externalEventId: "gx",
        syncedAt: 1,
      });
      await ctx.db.insert("calendarSyncs", {
        householdId,
        eventId,
        connectionId: bConnection,
        state: "queued",
        dirty: false,
      });
    });
    await t
      .withIdentity({ subject: "user_a" })
      .mutation(api.households.removeMember, { householdId, userId: "user_b" });
    const left = await t.run(async (ctx) => ({
      connections: await ctx.db.query("calendarConnections").collect(),
      links: await ctx.db.query("calendarEventLinks").collect(),
      syncs: await ctx.db.query("calendarSyncs").collect(),
    }));
    expect(left.connections.map((c) => c.userId)).toEqual(["user_a"]);
    expect(left.links).toHaveLength(0);
    expect(left.syncs.map((s) => s.connectionId)).not.toContain(bConnection);
    expect(left.syncs).toHaveLength(1);
  });
});

describe("push action", () => {
  test("creates the event, records the link and lastSyncedAt", async () => {
    const t = makeBackend();
    const { connectionId, eventId } = await setup(t);
    expect(await runPush(t)).toEqual({ outcome: "created" });
    expect(mocks.refreshAccessToken).toHaveBeenCalledWith("refresh-1");
    expect(mocks.upsertEvent).toHaveBeenCalledWith(
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
    await setup(t);
    await runPush(t);
    mocks.upsertEvent.mockResolvedValue({ id: "gext1", etag: "etag-2", created: false });
    expect(await runPush(t)).toEqual({ outcome: "updated" });
    const links = await t.run(async (ctx) => await ctx.db.query("calendarEventLinks").collect());
    expect(links).toHaveLength(1);
    expect(links[0]?.etag).toBe("etag-2");
  });

  test("deleting a cancelled event removes it from Google and drops the link", async () => {
    const t = makeBackend();
    const { householdId, eventId } = await setup(t);
    await runPush(t);
    await t
      .withIdentity({ subject: "user_a" })
      .mutation(api.calendar.cancelEvent, { householdId, eventId });
    expect(await runPush(t)).toEqual({ outcome: "deleted" });
    expect(mocks.deleteEvent).toHaveBeenCalledWith("access-1", "cal1", "gext1");
    expect(
      await t.run(async (ctx) => await ctx.db.query("calendarEventLinks").collect()),
    ).toHaveLength(0);
  });

  test("deleting an unlinked cancelled event uses the derived Google id", async () => {
    const t = makeBackend();
    const { householdId, eventId } = await setup(t);
    await t
      .withIdentity({ subject: "user_a" })
      .mutation(api.calendar.cancelEvent, { householdId, eventId });
    expect(await runPush(t)).toEqual({ outcome: "deleted" });
    expect(mocks.deleteEvent).toHaveBeenCalledWith("access-1", "cal1", `g${eventId.toLowerCase()}`);
  });

  test("a 401 refreshes the token once and retries", async () => {
    const t = makeBackend();
    await setup(t);
    mocks.refreshAccessToken
      .mockResolvedValueOnce({ accessToken: "stale", expiresAt: Date.now() + 3_600_000 })
      .mockResolvedValueOnce({ accessToken: "fresh", expiresAt: Date.now() + 3_600_000 });
    mocks.upsertEvent
      .mockRejectedValueOnce(new GoogleApiError("unauthorized", 401))
      .mockResolvedValueOnce({ id: "gext1", etag: "e", created: true });
    expect(await runPush(t)).toEqual({ outcome: "created" });
    expect(mocks.refreshAccessToken).toHaveBeenCalledTimes(2);
    expect(mocks.upsertEvent.mock.calls.map((c) => c[0])).toEqual(["stale", "fresh"]);
  });

  test("a second 401 is thrown so the workpool retries", async () => {
    const t = makeBackend();
    await setup(t);
    mocks.upsertEvent.mockRejectedValue(new GoogleApiError("unauthorized", 401));
    await expect(runPush(t)).rejects.toThrow("unauthorized");
    expect(mocks.refreshAccessToken).toHaveBeenCalledTimes(2);
  });

  test("revoked access marks the connection revoked with a readable error", async () => {
    const t = makeBackend();
    const { connectionId } = await setup(t);
    mocks.refreshAccessToken.mockRejectedValue(new GoogleAccessRevoked("invalid_grant"));
    expect(await runPush(t)).toEqual({ outcome: "revoked" });
    const connection = await t.run(async (ctx) => await ctx.db.get(connectionId));
    expect(connection).toMatchObject({
      status: "revoked",
      error: "Google access was revoked; reconnect Google Calendar.",
    });
  });

  test("a deleted Sunny calendar marks the connection in error", async () => {
    const t = makeBackend();
    const { connectionId } = await setup(t);
    mocks.upsertEvent.mockRejectedValue(new GoogleApiError("not found", 404, false, true));
    expect(await runPush(t)).toEqual({ outcome: "calendar_missing" });
    const connection = await t.run(async (ctx) => await ctx.db.get(connectionId));
    expect(connection).toMatchObject({
      status: "error",
      error: "The Sunny calendar was deleted in Google; reconnect.",
    });
  });

  test("a non-retryable Google error ends quietly and logs the reason", async () => {
    const t = makeBackend();
    const { connectionId } = await setup(t);
    mocks.upsertEvent.mockRejectedValue(new GoogleApiError("bad request", 400, false));
    expect(await runPush(t)).toEqual({ outcome: "failed", reason: "bad request" });
    expect(errorSpy).toHaveBeenCalled();
    expect((await t.run(async (ctx) => await ctx.db.get(connectionId)))?.status).toBe("active");
  });

  test("a retryable Google error is thrown so the workpool retries", async () => {
    const t = makeBackend();
    await setup(t);
    mocks.upsertEvent.mockRejectedValue(new GoogleApiError("unavailable", 503, true));
    await expect(runPush(t)).rejects.toThrow("unavailable");
  });

  test("a paused household defers without calling Google, then re-queues", async () => {
    const t = makeBackend();
    const { householdId } = await setup(t);
    await t
      .withIdentity({ subject: "user_a" })
      .mutation(api.households.update, { householdId, backgroundPaused: true });
    const result = await runPush(t);
    expect(result).toEqual({ outcome: "paused" });
    expect(mocks.refreshAccessToken).not.toHaveBeenCalled();
    const [row] = await syncs(t);
    await t.mutation(internal.calendarPush.onPushComplete, {
      workId: WORK_ID,
      context: { syncId: row!._id },
      result: { kind: "success", returnValue: result },
    });
    expect(await syncs(t)).toHaveLength(1);
    expect((await syncs(t))[0]).toMatchObject({ state: "queued", dirty: false });
  });

  test("a connection whose caregiver is no longer a member is skipped", async () => {
    const t = makeBackend();
    await setup(t);
    await t.run(async (ctx) => {
      const member = await ctx.db.query("householdMembers").first();
      await ctx.db.delete(member!._id);
    });
    expect(await runPush(t)).toMatchObject({ outcome: "skipped" });
    expect(mocks.refreshAccessToken).not.toHaveBeenCalled();
  });

  test("an inactive connection is skipped", async () => {
    const t = makeBackend();
    const { connectionId } = await setup(t);
    await t.run(async (ctx) => ctx.db.patch(connectionId, { status: "revoked" }));
    expect(await runPush(t)).toMatchObject({ outcome: "skipped", reason: "connection not active" });
  });

  test("a sync row from another household than the connection is skipped", async () => {
    const t = makeBackend();
    await setup(t);
    const other = await createHousehold(t, { subject: "user_z" });
    const [row] = await syncs(t);
    await t.run(async (ctx) => ctx.db.patch(row!._id, { householdId: other }));
    expect(await runPush(t)).toMatchObject({ outcome: "skipped" });
    expect(mocks.upsertEvent).not.toHaveBeenCalled();
  });

  test("a row that was removed before the push started is skipped", async () => {
    const t = makeBackend();
    await setup(t);
    const [row] = await syncs(t);
    await t.run(async (ctx) => ctx.db.delete(row!._id));
    expect(await t.action(internal.calendarPush.push, { syncId: row!._id })).toMatchObject({
      outcome: "skipped",
    });
  });
});

describe("OAuth callback", () => {
  /**
   * purpose: Set up the mocks for a successful callback and return the household.
   * @param t: (TestConvex) Harness.
   * @param seniorName: (string) The household's senior name.
   * @return: The household id.
   */
  async function readyHousehold(t: TestConvex, seniorName = "Margaret") {
    const householdId = await createHousehold(t, { seniorName });
    mocks.verifyState.mockImplementation(async (state: string) =>
      state === "good" ? { userId: "user_a", householdId } : null,
    );
    mocks.exchangeCode.mockResolvedValue({
      accessToken: "acc",
      refreshToken: "refresh-new",
      scopes: ["https://www.googleapis.com/auth/calendar.app.created"],
      email: "anna@example.com",
    });
    mocks.createSunnyCalendar.mockResolvedValue("cal-new");
    return householdId;
  }

  test("saves an encrypted connection and queues every live event and linked cancelled one", async () => {
    const t = makeBackend();
    const householdId = await readyHousehold(t);
    const live = await addEvent(t, householdId, "Live");
    const unlinkedCancelled = await addEvent(t, householdId, "Cancelled, never synced");
    const linkedCancelled = await addEvent(t, householdId, "Cancelled, synced");
    const asA = t.withIdentity({ subject: "user_a" });
    await asA.mutation(api.calendar.cancelEvent, { householdId, eventId: unlinkedCancelled });
    await asA.mutation(api.calendar.cancelEvent, { householdId, eventId: linkedCancelled });

    const res = await t.fetch("/google/callback?code=c1&state=good");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Google Calendar connected");
    expect(mocks.createSunnyCalendar).toHaveBeenCalledWith("acc", "Margaret", "America/New_York");

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
    // Both cancelled events are unlinked, so only the live one is queued.
    expect((await syncs(t)).map((s) => s.eventId)).toEqual([live]);

    // Link one cancelled event, then connect again: it is queued too.
    await t.run(async (ctx) =>
      ctx.db.insert("calendarEventLinks", {
        eventId: linkedCancelled,
        connectionId: connection!._id,
        externalEventId: "gx",
        syncedAt: 1,
      }),
    );
    mocks.calendarExists.mockResolvedValue(true);
    await t.fetch("/google/callback?code=c2&state=good");
    const queued = (await syncs(t)).map((s) => s.eventId).sort();
    expect(queued).toEqual([live, linkedCancelled].sort());
    expect(mocks.createSunnyCalendar).toHaveBeenCalledTimes(1);
  });

  test("reuses the existing calendar when it still exists and keeps the links", async () => {
    const t = makeBackend();
    const householdId = await readyHousehold(t);
    const connectionId = await addConnection(t, householdId, {
      status: "revoked",
      calendarId: "cal-old",
    });
    const eventId = await addEvent(t, householdId);
    await t.run(async (ctx) =>
      ctx.db.insert("calendarEventLinks", {
        eventId,
        connectionId,
        externalEventId: "gx",
        syncedAt: 1,
      }),
    );
    mocks.calendarExists.mockResolvedValue(true);
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
    expect(mocks.createSunnyCalendar).not.toHaveBeenCalled();
  });

  test("creates a new calendar and drops old links when the old one is gone", async () => {
    const t = makeBackend();
    const householdId = await readyHousehold(t);
    const connectionId = await addConnection(t, householdId, { calendarId: "cal-old" });
    const eventId = await addEvent(t, householdId);
    await t.run(async (ctx) =>
      ctx.db.insert("calendarEventLinks", {
        eventId,
        connectionId,
        externalEventId: "gx",
        syncedAt: 1,
      }),
    );
    mocks.calendarExists.mockResolvedValue(false);
    await t.fetch("/google/callback?code=c&state=good");
    const state = await t.run(async (ctx) => ({
      connection: await ctx.db.get(connectionId),
      links: await ctx.db.query("calendarEventLinks").collect(),
    }));
    expect(state.connection?.externalCalendarId).toBe("cal-new");
    expect(state.links).toHaveLength(0);
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
    expect(mocks.exchangeCode).not.toHaveBeenCalled();
  });

  test("a grant without the calendar scope is refused", async () => {
    const t = makeBackend();
    await readyHousehold(t);
    mocks.exchangeCode.mockResolvedValue({
      accessToken: "acc",
      refreshToken: "r",
      scopes: ["openid"],
      email: null,
    });
    const res = await t.fetch("/google/callback?code=c&state=good");
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("Permission needed");
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
    mocks.exchangeCode.mockRejectedValue(new Error("secret detail"));
    const res = await t.fetch("/google/callback?code=c&state=good");
    expect(res.status).toBe(500);
    const body = await res.text();
    expect(body).toContain("Something went wrong");
    expect(body).not.toContain("secret detail");
  });

  test("a caregiver who left the household is refused", async () => {
    const t = makeBackend();
    const householdId = await readyHousehold(t);
    mocks.verifyState.mockResolvedValue({ userId: "user_gone", householdId });
    const res = await t.fetch("/google/callback?code=c&state=good");
    expect(res.status).toBe(403);
    expect(mocks.createSunnyCalendar).not.toHaveBeenCalled();
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
    expect(url).toBe(`https://consent.test/?state=user_a~${householdId}`);
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
      ["accountEmail", "error", "id", "lastSyncedAt", "status"].sort(),
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
    const { connectionId, eventId } = await setup(t);
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
