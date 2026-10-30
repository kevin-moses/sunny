// lib/occurrences.test.ts
// Purpose: Unit tests for lib/occurrences.ts with plain event documents (no database):
// one-off and weekly expansion, bounds, cancelled events, DST stability across the
// 2026-11-01 fall-back and 2027-03-14 spring-forward, ordering, the JSON shapes, the next
// occurrence, and the not-in-the-past rules with their messages.
//
// Last modified: 2026-10-28

import { describe, expect, test } from "vitest";
import type { Doc, Id } from "../_generated/dataModel";
import { isAppError } from "./errors";
import {
  assertEventNotPast,
  eventJson,
  eventWithNext,
  expandOccurrences,
  occurrenceJson,
} from "./occurrences";

const NY = "America/New_York";

/**
 * purpose: A plain event document with sensible defaults.
 * @param overrides: (Partial<Doc<"events">>) Fields to set.
 * @return: (Doc<"events">) The event.
 */
function makeEvent(overrides: Partial<Doc<"events">> = {}): Doc<"events"> {
  return {
    _id: "evt1" as Id<"events">,
    _creationTime: 1,
    householdId: "hh1" as Id<"households">,
    title: "Walk",
    startsOn: "2026-10-30",
    startTime: "14:00",
    createdVia: "caregiver",
    ...overrides,
  };
}

/**
 * purpose: Epoch ms of a UTC instant.
 * @param iso: (string) ISO instant.
 * @return: (number) Epoch ms.
 */
function at(iso: string): number {
  return Date.parse(iso);
}

/**
 * purpose: The message of the application error thrown by a function.
 * @param fn: (() => void) Function expected to throw an invalid error.
 * @return: (string) The error message.
 */
function invalidMessage(fn: () => void): string {
  try {
    fn();
  } catch (e) {
    expect(isAppError(e, "invalid")).toBe(true);
    return (e as { data: { message: string } }).data.message;
  }
  throw new Error("did not throw");
}

