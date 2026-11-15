import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import React from 'react';
import { act, create } from 'react-test-renderer';

import type { TaskCard } from '../model';
import { DEFAULT_TUNING } from '../tuning';
import { TuningContext } from '../TuningProvider';
import type { TuningControls } from '../TuningProvider';
import { useDisplayKeys } from '../useDisplayKeys';
import type { DisplayKeys } from '../useDisplayKeys';

const mockMutation = jest.fn(
  async (..._args: unknown[]): Promise<{ state: string; currentStep?: number }> => ({
    state: 'confirmed',
  }),
);

jest.mock('@react-native-async-storage/async-storage', () =>
  jest.requireActual('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

jest.mock('../../backend/api', () => ({
  callMutation: (...args: unknown[]) => mockMutation(...args),
  toBackendError: (error: unknown) => ({ message: String(error) }),
}));

const talk = jest.fn();
const show = jest.fn((_text: string) => undefined);
const onPress = jest.fn();

const CARD = {
  kind: 'task',
  task: { instanceId: 't1', displayLabel: 'Morning pills', type: 'medication' },
  overdue: false,
  steps: null,
} as unknown as TaskCard;

function renderKeys(
  card: TaskCard | null,
  pressGapMs: number = DEFAULT_TUNING.pressGapMs,
): () => DisplayKeys {
  let current!: DisplayKeys;
  const Probe = (): null => {
    current = useDisplayKeys(card, onPress, show, talk);
    return null;
  };
  const controls = { tuning: { ...DEFAULT_TUNING, pressGapMs } } as TuningControls;
  act(() => {
    create(
      <TuningContext.Provider value={controls}>
        <Probe />
      </TuningContext.Provider>,
    );
  });
  return () => current;
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(new Date('2026-11-09T09:00:00Z'));
  jest.clearAllMocks();
});

afterEach(() => {
  jest.useRealTimers();
});

describe('useDisplayKeys', () => {
  it('hands Talk to the voice layer and ignores a second press inside the gap', () => {
    const get = renderKeys(null);
    act(() => get().pressTalk());
    act(() => get().pressTalk());
    expect(talk).toHaveBeenCalledTimes(1);
    act(() => {
      jest.advanceTimersByTime(DEFAULT_TUNING.pressGapMs);
    });
    act(() => get().pressTalk());
    expect(talk).toHaveBeenCalledTimes(2);
    expect(onPress).toHaveBeenCalledTimes(2);
  });

  it('uses the tuned press gap', () => {
    const get = renderKeys(null, 1_500);
    act(() => get().pressTalk());
    act(() => {
      jest.advanceTimersByTime(1_000);
    });
    act(() => get().pressTalk());
    expect(talk).toHaveBeenCalledTimes(1);
  });

  it('treats Done then Talk inside the gap as one press', () => {
    const get = renderKeys(null);
    act(() => get().pressDone());
    act(() => get().pressTalk());
    expect(talk).not.toHaveBeenCalled();
    expect(show).toHaveBeenCalledWith('Nothing to mark done right now');
  });

  it('confirms the task on the screen with Done', async () => {
    const get = renderKeys(CARD);
    await act(async () => {
      get().pressDone();
    });
    expect(mockMutation).toHaveBeenCalledWith(expect.anything(), {
      instanceId: 't1',
      via: 'button',
    });
    expect(show).toHaveBeenLastCalledWith('Checked off: Morning pills');
    expect(talk).not.toHaveBeenCalled();
  });

  it('sends every Done of a multi-step task and names the step the backend advanced past', async () => {
    const steps = ['Put on your coat', 'Take your keys', 'Lock the door'];
    const card = {
      ...CARD,
      task: { ...CARD.task, step: { index: 1, count: 3, text: 'Take your keys' } },
      steps,
    } as unknown as TaskCard;
    mockMutation.mockResolvedValueOnce({ state: 'due', currentStep: 2 });
    const get = renderKeys(card);
    await act(async () => {
      get().pressDone();
    });
    expect(mockMutation).toHaveBeenCalledTimes(1);
    expect(mockMutation).toHaveBeenCalledWith(expect.anything(), {
      instanceId: 't1',
      via: 'button',
    });
    expect(show).toHaveBeenLastCalledWith('Step 2 done');
  });
});
