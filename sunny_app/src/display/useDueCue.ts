// sunny_app/src/display/useDueCue.ts
//
// Purpose: Plays the home display's due cue (cue.ts rules, cueAudio.ts sound) as the day view
// changes, and is the one owner of cue playback, so no two cues ever overlap. When a timed
// task comes due, and again whenever the backend sends a reprompt for it (the task's
// seniorPrompts count goes up), the display chimes and speaks the task's fixed prompt. Tasks
// that come due together share one chime and are spoken in day order. Waits and the speech
// rate come from the tuning values (useTuning).
//
// - Once per cue: the played cue keys are remembered in AsyncStorage (CUED_STORAGE_KEY), so
//   a task already due when the app launches is cued on the first launch only, never again
//   on a restart. Until the remembered keys load, nothing is cued.
// - Blocked (a voice session is live): nothing new starts and a cue in progress stops; cues
//   owed meanwhile play cueSettleMs after the session ends (LiveKit releases the iOS audio
//   session first), if their task is still due then. A stopped cue is not replayed.
// - Snoozed: a snoozed task's owed cue waits (it is not remembered) and plays when the snooze
//   ends, unless the task was confirmed meanwhile. A new prompt count for a task cued less
//   than cueMinGapMs ago is absorbed, so a snooze end that releases the owed cue and the
//   backend's withheld reprompt firing a moment later give one cue, not two.
// - Confirmed or snoozed during a cue: its line is skipped, and a cue whose tasks are all no
//   longer cueable stops at once.
// - Failed (the cue made no sound, or a line got stuck): after cueRetryMs it is tried once
//   more from the line that failed (lines already spoken are not repeated); a second failure
//   is only logged.
// - Test cue: the developer sheet's "Play due cue now" (useTestCue) plays the chime and a
//   sample prompt here, under the same rules: refused with a reason during a voice session,
//   while a cue plays, or just after a session; stopped when a session starts or the sheet
//   closes. The outcome is reported back to the sheet.
// - onCue is called as each real cue starts (the screen brings the task forward).
// Unmounting stops any cue and clears pending retries.
//
// Last modified: 2026-11-09

import AsyncStorage from '@react-native-async-storage/async-storage';
import { useEffect, useRef, useState } from 'react';

import type { DayTask } from '../day/types';
import { errorMessage } from '../errors';
import { logger } from '../logging/logger';
import { SAMPLE_PROMPT, cueChoice, cueSpeech, isCueable, rememberCued } from './cue';
import { playCue } from './cueAudio';
import { useTestCue, useTuning } from './TuningProvider';

/** AsyncStorage key of the cue keys already played on this device. */
export const CUED_STORAGE_KEY = 'sunny.display.cuedKeys';

/** The test cue's outcome when a voice session is live or has just ended. */
export const TEST_CUE_BLOCKED = 'Not played: a voice session is on or just ended';

/** The test cue's outcome when another cue is playing. */
export const TEST_CUE_BUSY = 'Not played: a cue is already playing';

