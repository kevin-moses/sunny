// sunny_app/src/display/cueAudio.ts
//
// Purpose: The sound of the home display's due cue, on the device itself so it works without
// the LiveKit agent: the bundled chime (assets/sounds/chime.wav, made by
// scripts/makeChime.js) through expo-audio, then each line spoken with on-device speech
// (expo-speech) at the slow SPEECH_RATE. Before each cue the iOS audio session is set to the
// playback category with playsInSilentMode, which iOS plays even with the ring/silent switch
// (or the iPad's Control Center mute) on; other audio is ducked, not stopped. The chime player
// keeps the session active when it finishes so the speech right after it is not cut off. The
// LiveKit call takes the session back (play-and-record) when a Talk session starts, and
// releases it when the call ends; no cue plays during a call.
//
// playCue never rejects: failures are logged and the cue ends. An AbortSignal stops it at once.
//
// Last modified: 2026-11-09

import { createAudioPlayer, setAudioModeAsync } from 'expo-audio';
import type { AudioPlayer } from 'expo-audio';
import * as Speech from 'expo-speech';

import { errorMessage } from '../errors';
import { logger } from '../logging/logger';

/** Speech rate, as a multiple of the system's normal rate; slow, for the senior. */
export const SPEECH_RATE = 0.8;

/** Language of the spoken prompts. */
const SPEECH_LANGUAGE = 'en-US';

/** Longest wait (ms) for the chime to report it finished (it is 1.6 s long). */
const CHIME_TIMEOUT_MS = 3_000;

/** Pause (ms) between the chime and the first spoken line. */
const AFTER_CHIME_MS = 300;

// Metro bundles an asset referenced by require.
const CHIME = require('../../assets/sounds/chime.wav') as number;

/** The chime player, created on first use and reused. */
let chimePlayer: AudioPlayer | null = null;

/**
 * purpose: Wait for a time, or until the signal aborts.
 * @param ms: (number) Milliseconds.
 * @param signal: (AbortSignal) Ends the wait early.
 * @return: (Promise<void>) Resolves when the time passed or the signal aborted.
 */
function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done);
    /**
     * purpose: Finish the wait once.
     * @return: (void)
     */
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
  });
}

/**
 * purpose: Play the chime from the start and wait until it finishes (or CHIME_TIMEOUT_MS, or
 *          the signal aborts, which pauses it).
 * @param signal: (AbortSignal) Stops the chime.
 * @return: (Promise<void>) Resolves when the chime is over.
 */
async function playChime(signal: AbortSignal): Promise<void> {
  chimePlayer ??= createAudioPlayer(CHIME, { keepAudioSessionActive: true });
  const player = chimePlayer;
  // Aborted by the chime finishing, the timeout or the caller's signal, whichever is first.
  const over = new AbortController();
  const end = (): void => over.abort();
  const subscription = player.addListener('playbackStatusUpdate', (status) => {
    if (status.didJustFinish) end();
  });
  signal.addEventListener('abort', end);
  try {
    await player.seekTo(0);
    player.play();
    await wait(CHIME_TIMEOUT_MS, over.signal);
    if (signal.aborted) player.pause();
  } finally {
    subscription.remove();
    signal.removeEventListener('abort', end);
  }
}

/**
 * purpose: Speak one line with on-device speech and wait until it is done; aborting stops it.
 * @param text: (string) The line.
 * @param signal: (AbortSignal) Stops the speech.
 * @return: (Promise<void>) Resolves when the line was spoken, stopped or failed.
 */
function speak(text: string, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const stop = (): void => {
      void Speech.stop();
    };
    /**
     * purpose: Finish once the speech ended in any way.
     * @return: (void)
     */
    const done = (): void => {
      signal.removeEventListener('abort', stop);
      resolve();
    };
    signal.addEventListener('abort', stop);
    Speech.speak(text, {
      language: SPEECH_LANGUAGE,
      rate: SPEECH_RATE,
      onDone: done,
      onStopped: done,
      onError: (error) => {
        logger.warning('Cue', `Speech failed: ${errorMessage(error)}`);
        done();
      },
    });
  });
}

/**
 * purpose: Play one due cue: the chime, then each line spoken in turn.
 * @param lines: (string[]) What to say after the chime.
 * @param signal: (AbortSignal) Stops the cue (chime and speech) at once.
 * @return: (Promise<void>) Resolves when the cue finished or stopped; never rejects.
 */
export async function playCue(lines: string[], signal: AbortSignal): Promise<void> {
  try {
    await setAudioModeAsync({
      playsInSilentMode: true,
      interruptionMode: 'duckOthers',
      allowsRecording: false,
      shouldPlayInBackground: false,
    });
    if (signal.aborted) return;
    await playChime(signal);
    await wait(AFTER_CHIME_MS, signal);
    for (const line of lines) {
      if (signal.aborted) return;
      await speak(line, signal);
    }
  } catch (error) {
    logger.warning('Cue', `Cue failed: ${errorMessage(error)}`);
  }
}
