// calendarQueue.test.ts
// Purpose: Tests for queueing Google Calendar pushes (lib/calendarSync.ts and the hooks in
// calendar.ts and households.ts). Google is mocked (googleMocks.helpers.ts) and the clock is
// faked, so a queued push runs only when a test drives it. Covers: one push per active
// connection, no push without one, revoked/error/other-household connections ignored, repeat
// edits merging while queued, an edit while running going dirty, no-change updates, cancels,
// the completion handler (dirty -> queued again, clean -> deleted), a push running end to end
// through the workpool, the household resync (only the timezone, event notice time and
// senior's name, plus resuming from pause, and including still-linked cancelled events), and
// member removal dropping connections, links and syncs.
//
// Last modified: 2026-10-29

import type { WorkId } from "@convex-dev/workpool";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import { googleMocks, resetGoogleMocks } from "./googleMocks.helpers";
import {
  addCalendarEvent,
  addConnection,
  addMember,
  clearSyncs,
  createHousehold,
  insertEvent,
  makeBackend,
  pendingScheduled,
  runFanOut,
  setupSynced,
  syncRows,
} from "./testing.helpers";

vi.mock("./lib/google", async (original) =>
  (await import("./googleMocks.helpers")).googleMock(await original()),
);
vi.mock("./lib/googleEvent", async () => (await import("./googleMocks.helpers")).googleEventMock);
vi.mock("./lib/secretBox", async (original) =>
  (await import("./googleMocks.helpers")).secretBoxMock(await original()),
);

const WORK_ID = "work_1" as WorkId;

