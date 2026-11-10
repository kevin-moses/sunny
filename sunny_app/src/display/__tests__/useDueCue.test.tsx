// sunny_app/src/display/__tests__/useDueCue.test.tsx
//
// Purpose: Tests for the display's due cue, rendering the real useDueCue (and the real
// cueAudio) with react-test-renderer and fake timers. Only the device boundary is mocked:
// expo-audio (the chime player and audio mode), expo-speech, AsyncStorage and the logger.
// The tuning values are the defaults, given through TuningContext with the developer sheet's
// test cue request. Covers: a cue when a task comes due (chime, then the prompt at the tuned
// rate), no repeat on re-render, a repeat on each backend reprompt, once per task across app
// launches, nothing while a voice session is live and the queued cue cueSettleMs after it, no
// cue for a task confirmed meanwhile, a snoozed task's owed cue played once when the snooze
// ends (not again when the backend's withheld reprompt follows) and not at all when it was
// confirmed, stopping a cue when a session starts or the task is confirmed, one chime for
// tasks due together (skipping the line of one confirmed during the cue), a task coming due
// while another cue plays, one retry from the failed line of a cue that failed to play or
// whose speech never finished, the test cue (refused during a session or while a cue plays,
// stopped when the sheet closes), and nothing for anytime tasks.
//
// Last modified: 2026-11-09

import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import type { DayTask } from '../../day/types';
import { SAMPLE_PROMPT } from '../cue';
import { DEFAULT_TUNING } from '../tuning';
import { TuningContext } from '../TuningProvider';
import type { TestCueRequest, TuningControls } from '../TuningProvider';
import { CUED_STORAGE_KEY, TEST_CUE_BLOCKED, TEST_CUE_BUSY, useDueCue } from '../useDueCue';

/** Options the hook passes to Speech.speak. */
interface SpeakOptions {
  rate?: number;
  onDone?: () => void;
  onStopped?: () => void;
  onError?: (error: Error) => void;
}

const mockStore = new Map<string, string>();
const mockSpeech: { text: string; options: SpeakOptions }[] = [];
const mockSpeechStop = jest.fn(async () => {
  mockSpeech.at(-1)?.options.onStopped?.();
});
const mockSetAudioMode = jest.fn(async (_mode: unknown) => undefined);
const mockPlayer = {
  listener: null as ((status: { didJustFinish: boolean }) => void) | null,
  addListener(_event: string, fn: (status: { didJustFinish: boolean }) => void) {
    mockPlayer.listener = fn;
    return { remove: () => (mockPlayer.listener = null) };
  },
  seekTo: jest.fn(async (_seconds: number) => undefined),
  // The chime "plays" for one second of fake time.
  play: jest.fn(() => {
    setTimeout(() => mockPlayer.listener?.({ didJustFinish: true }), 1000);
  }),
  pause: jest.fn(),
};

jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem: async (key: string) => mockStore.get(key) ?? null,
    setItem: async (key: string, value: string) => void mockStore.set(key, value),
  },
}));

jest.mock('expo-audio', () => ({
  createAudioPlayer: () => mockPlayer,
  setAudioModeAsync: (mode: unknown) => mockSetAudioMode(mode),
}));

jest.mock('expo-speech', () => ({
  speak: (text: string, options: SpeakOptions) => mockSpeech.push({ text, options }),
  stop: () => mockSpeechStop(),
}));

jest.mock('../../logging/logger', () => ({
  logger: { info: jest.fn(), warning: jest.fn(), error: jest.fn() },
}));

/**
 * purpose: Build a task.
 * @param overrides: (Partial<Record<keyof DayTask, unknown>>) Fields to set.
 * @return: (DayTask) A due 08:00 medication with a written prompt unless overridden.
 */
