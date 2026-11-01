// sunny_app/src/caregiver/useUndoableCompletion.ts
//
// Purpose: Deferred "mark done" with a short undo window. Ticking a task shows it as done at
// once, but the server call waits UNDO_DELAY_MS so the caregiver can undo it. The timer and the
// state transitions live in a plain controller (createCompletionController) so they can be tested
// with fake timers; the hook wraps one controller for a screen. Only one completion is pending at
// a time: starting another commits the previous one immediately. Pending completions are also
// committed at once when the app goes to the background, when the screen is no longer the active
// tab, and when it unmounts, so a tick is never lost.
//
// Last modified: 2026-11-01

import { useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';

/** How long (milliseconds) a completion can be undone before it is sent. */
export const UNDO_DELAY_MS = 5000;

/** What a completion controller needs. */
export interface CompletionControllerOptions<T> {
  /** How long a completion stays pending. */
  delayMs: number;
  /** Called with the id when a completion is committed (timer end, flush or a newer start). */
  commit: (id: T) => void;
  /** Called with the pending id whenever it changes (null when nothing is pending). */
  onChange: (id: T | null) => void;
}

/** Starts, undoes and flushes the single pending completion. */
export interface CompletionController<T> {
  /** Make id the pending completion; a different pending one is committed first. */
  start: (id: T) => void;
  /** Cancel the pending completion; nothing is committed. */
  undo: () => void;
  /** Commit the pending completion now, if there is one. */
  flush: () => void;
}

/**
 * purpose: Create the controller behind the undo window.
 * @param options: (CompletionControllerOptions<T>) The delay and the commit and change callbacks.
 * @return: (CompletionController<T>) The controller; it holds the pending id and its timer.
 */
export function createCompletionController<T>(
  options: CompletionControllerOptions<T>,
): CompletionController<T> {
  let pending: { id: T } | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  /**
   * purpose: Stop the running timer, if any.
   * @return: (void)
   */
  const clearTimer = (): void => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };

  /**
   * purpose: Commit the pending completion now.
   * @return: (void)
   */
  const flush = (): void => {
    if (pending === null) return;
    const { id } = pending;
    clearTimer();
    pending = null;
    options.onChange(null);
    options.commit(id);
  };

  /**
   * purpose: Make an id the pending completion and (re)start the undo timer.
   * @param id: (T) The task to complete.
   * @return: (void)
   */
  const start = (id: T): void => {
    if (pending !== null && pending.id !== id) flush();
    clearTimer();
    pending = { id };
    options.onChange(id);
    timer = setTimeout(flush, options.delayMs);
  };

  /**
   * purpose: Cancel the pending completion without committing it.
   * @return: (void)
   */
  const undo = (): void => {
    clearTimer();
    pending = null;
    options.onChange(null);
  };

  return { start, undo, flush };
}

/** What useUndoableCompletion returns. */
export interface UndoableCompletion<T> {
  /** The id whose completion is pending (shown as done, with the undo toast); else null. */
  pendingId: T | null;
  /** Show id as done and send it after the undo window. */
  complete: (id: T) => void;
  /** Cancel the pending completion. */
  undo: () => void;
}

/**
 * purpose: Give a screen the deferred, undoable completion of tasks.
 * @param commit: ((id: T) => void) Sends the completion (for example markDone); the latest
 *        function is always used.
 * @param active: (boolean) Whether the screen is the visible tab; going inactive commits.
 * @return: (UndoableCompletion<T>) The pending id and the complete and undo functions.
 */
export function useUndoableCompletion<T>(
  commit: (id: T) => void,
  active: boolean,
): UndoableCompletion<T> {
  const [pendingId, setPendingId] = useState<T | null>(null);
  const commitRef = useRef(commit);
  const controllerRef = useRef<CompletionController<T> | null>(null);

  useEffect(() => {
    commitRef.current = commit;
  });

  useEffect(() => {
    const controller = createCompletionController<T>({
      delayMs: UNDO_DELAY_MS,
      commit: (id) => commitRef.current(id),
      onChange: setPendingId,
    });
    controllerRef.current = controller;
    const subscription = AppState.addEventListener('change', (state) => {
      if (state !== 'active') controller.flush();
    });
    return () => {
      subscription.remove();
      controller.flush();
      controllerRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!active) controllerRef.current?.flush();
  }, [active]);

  return {
    pendingId,
    complete: (id) => controllerRef.current?.start(id),
    undo: () => controllerRef.current?.undo(),
  };
}
