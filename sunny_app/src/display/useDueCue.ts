import AsyncStorage from '@react-native-async-storage/async-storage';
import { useEffect, useRef, useState } from 'react';

import type { DayTask } from '../day/types';
import { errorMessage } from '../errors';
import { logger } from '../logging/logger';
import { SAMPLE_PROMPT, cueChoice, cueSpeech, isCueable, rememberCued } from './cue';
import { playCue } from './cueAudio';
import type { CueLine, CueResult } from './cueAudio';
import { useLatest, useTimeout } from './timers';
import { useTestCue, useTuning } from './TuningProvider';

export const CUED_STORAGE_KEY = 'sunny.display.cuedKeys';

export const TEST_CUE_BLOCKED = 'Not played: a voice session is on or just ended';

export const TEST_CUE_BUSY = 'Not played: a cue is already playing';

interface PlayingCue {
  kind: 'due' | 'test';
  instanceIds: string[];
  controller: AbortController;
}

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

function saveCued(keys: ReadonlySet<string>): void {
  AsyncStorage.setItem(CUED_STORAGE_KEY, JSON.stringify([...keys])).catch((error: unknown) =>
    logger.warning('Cue', `Could not save the played cues: ${errorMessage(error)}`),
  );
}

function stillCueable(tasks: DayTask[] | null, instanceId: string): boolean {
  return (tasks ?? []).some((t) => t.instanceId === instanceId && isCueable(t));
}

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
  const latestTasks = useLatest(tasks);
  const reportRef = useLatest(testCue.report);
  const [loaded, setLoaded] = useState(false);
  const [finished, setFinished] = useState(0);

  const [wasBlocked, setWasBlocked] = useState(blocked);
  const [settleId, setSettleId] = useState(0);
  const [settledId, setSettledId] = useState(0);
  if (blocked !== wasBlocked) {
    setWasBlocked(blocked);
    if (!blocked) setSettleId(settleId + 1);
  }
  const settling = settleId !== settledId;
  useTimeout(() => setSettledId(settleId), settleId === 0 ? null : tuning.cueSettleMs, settleId);

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

  useEffect(() => {
    const start = (cue: PlayingCue, lines: CueLine[], after: (result: CueResult) => void): void => {
      playing.current = cue;
      void playCue(lines, cue.controller.signal, tuning).then((result) => {
        if (playing.current === cue) playing.current = null;
        after(result);
        setFinished((n) => n + 1);
      });
    };

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
  }, [
    loaded,
    tasks,
    blocked,
    settling,
    finished,
    onCue,
    tuning,
    testRequest,
    latestTasks,
    reportRef,
  ]);

  const testActive = testRequest?.active ?? false;
  useEffect(() => {
    const cue = playing.current;
    if (cue === null) return;
    const keep =
      cue.kind === 'test' ? testActive : cue.instanceIds.some((id) => stillCueable(tasks, id));
    if (blocked || !keep) cue.controller.abort();
  }, [tasks, blocked, testActive]);
}
