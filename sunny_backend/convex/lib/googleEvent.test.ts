// lib/googleEvent.test.ts
// Purpose: Tests for the pure event-to-Google mapping: eventSyncPayload against the cases of
// the SQL get_event_sync_payload tests (one-off, weekly with DTSTART shift, UNTIL at the end
// of the local day across DST and far-from-UTC zones, reminder minutes before and after the
// notice time, default duration, label fallback, cancelled), buildGoogleEvent shape, and
// googleEventId validity and determinism.
//
// Last modified: 2026-10-29

import { describe, expect, test } from "vitest";
import type { Doc } from "../_generated/dataModel";
import { buildGoogleEvent, eventSyncPayload, googleEventId } from "./googleEvent";

/**
 * purpose: A household document for tests.
 * @param over: (Partial<Doc<"households">>) Field overrides.
 * @return: (Doc<"households">) Household with 8:00 AM notice time in New York.
 */
function household(over: Partial<Doc<"households">> = {}): Doc<"households"> {
  return {
    _id: "h1",
    _creationTime: 0,
    seniorPreferredName: "Mom",
    timezone: "America/New_York",
    digestTime: "18:00",
    eventNoticeTime: "08:00",
    shareTranscripts: true,
    backgroundPaused: false,
    ...over,
  } as unknown as Doc<"households">;
}

/**
 * purpose: An event document for tests.
 * @param over: (Partial<Doc<"events">>) Field overrides.
 * @return: (Doc<"events">) A one-off 10:00 event on 2027-03-09.
 */
function event(over: Partial<Doc<"events">> = {}): Doc<"events"> {
  return {
    _id: "evt1",
    _creationTime: 0,
    householdId: "h1",
    title: "Walk",
    startsOn: "2027-03-09",
    startTime: "10:00",
    createdVia: "caregiver",
    ...over,
  } as unknown as Doc<"events">;
}

describe("eventSyncPayload", () => {
  test("one-off event uses its date, default one hour duration and no rrule", () => {
    const p = eventSyncPayload(event(), household());
    expect(p.startLocal).toBe("2027-03-09T10:00:00");
    expect(p.endLocal).toBe("2027-03-09T11:00:00");
    expect(p.rrule).toBeNull();
    expect(p.timeZone).toBe("America/New_York");
    expect(p.cancelled).toBe(false);
    expect(p.eventId).toBe("evt1");
  });

  test("explicit duration and midnight rollover", () => {
    const p = eventSyncPayload(event({ startTime: "23:30", durationMinutes: 90 }), household());
    expect(p.endLocal).toBe("2027-03-10T01:00:00");
  });

  test("weekly event starts on the first matching weekday and ends at the last local day", () => {
    // 2027-03-08 is a Monday; Tuesday is the first match. Matches the SQL test.
    const p = eventSyncPayload(
      event({ startsOn: "2027-03-08", repeatDays: [4, 2], repeatUntil: "2027-03-25" }),
      household(),
    );
    expect(p.startLocal).toBe("2027-03-09T10:00:00");
    expect(p.endLocal).toBe("2027-03-09T11:00:00");
    expect(p.rrule).toBe("RRULE:FREQ=WEEKLY;BYDAY=TU,TH;UNTIL=20270326T035959Z");
    expect(p.reminderMinutes).toBe(120);
  });

  test("weekly event starting on a matching weekday keeps its date", () => {
    const p = eventSyncPayload(event({ repeatDays: [2] }), household());
    expect(p.startLocal).toBe("2027-03-09T10:00:00");
  });

  test("weekly event whose weekday is earlier in the week moves forward", () => {
    // Tuesday start, Monday repeat: next Monday.
    const p = eventSyncPayload(event({ repeatDays: [1] }), household());
    expect(p.startLocal).toBe("2027-03-15T10:00:00");
  });

  test("weekly event without an end date has no UNTIL", () => {
    const p = eventSyncPayload(event({ repeatDays: [7, 1] }), household());
    expect(p.rrule).toBe("RRULE:FREQ=WEEKLY;BYDAY=MO,SU");
  });

  test("UNTIL on the day before spring forward is end of standard-time day", () => {
    const p = eventSyncPayload(event({ repeatDays: [2], repeatUntil: "2027-03-13" }), household());
    expect(p.rrule).toContain("UNTIL=20270314T045959Z");
  });

  test("UNTIL on the spring-forward day is end of the 23 hour daylight day", () => {
    const p = eventSyncPayload(event({ repeatDays: [2], repeatUntil: "2027-03-14" }), household());
    expect(p.rrule).toContain("UNTIL=20270315T035959Z");
  });

  test("UNTIL on the fall-back day is end of the 25 hour day", () => {
    const p = eventSyncPayload(
      event({ startsOn: "2027-10-26", repeatDays: [2], repeatUntil: "2027-11-07" }),
      household(),
    );
    expect(p.rrule).toContain("UNTIL=20271108T045959Z");
  });

  test("UNTIL in a zone ahead of UTC lands on the same UTC day", () => {
    const p = eventSyncPayload(
      event({ repeatDays: [2], repeatUntil: "2027-04-03" }),
      household({ timezone: "Pacific/Auckland" }),
    );
    expect(p.rrule).toContain("UNTIL=20270403T105959Z");
  });

  test("UNTIL in a half-hour offset zone", () => {
    const p = eventSyncPayload(
      event({ repeatDays: [2], repeatUntil: "2027-01-10" }),
      household({ timezone: "Asia/Kolkata" }),
    );
    expect(p.rrule).toContain("UNTIL=20270110T182959Z");
  });

  test("UNTIL in a zone far behind UTC rolls to the next UTC day", () => {
    const p = eventSyncPayload(
      event({ repeatDays: [2], repeatUntil: "2027-07-01" }),
      household({ timezone: "Pacific/Honolulu" }),
    );
    expect(p.rrule).toContain("UNTIL=20270702T095959Z");
  });

  test("reminder lands on the notice time when the event is later that day", () => {
    expect(eventSyncPayload(event({ startTime: "15:00" }), household()).reminderMinutes).toBe(420);
  });

  test("reminder is an hour ahead when the event starts before the notice time", () => {
    expect(eventSyncPayload(event({ startTime: "07:00" }), household()).reminderMinutes).toBe(60);
  });

  test("reminder is an hour ahead when the event starts exactly at the notice time", () => {
    expect(eventSyncPayload(event({ startTime: "08:00" }), household()).reminderMinutes).toBe(60);
  });

  test("reminder follows a custom notice time", () => {
    const p = eventSyncPayload(
      event({ startTime: "10:00" }),
      household({ eventNoticeTime: "09:30" }),
    );
    expect(p.reminderMinutes).toBe(30);
  });

  test("label falls back to the title", () => {
    expect(eventSyncPayload(event(), household()).label).toBe("Walk");
    expect(eventSyncPayload(event({ label: "Stroll" }), household()).label).toBe("Stroll");
  });

  test("optional fields map to null when absent and pass through when set", () => {
    const bare = eventSyncPayload(event(), household());
    expect([bare.place, bare.notes, bare.visitorName]).toEqual([null, null, null]);
    const full = eventSyncPayload(
      event({ place: "Park", notes: "Bring water", visitorName: "Sam" }),
      household(),
    );
    expect([full.place, full.notes, full.visitorName]).toEqual(["Park", "Bring water", "Sam"]);
  });

  test("a cancelled event is marked for deletion", () => {
    expect(eventSyncPayload(event({ deletedAt: 123 }), household()).cancelled).toBe(true);
  });
});

