// lib/time.test.ts
// Purpose: Tests for household-local date and time math, centered on the New York DST
// transitions of 2026 (spring forward 2026-03-08, fall back 2026-11-01) that the SQL tests
// covered, plus date arithmetic, weekday, part-of-day and formatting helpers.
//
// Last modified: 2026-10-28

import { describe, expect, test } from "vitest";
import {
  addDays,
  canonicalTimezone,
  dateLabel,
  daysBetween,
  formatTime12,
  isLocalDate,
  isLocalTime,
  isValidTimezone,
  isoWeekday,
  localDate,
  localDateTime,
  localMidnight,
  localTime,
  partOfDay,
  weekdayName,
  zonedInstant,
} from "./time";

const NY = "America/New_York";

describe("zonedInstant", () => {
  test("summer morning uses daylight offset", () => {
    expect(zonedInstant("2026-07-15", "08:00", NY)).toBe(Date.UTC(2026, 6, 15, 12, 0));
  });

  test("winter morning uses standard offset", () => {
    expect(zonedInstant("2026-01-15", "08:00", NY)).toBe(Date.UTC(2026, 0, 15, 13, 0));
  });

  test("spring-forward gap time resolves with the pre-change offset", () => {
    expect(zonedInstant("2026-03-08", "02:30", NY)).toBe(Date.UTC(2026, 2, 8, 7, 30));
  });

  test("time just before the gap is standard time", () => {
    expect(zonedInstant("2026-03-08", "01:30", NY)).toBe(Date.UTC(2026, 2, 8, 6, 30));
  });

  test("fall-back repeated time resolves to the standard-time instant", () => {
    expect(zonedInstant("2026-11-01", "01:30", NY)).toBe(Date.UTC(2026, 10, 1, 6, 30));
  });

  test("time after fall-back is standard time", () => {
    expect(zonedInstant("2026-11-01", "08:00", NY)).toBe(Date.UTC(2026, 10, 1, 13, 0));
  });

  test("rejects a malformed time", () => {
    expect(() => zonedInstant("2026-07-15", "8:00", NY)).toThrow();
  });

  test("rejects a date that is not on the calendar", () => {
    expect(() => zonedInstant("2026-02-30", "08:00", NY)).toThrow();
  });
});

describe("localDate, localTime and localDateTime", () => {
  test("a late UTC instant is still the previous local day", () => {
    const instant = Date.UTC(2026, 6, 16, 2, 30);
    expect(localDate(instant, NY)).toBe("2026-07-15");
    expect(localTime(instant, NY)).toBe("22:30");
    expect(localDateTime(instant, NY)).toBe("2026-07-15T22:30:00");
  });

  test("round trips with zonedInstant on a normal day", () => {
    const instant = zonedInstant("2026-10-28", "13:45", NY);
    expect(localDate(instant, NY)).toBe("2026-10-28");
    expect(localTime(instant, NY)).toBe("13:45");
  });

  test("gap time reads back as 03:30", () => {
    const instant = zonedInstant("2026-03-08", "02:30", NY);
    expect(localTime(instant, NY)).toBe("03:30");
  });

  test("midnight is rendered as 00:00, not 24:00", () => {
    const instant = zonedInstant("2026-10-28", "00:00", NY);
    expect(localTime(instant, NY)).toBe("00:00");
  });
});

describe("localMidnight", () => {
  test("is the start of the local day", () => {
    const instant = Date.UTC(2026, 6, 15, 20, 0);
    expect(localMidnight(instant, NY)).toBe(Date.UTC(2026, 6, 15, 4, 0));
  });

  test("a spring-forward day is 23 hours long", () => {
    const start = localMidnight(Date.UTC(2026, 2, 8, 12, 0), NY);
    const next = localMidnight(Date.UTC(2026, 2, 9, 12, 0), NY);
    expect(next - start).toBe(23 * 3_600_000);
  });
});

describe("date arithmetic", () => {
  test("addDays crosses a month end", () => {
    expect(addDays("2026-01-31", 1)).toBe("2026-02-01");
  });

  test("addDays crosses a year end", () => {
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
  });

  test("addDays goes backwards across a year start", () => {
    expect(addDays("2026-01-01", -1)).toBe("2025-12-31");
  });

  test("addDays handles a leap day", () => {
    expect(addDays("2028-02-28", 1)).toBe("2028-02-29");
  });

  test("daysBetween counts across a DST change as whole days", () => {
    expect(daysBetween("2026-03-07", "2026-03-10")).toBe(3);
    expect(daysBetween("2026-03-10", "2026-03-07")).toBe(-3);
  });

  test("isoWeekday numbers Monday as 1 and Sunday as 7", () => {
    expect(isoWeekday("2026-10-26")).toBe(1);
    expect(isoWeekday("2026-10-28")).toBe(3);
    expect(isoWeekday("2026-11-01")).toBe(7);
  });

  test("weekdayName and dateLabel read naturally", () => {
    expect(weekdayName("2026-10-28")).toBe("Wednesday");
    expect(dateLabel("2026-10-29")).toBe("October 29");
  });
});

