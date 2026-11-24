import {
  PressNotSaved,
  type LoggedAnswer,
  type LoggedPress,
  type PressStore,
  type SeenLog,
} from '../day/pressLog';

export interface FakePressStore extends PressStore {
  log: () => readonly LoggedPress[];
  pressedElsewhere: (press: Pick<LoggedPress, 'instanceId' | 'step' | 'pressedAt'>) => LoggedPress;
  answer: (pressId: string, answer?: LoggedAnswer) => void;
  failWrites: (fail: boolean) => void;
  unpair: () => void;
  holdWrites: () => () => void;
}

export function makeFakePressStore(): FakePressStore {
  let seen: SeenLog = { presses: [], at: Date.now() };
  let nextId = 0;
  let failing = false;
  let paired = true;
  let held: Promise<void> | null = null;
  const listeners = new Set<() => void>();

  const set = (presses: readonly LoggedPress[]): void => {
    seen = { presses, at: Date.now() };
    listeners.forEach((listener) => listener());
  };

  const change = (pressId: string, patch: (press: LoggedPress) => LoggedPress): void =>
    set(seen.presses.map((press) => (press.pressId === pressId ? patch(press) : press)));

  const write = async (what: 'press' | 'undo'): Promise<void> => {
    if (held !== null) await held;
    if (!paired) throw new PressNotSaved(what, 'noCredentials');
    if (failing) throw new PressNotSaved(what, 'notSaved');
  };

  const append = (press: Pick<LoggedPress, 'instanceId' | 'step' | 'pressedAt'>): LoggedPress => {
    nextId += 1;
    const logged = { ...press, pressId: `press-${String(nextId).padStart(16, '0')}` };
    set([...seen.presses, logged]);
    return logged;
  };

  return {
    subscribe: (listener) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    getSeen: () => seen,
    storePress: async (instanceId, step) => {
      await write('press');
      append({ instanceId, step, pressedAt: Date.now() });
    },
    storeUndo: async (pressId) => {
      await write('undo');
      change(pressId, (press) =>
        press.undo ? press : { ...press, undo: { undoneAt: Date.now() } },
      );
    },
    log: () => seen.presses,
    pressedElsewhere: append,
    answer: (pressId, answer = { applied: true }) =>
      change(pressId, (press) => ({ ...press, answer })),
    failWrites: (fail) => {
      failing = fail;
    },
    unpair: () => {
      paired = false;
    },
    holdWrites: () => {
      let release!: () => void;
      held = new Promise<void>((resolve) => (release = resolve));
      return () => {
        held = null;
        release();
      };
    },
  };
}