describe("expandOccurrences", () => {
  test("a one-off event occurs once on startsOn, with end from duration", () => {
    const event = makeEvent({ startsOn: "2027-03-18", durationMinutes: 60 });
    const out = expandOccurrences([event], NY, "2027-03-01", "2027-03-31");
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      localDate: "2027-03-18",
      startsAt: at("2027-03-18T18:00:00Z"),
      endsAt: at("2027-03-18T19:00:00Z"),
    });
  });

  test("an event without a duration has a null end", () => {
    const out = expandOccurrences([makeEvent()], NY, "2026-10-30", "2026-10-30");
    expect(out[0]!.endsAt).toBeNull();
  });

  test("a one-off event outside the range does not occur", () => {
    const event = makeEvent({ startsOn: "2027-03-18" });
    expect(expandOccurrences([event], NY, "2027-03-19", "2027-03-31")).toHaveLength(0);
    expect(expandOccurrences([event], NY, "2027-03-01", "2027-03-17")).toHaveLength(0);
  });

  test("range bounds are inclusive", () => {
    const event = makeEvent({ startsOn: "2027-03-18" });
    expect(expandOccurrences([event], NY, "2027-03-18", "2027-03-18")).toHaveLength(1);
  });

  test("a weekly repeat occurs on its weekdays from startsOn until repeatUntil", () => {
    // 2027-03-08 is a Monday; Tuesday and Thursday repeat through 2027-03-25.
    const event = makeEvent({
      startsOn: "2027-03-08",
      startTime: "10:00",
      repeatDays: [2, 4],
      repeatUntil: "2027-03-25",
    });
    const dates = expandOccurrences([event], NY, "2027-03-01", "2027-04-30").map(
      (o) => o.localDate,
    );
    expect(dates).toEqual([
      "2027-03-09",
      "2027-03-11",
      "2027-03-16",
      "2027-03-18",
      "2027-03-23",
      "2027-03-25",
    ]);
  });

  test("a weekly repeat without repeatUntil runs to the end of the range", () => {
    const event = makeEvent({ startsOn: "2027-03-08", repeatDays: [1] });
    const dates = expandOccurrences([event], NY, "2027-03-01", "2027-03-31").map(
      (o) => o.localDate,
    );
    expect(dates).toEqual(["2027-03-08", "2027-03-15", "2027-03-22", "2027-03-29"]);
  });

  test("a weekly repeat does not occur before startsOn", () => {
    const event = makeEvent({ startsOn: "2027-03-17", repeatDays: [1, 2, 3, 4, 5, 6, 7] });
    const first = expandOccurrences([event], NY, "2027-03-01", "2027-03-20")[0]!;
    expect(first.localDate).toBe("2027-03-17");
  });

  test("a weekly 14:00 event stays 14:00 local across fall-back on 2026-11-01", () => {
    const event = makeEvent({ startsOn: "2026-10-26", repeatDays: [1, 5] });
    const out = expandOccurrences([event], NY, "2026-10-26", "2026-11-06");
    const starts = out.map((o) => [o.localDate, o.startsAt]);
    expect(starts).toEqual([
      ["2026-10-26", at("2026-10-26T18:00:00Z")],
      ["2026-10-30", at("2026-10-30T18:00:00Z")],
      ["2026-11-02", at("2026-11-02T19:00:00Z")],
      ["2026-11-06", at("2026-11-06T19:00:00Z")],
    ]);
  });

  test("a weekly 10:00 event stays 10:00 local across spring-forward on 2027-03-14", () => {
    const event = makeEvent({ startsOn: "2027-03-08", startTime: "10:00", repeatDays: [2, 4] });
    const out = expandOccurrences([event], NY, "2027-03-09", "2027-03-18");
    expect(out.map((o) => o.startsAt)).toEqual([
      at("2027-03-09T15:00:00Z"),
      at("2027-03-11T15:00:00Z"),
      at("2027-03-16T14:00:00Z"),
      at("2027-03-18T14:00:00Z"),
    ]);
  });

  test("cancelled events produce no occurrences", () => {
    const event = makeEvent({ deletedAt: 5 });
    expect(expandOccurrences([event], NY, "2026-10-01", "2026-12-01")).toHaveLength(0);
  });

  test("occurrences of several events are ordered by start instant", () => {
    const late = makeEvent({ _id: "e2" as Id<"events">, startTime: "16:00" });
    const early = makeEvent({ _id: "e1" as Id<"events">, startTime: "08:00", _creationTime: 2 });
    const out = expandOccurrences([late, early], NY, "2026-10-30", "2026-10-30");
    expect(out.map((o) => o.event._id)).toEqual(["e1", "e2"]);
  });
});

describe("JSON shapes", () => {
  test("eventJson is camel case, nulls absent fields and falls back label to title", () => {
    expect(eventJson(makeEvent())).toEqual({
      eventId: "evt1",
      title: "Walk",
      label: "Walk",
      startsOn: "2026-10-30",
      startTime: "14:00",
      durationMinutes: null,
      place: null,
      visitorName: null,
      notes: null,
      repeatDays: null,
      repeatUntil: null,
      createdVia: "caregiver",
      cancelled: false,
    });
  });

  test("eventJson uses the label when set and marks cancelled events", () => {
    const json = eventJson(
      makeEvent({ label: "Stroll", place: "Park", durationMinutes: 30, deletedAt: 9 }),
    );
    expect(json).toMatchObject({ label: "Stroll", place: "Park", durationMinutes: 30 });
    expect(json.cancelled).toBe(true);
  });

  test("occurrenceJson adds the date and instants to the definition", () => {
    const event = makeEvent({ durationMinutes: 15 });
    const [occ] = expandOccurrences([event], NY, "2026-10-30", "2026-10-30");
    expect(occurrenceJson(occ!)).toMatchObject({
      eventId: "evt1",
      localDate: "2026-10-30",
      startsAt: at("2026-10-30T18:00:00Z"),
      endsAt: at("2026-10-30T18:15:00Z"),
    });
  });
});