beforeEach(() => {
  vi.useFakeTimers();
  resetGoogleMocks();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("queueing and dedupe", () => {
  test("adding an event queues one push per active connection", async () => {
    const t = makeBackend();
    const householdId = await createHousehold(t);
    await addMember(t, householdId, "user_b");
    await addConnection(t, householdId);
    await addConnection(t, householdId, { userId: "user_b" });
    await addCalendarEvent(t, householdId);
    const rows = await syncRows(t);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.state === "queued")).toBe(true);
  });

  test("a household without connections queues nothing", async () => {
    const t = makeBackend();
    const householdId = await createHousehold(t);
    await addCalendarEvent(t, householdId);
    expect(await syncRows(t)).toHaveLength(0);
  });

  test("revoked, error and other-household connections are not queued", async () => {
    const t = makeBackend();
    const householdId = await createHousehold(t);
    await addMember(t, householdId, "user_b");
    await addConnection(t, householdId, { status: "revoked" });
    await addConnection(t, householdId, { userId: "user_b", status: "error" });
    const other = await createHousehold(t, { subject: "user_z" });
    await addConnection(t, other, { userId: "user_z" });
    await addCalendarEvent(t, householdId);
    expect(await syncRows(t)).toHaveLength(0);
  });

  test("repeat edits while queued merge into one row", async () => {
    const t = makeBackend();
    const { householdId, eventId } = await setupSynced(t);
    const asA = t.withIdentity({ subject: "user_a" });
    for (const title of ["One", "Two", "Three"]) {
      await asA.mutation(api.calendar.updateEvent, { householdId, eventId, changes: { title } });
    }
    const rows = await syncRows(t);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.state).toBe("queued");
  });

  test("an edit while running makes the row dirty and keeps one row", async () => {
    const t = makeBackend();
    const { householdId, eventId } = await setupSynced(t);
    await t.run(async (ctx) => {
      for (const row of await ctx.db.query("calendarSyncs").collect()) {
        await ctx.db.patch(row._id, { state: "running" });
      }
    });
    const asA = t.withIdentity({ subject: "user_a" });
    await asA.mutation(api.calendar.updateEvent, { householdId, eventId, changes: { title: "A" } });
    await asA.mutation(api.calendar.updateEvent, { householdId, eventId, changes: { title: "B" } });
    const rows = await syncRows(t);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.state).toBe("dirty");
  });

  test("an update that changes nothing queues nothing", async () => {
    const t = makeBackend();
    const { householdId, eventId } = await setupSynced(t);
    await clearSyncs(t);
    await t
      .withIdentity({ subject: "user_a" })
      .mutation(api.calendar.updateEvent, { householdId, eventId, changes: { title: "Dentist" } });
    expect(await syncRows(t)).toHaveLength(0);
  });

  test("cancelling an event queues a push", async () => {
    const t = makeBackend();
    const { householdId, eventId } = await setupSynced(t);
    await clearSyncs(t);
    await t
      .withIdentity({ subject: "user_a" })
      .mutation(api.calendar.cancelEvent, { householdId, eventId });
    expect(await syncRows(t)).toHaveLength(1);
  });

  test("completion resets a dirty row to queued and deletes a clean one", async () => {
    const t = makeBackend();
    await setupSynced(t);
    const [row] = await syncRows(t);
    const args = {
      workId: WORK_ID,
      context: { syncId: row!._id },
      result: { kind: "success" as const, returnValue: "updated" },
    };

    await t.run(async (ctx) => ctx.db.patch(row!._id, { state: "dirty" }));
    await t.mutation(internal.calendarPush.onPushComplete, args);
    expect((await syncRows(t))[0]?.state).toBe("queued");

    await t.run(async (ctx) => ctx.db.patch(row!._id, { state: "running" }));
    await t.mutation(internal.calendarPush.onPushComplete, args);
    expect(await syncRows(t)).toHaveLength(0);

    // A completion for a row that is already gone is ignored.
    await t.mutation(internal.calendarPush.onPushComplete, args);
  });

  test("a failed run records a caregiver-safe error and retries once after a delay", async () => {
    const t = makeBackend();
    const { connectionId } = await setupSynced(t);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const [row] = await syncRows(t);
    const failed = {
      workId: WORK_ID,
      context: { syncId: row!._id },
      result: { kind: "failed" as const, error: "boom" },
    };
    await t.mutation(internal.calendarPush.onPushComplete, failed);
    expect((await syncRows(t))[0]).toMatchObject({ state: "queued", failures: 1 });
    const connection = await t.run(async (ctx) => await ctx.db.get(connectionId));
    expect(connection?.lastError).toBe(
      "Some events could not be synced to Google; Sunny will retry.",
    );

    // Failing again after the extra attempt drops the row.
    await t.mutation(internal.calendarPush.onPushComplete, failed);
    expect(await syncRows(t)).toHaveLength(0);
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  test("a failed extra attempt keeps the row when the event changed meanwhile", async () => {
    const t = makeBackend();
    await setupSynced(t);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const [row] = await syncRows(t);
    await t.run(async (ctx) => ctx.db.patch(row!._id, { state: "dirty", failures: 1 }));
    await t.mutation(internal.calendarPush.onPushComplete, {
      workId: WORK_ID,
      context: { syncId: row!._id },
      result: { kind: "failed", error: "boom" },
    });
    expect((await syncRows(t))[0]).toMatchObject({ state: "queued" });
    expect((await syncRows(t))[0]?.failures).toBeUndefined();
    errorSpy.mockRestore();
  });

  test("a push runs end to end through the workpool", async () => {
    const t = makeBackend();
    await setupSynced(t);
    for (let i = 0; i < 100 && (await syncRows(t)).length > 0; i++) {
      let finished = false;
      void t.finishInProgressScheduledFunctions().then(() => {
        finished = true;
      });
      while (!finished) await vi.advanceTimersByTimeAsync(250);
      await vi.advanceTimersByTimeAsync(1_100);
    }
    expect(await syncRows(t)).toHaveLength(0);
    expect(googleMocks.upsertEvent).toHaveBeenCalledTimes(1);
  });
});

