// sunny_app/src/display/useDueCue.ts
//
// Purpose: Plays the home display's due cue (cue.ts rules, cueAudio.ts sound) as the day view
// changes. When a timed task comes due, and again whenever the backend sends a reprompt for
// it (the task's seniorPrompts count goes up), the display chimes and speaks the task's fixed
// prompt. Tasks that come due together share one chime and are spoken in day order.
//
// - Once per cue: the played cue keys are remembered in AsyncStorage (CUED_STORAGE_KEY), so
//   a task already due when the app launches is cued on the first launch only, never again
//   on a restart. Until the remembered keys load, nothing is cued.
// - Blocked (a voice session is live): nothing new starts and a cue in progress stops; cues
//   owed meanwhile play when the session ends, if their task is still due then. A task
//   confirmed in the meantime is no longer due, so its cue is dropped, and a cue in progress
//   for tasks that are all no longer due stops at once. A stopped cue is not replayed.
// - onCue is called as each cue starts (the screen brings the task forward).
//
// Last modified: 2026-11-09

import AsyncStorage from '@react-native-async-storage/async-storage';
import { useEffect, useRef, useState } from 'react';

import { isDue } from '../day/format';
import type { DayTask } from '../day/types';
import { errorMessage } from '../errors';
import { logger } from '../logging/logger';
import { cueSpeech, rememberCued, tasksToCue } from './cue';
import { playCue } from './cueAudio';

/** AsyncStorage key of the cue keys already played on this device. */
export const CUED_STORAGE_KEY = 'sunny.display.cuedKeys';

/** A cue being played: the instances it is for and the controller that stops it. */
interface PlayingCue {
  instanceIds: string[];
  controller: AbortController;
}

/**
 * purpose: Read the remembered cue keys.
 * @return: (Promise<Set<string>>) The keys; empty when none are stored or they cannot be read.
 */
async function loadCued(): Promise<Set<string>> {
  try {
    const stored = await AsyncStorage.getItem(CUED_STORAGE_KEY);
    const parsed: unknown = stored === null ? [] : JSON.parse(stored);
    return new Set(Array.isArray(parsed) ? parsed.filter((k) => typeof k === 'string') : []);
  } catch (error) {
    logger.warning('Cue', `Could not read the played cues: ${errorMessage(error)}`);
    return new Set();
  }
}

/**
 * purpose: Remember the played cue keys; a failure is logged (the worst case is a repeat
 *          cue after a restart).
 * @param keys: (ReadonlySet<string>) The keys.
 * @return: (void)
 */
function saveCued(keys: ReadonlySet<string>): void {
  AsyncStorage.setItem(CUED_STORAGE_KEY, JSON.stringify([...keys])).catch((error: unknown) =>
    logger.warning('Cue', `Could not save the played cues: ${errorMessage(error)}`),
  );
}

/**
 * purpose: Play the due cue as tasks come due or are reprompted.
 * @param tasks: (DayTask[] | null) The day view's tasks, or null while the day loads.
 * @param blocked: (boolean) A voice session is live; cues wait until it ends.
 * @param onCue: (() => void) Called when a cue starts.
 * @return: (void)
 */
export function useDueCue(tasks: DayTask[] | null, blocked: boolean, onCue: () => void): void {
  const cued = useRef<ReadonlySet<string>>(new Set());
  const playing = useRef<PlayingCue | null>(null);
  const [loaded, setLoaded] = useState(false);
  // Bumped when a cue ends, so cues owed while it played are looked at again.
  const [finished, setFinished] = useState(0);

  useEffect(() => {
    let live = true;
    void loadCued().then((keys) => {
      if (!live) return;
      cued.current = keys;
      setLoaded(true);
    });
    return () => {
      live = false;
      playing.current?.controller.abort();
    };
  }, []);

  // Start a cue for the tasks owed one.
  useEffect(() => {
    if (!loaded || tasks === null || blocked || playing.current !== null) return;
    const due = tasksToCue(tasks, cued.current);
    if (due.length === 0) return;
    cued.current = rememberCued(cued.current, due, tasks);
    saveCued(cued.current);
    const cue: PlayingCue = {
      instanceIds: due.map((t) => t.instanceId),
      controller: new AbortController(),
    };
    playing.current = cue;
    onCue();
    void playCue(due.map(cueSpeech), cue.controller.signal).then(() => {
      if (playing.current === cue) playing.current = null;
      setFinished((n) => n + 1);
    });
  }, [loaded, tasks, blocked, finished, onCue]);

  // Stop a cue when a voice session starts or none of its tasks is due any more.
  useEffect(() => {
    const cue = playing.current;
    if (cue === null) return;
    const stillDue = (tasks ?? []).some((t) => cue.instanceIds.includes(t.instanceId) && isDue(t));
    if (blocked || !stillDue) cue.controller.abort();
  }, [tasks, blocked]);
}
