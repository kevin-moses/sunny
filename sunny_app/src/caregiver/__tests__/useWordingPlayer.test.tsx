import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { SpeechOptions } from 'expo-speech';
import React from 'react';
import { AppState } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { useWordingPlayer, type WordingPlayer } from '../useWordingPlayer';

const mockSpoken: { text: string; options: SpeechOptions }[] = [];
const mockStop = jest.fn();
const mockSetAudioMode = jest.fn<(mode: unknown) => Promise<void>>();

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

let appStateListener: ((state: string) => void) | null = null;
const mockRemove = jest.fn();

interface Harness {
  get: () => WordingPlayer;
  setActive: (active: boolean) => void;
  renderer: ReactTestRenderer;
}

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

  it('an audio session that cannot be set is logged and the sentence is spoken anyway', async () => {
    mockSetAudioMode.mockRejectedValue(new Error('busy'));
    const h = renderPlayer();
    await tap(h, 'a');
    expect(mockSpoken.map((s) => s.text)).toEqual(['sentence a']);
    expect(h.get()).toMatchObject({ playingId: 'a', failedId: null });
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
