import { setAudioModeAsync } from 'expo-audio';
import * as Speech from 'expo-speech';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';

import { DEFAULT_TUNING, SPEECH_AUDIO_MODE, SPEECH_LANGUAGE } from '../display/tuning';
import { errorMessage } from '../errors';
import { logger } from '../logging/logger';

export interface WordingPlayer {
  playingId: string | null;
  failedId: string | null;
  toggle: (id: string, sentence: string) => void;
}

export function useWordingPlayer(active: boolean): WordingPlayer {
  const [playingId, setPlayingId] = useState<string | null>(null);
  const [failedId, setFailedId] = useState<string | null>(null);
  const tokenRef = useRef(0);
  const speakingRef = useRef(false);

  if (!active && playingId !== null) setPlayingId(null);

  const stopSpeech = useCallback((): void => {
    tokenRef.current += 1;
    if (speakingRef.current) {
      speakingRef.current = false;
      void Speech.stop();
    }
  }, []);

  const play = useCallback(
    async (id: string, sentence: string): Promise<void> => {
      stopSpeech();
      const token = tokenRef.current;
      setFailedId(null);
      setPlayingId(id);
      const finish = (failed: boolean): void => {
        if (tokenRef.current !== token) return;
        speakingRef.current = false;
        setPlayingId(null);
        if (failed) setFailedId(id);
      };
      try {
        await setAudioModeAsync(SPEECH_AUDIO_MODE);
      } catch (error) {
        logger.warning('Wording', `Audio mode failed; speaking anyway: ${errorMessage(error)}`);
      }
      if (tokenRef.current !== token) return;
      try {
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
      } catch (error) {
        logger.warning('Wording', `Speech failed: ${errorMessage(error)}`);
        finish(true);
      }
    },
    [stopSpeech],
  );

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
