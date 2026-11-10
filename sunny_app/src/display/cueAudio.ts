// sunny_app/src/display/cueAudio.ts
//
// Purpose: The sound of the home display's due cue, on the device itself so it works without
// the LiveKit agent: the bundled chime (assets/sounds/chime.wav, made by
// scripts/makeChime.js) through expo-audio, then each line spoken with on-device speech
// (expo-speech) at the tuned rate. Before each cue the iOS audio session is set to the
// playback category with playsInSilentMode, which iOS plays even with the ring/silent switch
// (or the iPad's Control Center mute) on; other audio is ducked, not stopped. The chime player
// keeps the session active when it finishes so the speech right after it is not cut off. The
// LiveKit call takes the session back (play-and-record) when a Talk session starts, and
// releases it when the call ends; no cue plays during a call.
//
// The words matter more than the chime: if the chime cannot play, that is logged, the player
// is released (the next cue creates a fresh one, so a broken player never sticks), and the
// lines are still spoken; the cue then counts as played.
//
// playCue never rejects; it reports how the cue ended (CueResult): played, stopped (its
// AbortSignal fired) or failed (the audio mode or the speech failed, or a line did not finish
// within its time limit, after which the speech is stopped), with how many lines were done
// before that, so a retry can start from the line that failed. A line can be skipped at the
// moment it is due (its task was confirmed during the cue).
//
// Last modified: 2026-11-09

import { createAudioPlayer, setAudioModeAsync } from 'expo-audio';
import type { AudioPlayer } from 'expo-audio';
import * as Speech from 'expo-speech';

import { errorMessage } from '../errors';
import { logger } from '../logging/logger';
import type { DisplayTuning } from './tuning';

/** Language of the spoken prompts. */
const SPEECH_LANGUAGE = 'en-US';

/**
 * Longest wait (ms) for the chime to report it finished. Tied to the asset (1.6 s long), not a
 * tunable: it only guards against a missing completion event.
 */
const CHIME_TIMEOUT_MS = 3_000;

// Metro bundles an asset referenced by require.
const CHIME = require('../../assets/sounds/chime.wav') as number;

/** One line of a cue. */
export interface CueLine {
  text: string;
  /** Asked just before the line is spoken; true skips it. */
  skip?: () => boolean;
}

/** How a cue ended. */
type CueStatus = 'played' | 'stopped' | 'failed';

/** How a cue ended, and how many of its lines were done (spoken or skipped) before that. */
export interface CueResult {
  status: CueStatus;
  done: number;
}

/** The tuning values a cue uses. */
type CueTuning = Pick<
  DisplayTuning,
  'speechRate' | 'afterChimeMs' | 'speechTimeoutMinMs' | 'speechMsPerChar'
>;

/** How one spoken line ended. */
type SpeechResult = 'done' | 'stopped' | 'failed';

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
 * @return: (Promise<void>) Resolves when the chime is over; rejects when the player fails.
 */
async function playChime(signal: AbortSignal): Promise<void> {
  chimePlayer ??= createAudioPlayer(CHIME, { keepAudioSessionActive: true });
  const player = chimePlayer;
  // Aborted by the chime finishing, the timeout or the caller's signal, whichever is first.
  const over = new AbortController();
  /**
   * purpose: Mark the chime as over.
   * @return: (void)
   */
  const end = (): void => over.abort();
  const subscription = player.addListener('playbackStatusUpdate', (status) => {
    if (status.didJustFinish) end();
  });
  signal.addEventListener('abort', end);
  try {
    await player.seekTo(0);
    if (signal.aborted) return;
    player.play();
    await wait(CHIME_TIMEOUT_MS, over.signal);
    if (signal.aborted) player.pause();
  } finally {
    subscription.remove();
    signal.removeEventListener('abort', end);
  }
}

/**
 * purpose: Free the chime player so the next cue creates a fresh one.
 * @return: (void)
 */
function releaseChime(): void {
  const player = chimePlayer;
  chimePlayer = null;
  try {
    player?.remove();
  } catch (error) {
    logger.warning('Cue', `Releasing the chime player failed: ${errorMessage(error)}`);
  }
}