describe("household hooks", () => {
  test.each([
    ["timezone", { timezone: "America/Chicago" }],
    ["eventNoticeTime", { eventNoticeTime: "07:30" }],
    ["seniorPreferredName", { seniorPreferredName: "Peggy" }],
  ])("changing %s schedules a resync instead of queueing inline", async (_label, change) => {
    const t = makeBackend();
    const { householdId } = await setupSynced(t);
    await clearSyncs(t);
    await t
      .withIdentity({ subject: "user_a" })
      .mutation(api.households.update, { householdId, ...change });
    expect(await syncRows(t)).toHaveLength(0);
    expect(await pendingScheduled(t)).toContain("calendarFanOut:chunk");
  });

  test.each([
    ["the same timezone", { timezone: "America/New_York" }],
    ["digestTime", { digestTime: "20:00" }],
    ["shareTranscripts", { shareTranscripts: true }],
    ["the same name", { seniorPreferredName: "Margaret" }],
    ["pausing", { backgroundPaused: true }],
  ])("%s schedules nothing", async (_label, change) => {
    const t = makeBackend();
    const { householdId } = await setupSynced(t);
    await t
      .withIdentity({ subject: "user_a" })
      .mutation(api.households.update, { householdId, ...change });
    expect(await pendingScheduled(t)).not.toContain("calendarFanOut:chunk");
  });

  test("resuming from pause schedules a resync; resuming again does not", async () => {
    const t = makeBackend();
    const { householdId } = await setupSynced(t);
    const asA = t.withIdentity({ subject: "user_a" });
    await asA.mutation(api.households.update, { householdId, backgroundPaused: true });
    expect(await pendingScheduled(t)).not.toContain("calendarFanOut:chunk");
    await asA.mutation(api.households.update, { householdId, backgroundPaused: false });
    expect(await pendingScheduled(t)).toEqual(["calendarFanOut:chunk"]);
    await asA.mutation(api.households.update, { householdId, backgroundPaused: false });
    expect(await pendingScheduled(t)).toEqual(["calendarFanOut:chunk"]);
  });

  test("removing a member drops their connections, links and syncs and revokes the grant", async () => {
    const t = makeBackend();
    const { householdId, eventId } = await setupSynced(t);
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
        eventId,
        connectionId: bConnection,
        state: "queued",
        updatedAt: Date.now(),
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
    expect(await pendingScheduled(t)).toContain("googleCalendar:revokeGrant");
  });
});

