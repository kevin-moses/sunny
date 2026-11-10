// sunny_app/src/display/TuningProvider.tsx
//
// Purpose: Holds the live values of the home display's tunables (tuning.ts) so they can be
// changed on a running build from the developer sheet, the way ThemeProvider holds the theme.
// Values start at their defaults, are replaced by the saved ones once AsyncStorage answers
// (unless a value was already changed meanwhile, which wins), are clamped on every change, are
// saved on every change, and apply at once (hooks read them with useTuning()).
// resetToDefaults restores and saves the defaults. Saved values are only used where the
// developer sheet exists (`persisted`, default __DEV__): a release build always runs on the
// defaults, so values saved during testing cannot carry into a build with no way to reset
// them. It also carries two requests from the sheet to the display: "Show sample answer"
// (useSampleAnswer) and "Play due cue now" (useTestCue; useDueCue plays it under the same
// rules as a real cue and reports the outcome back).
// Without a provider (tests, or a tree that does not need one) useTuning returns the defaults;
// tests inject values with TuningContext.
//
// Last modified: 2026-11-09

import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

import { DEFAULT_TUNING, clampTuning, sanitizeTuning } from './tuning';
import type { DisplayTuning, TuningKey } from './tuning';

/** AsyncStorage key of the saved tunables. */
export const TUNING_STORAGE_KEY = 'sunny.display.tuning';

/** A request from the developer sheet to put a sample answer on the panel. */
export interface SampleAnswer {
  text: string;
  /** Increases with each request, so the same text can be shown again. */
  id: number;
}

/** A request from the developer sheet to play the due cue now. */
export interface TestCueRequest {
  /** Increases with each request. */
  id: number;
  /** False once the sheet closed: a test cue still playing stops. */
  active: boolean;
}

/** What the tuning context carries. */
export interface TuningControls {
  tuning: DisplayTuning;
  /** Set one tunable (clamped) and save it. */
  setValue: (key: TuningKey, value: number) => void;
  /** Restore and save the defaults. */
  resetToDefaults: () => void;
  /** The latest sample answer request, or null. */
  sample: SampleAnswer | null;
  /** Ask the display to show a sample answer. */
  showSampleAnswer: (text: string) => void;
  /** The latest test cue request, or null. */
  testCue: TestCueRequest | null;
  /** How the latest test cue went ("played", or why it did not play), or null. */
  testCueResult: string | null;
  /** Ask the display to play the due cue now. */
  requestTestCue: () => void;
  /** Stop a test cue that is still playing (the sheet closed). */
  stopTestCue: () => void;
  /** Report how a test cue went (called by the cue's owner). */
  reportTestCue: (result: string) => void;
}

/** The tuning context; null outside a TuningProvider. */
export const TuningContext = createContext<TuningControls | null>(null);

/**
 * purpose: Read the saved tunables.
 * @return: (Promise<DisplayTuning>) The saved values, or the defaults when none or unreadable.
 */
async function loadTuning(): Promise<DisplayTuning> {
  try {
    const raw = await AsyncStorage.getItem(TUNING_STORAGE_KEY);
    return sanitizeTuning(raw === null ? null : JSON.parse(raw));
  } catch {
    return { ...DEFAULT_TUNING };
  }
}

/**
 * purpose: Provide the live tunables and persist changes.
 * @param props: ({ children: ReactNode, persisted?: boolean }) The subtree that reads
 *        useTuning(), and whether saved values are loaded and changes saved (default __DEV__,
 *        where the developer sheet exists).
 * @return: (JSX.Element) The provider.
 */
export function TuningProvider({
  children,
  persisted = __DEV__,
}: {
  children: ReactNode;
  persisted?: boolean;
}) {
  const [tuning, setTuning] = useState<DisplayTuning>(DEFAULT_TUNING);
  const [sample, setSample] = useState<SampleAnswer | null>(null);
  const [testCue, setTestCue] = useState<TestCueRequest | null>(null);
  const [testCueResult, setTestCueResult] = useState<string | null>(null);
  // Set by the first change; a load that finishes later must not overwrite it.
  const changed = useRef(false);

  useEffect(() => {
    if (!persisted) return undefined;
    let live = true;
    void loadTuning().then((saved) => {
      if (live && !changed.current) setTuning(saved);
    });
    return () => {
      live = false;
    };
  }, [persisted]);

  /**
   * purpose: Apply new tunables and save them.
   * @param next: (DisplayTuning) The values to use from now on.
   * @return: (void)
   */
  const commit = useCallback(
    (next: DisplayTuning): void => {
      changed.current = true;
      setTuning(next);
      if (!persisted) return;
      AsyncStorage.setItem(TUNING_STORAGE_KEY, JSON.stringify(next)).catch(() => undefined);
    },
    [persisted],
  );

  const value = useMemo<TuningControls>(
    () => ({
      tuning,
      /**
       * purpose: Set one tunable, clamped, and save it.
       * @param key: (TuningKey) The tunable.
       * @param raw: (number) The candidate value.
       * @return: (void)
       */
      setValue: (key, raw) => commit({ ...tuning, [key]: clampTuning(key, raw) }),
      /**
       * purpose: Restore and save the defaults.
       * @return: (void)
       */
      resetToDefaults: () => commit({ ...DEFAULT_TUNING }),
      sample,
      /**
       * purpose: Ask the display to show a sample answer.
       * @param text: (string) The answer.
       * @return: (void)
       */
      showSampleAnswer: (text) => setSample((last) => ({ text, id: (last?.id ?? 0) + 1 })),
      testCue,
      testCueResult,
      /**
       * purpose: Ask the display to play the due cue now.
       * @return: (void)
       */
      requestTestCue: () => {
        setTestCueResult(null);
        setTestCue((last) => ({ id: (last?.id ?? 0) + 1, active: true }));
      },
      /**
       * purpose: Stop a test cue still playing.
       * @return: (void)
       */
      stopTestCue: () => setTestCue((last) => (last === null ? null : { ...last, active: false })),
      reportTestCue: setTestCueResult,
    }),
    [tuning, sample, testCue, testCueResult, commit],
  );

  return <TuningContext.Provider value={value}>{children}</TuningContext.Provider>;
}

/**
 * purpose: Read the live tunables.
 * @return: (DisplayTuning) The current values; the defaults outside a TuningProvider.
 */
export function useTuning(): DisplayTuning {
  return useContext(TuningContext)?.tuning ?? DEFAULT_TUNING;
}

/**
 * purpose: Read the tunables with their setters, for the developer sheet.
 * @return: (TuningControls | null) The controls, or null outside a TuningProvider.
 */
export function useTuningControls(): TuningControls | null {
  return useContext(TuningContext);
}

/**
 * purpose: Read the latest sample answer request from the developer sheet.
 * @return: (SampleAnswer | null) The request, or null when none was made.
 */
export function useSampleAnswer(): SampleAnswer | null {
  return useContext(TuningContext)?.sample ?? null;
}

/** The test cue request and the function that reports its outcome. */
export interface TestCue {
  request: TestCueRequest | null;
  report: (result: string) => void;
}

/** Report function used outside a TuningProvider. */
const IGNORE_REPORT = (): void => undefined;

/**
 * purpose: Read the latest test cue request from the developer sheet.
 * @return: (TestCue) The request (null when none was made) and the report function.
 */
export function useTestCue(): TestCue {
  const controls = useContext(TuningContext);
  return {
    request: controls?.testCue ?? null,
    report: controls?.reportTestCue ?? IGNORE_REPORT,
  };
}
