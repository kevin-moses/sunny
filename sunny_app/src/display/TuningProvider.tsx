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

export const TUNING_STORAGE_KEY = 'sunny.display.tuning';

export interface SampleAnswer {
  text: string;
  id: number;
}

export interface TestCueRequest {
  id: number;
  active: boolean;
}

export interface TuningControls {
  tuning: DisplayTuning;
  setValue: (key: TuningKey, value: number) => void;
  resetToDefaults: () => void;
  sample: SampleAnswer | null;
  showSampleAnswer: (text: string) => void;
  testCue: TestCueRequest | null;
  testCueResult: string | null;
  requestTestCue: () => void;
  stopTestCue: () => void;
  reportTestCue: (result: string) => void;
}

export const TuningContext = createContext<TuningControls | null>(null);

async function loadTuning(): Promise<DisplayTuning> {
  try {
    const raw = await AsyncStorage.getItem(TUNING_STORAGE_KEY);
    return sanitizeTuning(raw === null ? null : JSON.parse(raw));
  } catch {
    return sanitizeTuning(null);
  }
}

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
      setValue: (key, raw) => {
        const value = clampTuning(key, raw);
        if (value !== tuning[key]) commit({ ...tuning, [key]: value });
      },
      resetToDefaults: () => commit({ ...DEFAULT_TUNING }),
      sample,
      showSampleAnswer: (text) => setSample((last) => ({ text, id: (last?.id ?? 0) + 1 })),
      testCue,
      testCueResult,
      requestTestCue: () => {
        setTestCueResult(null);
        setTestCue((last) => ({ id: (last?.id ?? 0) + 1, active: true }));
      },
      stopTestCue: () => setTestCue((last) => (last === null ? null : { ...last, active: false })),
      reportTestCue: setTestCueResult,
    }),
    [tuning, sample, testCue, testCueResult, commit],
  );

  return <TuningContext.Provider value={value}>{children}</TuningContext.Provider>;
}

export function useTuning(): DisplayTuning {
  return useContext(TuningContext)?.tuning ?? DEFAULT_TUNING;
}

export function useTuningControls(): TuningControls | null {
  return useContext(TuningContext);
}

export function useSampleAnswer(): SampleAnswer | null {
  return useContext(TuningContext)?.sample ?? null;
}

export interface TestCue {
  request: TestCueRequest | null;
  report: (result: string) => void;
}

const IGNORE_REPORT = (): void => undefined;

export function useTestCue(): TestCue {
  const controls = useContext(TuningContext);
  return {
    request: controls?.testCue ?? null,
    report: controls?.reportTestCue ?? IGNORE_REPORT,
  };
}
