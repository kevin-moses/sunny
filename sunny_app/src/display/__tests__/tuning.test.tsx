// sunny_app/src/display/__tests__/tuning.test.tsx
//
// Purpose: Tests for the display's tunables: clamping and rounding (tuning.ts), the start
// timeout's bound against the voice layer's agent wait on the display, turning
// stored data back into valid values, the display text, and TuningProvider rendered for real
// with AsyncStorage mocked: defaults before anything is saved, saved values loaded at start,
// a change made before they load kept, saved values ignored (and nothing saved) where the
// developer sheet does not exist, changes clamped, saved and applied at once, reset restoring
// and saving the defaults,
// useTuning's defaults outside a provider, and the sample answer request.
//
// Last modified: 2026-11-09

import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import React from 'react';
import { act, create } from 'react-test-renderer';

import {
  DEFAULT_TUNING,
  TUNING_KEYS,
  TUNING_SPECS,
  clampTuning,
  formatTuning,
  sanitizeTuning,
} from '../tuning';
import {
  TUNING_STORAGE_KEY,
  TuningProvider,
  useTuning,
  useTuningControls,
} from '../TuningProvider';
import type { TuningControls } from '../TuningProvider';
import type { DisplayTuning } from '../tuning';
import { DISPLAY_AGENT_CONNECT_TIMEOUT_MS } from '../../voice/agentTimeouts';

const mockStore = new Map<string, string>();
// When set, reads wait for it, so a test can change a value before the load lands.
let mockReadGate: Promise<void> | null = null;

jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem: async (key: string) => {
      if (mockReadGate !== null) await mockReadGate;
      return mockStore.get(key) ?? null;
    },
    setItem: async (key: string, value: string) => void mockStore.set(key, value),
  },
}));

beforeEach(() => {
  mockStore.clear();
  mockReadGate = null;
});

describe('clampTuning', () => {
  it('keeps every default as it is', () => {
    for (const key of TUNING_KEYS) {
      expect(clampTuning(key, TUNING_SPECS[key].default)).toBe(TUNING_SPECS[key].default);
    }
  });

  it('never goes below the minimum, so a typo cannot make a 0 ms timeout', () => {
    expect(clampTuning('firstQuestionMs', 0)).toBe(TUNING_SPECS.firstQuestionMs.min);
    expect(clampTuning('startTimeoutMs', -5)).toBe(TUNING_SPECS.startTimeoutMs.min);
  });

  it('never goes above the maximum, so the microphone always closes', () => {
    expect(clampTuning('followUpMs', 10_000_000)).toBe(TUNING_SPECS.followUpMs.max);
    expect(clampTuning('stuckMs', Infinity)).toBe(TUNING_SPECS.stuckMs.default);
  });

  it('rounds to the step without floating point noise', () => {
    expect(clampTuning('speechRate', 0.8 + 0.05)).toBe(0.85);
    expect(clampTuning('firstQuestionMs', 12_345)).toBe(12_000);
  });

  it('turns a non-number into the default', () => {
    expect(clampTuning('speechRate', '1')).toBe(DEFAULT_TUNING.speechRate);
    expect(clampTuning('speechRate', Number.NaN)).toBe(DEFAULT_TUNING.speechRate);
  });
});

describe('startTimeoutMs', () => {
  it("can never be tuned above LiveKit's agent wait on the display", () => {
    expect(TUNING_SPECS.startTimeoutMs.max).toBeLessThanOrEqual(DISPLAY_AGENT_CONNECT_TIMEOUT_MS);
    expect(clampTuning('startTimeoutMs', 10 * DISPLAY_AGENT_CONNECT_TIMEOUT_MS)).toBe(
      DISPLAY_AGENT_CONNECT_TIMEOUT_MS,
    );
  });
});

describe('sanitizeTuning', () => {
  it('fills missing and bad fields with defaults and clamps the rest', () => {
    expect(sanitizeTuning({ followUpMs: 1, carouselMs: 'x', extra: 5 })).toEqual({
      ...DEFAULT_TUNING,
      followUpMs: TUNING_SPECS.followUpMs.min,
    });
    expect(sanitizeTuning(null)).toEqual(DEFAULT_TUNING);
  });
});