describe("buildGoogleEvent", () => {
  test("builds a one-off event with reminder and private extended property", () => {
    const g = buildGoogleEvent(eventSyncPayload(event({ place: "Park" }), household()));
    expect(g).toMatchObject({
      summary: "Walk",
      location: "Park",
      start: { dateTime: "2027-03-09T10:00:00", timeZone: "America/New_York" },
      end: { dateTime: "2027-03-09T11:00:00", timeZone: "America/New_York" },
      recurrence: undefined,
      reminders: { useDefault: false, overrides: [{ method: "popup", minutes: 120 }] },
      extendedProperties: { private: { sunny_event_id: "evt1" } },
      status: "confirmed",
    });
  });

  test("includes the recurrence rule", () => {
    const g = buildGoogleEvent(eventSyncPayload(event({ repeatDays: [2, 4] }), household()));
    expect(g.recurrence).toEqual(["RRULE:FREQ=WEEKLY;BYDAY=TU,TH"]);
  });

  test("description lists notes, visitor and the senior-facing label", () => {
    const g = buildGoogleEvent(
      eventSyncPayload(
        event({ notes: "Bring water", visitorName: "Sam", label: "Stroll" }),
        household(),
      ),
    );
    expect(g.description).toBe(
      [
        "Bring water",
        "With Sam.",
        'Shown to Mom as "Stroll".',
        "Kept by Sunny: make changes in Sunny, edits here are not synced back yet.",
      ].join("\n\n"),
    );
  });

  test("description is only the footer when there is nothing else", () => {
    const g = buildGoogleEvent(eventSyncPayload(event(), household()));
    expect(g.description).toBe(
      "Kept by Sunny: make changes in Sunny, edits here are not synced back yet.",
    );
    expect(g.location).toBeUndefined();
  });
});

describe("googleEventId", () => {
  const convexLikeId = "k17f3z9xwq5hrwm8y0tzvn2c7x6zb4d9";

  test("uses only base32hex characters and a valid length", () => {
    const id = googleEventId(convexLikeId);
    expect(id).toMatch(/^[0-9a-v]{5,1024}$/);
  });

  test("is deterministic", () => {
    expect(googleEventId(convexLikeId)).toBe(googleEventId(convexLikeId));
  });

  test("is injective across different ids", () => {
    expect(googleEventId("abc")).not.toBe(googleEventId("abd"));
    expect(googleEventId("a")).not.toBe(googleEventId("aa"));
  });

  test("a short id still reaches the 5 character minimum", () => {
    expect(googleEventId("abc").length).toBeGreaterThanOrEqual(5);
  });
});
