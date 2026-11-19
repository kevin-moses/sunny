import { describe, expect, it } from '@jest/globals';

import {
  addDays,
  currentLocalDate,
  dayOfMonth,
  daysBetween,
  formatLocalDate,
  localClockTime,
  monthName,
  MS_PER_DAY,
  parseLocalDate,
  weekdayName,
  yearOf,
} from '../localDate';

function parsed(localDate: string): number {
  const time = parseLocalDate(localDate);
  if (time === null) throw new Error(`invalid test date ${localDate}`);
  return time;
}

describe('parseLocalDate', () => {
  it('parses a valid date to UTC midnight', () => {
    expect(parseLocalDate('2026-10-29')).toBe(Date.UTC(2026, 9, 29));
  });

  it('rejects malformed and impossible dates', () => {
    expect(parseLocalDate('nope')).toBeNull();
    expect(parseLocalDate('2026-1-5')).toBeNull();
    expect(parseLocalDate('2026-02-30')).toBeNull();
    expect(parseLocalDate('2026-13-01')).toBeNull();
  });

  it('accepts a leap day only in a leap year', () => {
    expect(parseLocalDate('2028-02-29')).not.toBeNull();
    expect(parseLocalDate('2026-02-29')).toBeNull();
  });
});

describe('addDays and formatLocalDate', () => {
  it('crosses month and year boundaries', () => {
    expect(formatLocalDate(addDays(parsed('2026-10-30'), 6))).toBe('2026-11-05');
    expect(formatLocalDate(addDays(parsed('2026-12-30'), 3))).toBe('2027-01-02');
  });

  it('goes backwards with a negative count', () => {
    expect(formatLocalDate(addDays(parsed('2026-03-01'), -1))).toBe('2026-02-28');
  });

  it('round-trips through format', () => {
    expect(formatLocalDate(parsed('2026-10-29'))).toBe('2026-10-29');
  });
});

describe('daysBetween', () => {
  it('counts whole days in either direction', () => {
    expect(daysBetween(parsed('2026-10-29'), parsed('2026-10-29'))).toBe(0);
    expect(daysBetween(parsed('2026-10-29'), parsed('2026-11-02'))).toBe(4);
    expect(daysBetween(parsed('2026-11-02'), parsed('2026-10-29'))).toBe(-4);
  });

  it('is unaffected by a daylight saving change because dates are UTC counters', () => {
    expect(daysBetween(parsed('2026-03-07'), parsed('2026-03-09'))).toBe(2);
  });

  it('agrees with MS_PER_DAY', () => {
    expect(parsed('2026-10-30') - parsed('2026-10-29')).toBe(MS_PER_DAY);
  });
});

describe('names', () => {
  it('names the weekday', () => {
    expect(weekdayName(parsed('2026-10-29'))).toBe('Thursday');
    expect(weekdayName(parsed('2026-11-01'))).toBe('Sunday');
  });

  it('names the month and gives the day and year', () => {
    const time = parsed('2026-12-05');
    expect(monthName(time)).toBe('December');
    expect(dayOfMonth(time)).toBe(5);
    expect(yearOf(time)).toBe(2026);
  });
});

describe('the clock and date in a time zone', () => {
  const evening = Date.parse('2026-11-20T03:30:00Z');

  it('gives the 24-hour clock time in the zone', () => {
    expect(localClockTime('America/New_York', evening)).toBe('22:30');
    expect(localClockTime('Asia/Tokyo', evening)).toBe('12:30');
    expect(localClockTime('America/New_York', Date.parse('2026-11-19T05:05:00Z'))).toBe('00:05');
  });

  it('gives the calendar date in the zone', () => {
    expect(currentLocalDate('America/New_York', evening)).toBe('2026-11-19');
    expect(currentLocalDate('Asia/Tokyo', evening)).toBe('2026-11-20');
  });

  it('answers the same for each zone when asked again', () => {
    expect(localClockTime('America/New_York', evening)).toBe('22:30');
    expect(localClockTime('Asia/Tokyo', evening)).toBe('12:30');
    expect(currentLocalDate('Asia/Tokyo', evening)).toBe('2026-11-20');
  });

  it('gives null for an unknown zone or an invalid time', () => {
    expect(localClockTime('Mars/Olympus', evening)).toBeNull();
    expect(currentLocalDate('Mars/Olympus', evening)).toBeNull();
    expect(localClockTime('America/New_York', Number.NaN)).toBeNull();
    expect(currentLocalDate('America/New_York', Number.NaN)).toBeNull();
  });
});