describe("chunked fan-out", () => {
  test("covers only events that can still occur, plus linked cancelled ones", async () => {
    const t = makeBackend();
    const { householdId, connectionId } = await setupSynced(t);
    await clearSyncs(t);
    const base = { title: "E", startTime: "10:00" };
    const future = await insertEvent(t, householdId, { ...base, startsOn: "2099-01-01" });
    const repeatOpen = await insertEvent(t, householdId, {
      ...base,
      startsOn: "2020-01-01",
      repeatDays: [1],
    });
    const repeatEnded = await insertEvent(t, householdId, {
      ...base,
      startsOn: "2020-01-01",
      repeatDays: [1],
      repeatUntil: "2020-12-31",
    });
    const pastOneOff = await insertEvent(t, householdId, { ...base, startsOn: "2020-01-01" });
    const cancelledLinked = await insertEvent(t, householdId, {
      ...base,
      startsOn: "2020-01-01",
      deletedAt: 1,
    });
    await insertEvent(t, householdId, { ...base, startsOn: "2099-01-01", deletedAt: 1 });
    await t.run(async (ctx) =>
      ctx.db.insert("calendarEventLinks", {
        eventId: cancelledLinked,
        connectionId,
        externalEventId: "gx",
        syncedAt: 1,
      }),
    );
    await runFanOut(t, householdId);
    const queued = (await syncRows(t)).map((r) => r.eventId);
    expect(queued).toContain(future);
    expect(queued).toContain(repeatOpen);
    expect(queued).toContain(cancelledLinked);
    expect(queued).not.toContain(repeatEnded);
    expect(queued).not.toContain(pastOneOff);
    // The setup event plus the three above; the unlinked cancelled event is left out.
    expect(queued).toHaveLength(4);
  });

  test("queues at most 200 syncs per chunk and covers more events than one chunk", async () => {
    const t = makeBackend();
    const householdId = await createHousehold(t);
    await addConnection(t, householdId);
    for (let i = 0; i < 450; i++) {
      await insertEvent(t, householdId, {
        title: `E${i}`,
        startsOn: "2099-01-01",
        startTime: "10:00",
      });
    }
    const sizes = await runFanOut(t, householdId);
    expect(sizes.length).toBeGreaterThan(1);
    expect(Math.max(...sizes)).toBeLessThanOrEqual(200);
    expect(sizes.reduce((a, b) => a + b, 0)).toBe(450);
    expect(await syncRows(t)).toHaveLength(450);
  });

  test("a chunk schedules the next one while events remain, and shrinks with more connections", async () => {
    const t = makeBackend();
    const householdId = await createHousehold(t);
    await addMember(t, householdId, "user_b");
    await addConnection(t, householdId);
    await addConnection(t, householdId, { userId: "user_b" });
    for (let i = 0; i < 150; i++) {
      await insertEvent(t, householdId, {
        title: `E${i}`,
        startsOn: "2099-01-01",
        startTime: "10:00",
      });
    }
    const first = await t.mutation(internal.calendarFanOut.chunk, { householdId, cursor: null });
    expect(first.queued).toBeLessThanOrEqual(200);
    expect(first.next).not.toBeNull();
    expect(await pendingScheduled(t)).toContain("calendarFanOut:chunk");
  });

  test("a backfill queues for its own connection only and skips an inactive one", async () => {
    const t = makeBackend();
    const { householdId, connectionId } = await setupSynced(t);
    await addMember(t, householdId, "user_b");
    const other = await addConnection(t, householdId, { userId: "user_b" });
    await clearSyncs(t);
    await runFanOut(t, householdId, other);
    expect((await syncRows(t)).map((r) => r.connectionId)).toEqual([other]);
    await t.run(async (ctx) => ctx.db.patch(connectionId, { status: "revoked" }));
    await clearSyncs(t);
    expect(await runFanOut(t, householdId, connectionId)).toEqual([0]);
  });

  test("a chunk for a missing household does nothing", async () => {
    const t = makeBackend();
    const { householdId } = await setupSynced(t);
    await t.run(async (ctx) => {
      for (const row of await ctx.db.query("calendarSyncs").collect()) await ctx.db.delete(row._id);
      for (const e of await ctx.db.query("events").collect()) await ctx.db.delete(e._id);
      for (const c of await ctx.db.query("calendarConnections").collect())
        await ctx.db.delete(c._id);
      for (const m of await ctx.db.query("householdMembers").collect()) await ctx.db.delete(m._id);
      await ctx.db.delete(householdId);
    });
    expect(await runFanOut(t, householdId)).toEqual([0]);
  });
});

describe("stuck sync sweeper", () => {
  test("re-enqueues rows idle for 15 minutes and leaves fresh ones", async () => {
    const t = makeBackend();
    const { householdId } = await setupSynced(t);
    const second = await addCalendarEvent(t, householdId, "Second");
    const stale = (await syncRows(t)).find((r) => r.eventId !== second)!;
    await t.run(async (ctx) =>
      ctx.db.patch(stale._id, { state: "running", updatedAt: Date.now() - 16 * 60_000 }),
    );
    expect(await t.mutation(internal.calendarFanOut.sweepStuckSyncs, {})).toBe(1);
    const after = await syncRows(t);
    expect(after).toHaveLength(2);
    expect(after.find((r) => r._id === stale._id)).toMatchObject({ state: "queued" });
    expect(await t.mutation(internal.calendarFanOut.sweepStuckSyncs, {})).toBe(0);
  });
});
