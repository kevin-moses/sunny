// sunny_app/src/day/__tests__/localDate.test.ts
//
// Purpose: Unit tests for the local date helpers: parsing and validation, formatting, day
// shifting across month, year and leap boundaries, day differences, and weekday, month, day of
// month and year names. 2026-10-29 is a Thursday.
//
// Last modified: 2026-10-31

import { describe, expect, it } from '@jest/globals';

import {
  addDays,
  dayOfMonth,
  daysBetween,
  formatLocalDate,
  monthName,
  MS_PER_DAY,
  parseLocalDate,
  weekdayName,
  yearOf,
} from '../localDate';

/**
 * purpose: Parse a date that must be valid.
 * @param localDate: (string) "YYYY-MM-DD".
 * @return: (number) The day counter.
 */
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
