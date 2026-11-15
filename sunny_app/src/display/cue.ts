import { clockTime, isDue, stepCounter } from '../day/format';
import type { DayTask } from '../day/types';

export const SAMPLE_PROMPT =
  "Time for Morning pills, at 8 o'clock. Press Done when you have taken them.";

export function cueKey(
  task: Pick<DayTask, 'instanceId' | 'seniorPrompts' | 'snoozedUntil'>,
): string {
  const base = `${task.instanceId}:${task.seniorPrompts}`;
  return task.snoozedUntil == null ? base : `${base}:${task.snoozedUntil}`;
}

function keyInstance(key: string): string {
  return key.replace(/(:\d+)+$/, '');
}

export function isCueable(task: DayTask): boolean {
  return isDue(task) && !task.snoozed;
}

interface CueChoice {
  play: DayTask[];
  absorb: DayTask[];
}

interface CueSpacing {
  lastCueAt: ReadonlyMap<string, number>;
  now: number;
  minGapMs: number;
}

export function cueChoice(
  tasks: DayTask[],
  cued: ReadonlySet<string>,
  spacing: CueSpacing,
): CueChoice {
  const owed = tasks.filter((task) => isCueable(task) && !cued.has(cueKey(task)));
  const snoozeEndRepeat = (task: DayTask): boolean => {
    const ended = task.snoozedUntil;
    const last = spacing.lastCueAt.get(task.instanceId);
    if (ended == null || last === undefined) return false;
    return last >= ended && spacing.now - ended < spacing.minGapMs;
  };
  return { play: owed.filter((t) => !snoozeEndRepeat(t)), absorb: owed.filter(snoozeEndRepeat) };
}

export function rememberCued(
  cued: ReadonlySet<string>,
  played: DayTask[],
  tasks: DayTask[],
): Set<string> {
  const live = new Set<string>(tasks.map((t) => t.instanceId));
  const next = new Set<string>();
  for (const key of [...cued, ...played.map(cueKey)]) {
    if (live.has(keyInstance(key))) next.add(key);
  }
  return next;
}

export function spokenTime(localTime: string): string {
  const clock = clockTime(localTime);
  return clock.endsWith(':00') ? `${clock.slice(0, -3)} o'clock` : clock;
}

export function hasWrittenPrompt(task: Pick<DayTask, 'spokenPrompt' | 'displayLabel'>): boolean {
  const prompt = task.spokenPrompt.trim();
  return prompt !== '' && prompt !== `Time for ${task.displayLabel}.`;
}

export function stepSpeech(step: NonNullable<DayTask['step']>): string {
  const text = step.text.trim();
  const end = /[.!?]$/.test(text) ? '' : '.';
  return `${stepCounter(step)}: ${text}${end}`;
}

function baseCueSpeech(task: DayTask): string {
  if (hasWrittenPrompt(task)) return task.spokenPrompt.trim();
  const finish = task.type === 'medication' ? 'taken them' : 'finished';
  const when = spokenTime(task.scheduledTime);
  return `Time for ${task.displayLabel}, at ${when}. Press Done when you have ${finish}.`;
}

export function cueSpeech(task: DayTask): string {
  const base = baseCueSpeech(task);
  return task.step === null ? base : `${base} ${stepSpeech(task.step)}`;
}