function makeTask(overrides: Partial<Record<keyof DayTask, unknown>> = {}): DayTask {
  return {
    instanceId: 't1',
    type: 'medication',
    displayLabel: 'Morning pills',
    spokenPrompt: 'Time for your pills.',
    scheduledTime: '08:00',
    state: 'due',
    seniorPrompts: 0,
    snoozed: false,
    ...overrides,
  } as DayTask;
}

/** The hook's inputs, and the developer sheet's test cue request. */
interface Props {
  tasks: DayTask[] | null;
  blocked: boolean;
  testCue?: TestCueRequest | null;
}

const onCue = jest.fn();
const reportTestCue = jest.fn((_result: string) => undefined);
const renderers: ReactTestRenderer[] = [];

/**
 * purpose: The tree for some inputs: the hook under the tuning context.
 * @param props: (Props) The inputs.
 * @return: (JSX.Element) The tree.
 */
function tree({ tasks, blocked, testCue }: Props) {
  const controls = {
    tuning: DEFAULT_TUNING,
    testCue: testCue ?? null,
    reportTestCue,
  } as unknown as TuningControls;
  return (
    <TuningContext.Provider value={controls}>
      <Probe tasks={tasks} blocked={blocked} />
    </TuningContext.Provider>
  );
}

/**
 * purpose: A component that only runs the hook.
 * @param props: (Props) The day's tasks and whether a voice session is live.
 * @return: (null) Nothing.
 */
function Probe({ tasks, blocked }: Props): null {
  useDueCue(tasks, blocked, onCue);
  return null;
}

/**
 * purpose: Render the real hook with the given inputs and let the stored keys load.
 * @param props: (Props) The first inputs.
 * @return: (Promise<(next: Props) => Promise<void>>) A function that re-renders with new
 *          inputs and lets pending work run.
 */
async function renderCue(props: Props): Promise<(next: Props) => Promise<void>> {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(tree(props));
  });
  renderers.push(renderer);
  await settle(0);
  return async (next: Props) => {
    await act(async () => {
      renderer.update(tree(next));
    });
    await settle(0);
  };
}

/**
 * purpose: Advance fake time and run the promises it releases.
 * @param ms: (number) Milliseconds to advance.
 * @return: (Promise<void>) Resolves after the work ran.
 */
async function settle(ms: number): Promise<void> {
  await act(async () => {
    await jest.advanceTimersByTimeAsync(ms);
  });
}

/**
 * purpose: Finish the line being spoken, as the speech engine would.
 * @return: (Promise<void>) Resolves after the hook reacted.
 */
async function finishSpeech(): Promise<void> {
  await act(async () => {
    mockSpeech.at(-1)?.options.onDone?.();
  });
  await settle(0);
}

/**
 * purpose: The lines spoken so far.
 * @return: (string[]) The texts.
 */
function spoken(): string[] {
  return mockSpeech.map((s) => s.text);
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  mockStore.clear();
  mockSpeech.length = 0;
  mockPlayer.listener = null;
});

afterEach(() => {
  act(() => renderers.splice(0).forEach((r) => r.unmount()));
  jest.useRealTimers();
});

/**
 * purpose: Make the line being spoken fail, as the speech engine would on an error.
 * @return: (Promise<void>) Resolves after the hook reacted.
 */
async function failSpeech(): Promise<void> {
  await act(async () => {
    mockSpeech.at(-1)?.options.onError?.(new Error('speech failed'));
  });
  await settle(0);
}

