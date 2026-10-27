// tests/jobs_test.ts
// Purpose: Unit tests for the pure parts of the job runner: the Google event mapping and
// signed OAuth state (_shared/google.ts), the agent tool field mapping
// (_shared/agent_tools.ts), and how the Managed Agents runtime reads a session's events
// (pending tool calls, end of turn). Network calls are covered by the local end-to-end
// run described in notes/AGENT_RUNTIME.md.
// Run with: deno test supabase/functions/tests
//
// Last modified: 2026-10-27

import { assertEquals, assertThrows } from "jsr:@std/assert@1";
import { toEventChanges } from "../_shared/agent_tools.ts";
import { buildGoogleEvent, type EventSyncPayload, googleEventId, signState, verifyState } from "../_shared/google.ts";
import { finishedTurn, pendingToolUses } from "../jobs-run/agent.ts";

const PAYLOAD: EventSyncPayload = {
  event_id: "e1",
  household_id: "h1",
  cancelled: false,
  title: "Physiotherapy",
  place: "Riverside Clinic",
  notes: "Bring the referral",
  visitor_name: null,
  label: "Exercises with Dana",
  senior_preferred_name: "Mom",
  time_zone: "America/New_York",
  start_local: "2026-10-29T14:00:00",
  end_local: "2026-10-29T15:00:00",
  rrule: null,
  reminder_minutes: 360,
  external_event_id: null,
};

Deno.test("buildGoogleEvent maps times, reminder, label and Sunny's id", () => {
  const event = buildGoogleEvent(PAYLOAD);
  assertEquals(event.start, { dateTime: "2026-10-29T14:00:00", timeZone: "America/New_York" });
  assertEquals(event.end, { dateTime: "2026-10-29T15:00:00", timeZone: "America/New_York" });
  assertEquals(event.reminders, { useDefault: false, overrides: [{ method: "popup", minutes: 360 }] });
  assertEquals(event.extendedProperties, { private: { sunny_event_id: "e1" } });
  assertEquals(event.recurrence, undefined);
  assertEquals(
    String(event.description).split("\n\n").slice(0, 2),
    ["Bring the referral", 'Shown to Mom as "Exercises with Dana".'],
  );
});

Deno.test("googleEventId is a stable base32hex id", () => {
  const id = googleEventId("DEC014D9-9110-432A-BBAC-ED2F0B48D195");
  assertEquals(id, "dec014d99110432abbaced2f0b48d195");
  assertEquals(/^[0-9a-v]{5,1024}$/.test(id), true);
});

Deno.test("buildGoogleEvent carries a weekly RRULE", () => {
  const rrule = "RRULE:FREQ=WEEKLY;BYDAY=TU,TH;UNTIL=20270326T035959Z";
  assertEquals(buildGoogleEvent({ ...PAYLOAD, rrule }).recurrence, [rrule]);
});

Deno.test("OAuth state round-trips and rejects tampering and expiry", async () => {
  const now = Date.UTC(2026, 9, 27, 12);
  const state = await signState("user-1", "house-1", now, "secret");
  assertEquals(await verifyState(state, now + 60_000, "secret"), {
    userId: "user-1",
    householdId: "house-1",
    expiresAt: now / 1000 + 900,
  });
  assertEquals(await verifyState(state, now + 16 * 60_000, "secret"), null);
  assertEquals(await verifyState(state, now, "other-secret"), null);
  const [payload, signature] = state.split(".");
  assertEquals(await verifyState(`${payload}x.${signature}`, now, "secret"), null);
  assertEquals(await verifyState("garbage", now, "secret"), null);
});

Deno.test("toEventChanges maps tool fields to RPC fields", () => {
  assertEquals(
    toEventChanges({ date: "2026-10-29", start_time: "14:00", repeat_weekdays: ["tue", "thu"], place: "Clinic" }),
    { on_date: "2026-10-29", start_time: "14:00", repeat_days: [2, 4], place: "Clinic" },
  );
  assertEquals(toEventChanges({ repeat_weekdays: [] }), { repeat_days: null });
  assertThrows(() => toEventChanges({ start_time: "2pm" }));
  assertThrows(() => toEventChanges({ repeat_weekdays: ["someday"] }));
  assertThrows(() => toEventChanges({ household_id: "other" }));
});

Deno.test("pendingToolUses finds tool calls without results", () => {
  const events = [
    { id: "a", type: "agent.custom_tool_use", name: "get_calendar" },
    { id: "r", type: "user.custom_tool_result", custom_tool_use_id: "a" },
    { id: "b", type: "agent.custom_tool_use", name: "add_event" },
  ];
  assertEquals(pendingToolUses(events).map((e) => e.id), ["b"]);
});

Deno.test("finishedTurn waits for an end-of-turn idle after the latest message", () => {
  const first = [
    { id: "1", type: "user.message" },
    { id: "2", type: "agent.message", content: [{ type: "text", text: "Added it." }] },
    { id: "3", type: "session.status_idle", stop_reason: { type: "end_turn" } },
  ];
  assertEquals(finishedTurn(first), { state: "replied", reply: "Added it." });
  // A follow-up message: the earlier idle must not count as this turn's end.
  assertEquals(finishedTurn([...first, { id: "4", type: "user.message" }]), { state: "running" });
  assertEquals(
    finishedTurn([...first, { id: "4", type: "session.status_idle", stop_reason: { type: "requires_action" } }]),
    { state: "running" },
  );
});

Deno.test("finishedTurn reports any other stop as stopped, not success", () => {
  for (const reason of ["budget_reached", "retries_exhausted", "refusal", "something_new"]) {
    assertEquals(
      finishedTurn([
        { id: "1", type: "user.message" },
        { id: "2", type: "agent.message", content: [{ type: "text", text: "partial" }] },
        { id: "3", type: "session.status_idle", stop_reason: { type: reason } },
      ]),
      { state: "stopped", reason },
    );
  }
});
