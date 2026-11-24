export interface LoggedAnswer {
  applied: boolean;
  answeredPresses?: number;
}

export interface LoggedUndo {
  undoneAt: number;
  answer?: LoggedAnswer;
}

export interface LoggedPress {
  pressId: string;
  instanceId: string;
  step: number;
  pressedAt: number;
  answer?: LoggedAnswer;
  undo?: LoggedUndo;
}

export interface SeenLog {
  presses: readonly LoggedPress[];
  at: number;
}

export interface PressStore {
  subscribe: (listener: () => void) => () => void;
  getSeen: () => SeenLog;
  storePress: (instanceId: string, step: number) => Promise<void>;
  storeUndo: (pressId: string) => Promise<void>;
}

export class PressNotSaved extends Error {
  readonly noCredentials: boolean;

  constructor(what: 'press' | 'undo', status: string) {
    super(`The ${what} was not saved (${status})`);
    this.name = 'PressNotSaved';
    this.noCredentials = status === 'noCredentials';
  }
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isAnswer(value: unknown): value is LoggedAnswer | undefined {
  if (value === undefined) return true;
  if (!isRecord(value) || typeof value.applied !== 'boolean') return false;
  return value.answeredPresses === undefined || Number.isInteger(value.answeredPresses);
}

function isUndo(value: unknown): value is LoggedUndo | undefined {
  if (value === undefined) return true;
  return isRecord(value) && isFiniteNumber(value.undoneAt) && isAnswer(value.answer);
}

export function isLoggedPress(value: unknown): value is LoggedPress {
  return (
    isRecord(value) &&
    typeof value.pressId === 'string' &&
    typeof value.instanceId === 'string' &&
    Number.isInteger(value.step) &&
    isFiniteNumber(value.pressedAt) &&
    isAnswer(value.answer) &&
    isUndo(value.undo)
  );
}

export function hasUnsent(press: LoggedPress): boolean {
  return (
    press.answer === undefined || (press.undo !== undefined && press.undo.answer === undefined)
  );
}

export function oldestUnsentAt(log: readonly LoggedPress[]): number | null {
  const times = log.filter(hasUnsent).map((press) => press.pressedAt);
  return times.length === 0 ? null : Math.min(...times);
}