describe('formatTuning', () => {
  it('shows durations in seconds or milliseconds, and the rate as a multiple', () => {
    expect(formatTuning('firstQuestionMs', 20_000)).toBe('20 s');
    expect(formatTuning('afterChimeMs', 300)).toBe('300 ms');
    expect(formatTuning('speechRate', 0.8)).toBe('0.80x');
  });
});

/**
 * purpose: Render the real provider and expose its controls.
 * @param persisted: (boolean) Whether saved values are used (the developer sheet exists).
 * @return: (Promise<() => TuningControls>) A getter for the latest controls.
 */
async function renderProvider(persisted = true): Promise<() => TuningControls> {
  let current!: TuningControls;
  const Probe = (): null => {
    current = useTuningControls()!;
    return null;
  };
  await act(async () => {
    create(
      <TuningProvider persisted={persisted}>
        <Probe />
      </TuningProvider>,
    );
  });
  return () => current;
}

/**
 * purpose: The saved tunables.
 * @return: (DisplayTuning | null) The parsed stored value, or null when nothing is stored.
 */
function saved(): DisplayTuning | null {
  const raw = mockStore.get(TUNING_STORAGE_KEY);
  return raw === undefined ? null : (JSON.parse(raw) as DisplayTuning);
}

describe('TuningProvider', () => {
  it('starts at the defaults when nothing is saved', async () => {
    const get = await renderProvider();
    expect(get().tuning).toEqual(DEFAULT_TUNING);
  });

  it('loads the saved values, clamped', async () => {
    mockStore.set(TUNING_STORAGE_KEY, JSON.stringify({ followUpMs: 15_000, stuckMs: 1 }));
    const get = await renderProvider();
    expect(get().tuning.followUpMs).toBe(15_000);
    expect(get().tuning.stuckMs).toBe(TUNING_SPECS.stuckMs.min);
  });

  it('keeps a change made before the saved values finish loading', async () => {
    mockStore.set(TUNING_STORAGE_KEY, JSON.stringify({ followUpMs: 15_000 }));
    let open!: () => void;
    mockReadGate = new Promise((resolve) => {
      open = resolve;
    });
    const get = await renderProvider();
    await act(async () => get().setValue('followUpMs', 4_000));
    await act(async () => open());
    expect(get().tuning.followUpMs).toBe(4_000);
  });

  it('ignores saved values and saves nothing where the developer sheet does not exist', async () => {
    mockStore.set(TUNING_STORAGE_KEY, JSON.stringify({ followUpMs: 15_000 }));
    const get = await renderProvider(false);
    expect(get().tuning).toEqual(DEFAULT_TUNING);
    await act(async () => get().setValue('stuckMs', 30_000));
    expect(get().tuning.stuckMs).toBe(30_000);
    expect(saved()).toEqual({ followUpMs: 15_000 });
  });

  it('clamps, saves and applies a change at once', async () => {
    const get = await renderProvider();
    await act(async () => get().setValue('followUpMs', 2));
    expect(get().tuning.followUpMs).toBe(TUNING_SPECS.followUpMs.min);
    expect(saved()?.followUpMs).toBe(TUNING_SPECS.followUpMs.min);
  });

  it('resets to the defaults and saves them', async () => {
    const get = await renderProvider();
    await act(async () => get().setValue('speechRate', 1.1));
    await act(async () => get().resetToDefaults());
    expect(get().tuning).toEqual(DEFAULT_TUNING);
    expect(saved()).toEqual(DEFAULT_TUNING);
  });

  it('numbers each sample answer request', async () => {
    const get = await renderProvider();
    expect(get().sample).toBeNull();
    await act(async () => get().showSampleAnswer('Hi.'));
    await act(async () => get().showSampleAnswer('Hi.'));
    expect(get().sample).toEqual({ text: 'Hi.', id: 2 });
  });
});

describe('useTuning', () => {
  it('returns the defaults outside a provider', () => {
    let current!: DisplayTuning;
    const Probe = (): null => {
      current = useTuning();
      return null;
    };
    act(() => {
      create(<Probe />);
    });
    expect(current).toEqual(DEFAULT_TUNING);
  });
});