describe("partOfDay", () => {
  test.each([
    ["04:59", "night"],
    ["05:00", "morning"],
    ["11:59", "morning"],
    ["12:00", "afternoon"],
    ["16:59", "afternoon"],
    ["17:00", "evening"],
    ["20:59", "evening"],
    ["21:00", "night"],
    ["00:00", "night"],
  ])("%s is %s", (time, expected) => {
    expect(partOfDay(time)).toBe(expected);
  });
});

describe("formatTime12", () => {
  test.each([
    ["00:05", "12:05 AM"],
    ["12:00", "12:00 PM"],
    ["08:00", "8:00 AM"],
    ["13:30", "1:30 PM"],
    ["23:59", "11:59 PM"],
  ])("%s becomes %s", (time, expected) => {
    expect(formatTime12(time)).toBe(expected);
  });
});

describe("validators", () => {
  test("isValidTimezone accepts region zones only", () => {
    expect(isValidTimezone(NY)).toBe(true);
    expect(isValidTimezone("EST")).toBe(false);
    expect(isValidTimezone("PST8PDT")).toBe(false);
    expect(isValidTimezone("Not/AZone")).toBe(false);
  });

  test("isLocalDate rejects impossible dates", () => {
    expect(isLocalDate("2026-10-28")).toBe(true);
    expect(isLocalDate("2026-13-01")).toBe(false);
    expect(isLocalDate("10/28/2026")).toBe(false);
  });

  test("isLocalTime accepts 24-hour HH:MM only", () => {
    expect(isLocalTime("00:00")).toBe(true);
    expect(isLocalTime("23:59")).toBe(true);
    expect(isLocalTime("24:00")).toBe(false);
    expect(isLocalTime("9:00")).toBe(false);
  });
});

describe("zonedInstant in zones ahead of UTC+12", () => {
  test("Auckland spring-forward gap resolves to 03:30 NZDT", () => {
    // 02:30 does not exist; the pre-change offset is NZST (+12), so 14:30Z the day before,
    // which is 03:30 NZDT (+13).
    const t = zonedInstant("2026-09-27", "02:30", "Pacific/Auckland");
    expect(t).toBe(Date.UTC(2026, 8, 26, 14, 30));
    expect(localDateTime(t, "Pacific/Auckland")).toBe("2026-09-27T03:30:00");
  });

  test("Auckland fall-back repeated time resolves to the later NZST instant", () => {
    // 02:30 happens at 13:30Z (NZDT, +13) and 14:30Z (NZST, +12); the later one wins.
    expect(zonedInstant("2026-04-05", "02:30", "Pacific/Auckland")).toBe(
      Date.UTC(2026, 3, 4, 14, 30),
    );
  });

  test("Auckland time on a non-transition day", () => {
    // Mid-July is NZST (+12).
    expect(zonedInstant("2026-07-15", "08:00", "Pacific/Auckland")).toBe(
      Date.UTC(2026, 6, 14, 20, 0),
    );
  });

  test("Chatham gap start 02:45 reads back as 03:45", () => {
    // Chatham jumps from 02:45 (+12:45) to 03:45 (+13:45) on 2026-09-27.
    const t = zonedInstant("2026-09-27", "02:45", "Pacific/Chatham");
    expect(t).toBe(Date.UTC(2026, 8, 26, 14, 0));
    expect(localDateTime(t, "Pacific/Chatham")).toBe("2026-09-27T03:45:00");
  });

  test("Chatham gap time 03:30 resolves to 04:30 local", () => {
    const t = zonedInstant("2026-09-27", "03:30", "Pacific/Chatham");
    expect(t).toBe(Date.UTC(2026, 8, 26, 14, 45));
    expect(localDateTime(t, "Pacific/Chatham")).toBe("2026-09-27T04:30:00");
  });

  test("Sydney spring-forward gap resolves to 03:30 AEDT", () => {
    const t = zonedInstant("2026-10-04", "02:30", "Australia/Sydney");
    expect(t).toBe(Date.UTC(2026, 9, 3, 16, 30));
    expect(localDateTime(t, "Australia/Sydney")).toBe("2026-10-04T03:30:00");
  });
});

describe("canonicalTimezone", () => {
  test("fixes the case of a region zone", () => {
    expect(canonicalTimezone("america/new_york")).toBe("America/New_York");
  });

  test("leaves a canonical zone unchanged", () => {
    expect(canonicalTimezone("Pacific/Auckland")).toBe("Pacific/Auckland");
  });

  test("rejects abbreviations, POSIX strings, unknown zones and blanks", () => {
    expect(canonicalTimezone("EST")).toBeNull();
    expect(canonicalTimezone("PST8PDT")).toBeNull();
    expect(canonicalTimezone("Mars/Olympus")).toBeNull();
    expect(canonicalTimezone("")).toBeNull();
  });
});
