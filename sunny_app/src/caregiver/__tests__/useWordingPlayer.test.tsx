// sunny_app/src/caregiver/__tests__/useWordingPlayer.test.tsx
//
// Purpose: Tests for useWordingPlayer with react-test-renderer and expo-speech, expo-audio and
// AppState mocked at the module boundary: a play speaks with the display's language and rate
// after setting the audio session; a session that cannot be set, or a speech engine that throws
// at once, ends in the failed state with nothing playing; a stop tapped during the audio setup
// means nothing is spoken; a second tap on the same card stops it; tapping another card stops
// the first and plays the second, and the first's late "stopped" callback does not clear the
// second; finishing clears the playing card; an
// error marks the card failed; the tab becoming inactive, the app leaving the foreground and
// unmounting each stop the speech.
//
// Last modified: 2026-11-14

import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { SpeechOptions } from 'expo-speech';
import React from 'react';
import { AppState } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { useWordingPlayer, type WordingPlayer } from '../useWordingPlayer';

/** Each speak call, with its options (callbacks included). */
const mockSpoken: { text: string; options: SpeechOptions }[] = [];
const mockStop = jest.fn();
const mockSetAudioMode = jest.fn<(mode: unknown) => Promise<void>>();

/** When set, the next speak call throws synchronously. */
let mockSpeakError: Error | null = null;

jest.mock('expo-speech', () => ({
  speak: (text: string, options: SpeechOptions) => {
    if (mockSpeakError !== null) throw mockSpeakError;
    mockSpoken.push({ text, options });
  },
  stop: () => mockStop(),
}));

jest.mock('expo-audio', () => ({
  setAudioModeAsync: (mode: unknown) => mockSetAudioMode(mode),
}));

jest.mock('../../logging/logger', () => ({
  logger: { info: jest.fn(), warning: jest.fn(), error: jest.fn() },
}));

/** The AppState listener the hook registered. */
let appStateListener: ((state: string) => void) | null = null;
const mockRemove = jest.fn();

/** A rendered hook: the latest player, a re-render with another active flag, and the renderer. */
interface Harness {
  get: () => WordingPlayer;
  setActive: (active: boolean) => void;
  renderer: ReactTestRenderer;
}

/**
 * purpose: Render the real hook and expose its latest return value.
 * @return: (Harness) The harness.
 */
function renderPlayer(): Harness {
  let current!: WordingPlayer;
  const Probe = ({ active }: { active: boolean }): null => {
    current = useWordingPlayer(active);
    return null;
  };
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(<Probe active />);
  });
  return {
    get: () => current,
    setActive: (active) =>
      act(() => {
        renderer.update(<Probe active={active} />);
      }),
    renderer,
  };
}

/**
 * purpose: Tap a card's button and let the audio session promise settle.
 * @param h: (Harness) The harness.
 * @param id: (string) The card.
 * @return: (Promise<void>) Resolves after the tap's async work.
 */
async function tap(h: Harness, id: string): Promise<void> {
  await act(async () => {
    h.get().toggle(id, `sentence ${id}`);
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockSpoken.length = 0;
  mockSpeakError = null;
  mockSetAudioMode.mockResolvedValue(undefined);
  appStateListener = null;
  jest.spyOn(AppState, 'addEventListener').mockImplementation((_type, listener) => {
    appStateListener = listener as (state: string) => void;
    return { remove: mockRemove } as never;
  });
});

describe('useWordingPlayer', () => {
  it('plays with the display voice after setting the audio session to ignore the silent switch', async () => {
    const h = renderPlayer();
    await tap(h, 'a');
    expect(mockSetAudioMode).toHaveBeenCalledWith(
      expect.objectContaining({ playsInSilentMode: true }),
    );
    expect(mockSpoken).toHaveLength(1);
    expect(mockSpoken[0]).toMatchObject({
      text: 'sentence a',
      options: { language: 'en-US', rate: 0.8 },
    });
    expect(h.get().playingId).toBe('a');
  });

  it('an audio session that cannot be set ends in the failed state, nothing playing', async () => {
    mockSetAudioMode.mockRejectedValue(new Error('busy'));
    const h = renderPlayer();
    await tap(h, 'a');
    expect(mockSpoken).toHaveLength(0);
    expect(h.get()).toMatchObject({ playingId: null, failedId: 'a' });
  });

  it('a synchronous throw from the speech engine ends in the failed state', async () => {
    mockSpeakError = new Error('engine gone');
    const h = renderPlayer();
    await tap(h, 'a');
    expect(h.get()).toMatchObject({ playingId: null, failedId: 'a' });
    mockSpeakError = null;
    await tap(h, 'a');
    expect(h.get()).toMatchObject({ playingId: 'a', failedId: null });
  });

  it('a stop tapped while the audio session is being set means nothing is spoken', async () => {
    let release!: () => void;
    mockSetAudioMode.mockReturnValue(
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    const h = renderPlayer();
    act(() => h.get().toggle('a', 'sentence a'));
    expect(h.get().playingId).toBe('a');
    act(() => h.get().toggle('a', 'sentence a'));
    expect(h.get().playingId).toBeNull();
    await act(async () => {
      release();
    });
    expect(mockSpoken).toHaveLength(0);
    expect(h.get()).toMatchObject({ playingId: null, failedId: null });
  });

  it('a second tap on the playing card stops it', async () => {
    const h = renderPlayer();
    await tap(h, 'a');
    await tap(h, 'a');
    expect(mockStop).toHaveBeenCalledTimes(1);
    expect(h.get().playingId).toBeNull();
    expect(mockSpoken).toHaveLength(1);
  });

  it("another card stops the first and plays; the first one's late callback is ignored", async () => {
    const h = renderPlayer();
    await tap(h, 'a');
    await tap(h, 'b');
    expect(mockStop).toHaveBeenCalledTimes(1);
    expect(mockSpoken.map((s) => s.text)).toEqual(['sentence a', 'sentence b']);
    act(() => {
      mockSpoken[0]!.options.onStopped?.();
    });
    expect(h.get().playingId).toBe('b');
    act(() => {
      mockSpoken[1]!.options.onDone?.();
    });
    expect(h.get().playingId).toBeNull();
  });

  it('an error marks the card failed; the next play clears it', async () => {
    const h = renderPlayer();
    await tap(h, 'a');
    act(() => {
      mockSpoken[0]!.options.onError?.(new Error('no voice'));
    });
    expect(h.get()).toMatchObject({ playingId: null, failedId: 'a' });
    await tap(h, 'a');
    expect(h.get()).toMatchObject({ playingId: 'a', failedId: null });
  });

  it('hiding the tab stops the speech', async () => {
    const h = renderPlayer();
    await tap(h, 'a');
    h.setActive(false);
    expect(mockStop).toHaveBeenCalledTimes(1);
    expect(h.get().playingId).toBeNull();
  });

  it('the app leaving the foreground stops the speech', async () => {
    const h = renderPlayer();
    await tap(h, 'a');
    act(() => appStateListener?.('background'));
    expect(mockStop).toHaveBeenCalledTimes(1);
    expect(h.get().playingId).toBeNull();
  });

  it('unmounting stops the speech and the listener', async () => {
    const h = renderPlayer();
    await tap(h, 'a');
    act(() => h.renderer.unmount());
    expect(mockStop).toHaveBeenCalledTimes(1);
    expect(mockRemove).toHaveBeenCalled();
  });

  it('stopping with nothing playing does not call the speech engine', () => {
    const h = renderPlayer();
    h.setActive(false);
    act(() => h.renderer.unmount());
    expect(mockStop).not.toHaveBeenCalled();
  });
});
