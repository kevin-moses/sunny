import { describe, expect, it } from '@jest/globals';
import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { useLastDefined } from '../useLastDefined';

interface Day {
  date: string;
}

function renderLast(initial: Day | null | undefined): {
  seen: (Day | null | undefined)[];
  update: (value: Day | null | undefined) => void;
} {
  const seen: (Day | null | undefined)[] = [];
  const Probe = ({ value }: { value: Day | null | undefined }): null => {
    seen.push(useLastDefined(value));
    return null;
  };
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(<Probe value={initial} />);
  });
  const update = (value: Day | null | undefined): void => {
    act(() => {
      renderer.update(<Probe value={value} />);
    });
  };
  return { seen, update };
}

const MONDAY: Day = { date: '2026-11-16' };
const TUESDAY: Day = { date: '2026-11-17' };

describe('useLastDefined', () => {
  it('is undefined until a value arrives', () => {
    const h = renderLast(undefined);
    expect(h.seen).toEqual([undefined]);
    h.update(MONDAY);
    expect(h.seen.at(-1)).toBe(MONDAY);
  });

  it('keeps the last value while the next one loads, in every render', () => {
    const h = renderLast(MONDAY);
    h.update(undefined);
    h.update(undefined);
    expect(h.seen.every((value) => value === MONDAY)).toBe(true);
  });

  it('shows a new value at once, without a render of the old one', () => {
    const h = renderLast(MONDAY);
    h.update(undefined);
    const before = h.seen.length;
    h.update(TUESDAY);
    expect(h.seen.slice(before).every((value) => value === TUESDAY)).toBe(true);
    h.update(undefined);
    expect(h.seen.at(-1)).toBe(TUESDAY);
  });

  it('keeps null as a value rather than a gap', () => {
    const h = renderLast(MONDAY);
    h.update(null);
    expect(h.seen.at(-1)).toBeNull();
    h.update(undefined);
    expect(h.seen.at(-1)).toBeNull();
  });

  it('renders once per update when the value does not change', () => {
    const h = renderLast(MONDAY);
    const before = h.seen.length;
    h.update(MONDAY);
    h.update(undefined);
    expect(h.seen.length - before).toBe(2);
  });

  it('settles after one extra render when the value changes', () => {
    const h = renderLast(MONDAY);
    const before = h.seen.length;
    h.update(TUESDAY);
    expect(h.seen.length - before).toBeLessThanOrEqual(2);
  });
});
