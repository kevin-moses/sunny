// sunny_app/src/display/useDueCue.ts
//
// Purpose: Plays the home display's due cue (cue.ts rules, cueAudio.ts sound) as the day view
// changes. When a timed task comes due, and again whenever the backend sends a reprompt for
// it (the task's seniorPrompts count goes up), the display chimes and speaks the task's fixed
// prompt. Tasks that come due together share one chime and are spoken in day order. Waits and
// the speech rate come from the tuning values (useTuning).
//
// - Once per cue: the played cue keys are remembered in AsyncStorage (CUED_STORAGE_KEY), so
//   a task already due when the app launches is cued on the first launch only, never again
//   on a restart. Until the remembered keys load, nothing is cued.
// - Blocked (a voice session is live): nothing new starts and a cue in progress stops; cues
//   owed meanwhile play cueSettleMs after the session ends (LiveKit releases the iOS audio
//   session first), if their task is still due and not snoozed then. A stopped cue is not
//   replayed.
// - Snoozed: a snoozed task's owed cue is passed over (remembered, never sounded); the next
//   one comes with the backend's reprompt after the snooze.
// - Confirmed or snoozed during a cue: its line is skipped, and a cue whose tasks are all no
//   longer cueable stops at once.
// - Failed (the cue made no sound, or a line got stuck): its keys are forgotten and it is
//   tried once more after cueRetryMs; a second failure is only logged.
// - onCue is called as each cue starts (the screen brings the task forward).
//
// Last modified: 2026-11-09

import AsyncStorage from '@react-native-async-storage/async-storage';
import { useEffect, useRef, useState } from 'react';

import type { DayTask } from '../day/types';
import { errorMessage } from '../errors';
import { logger } from '../logging/logger';
import { cueChoice, cueKey, cueSpeech, isCueable, rememberCued } from './cue';
import { playCue } from './cueAudio';
import { useTuning } from './TuningProvider';

/** AsyncStorage key of the cue keys already played on this device. */
export const CUED_STORAGE_KEY = 'sunny.display.cuedKeys';

/** A cue being played: its instances and keys, and the controller that stops it. */
interface PlayingCue {
  instanceIds: string[];
  keys: string[];
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
 * purpose: Whether an instance is still in the day view and may be cued.
 * @param tasks: (DayTask[] | null) The day view's tasks.
 * @param instanceId: (string) The instance.
 * @return: (boolean) True when it is due and not snoozed.
 */
function stillCueable(tasks: DayTask[] | null, instanceId: string): boolean {
  return (tasks ?? []).some((t) => t.instanceId === instanceId && isCueable(t));
}

/**
 * purpose: Play the due cue as tasks come due or are reprompted.
 * @param tasks: (DayTask[] | null) The day view's tasks, or null while the day loads.
 * @param blocked: (boolean) A voice session is live; cues wait until it ends.
 * @param onCue: (() => void) Called when a cue starts.
 * @return: (void)
 */
export function useDueCue(tasks: DayTask[] | null, blocked: boolean, onCue: () => void): void {
  const tuning = useTuning();
  const cued = useRef<ReadonlySet<string>>(new Set());
  const retried = useRef<Set<string>>(new Set());
  const retryTimers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const playing = useRef<PlayingCue | null>(null);
  const latestTasks = useRef<DayTask[] | null>(tasks);
  const [loaded, setLoaded] = useState(false);
  // Bumped when a cue ends or a retry is due, so owed cues are looked at again.
  const [finished, setFinished] = useState(0);

  // After a voice session ends, owed cues wait cueSettleMs (state adjusted while rendering).
  const [wasBlocked, setWasBlocked] = useState(blocked);
  const [settleId, setSettleId] = useState(0);
  const [settledId, setSettledId] = useState(0);
  if (blocked !== wasBlocked) {
    setWasBlocked(blocked);
    if (!blocked) setSettleId(settleId + 1);
  }
  const settling = settleId !== settledId;
  const settleMs = tuning.cueSettleMs;
  useEffect(() => {
    if (settleId === 0) return undefined;
    const timer = setTimeout(() => setSettledId(settleId), settleMs);
    return () => clearTimeout(timer);
  }, [settleId, settleMs]);

  useEffect(() => {
    latestTasks.current = tasks;
  }, [tasks]);

  useEffect(() => {
    let live = true;
    const timers = retryTimers.current;
    void loadCued().then((keys) => {
      if (!live) return;
      cued.current = keys;
      setLoaded(true);
    });
    return () => {
      live = false;
      timers.forEach(clearTimeout);
      playing.current?.controller.abort();
    };
  }, []);

  // Start a cue for the tasks owed one (and pass over the snoozed ones).
  useEffect(() => {
    if (!loaded || tasks === null || blocked || settling || playing.current !== null) return;
    const { play, skip } = cueChoice(tasks, cued.current);
    if (play.length === 0 && skip.length === 0) return;
    cued.current = rememberCued(cued.current, [...play, ...skip], tasks);
    saveCued(cued.current);
    if (play.length === 0) return;
    const cue: PlayingCue = {
      instanceIds: play.map((t) => t.instanceId),
      keys: play.map(cueKey),
      controller: new AbortController(),
    };
    playing.current = cue;
    onCue();
    const lines = play.map((task) => ({
      text: cueSpeech(task),
      skip: () => !stillCueable(latestTasks.current, task.instanceId),
    }));
    void playCue(lines, cue.controller.signal, tuning).then((result) => {
      if (playing.current === cue) playing.current = null;
      if (result === 'failed') {
        const retry = cue.keys.filter((key) => !retried.current.has(key));
        logger.warning('Cue', retry.length > 0 ? 'Cue failed; retrying once' : 'Cue failed again');
        if (retry.length > 0) {
          retry.forEach((key) => retried.current.add(key));
          const timer = setTimeout(() => {
            const next = new Set(cued.current);
            retry.forEach((key) => next.delete(key));
            cued.current = next;
            saveCued(next);
            setFinished((n) => n + 1);
          }, tuning.cueRetryMs);
          retryTimers.current.push(timer);
        }
      }
      setFinished((n) => n + 1);
    });
  }, [loaded, tasks, blocked, settling, finished, onCue, tuning]);

  // Stop a cue when a voice session starts or none of its tasks may be cued any more.
  useEffect(() => {
    const cue = playing.current;
    if (cue === null) return;
    const anyCueable = cue.instanceIds.some((id) => stillCueable(tasks, id));
    if (blocked || !anyCueable) cue.controller.abort();
  }, [tasks, blocked]);
}
