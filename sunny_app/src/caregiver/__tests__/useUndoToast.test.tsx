// sunny_app/src/caregiver/__tests__/useUndoToast.test.tsx
//
// Purpose: Tests for useUndoToast, rendering the real hook with react-test-renderer and fake
// timers: the toast shows for the task, goes away after the duration, a newer tick replaces it
// and restarts the timer (the older timer must not hide the newer toast), dismiss hides it at
// once, unmounting clears the timer, and a show after unmount arms no timer.
//
// Last modified: 2026-11-01

import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { UNDO_TOAST_MS, useUndoToast, type UndoToast } from '../useUndoToast';

/**
 * purpose: Render the real hook and expose its latest return value.
 * @return: (object) A getter for the current toast state and the renderer.
 */
function renderToast(): { get: () => UndoToast<string>; renderer: ReactTestRenderer } {
  let current!: UndoToast<string>;
  const Probe = (): null => {
    current = useUndoToast<string>();
    return null;
  };
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(<Probe />);
  });
  return { get: () => current, renderer };
}

describe('useUndoToast', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('shows nothing at first', () => {
    expect(renderToast().get().id).toBeNull();
  });

  it('shows the task, then hides it after the duration', () => {
    const h = renderToast();
    act(() => h.get().show('a'));
    expect(h.get().id).toBe('a');
    act(() => {
      jest.advanceTimersByTime(UNDO_TOAST_MS - 1);
    });
    expect(h.get().id).toBe('a');
    act(() => {
      jest.advanceTimersByTime(1);
    });
    expect(h.get().id).toBeNull();
  });

  it('a newer tick replaces the toast and restarts the timer', () => {
    const h = renderToast();
    act(() => h.get().show('a'));
    act(() => {
      jest.advanceTimersByTime(3000);
    });
    act(() => h.get().show('b'));
    expect(h.get().id).toBe('b');
    act(() => {
      jest.advanceTimersByTime(3000);
    });
    expect(h.get().id).toBe('b');
    act(() => {
      jest.advanceTimersByTime(2000);
    });
    expect(h.get().id).toBeNull();
  });

  it('dismiss hides the toast at once and the old timer does not fire later', () => {
    const h = renderToast();
    act(() => h.get().show('a'));
    act(() => h.get().dismiss());
    expect(h.get().id).toBeNull();
    act(() => h.get().show('b'));
    act(() => {
      jest.advanceTimersByTime(UNDO_TOAST_MS - 1);
    });
    expect(h.get().id).toBe('b');
  });

  it('keeps show and dismiss stable between renders', () => {
    const h = renderToast();
    const { show, dismiss } = h.get();
    act(() => h.get().show('a'));
    expect(h.get().show).toBe(show);
    expect(h.get().dismiss).toBe(dismiss);
  });

  it('clears the timer on unmount', () => {
    const h = renderToast();
    act(() => h.get().show('a'));
    act(() => h.renderer.unmount());
    expect(jest.getTimerCount()).toBe(0);
  });

  it('a show after unmount does nothing and arms no timer', () => {
    const h = renderToast();
    const { show } = h.get();
    act(() => h.renderer.unmount());
    act(() => show('a'));
    expect(jest.getTimerCount()).toBe(0);
  });
});
