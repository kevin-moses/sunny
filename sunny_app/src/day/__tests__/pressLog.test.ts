import { describe, expect, it } from '@jest/globals';

import { hasUnsent, isLoggedPress, oldestUnsentAt, type LoggedPress } from '../pressLog';

const press: LoggedPress = { pressId: 'P1', instanceId: 'inst1', step: 0, pressedAt: 1_000 };

describe('isLoggedPress', () => {
  it('accepts a press with or without its answer and undo', () => {
    expect(isLoggedPress(press)).toBe(true);
    expect(isLoggedPress({ ...press, answer: { applied: true, answeredPresses: 4 } })).toBe(true);
    expect(isLoggedPress({ ...press, answer: { applied: false } })).toBe(true);
    expect(isLoggedPress({ ...press, undo: { undoneAt: 2_000, answer: { applied: true } } })).toBe(
      true,
    );
  });

  it('refuses anything else the bridge could hand over', () => {
    const bad: unknown[] = [
      null,
      'press',
      { ...press, pressId: 7 },
      { ...press, instanceId: undefined },
      { ...press, step: 0.5 },
      { ...press, pressedAt: Number.NaN },
      { ...press, answer: { applied: 'yes' } },
      { ...press, answer: { applied: true, answeredPresses: 1.5 } },
      { ...press, undo: {} },
      { ...press, undo: { undoneAt: 2_000, answer: { applied: 1 } } },
    ];
    expect(bad.filter(isLoggedPress)).toEqual([]);
  });
});

describe('unsent presses', () => {
  const answered = { applied: true, answeredPresses: 1 };

  it('counts a press or an undo that the server has not answered', () => {
    expect(hasUnsent(press)).toBe(true);
    expect(hasUnsent({ ...press, answer: answered })).toBe(false);
    expect(hasUnsent({ ...press, answer: answered, undo: { undoneAt: 2_000 } })).toBe(true);
    expect(
      hasUnsent({ ...press, answer: answered, undo: { undoneAt: 2_000, answer: answered } }),
    ).toBe(false);
  });

  it('names the oldest press that still has something unsent', () => {
    expect(oldestUnsentAt([])).toBeNull();
    expect(oldestUnsentAt([{ ...press, answer: answered }])).toBeNull();
    expect(
      oldestUnsentAt([
        { ...press, pressedAt: 3_000 },
        { ...press, pressedAt: 1_000, answer: answered },
        { ...press, pressedAt: 2_000, answer: answered, undo: { undoneAt: 2_500 } },
      ]),
    ).toBe(2_000);
  });
});
