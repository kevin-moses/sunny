// sunny_app/src/display/tuning.ts
//
// Purpose: Every tunable number of the home display's voice and cue behavior, in one place:
// its default, unit, allowed range and step (TUNING_SPECS), plus the pure rules that keep a
// value safe (clampTuning: inside the range and on the step, so a typo cannot make a 0 ms
// timeout or a microphone that never closes) and that turn stored data back into valid values
// (sanitizeTuning). Defaults are the product owner's starting values. TuningProvider holds
// the live values (persisted, adjustable from the developer sheet); hooks read them with
// useTuning().
//
// Last modified: 2026-11-09

/** The tunable values, all numbers. Durations are milliseconds; speechRate is a multiple. */
export interface DisplayTuning {
  /** Longest a Talk press may take to reach the agent before it gives up (ms). */
  startTimeoutMs: number;
  /** How long the session waits for the first question before it ends (ms). */
  firstQuestionMs: number;
  /** How long the session waits for a follow-up after an answer (ms). */
  followUpMs: number;
  /** How long the agent may think or speak with nothing changing before the session ends (ms). */
  stuckMs: number;
  /** How long an answer stays on the panel after the session ends (ms). */
  answerLingerMs: number;
  /** Speech rate of the due cue, as a multiple of the system's normal rate. */
  speechRate: number;
  /** Pause between the chime and the spoken prompt (ms). */
  afterChimeMs: number;
  /** Shortest time a spoken line may take before it counts as stuck (ms). */
  speechTimeoutMinMs: number;
  /** Time allowed per character of a spoken line at rate 1, for the stuck limit (ms). */
  speechMsPerChar: number;
  /** Wait after a voice session ends before an owed cue plays, so audio can settle (ms). */
  cueSettleMs: number;
  /** Wait before the one retry of a cue that failed to play (ms). */
  cueRetryMs: number;
  /** Key presses closer together than this count as one (ms). */
  pressGapMs: number;
  /** How long a message stays on the status line (ms). */
  messageMs: number;
  /** How long each carousel screen (Now, Today) stays up (ms). */
  carouselMs: number;
}

/** A tunable's name. */
export type TuningKey = keyof DisplayTuning;

/** How a tunable is shown and bounded. */
export interface TuningSpec {
  /** Label in the developer sheet. */
  label: string;
  /** 'ms' values are shown in seconds; 'rate' values as a multiple ("0.80x"). */
  unit: 'ms' | 'rate';
  default: number;
  min: number;
  max: number;
  /** The stepper's increment; values are rounded to it. */
  step: number;
}

/** The tunables in the order the developer sheet lists them. */
export const TUNING_SPECS: Readonly<Record<TuningKey, TuningSpec>> = {
  startTimeoutMs: {
    label: 'Give up connecting after',
    unit: 'ms',
    default: 15_000,
    min: 5_000,
    max: 60_000,
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
};

/** The tunable names, in sheet order. */
export const TUNING_KEYS = Object.keys(TUNING_SPECS) as TuningKey[];

/** The default value of every tunable. */
export const DEFAULT_TUNING: Readonly<DisplayTuning> = Object.fromEntries(
  TUNING_KEYS.map((key) => [key, TUNING_SPECS[key].default]),
) as unknown as DisplayTuning;

/**
 * purpose: Make a candidate value safe: round it to the tunable's step and keep it inside its
 *          range; anything that is not a finite number becomes the default.
 * @param key: (TuningKey) The tunable.
 * @param value: (unknown) The candidate.
 * @return: (number) A valid value.
 */
export function clampTuning(key: TuningKey, value: unknown): number {
  const spec = TUNING_SPECS[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) return spec.default;
  const stepped = Math.round(value / spec.step) * spec.step;
  // Two decimals strip floating point noise from fractional steps (0.8 + 0.05).
  const tidy = Number(stepped.toFixed(2));
  return Math.min(spec.max, Math.max(spec.min, tidy));
}

/**
 * purpose: Turn stored data into valid tunables; missing or bad fields get their default.
 * @param raw: (unknown) A parsed JSON value.
 * @return: (DisplayTuning) Valid tunables.
 */
export function sanitizeTuning(raw: unknown): DisplayTuning {
  const source = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  return Object.fromEntries(
    TUNING_KEYS.map((key) => [key, clampTuning(key, source[key])]),
  ) as unknown as DisplayTuning;
}

/**
 * purpose: A tunable's value as the developer sheet shows it: seconds for durations of a
 *          second or more ("20 s"), milliseconds below ("300 ms"), a multiple for the rate
 *          ("0.80x").
 * @param key: (TuningKey) The tunable.
 * @param value: (number) The value.
 * @return: (string) The text.
 */
export function formatTuning(key: TuningKey, value: number): string {
  if (TUNING_SPECS[key].unit === 'rate') return `${value.toFixed(2)}x`;
  return value < 1000 ? `${value} ms` : `${value / 1000} s`;
}