/** A cue being played: what it is for, and the controller that stops it. */
interface PlayingCue {
  /** 'due' for a real cue, 'test' for the developer sheet's. */
  kind: 'due' | 'test';
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
 * purpose: Whether an instance is still in the day view and may be cued.
 * @param tasks: (DayTask[] | null) The day view's tasks.
 * @param instanceId: (string) The instance.
 * @return: (boolean) True when it is due and not snoozed.
 */
function stillCueable(tasks: DayTask[] | null, instanceId: string): boolean {
  return (tasks ?? []).some((t) => t.instanceId === instanceId && isCueable(t));
}

/**
 * purpose: Play the due cue as tasks come due or are reprompted, and the developer sheet's
 *          test cue.
 * @param tasks: (DayTask[] | null) The day view's tasks, or null while the day loads.
 * @param blocked: (boolean) A voice session is live; cues wait until it ends.
 * @param onCue: (() => void) Called when a real cue starts.
 * @return: (void)
 */
export function useDueCue(tasks: DayTask[] | null, blocked: boolean, onCue: () => void): void {
  const tuning = useTuning();
  const testCue = useTestCue();
  const testRequest = testCue.request;
  const cued = useRef<ReadonlySet<string>>(new Set());
  const lastCueAt = useRef(new Map<string, number>());
  const pendingRetry = useRef<DayTask[] | null>(null);
  const handledTestId = useRef(testRequest?.id ?? 0);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const playing = useRef<PlayingCue | null>(null);
  const latestTasks = useRef<DayTask[] | null>(tasks);
  const reportRef = useRef(testCue.report);
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
    reportRef.current = testCue.report;
  });

  useEffect(() => {
    let live = true;
    const pending = timers.current;
    void loadCued().then((keys) => {
      if (!live) return;
      cued.current = keys;
      setLoaded(true);
    });
    return () => {
      live = false;
      pending.forEach(clearTimeout);
      playing.current?.controller.abort();
    };
  }, []);

  // Start a cue: a test cue the sheet asked for, a retry that is due, or the cues owed now.
  useEffect(() => {
    /**
     * purpose: Play a cue and clear the playing mark when it ends.
     * @param cue: (PlayingCue) The cue being started.
     * @param lines: (Parameters<typeof playCue>[0]) Its lines.
     * @param after: ((result: Awaited<ReturnType<typeof playCue>>) => void) Runs when it ends.
     * @return: (void)
     */
    const start = (
      cue: PlayingCue,
      lines: Parameters<typeof playCue>[0],
      after: (result: Awaited<ReturnType<typeof playCue>>) => void,
    ): void => {
      playing.current = cue;
      void playCue(lines, cue.controller.signal, tuning).then((result) => {
        if (playing.current === cue) playing.current = null;
        after(result);
        setFinished((n) => n + 1);
      });
    };

    /**
     * purpose: Play a real cue for some tasks, retrying once from the failed line.
     * @param play: (DayTask[]) The tasks, in day order.
     * @param retry: (boolean) This is already the retry.
     * @return: (void)
     */
    const startDue = (play: DayTask[], retry: boolean): void => {
      const cue: PlayingCue = {
        kind: 'due',
        instanceIds: play.map((t) => t.instanceId),
        controller: new AbortController(),
      };
      onCue();
      const lines = play.map((task) => ({
        text: cueSpeech(task),
        skip: () => !stillCueable(latestTasks.current, task.instanceId),
      }));
      start(cue, lines, (result) => {
        if (result.status !== 'failed') {
          play.forEach((t) => lastCueAt.current.set(t.instanceId, Date.now()));
          return;
        }
        if (retry) {
          logger.warning('Cue', 'Cue failed again');
          return;
        }
        logger.warning('Cue', 'Cue failed; retrying once from the failed line');
        const remaining = play.slice(result.done);
        const timer = setTimeout(() => {
          pendingRetry.current = remaining;
          setFinished((n) => n + 1);
        }, tuning.cueRetryMs);
        timers.current.push(timer);
      });
    };

    if (!loaded) return;
    if (testRequest !== null && testRequest.active && testRequest.id !== handledTestId.current) {
      handledTestId.current = testRequest.id;
      if (blocked || settling) reportRef.current(TEST_CUE_BLOCKED);
      else if (playing.current !== null) reportRef.current(TEST_CUE_BUSY);
      else {
        const controller = new AbortController();
        const cue: PlayingCue = { kind: 'test', instanceIds: [], controller };
        start(cue, [{ text: SAMPLE_PROMPT }], (result) => reportRef.current(result.status));
        return;
      }
    }
    if (tasks === null || blocked || settling || playing.current !== null) return;

    const retry = pendingRetry.current;
    if (retry !== null) {
      pendingRetry.current = null;
      const still = retry.filter((t) => stillCueable(tasks, t.instanceId));
      if (still.length > 0) {
        startDue(still, true);
        return;
      }
    }

    const { play, absorb } = cueChoice(tasks, cued.current, {
      lastCueAt: lastCueAt.current,
      now: Date.now(),
      minGapMs: tuning.cueMinGapMs,
    });
    if (play.length === 0 && absorb.length === 0) return;
    cued.current = rememberCued(cued.current, [...play, ...absorb], tasks);
    saveCued(cued.current);
    if (play.length > 0) startDue(play, false);
  }, [loaded, tasks, blocked, settling, finished, onCue, tuning, testRequest]);

  // Stop a cue when a voice session starts, when none of its tasks may be cued any more, or
  // (a test cue) when the sheet closed.
  const testActive = testRequest?.active ?? false;
  useEffect(() => {
    const cue = playing.current;
    if (cue === null) return;
    const keep =
      cue.kind === 'test' ? testActive : cue.instanceIds.some((id) => stillCueable(tasks, id));
    if (blocked || !keep) cue.controller.abort();
  }, [tasks, blocked, testActive]);
}