describe('useDueCue', () => {
  it('chimes, then speaks the prompt slowly when a task comes due', async () => {
    const update = await renderCue({ tasks: [makeTask({ state: 'upcoming' })], blocked: false });
    expect(mockPlayer.play).not.toHaveBeenCalled();
    await update({ tasks: [makeTask()], blocked: false });
    expect(onCue).toHaveBeenCalledTimes(1);
    expect(mockSetAudioMode).toHaveBeenCalledWith(
      expect.objectContaining({ playsInSilentMode: true, allowsRecording: false }),
    );
    expect(mockPlayer.play).toHaveBeenCalledTimes(1);
    expect(spoken()).toEqual([]);
    await settle(1500);
    expect(spoken()).toEqual(['Time for your pills.']);
    expect(mockSpeech[0]!.options.rate).toBe(DEFAULT_TUNING.speechRate);
  });

  it('does not cue again when the day view re-renders', async () => {
    const update = await renderCue({ tasks: [makeTask()], blocked: false });
    await settle(1500);
    await finishSpeech();
    await update({ tasks: [makeTask()], blocked: false });
    await settle(5000);
    expect(mockPlayer.play).toHaveBeenCalledTimes(1);
  });

  it('cues again for each reprompt the backend sends', async () => {
    const update = await renderCue({ tasks: [makeTask({ seniorPrompts: 1 })], blocked: false });
    await settle(1500);
    await finishSpeech();
    // Reprompts come minutes apart, beyond the minimum gap between cues.
    await settle(DEFAULT_TUNING.cueMinGapMs);
    await update({ tasks: [makeTask({ seniorPrompts: 2 })], blocked: false });
    await settle(1500);
    expect(mockPlayer.play).toHaveBeenCalledTimes(2);
    expect(spoken()).toEqual(['Time for your pills.', 'Time for your pills.']);
  });

  it('cues a task already due at launch once, and not after a restart', async () => {
    await renderCue({ tasks: [makeTask()], blocked: false });
    expect(mockPlayer.play).toHaveBeenCalledTimes(1);
    expect(JSON.parse(mockStore.get(CUED_STORAGE_KEY)!)).toEqual(['t1:0']);

    jest.clearAllMocks();
    await renderCue({ tasks: [makeTask()], blocked: false });
    expect(mockPlayer.play).not.toHaveBeenCalled();
  });

  it('waits for a voice session to end, then cues after cueSettleMs', async () => {
    const update = await renderCue({ tasks: [makeTask()], blocked: true });
    await settle(5000);
    expect(mockPlayer.play).not.toHaveBeenCalled();
    await update({ tasks: [makeTask()], blocked: false });
    await settle(DEFAULT_TUNING.cueSettleMs - 1);
    expect(mockPlayer.play).not.toHaveBeenCalled();
    await settle(1);
    expect(mockPlayer.play).toHaveBeenCalledTimes(1);
  });

  it('holds the cue of a snoozed task and plays it once when the snooze ends', async () => {
    const update = await renderCue({
      tasks: [makeTask({ seniorPrompts: 1, snoozed: true })],
      blocked: false,
    });
    await settle(5000);
    expect(mockPlayer.play).not.toHaveBeenCalled();
    // The snooze ends with no new prompt from the backend: the owed cue plays.
    await update({ tasks: [makeTask({ seniorPrompts: 1 })], blocked: false });
    expect(mockPlayer.play).toHaveBeenCalledTimes(1);
    await settle(1500);
    await finishSpeech();
    // The backend's withheld reprompt fires a moment later: absorbed, no second cue.
    await settle(60_000);
    await update({ tasks: [makeTask({ seniorPrompts: 2 })], blocked: false });
    await settle(5000);
    expect(mockPlayer.play).toHaveBeenCalledTimes(1);
  });

  it('plays a reprompt that comes well after the snooze-end cue', async () => {
    const update = await renderCue({ tasks: [makeTask({ snoozed: true })], blocked: false });
    await update({ tasks: [makeTask()], blocked: false });
    await settle(1500);
    await finishSpeech();
    await settle(DEFAULT_TUNING.cueMinGapMs);
    await update({ tasks: [makeTask({ seniorPrompts: 1 })], blocked: false });
    expect(mockPlayer.play).toHaveBeenCalledTimes(2);
  });

  it('plays no cue for a snoozed task confirmed before its snooze ended', async () => {
    const update = await renderCue({ tasks: [makeTask({ snoozed: true })], blocked: false });
    await update({ tasks: [makeTask({ state: 'confirmed' })], blocked: false });
    await settle(10_000);
    expect(mockPlayer.play).not.toHaveBeenCalled();
  });

  it('plays a cue owed during a session that the senior snoozed, once the snooze ends', async () => {
    const update = await renderCue({ tasks: [makeTask()], blocked: true });
    await update({ tasks: [makeTask({ snoozed: true })], blocked: true });
    await update({ tasks: [makeTask({ snoozed: true })], blocked: false });
    await settle(10_000);
    expect(mockPlayer.play).not.toHaveBeenCalled();
    await update({ tasks: [makeTask()], blocked: false });
    expect(mockPlayer.play).toHaveBeenCalledTimes(1);
  });

  it('drops a queued cue when the task was confirmed during the session', async () => {
    const update = await renderCue({ tasks: [makeTask()], blocked: true });
    await update({ tasks: [makeTask({ state: 'confirmed' })], blocked: true });
    await update({ tasks: [makeTask({ state: 'confirmed' })], blocked: false });
    await settle(5000);
    expect(mockPlayer.play).not.toHaveBeenCalled();
  });

  it('stops the cue when a voice session starts, and does not replay it', async () => {
    const update = await renderCue({ tasks: [makeTask()], blocked: false });
    await settle(1500);
    expect(spoken()).toHaveLength(1);
    await update({ tasks: [makeTask()], blocked: true });
    expect(mockSpeechStop).toHaveBeenCalled();
    await update({ tasks: [makeTask()], blocked: false });
    await settle(5000);
    expect(mockPlayer.play).toHaveBeenCalledTimes(1);
  });

  it('stops the chime and skips the prompt when the task is confirmed during the chime', async () => {
    const update = await renderCue({ tasks: [makeTask()], blocked: false });
    await update({ tasks: [makeTask({ state: 'confirmed' })], blocked: false });
    expect(mockPlayer.pause).toHaveBeenCalled();
    await settle(5000);
    expect(spoken()).toEqual([]);
  });

  it('skips the line of a task confirmed during a two-task cue', async () => {
    const a = makeTask({ instanceId: 'a', spokenPrompt: 'First.' });
    const b = makeTask({ instanceId: 'b', spokenPrompt: 'Second.' });
    const update = await renderCue({ tasks: [a, b], blocked: false });
    await update({ tasks: [a, { ...b, state: 'confirmed' } as DayTask], blocked: false });
    await settle(1500);
    await finishSpeech();
    expect(spoken()).toEqual(['First.']);
  });

  it('cues a task that comes due while another cue plays, after that cue', async () => {
    const a = makeTask({ instanceId: 'a', spokenPrompt: 'First.' });
    const b = makeTask({ instanceId: 'b', spokenPrompt: 'Second.' });
    const update = await renderCue({ tasks: [a], blocked: false });
    await update({ tasks: [a, b], blocked: false });
    expect(mockPlayer.play).toHaveBeenCalledTimes(1);
    await settle(1500);
    await finishSpeech();
    expect(mockPlayer.play).toHaveBeenCalledTimes(2);
    await settle(1500);
    expect(spoken()).toEqual(['First.', 'Second.']);
  });

  it('retries once a cue that failed to play, then gives up', async () => {
    mockSetAudioMode.mockRejectedValue(new Error('audio session busy'));
    await renderCue({ tasks: [makeTask()], blocked: false });
    expect(mockPlayer.play).not.toHaveBeenCalled();
    expect(mockSetAudioMode).toHaveBeenCalledTimes(1);
    await settle(DEFAULT_TUNING.cueRetryMs);
    expect(mockSetAudioMode).toHaveBeenCalledTimes(2);
    await settle(10 * DEFAULT_TUNING.cueRetryMs);
    expect(mockSetAudioMode).toHaveBeenCalledTimes(2);
    mockSetAudioMode.mockResolvedValue(undefined);
  });

  it('stops speech that never finishes and retries the cue once', async () => {
    await renderCue({ tasks: [makeTask()], blocked: false });
    await settle(1500);
    expect(spoken()).toHaveLength(1);
    await settle(DEFAULT_TUNING.speechTimeoutMinMs);
    expect(mockSpeechStop).toHaveBeenCalled();
    await settle(DEFAULT_TUNING.cueRetryMs + 1500);
    expect(mockPlayer.play).toHaveBeenCalledTimes(2);
    await settle(1500);
    expect(spoken()).toHaveLength(2);
  });

  it('retries a two-task cue from the line that failed, not from the start', async () => {
    const a = makeTask({ instanceId: 'a', spokenPrompt: 'First.' });
    const b = makeTask({ instanceId: 'b', spokenPrompt: 'Second.' });
    await renderCue({ tasks: [a, b], blocked: false });
    await settle(1500);
    await finishSpeech();
    expect(spoken()).toEqual(['First.', 'Second.']);
    await failSpeech();
    await settle(DEFAULT_TUNING.cueRetryMs + 1500);
    expect(mockPlayer.play).toHaveBeenCalledTimes(2);
    await settle(1500);
    expect(spoken()).toEqual(['First.', 'Second.', 'Second.']);
  });

  it('plays one chime for tasks due together and speaks them in day order', async () => {
    const tasks = [
      makeTask({ instanceId: 'a', spokenPrompt: 'First.' }),
      makeTask({ instanceId: 'b', spokenPrompt: 'Second.' }),
    ];
    await renderCue({ tasks, blocked: false });
    await settle(1500);
    await finishSpeech();
    expect(mockPlayer.play).toHaveBeenCalledTimes(1);
    expect(spoken()).toEqual(['First.', 'Second.']);
  });

  it('plays the test cue when nothing else is going on, and reports it', async () => {
    const update = await renderCue({ tasks: [], blocked: false });
    await update({ tasks: [], blocked: false, testCue: { id: 1, active: true } });
    await settle(1500);
    expect(spoken()).toEqual([SAMPLE_PROMPT]);
    await finishSpeech();
    expect(reportTestCue).toHaveBeenCalledWith('played');
    expect(onCue).not.toHaveBeenCalled();
  });

  it('refuses the test cue during a voice session and says why', async () => {
    const update = await renderCue({ tasks: [], blocked: true });
    await update({ tasks: [], blocked: true, testCue: { id: 1, active: true } });
    await settle(5000);
    expect(mockSetAudioMode).not.toHaveBeenCalled();
    expect(reportTestCue).toHaveBeenCalledWith(TEST_CUE_BLOCKED);
  });

  it('never lets the test cue overlap a real cue', async () => {
    const update = await renderCue({ tasks: [makeTask()], blocked: false });
    await update({ tasks: [makeTask()], blocked: false, testCue: { id: 1, active: true } });
    await settle(1500);
    expect(reportTestCue).toHaveBeenCalledWith(TEST_CUE_BUSY);
    expect(mockPlayer.play).toHaveBeenCalledTimes(1);
    expect(spoken()).toEqual(['Time for your pills.']);
  });

  it('stops the test cue when the sheet closes', async () => {
    const update = await renderCue({ tasks: [], blocked: false });
    await update({ tasks: [], blocked: false, testCue: { id: 1, active: true } });
    await settle(1500);
    await update({ tasks: [], blocked: false, testCue: { id: 1, active: false } });
    expect(mockSpeechStop).toHaveBeenCalled();
    expect(reportTestCue).toHaveBeenCalledWith('stopped');
  });

  it('never cues an anytime task', async () => {
    await renderCue({ tasks: [makeTask({ scheduledTime: 'anytime' })], blocked: false });
    await settle(5000);
    expect(mockPlayer.play).not.toHaveBeenCalled();
  });

  it('does nothing while the day is loading', async () => {
    await renderCue({ tasks: null, blocked: false });
    await settle(5000);
    expect(mockPlayer.play).not.toHaveBeenCalled();
    expect(onCue).not.toHaveBeenCalled();
  });
});