describe("eventWithNext", () => {
  test("returns the first occurrence starting at or after now", () => {
    const event = makeEvent({ startsOn: "2027-03-08", startTime: "10:00", repeatDays: [2, 4] });
    const next = eventWithNext(event, NY, at("2027-03-16T14:00:00Z")).nextOccurrence;
    expect(next).toEqual({ localDate: "2027-03-16", startsAt: at("2027-03-16T14:00:00Z") });
    const after = eventWithNext(event, NY, at("2027-03-16T14:00:01Z")).nextOccurrence;
    expect(after?.localDate).toBe("2027-03-18");
  });

  test("is null for a one-off event in the past", () => {
    expect(eventWithNext(makeEvent(), NY, at("2026-11-05T00:00:00Z")).nextOccurrence).toBeNull();
  });

  test("is null when the repeat has ended", () => {
    const event = makeEvent({ repeatDays: [1], repeatUntil: "2026-11-02" });
    expect(eventWithNext(event, NY, at("2026-11-10T00:00:00Z")).nextOccurrence).toBeNull();
  });

  test("looks 400 days ahead but no further", () => {
    const event = makeEvent({ startsOn: "2028-03-01" });
    expect(eventWithNext(event, NY, at("2027-03-01T12:00:00Z")).nextOccurrence).not.toBeNull();
    const far = makeEvent({ startsOn: "2028-06-01" });
    expect(eventWithNext(far, NY, at("2027-03-01T12:00:00Z")).nextOccurrence).toBeNull();
  });
});

describe("assertEventNotPast", () => {
  const now = at("2027-03-01T15:00:00Z");

  test("rejects a one-off event that has started", () => {
    const schedule = { startsOn: "2027-03-01", startTime: "09:00" };
    expect(invalidMessage(() => assertEventNotPast(schedule, NY, now))).toBe(
      "That time has already passed",
    );
  });

  test("accepts a one-off event later today", () => {
    expect(() =>
      assertEventNotPast({ startsOn: "2027-03-01", startTime: "11:00" }, NY, now),
    ).not.toThrow();
  });

  test("a repeating event that started in the past is fine", () => {
    const schedule = { startsOn: "2027-01-04", startTime: "09:00", repeatDays: [1] };
    expect(() => assertEventNotPast(schedule, NY, now)).not.toThrow();
  });

  test("rejects a repeat that ended before today (household-local)", () => {
    const schedule = {
      startsOn: "2027-01-04",
      startTime: "09:00",
      repeatDays: [1],
      repeatUntil: "2027-02-28",
    };
    expect(invalidMessage(() => assertEventNotPast(schedule, NY, now))).toBe(
      "The repeat end date has already passed",
    );
  });

  test("a repeat ending today is accepted", () => {
    const schedule = {
      startsOn: "2027-01-04",
      startTime: "09:00",
      repeatDays: [1],
      repeatUntil: "2027-03-01",
    };
    expect(() => assertEventNotPast(schedule, NY, now)).not.toThrow();
  });

  test("rejects a weekly repeat whose weekdays never occur before repeatUntil", () => {
    // 2027-03-22 is a Monday; only Sunday is requested and the repeat ends Tuesday.
    const schedule = {
      startsOn: "2027-03-22",
      startTime: "09:00",
      repeatDays: [7],
      repeatUntil: "2027-03-23",
    };
    expect(invalidMessage(() => assertEventNotPast(schedule, NY, now))).toBe(
      "The repeat has no dates between its start and end",
    );
  });

  test("accepts a weekly repeat whose only matching date is repeatUntil itself", () => {
    const schedule = {
      startsOn: "2027-03-22",
      startTime: "09:00",
      repeatDays: [2],
      repeatUntil: "2027-03-23",
    };
    expect(() => assertEventNotPast(schedule, NY, now)).not.toThrow();
  });
});
