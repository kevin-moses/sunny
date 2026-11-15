import { DISPLAY_AGENT_CONNECT_TIMEOUT_MS } from '../voice/agentTimeouts';

interface TuningSpec {
  label: string;
  unit: 'ms' | 'rate';
  default: number;
  min: number;
  max: number;
  step: number;
}

export const TUNING_SPECS = {
  startTimeoutMs: {
    label: 'Give up connecting after',
    unit: 'ms',
    default: 15_000,
    min: 5_000,
    max: DISPLAY_AGENT_CONNECT_TIMEOUT_MS,
    step: 1_000,
  },
  firstQuestionMs: {
    label: 'Wait for a question',
    unit: 'ms',
    default: 20_000,
    min: 5_000,
    max: 60_000,
    step: 1_000,
  },
  followUpMs: {
    label: 'Wait for a follow-up',
    unit: 'ms',
    default: 10_000,
    min: 3_000,
    max: 60_000,
    step: 1_000,
  },
  stuckMs: {
    label: 'End a stuck session',
    unit: 'ms',
    default: 60_000,
    min: 15_000,
    max: 180_000,
    step: 5_000,
  },
  sessionMaxMs: {
    label: 'A session never lasts longer than',
    unit: 'ms',
    default: 180_000,
    min: 60_000,
    max: 600_000,
    step: 10_000,
  },
  ceilingGraceMs: {
    label: 'Let an answer finish, at most',
    unit: 'ms',
    default: 30_000,
    min: 0,
    max: 60_000,
    step: 5_000,
  },
  speakingCapMs: {
    label: 'Continuous speech holds the session for',
    unit: 'ms',
    default: 30_000,
    min: 10_000,
    max: 120_000,
    step: 5_000,
  },
  answerLingerMs: {
    label: 'Answer stays on screen',
    unit: 'ms',
    default: 180_000,
    min: 10_000,
    max: 600_000,
    step: 10_000,
  },
  speechRate: {
    label: 'Cue speech rate',
    unit: 'rate',
    default: 0.8,
    min: 0.5,
    max: 1.2,
    step: 0.05,
  },
  afterChimeMs: {
    label: 'Pause after the chime',
    unit: 'ms',
    default: 300,
    min: 0,
    max: 2_000,
    step: 100,
  },
  speechTimeoutMinMs: {
    label: 'Spoken line stuck after at least',
    unit: 'ms',
    default: 15_000,
    min: 5_000,
    max: 60_000,
    step: 1_000,
  },
  speechMsPerChar: {
    label: 'Spoken line time per character',
    unit: 'ms',
    default: 150,
    min: 50,
    max: 500,
    step: 10,
  },
  cueSettleMs: {
    label: 'Cue waits after a voice session',
    unit: 'ms',
    default: 2_000,
    min: 500,
    max: 10_000,
    step: 500,
  },
  cueRetryMs: {
    label: 'Retry a failed cue after',
    unit: 'ms',
    default: 5_000,
    min: 1_000,
    max: 60_000,
    step: 1_000,
  },
  cueMinGapMs: {
    label: 'Snooze end and its reprompt count as one within',
    unit: 'ms',
    default: 120_000,
    min: 30_000,
    max: 600_000,
    step: 10_000,
  },
  pressGapMs: {
    label: 'Ignore a second press within',
    unit: 'ms',
    default: 700,
    min: 200,
    max: 2_000,
    step: 100,
  },
  messageMs: {
    label: 'Status message stays',
    unit: 'ms',
    default: 10_000,
    min: 3_000,
    max: 30_000,
    step: 1_000,
  },
  carouselMs: {
    label: 'Now and Today screens switch every',
    unit: 'ms',
    default: 45_000,
    min: 10_000,
    max: 300_000,
    step: 5_000,
  },
} as const satisfies Record<string, TuningSpec>;

export type TuningKey = keyof typeof TUNING_SPECS;

export type DisplayTuning = Record<TuningKey, number>;

export const TUNING_KEYS = Object.keys(TUNING_SPECS) as TuningKey[];

function tuningFrom(valueOf: (key: TuningKey) => number): DisplayTuning {
  return Object.fromEntries(TUNING_KEYS.map((key) => [key, valueOf(key)])) as DisplayTuning;
}

export const DEFAULT_TUNING: Readonly<DisplayTuning> = tuningFrom(
  (key) => TUNING_SPECS[key].default,
);

export const SPEECH_LANGUAGE = 'en-US';

export const SPEECH_AUDIO_MODE = {
  playsInSilentMode: true,
  interruptionMode: 'duckOthers',
  allowsRecording: false,
  shouldPlayInBackground: false,
} as const;

export function clampTuning(key: TuningKey, value: unknown): number {
  const spec: TuningSpec = TUNING_SPECS[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) return spec.default;
  const stepped = Math.round(value / spec.step) * spec.step;
  const tidy = Number(stepped.toFixed(2));
  return Math.min(spec.max, Math.max(spec.min, tidy));
}

export function sanitizeTuning(raw: unknown): DisplayTuning {
  const source = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  return tuningFrom((key) => clampTuning(key, source[key]));
}

export function formatTuning(key: TuningKey, value: number): string {
  if (TUNING_SPECS[key].unit === 'rate') return `${value.toFixed(2)}x`;
  return value < 1000 ? `${value} ms` : `${value / 1000} s`;
}