/**
 * purpose: Play the chime; if it cannot play, log it and release the player instead of
 *          failing the cue.
 * @param signal: (AbortSignal) Stops the chime.
 * @return: (Promise<void>) Resolves when the chime is over or has failed; never rejects.
 */
async function chimeIfPossible(signal: AbortSignal): Promise<void> {
  try {
    await playChime(signal);
  } catch (error) {
    logger.warning('Cue', `Chime failed; speaking without it: ${errorMessage(error)}`);
    releaseChime();
  }
}

/**
 * purpose: The longest a line may take before it counts as stuck: the tuned minimum, or the
 *          tuned time per character slowed down by the speech rate, whichever is longer.
 * @param text: (string) The line.
 * @param tuning: (CueTuning) The tuning values.
 * @return: (number) Milliseconds.
 */
function speechLimitMs(text: string, tuning: CueTuning): number {
  return Math.max(
    tuning.speechTimeoutMinMs,
    (text.length * tuning.speechMsPerChar) / tuning.speechRate,
  );
}

/**
 * purpose: Speak one line with on-device speech and wait until it ends. Aborting stops it; a
 *          line that does not end within speechLimitMs is stopped and counts as failed (an
 *          audio interruption can leave the speech engine silent without a callback).
 * @param text: (string) The line.
 * @param signal: (AbortSignal) Stops the speech.
 * @param tuning: (CueTuning) The rate and time limits.
 * @return: (Promise<SpeechResult>) How the line ended.
 */
function speak(text: string, signal: AbortSignal, tuning: CueTuning): Promise<SpeechResult> {
  return new Promise((resolve) => {
    let settled = false;
    /**
     * purpose: Finish once, however the line ended.
     * @param result: (SpeechResult) How it ended.
     * @return: (void)
     */
    const finish = (result: SpeechResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', stop);
      resolve(result);
    };
    /**
     * purpose: Stop the speech because the cue was stopped.
     * @return: (void)
     */
    const stop = (): void => {
      void Speech.stop();
      finish('stopped');
    };
    const timer = setTimeout(
      () => {
        logger.warning('Cue', 'Speech did not finish in time; stopping it');
        void Speech.stop();
        finish('failed');
      },
      speechLimitMs(text, tuning),
    );
    signal.addEventListener('abort', stop);
    Speech.speak(text, {
      language: SPEECH_LANGUAGE,
      rate: tuning.speechRate,
      onDone: () => finish('done'),
      onStopped: () => finish(signal.aborted ? 'stopped' : 'failed'),
      onError: (error) => {
        logger.warning('Cue', `Speech failed: ${errorMessage(error)}`);
        finish('failed');
      },
    });
  });
}

/**
 * purpose: Play one due cue: the chime, then each line spoken in turn.
 * @param lines: (CueLine[]) What to say after the chime.
 * @param signal: (AbortSignal) Stops the cue (chime and speech) at once.
 * @param tuning: (CueTuning) The rate, the pause after the chime and the speech time limits.
 * @return: (Promise<CueResult>) How the cue ended and how many lines were done; never
 *          rejects.
 */
export async function playCue(
  lines: CueLine[],
  signal: AbortSignal,
  tuning: CueTuning,
): Promise<CueResult> {
  let done = 0;
  /**
   * purpose: The result so far with a status.
   * @param status: (CueStatus) How the cue ended.
   * @return: (CueResult) The result.
   */
  const end = (status: CueStatus): CueResult => ({ status, done });
  try {
    await setAudioModeAsync({
      playsInSilentMode: true,
      interruptionMode: 'duckOthers',
      allowsRecording: false,
      shouldPlayInBackground: false,
    });
    if (signal.aborted) return end('stopped');
    await chimeIfPossible(signal);
    await wait(tuning.afterChimeMs, signal);
    for (const line of lines) {
      if (signal.aborted) return end('stopped');
      if (line.skip?.() !== true) {
        const result = await speak(line.text, signal, tuning);
        if (result === 'stopped') return end('stopped');
        if (result === 'failed') return end('failed');
      }
      done += 1;
    }
    return end(signal.aborted ? 'stopped' : 'played');
  } catch (error) {
    logger.warning('Cue', `Cue failed: ${errorMessage(error)}`);
    return end(signal.aborted ? 'stopped' : 'failed');
  }
}
