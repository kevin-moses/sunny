// sunny_app/src/caregiver/useWordingPlayer.ts
//
// Purpose: Plays the sentence of a wording card in the caregiver's Chat tab, so the caregiver
// hears what the senior will hear: on-device speech (expo-speech) with the home display's voice
// settings (tuning.ts SPEECH_LANGUAGE and the default speech rate, DEFAULT_TUNING.speechRate).
// The audio session plays even with the ring/silent switch on, ducking other audio, as the
// display's cue does; if setting it fails the sentence is still spoken.
// Rules: one sentence plays at a time; tapping the playing card's button stops it, and tapping
// another card's button stops the first and plays the second. Leaving the screen stops it: the
// tab becoming inactive (the Chat tab stays mounted but hidden), the app leaving the foreground,
// or the screen unmounting. A sentence that cannot be spoken is reported for that card
// (failedId), so a tap is never silently ignored. Callbacks of a sentence that was already
// replaced or stopped are ignored (each play has its own token).
//
// Last modified: 2026-11-14

import { setAudioModeAsync } from 'expo-audio';
import * as Speech from 'expo-speech';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';

import { DEFAULT_TUNING, SPEECH_LANGUAGE } from '../display/tuning';
import { errorMessage } from '../errors';
import { logger } from '../logging/logger';

/** What the Chat tab needs from the player. */
export interface WordingPlayer {
  /** The card whose sentence is playing, or null. */
  playingId: string | null;
  /** The card whose last play failed, or null. */
  failedId: string | null;
  /** Play a card's sentence, or stop it when it is the one playing. */
  toggle: (id: string, sentence: string) => void;
}

/**
 * purpose: Set the audio session so speech plays with the silent switch on, ducking other audio.
 * @return: (Promise<void>) Resolves when set; a failure is logged and the speech goes ahead.
 */
async function prepareAudio(): Promise<void> {
  try {
    await setAudioModeAsync({
      playsInSilentMode: true,
      interruptionMode: 'duckOthers',
      allowsRecording: false,
      shouldPlayInBackground: false,
    });
  } catch (error) {
    logger.warning('Wording', `Audio mode failed; speaking anyway: ${errorMessage(error)}`);
  }
}

/**
 * purpose: Play wording card sentences one at a time (see the file header for the rules).
 * @param active: (boolean) Whether the Chat tab is showing; false stops what is playing.
 * @return: (WordingPlayer) The playing and failed card and the toggle.
 */
export function useWordingPlayer(active: boolean): WordingPlayer {
  const [playingId, setPlayingId] = useState<string | null>(null);
  const [failedId, setFailedId] = useState<string | null>(null);
  // The token of the latest play or stop; a callback carrying an older token is stale.
  const tokenRef = useRef(0);
  // Whether speech this hook started may still be sounding (so a stop calls Speech.stop).
  const speakingRef = useRef(false);

  // The tab was hidden: forget the playing card now (its speech is stopped by the effect below).
  if (!active && playingId !== null) setPlayingId(null);

  /**
   * purpose: Silence speech this hook started and make its callbacks stale. Touches refs only,
   *          so effects may call it; callers clear playingId themselves.
   * @return: (void)
   */
  const stopSpeech = useCallback((): void => {
    tokenRef.current += 1;
    if (speakingRef.current) {
      speakingRef.current = false;
      void Speech.stop();
    }
  }, []);

  /**
   * purpose: Speak one card's sentence, replacing anything playing.
   * @param id: (string) The card.
   * @param sentence: (string) What to say.
   * @return: (Promise<void>) Resolves once the speech has started (or was replaced first).
   */
  const play = useCallback(
    async (id: string, sentence: string): Promise<void> => {
      stopSpeech();
      const token = tokenRef.current;
      setFailedId(null);
      setPlayingId(id);
      await prepareAudio();
      if (tokenRef.current !== token) return;
      /**
       * purpose: End this play, unless another play or a stop replaced it.
       * @param failed: (boolean) Whether the speech failed.
       * @return: (void)
       */
      const finish = (failed: boolean): void => {
        if (tokenRef.current !== token) return;
        speakingRef.current = false;
        setPlayingId(null);
        if (failed) setFailedId(id);
      };
      speakingRef.current = true;
      Speech.speak(sentence, {
        language: SPEECH_LANGUAGE,
        rate: DEFAULT_TUNING.speechRate,
        onDone: () => finish(false),
        onStopped: () => finish(false),
        onError: (error) => {
          logger.warning('Wording', `Speech failed: ${errorMessage(error)}`);
          finish(true);
        },
      });
    },
    [stopSpeech],
  );

  /**
   * purpose: The card button's action: stop the card that is playing, or play this one.
   * @param id: (string) The card.
   * @param sentence: (string) Its sentence.
   * @return: (void)
   */
  const toggle = useCallback(
    (id: string, sentence: string): void => {
      if (playingId === id) {
        stopSpeech();
        setPlayingId(null);
      } else {
        void play(id, sentence);
      }
    },
    [playingId, play, stopSpeech],
  );

  useEffect(() => {
    if (!active) stopSpeech();
  }, [active, stopSpeech]);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') return;
      stopSpeech();
      setPlayingId(null);
    });
    return () => {
      subscription.remove();
      stopSpeech();
    };
  }, [stopSpeech]);

  return { playingId, failedId, toggle };
}
