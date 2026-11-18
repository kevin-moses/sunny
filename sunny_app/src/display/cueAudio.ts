import { createAudioPlayer, setAudioModeAsync } from 'expo-audio';
import type { AudioPlayer } from 'expo-audio';
import * as Speech from 'expo-speech';

import { errorMessage } from '../errors';
import { logger } from '../logging/logger';
import { SPEECH_AUDIO_MODE, SPEECH_LANGUAGE } from './tuning';
import type { DisplayTuning } from './tuning';

const CHIME_TIMEOUT_MS = 3_000;

const CHIME = require('../../assets/sounds/chime.wav') as number;

export interface CueLine {
  text: string;
  skip?: () => boolean;
}

type CueStatus = 'played' | 'stopped' | 'failed';

export interface CueResult {
  status: CueStatus;
  done: number;
}

type CueTuning = Pick<
  DisplayTuning,
  'speechRate' | 'afterChimeMs' | 'speechTimeoutMinMs' | 'speechMsPerChar'
>;

type SpeechResult = 'done' | 'stopped' | 'failed';

let chimePlayer: AudioPlayer | null = null;

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done);
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
  });
}

async function playChime(signal: AbortSignal): Promise<void> {
  chimePlayer ??= createAudioPlayer(CHIME, { keepAudioSessionActive: true });
  const player = chimePlayer;
  const over = new AbortController();
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

function releaseChime(): void {
  const player = chimePlayer;
  chimePlayer = null;
  try {
    player?.remove();
  } catch (error) {
    logger.warning('Cue', `Releasing the chime player failed: ${errorMessage(error)}`);
  }
}

async function chimeIfPossible(signal: AbortSignal): Promise<void> {
  try {
    await playChime(signal);
  } catch (error) {
    logger.warning('Cue', `Chime failed; speaking without it: ${errorMessage(error)}`);
    releaseChime();
  }
}

function speechLimitMs(text: string, tuning: CueTuning): number {
  return Math.max(
    tuning.speechTimeoutMinMs,
    (text.length * tuning.speechMsPerChar) / tuning.speechRate,
  );
}

function speak(text: string, signal: AbortSignal, tuning: CueTuning): Promise<SpeechResult> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: SpeechResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', stop);
      resolve(result);
    };
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

export async function playCue(
  lines: CueLine[],
  signal: AbortSignal,
  tuning: CueTuning,
): Promise<CueResult> {
  let done = 0;
  const end = (status: CueStatus): CueResult => ({ status, done });
  try {
    await setAudioModeAsync(SPEECH_AUDIO_MODE);
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
