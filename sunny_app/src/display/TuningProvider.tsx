// sunny_app/src/display/TuningProvider.tsx
//
// Purpose: Holds the live values of the home display's tunables (tuning.ts) so they can be
// changed on a running build from the developer sheet, the way ThemeProvider holds the theme.
// Values start at their defaults, are replaced by the saved ones once AsyncStorage answers,
// are clamped on every change, are saved on every change, and apply at once (hooks read them
// with useTuning()). resetToDefaults restores and saves the defaults. It also carries the
// sheet's "Show sample answer" request to the display (useSampleAnswer).
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
 * @param props: ({ children: ReactNode }) The subtree that reads useTuning().
 * @return: (JSX.Element) The provider.
 */
export function TuningProvider({ children }: { children: ReactNode }) {
  const [tuning, setTuning] = useState<DisplayTuning>(DEFAULT_TUNING);
  const [sample, setSample] = useState<SampleAnswer | null>(null);

  useEffect(() => {
    let live = true;
    void loadTuning().then((saved) => {
      if (live) setTuning(saved);
    });
    return () => {
      live = false;
    };
  }, []);

  /**
   * purpose: Apply new tunables and save them.
   * @param next: (DisplayTuning) The values to use from now on.
   * @return: (void)
   */
  const commit = useCallback((next: DisplayTuning): void => {
    setTuning(next);
    AsyncStorage.setItem(TUNING_STORAGE_KEY, JSON.stringify(next)).catch(() => undefined);
  }, []);

  const value = useMemo<TuningControls>(
    () => ({
      tuning,
      setValue: (key, raw) => commit({ ...tuning, [key]: clampTuning(key, raw) }),
      resetToDefaults: () => commit({ ...DEFAULT_TUNING }),
      sample,
      showSampleAnswer: (text) => setSample((last) => ({ text, id: (last?.id ?? 0) + 1 })),
    }),
    [tuning, sample, commit],
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
