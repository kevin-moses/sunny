// sunny_app/src/day/__tests__/useDoneAction.test.tsx
//
// Purpose: Tests for the phone's Done button. doneTarget (pure): the first due or escalated
// timed task, none when nothing is due, anytime and upcoming tasks never targeted. The real
// useDoneAction hook with callMutation mocked: a press confirms the target by instance id via
// "phone_app" and shows the result, no target sends nothing, a press within the gap is ignored
// (fake timers), a press while a confirm is in flight is ignored, a failure shows its message
// and says the task is not checked off, offline sends nothing and says so, and the result line
// clears itself. DoneCard: shows the label and a Done button when a task is due, nothing when
// there is neither a task nor a message.
//
// Last modified: 2026-11-09

import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { getFunctionName } from 'convex/server';
import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { BackendError, callMutation } from '../../backend/api';
import { DoneCard } from '../../components/DayComponents';
import type { DayTask } from '../types';
import {
  doneTarget,
  MESSAGE_MS,
  OFFLINE_DONE_MESSAGE,
  PRESS_GAP_MS,
  useDoneAction,
  type DoneAction,
} from '../useDoneAction';

jest.mock('../../backend/convex', () => ({ convex: {} }));

jest.mock('../../backend/api', () => ({
  ...jest.requireActual<typeof import('../../backend/api')>('../../backend/api'),
  callMutation: jest.fn(),
}));

jest.mock('expo-symbols', () => ({ SymbolView: () => null }));

jest.mock('../../theme/ThemeProvider', () => ({ useTheme: () => ({ accentColor: '#FA8539' }) }));

const mockCall = callMutation as unknown as jest.Mock<(...a: unknown[]) => Promise<unknown>>;
const mounted: ReactTestRenderer[] = [];

/**
 * purpose: Build a task fixture.
 * @param overrides: (Partial<DayTask>) Fields to change.
 * @return: (DayTask) The task.
 */
function task(overrides: Partial<DayTask> = {}): DayTask {
  return {
    instanceId: 'inst1',
    displayLabel: 'Morning pills',
    scheduledTime: '08:00',
    state: 'due',
    ...overrides,
  } as unknown as DayTask;
}

/**
 * purpose: Render the real hook and expose its latest return value.
 * @param target: (DayTask | null) The task Done confirms.
 * @param isOffline: (boolean) Whether the phone is offline.
 * @return: ({ get }) A getter for the current DoneAction.
 */
function renderDone(target: DayTask | null, isOffline = false): { get: () => DoneAction } {
  let current!: DoneAction;
  const Probe = (): null => {
    current = useDoneAction(target, isOffline);
    return null;
  };
  act(() => {
    mounted.push(create(<Probe />));
  });
  return { get: () => current };
}

describe('doneTarget', () => {
  it('picks the first due task', () => {
    const first = task({ instanceId: 'a' as never });
    const second = task({ instanceId: 'b' as never });
    const done = task({ instanceId: 'x' as never, state: 'confirmed' });
    expect(doneTarget([done, first, second])).toBe(first);
  });

  it('picks an escalated task', () => {
    const late = task({ state: 'escalated' });
    expect(doneTarget([late])).toBe(late);
  });

  it('is null when nothing is due', () => {
    expect(doneTarget([task({ state: 'upcoming' }), task({ state: 'missed' })])).toBeNull();
    expect(doneTarget([])).toBeNull();
  });

  it('never targets an anytime task', () => {
    expect(doneTarget([task({ scheduledTime: 'anytime' })])).toBeNull();
  });
});

describe('useDoneAction', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-11-09T08:00:00Z'));
    mockCall.mockReset();
    mockCall.mockResolvedValue(null);
  });

  afterEach(() => {
    act(() => {
      mounted.splice(0).forEach((renderer) => renderer.unmount());
    });
    jest.useRealTimers();
  });

  it('confirms the target by instance id as phone_app and shows the result', async () => {
    const h = renderDone(task());
    await act(async () => {
      h.get().pressDone();
    });
    expect(mockCall).toHaveBeenCalledTimes(1);
    const [ref, args] = mockCall.mock.calls[0];
    expect(getFunctionName(ref as never)).toBe('instances:confirmTaskInstance');
    expect(args).toEqual({ instanceId: 'inst1', via: 'phone_app' });
    expect(h.get().message).toBe('Checked off: Morning pills');
    expect(h.get().busy).toBe(false);
  });

  it('sends nothing without a target', async () => {
    const h = renderDone(null);
    await act(async () => {
      h.get().pressDone();
    });
    expect(mockCall).not.toHaveBeenCalled();
    expect(h.get().message).toBeNull();
  });

  it('ignores a second press within the gap', async () => {
    const h = renderDone(task());
    await act(async () => {
      h.get().pressDone();
    });
    act(() => {
      jest.advanceTimersByTime(PRESS_GAP_MS - 100);
    });
    await act(async () => {
      h.get().pressDone();
    });
    expect(mockCall).toHaveBeenCalledTimes(1);
  });

  it('accepts a press after the gap', async () => {
    const h = renderDone(task());
    await act(async () => {
      h.get().pressDone();
    });
    act(() => {
      jest.advanceTimersByTime(PRESS_GAP_MS + 100);
    });
    await act(async () => {
      h.get().pressDone();
    });
    expect(mockCall).toHaveBeenCalledTimes(2);
  });

  it('ignores presses while a confirm is in flight', async () => {
    let finish!: () => void;
    mockCall.mockReturnValue(new Promise<void>((resolve) => (finish = resolve)));
    const h = renderDone(task());
    await act(async () => {
      h.get().pressDone();
    });
    expect(h.get().busy).toBe(true);
    act(() => {
      jest.advanceTimersByTime(PRESS_GAP_MS + 100);
    });
    await act(async () => {
      h.get().pressDone();
    });
    expect(mockCall).toHaveBeenCalledTimes(1);
    await act(async () => {
      finish();
    });
    expect(h.get().busy).toBe(false);
  });

  it('shows the failure and says the task is not checked off', async () => {
    mockCall.mockRejectedValue(new BackendError('Could not reach Sunny.', 0));
    const h = renderDone(task());
    await act(async () => {
      h.get().pressDone();
    });
    expect(h.get().message).toBe('Could not reach Sunny. It is not checked off yet.');
    expect(h.get().busy).toBe(false);
  });

  it('sends nothing offline and says so', async () => {
    const h = renderDone(task(), true);
    await act(async () => {
      h.get().pressDone();
    });
    expect(mockCall).not.toHaveBeenCalled();
    expect(h.get().message).toBe(OFFLINE_DONE_MESSAGE);
  });

  it('clears the result line after MESSAGE_MS', async () => {
    const h = renderDone(task());
    await act(async () => {
      h.get().pressDone();
    });
    act(() => {
      jest.advanceTimersByTime(MESSAGE_MS + 1);
    });
    expect(h.get().message).toBeNull();
  });
});

describe('DoneCard', () => {
  afterEach(() => {
    act(() => {
      mounted.splice(0).forEach((renderer) => renderer.unmount());
    });
  });

  /**
   * purpose: Render the card and report what it shows.
   * @param props: (object) The task and message.
   * @return: ({ texts, buttons, empty }) The strings shown, the number of buttons, and whether
   *          nothing rendered.
   */
  function render(props: { task: DayTask | null; message: string | null }): {
    texts: string[];
    buttons: number;
    empty: boolean;
  } {
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(<DoneCard {...props} busy={false} onPress={() => {}} />);
      mounted.push(renderer);
    });
    const root = renderer.root;
    return {
      texts: root
        .findAll((n) => (n.type as unknown) === 'Text')
        .map((n) => String(n.props.children)),
      buttons: root.findAll((n) => n.props.accessibilityRole === 'button').length,
      empty: renderer.toJSON() === null,
    };
  }

  it('shows the task label and a Done button when a task is due', () => {
    const out = render({ task: task(), message: null });
    expect(out.texts).toContain('Morning pills');
    expect(out.texts).toContain('Done');
    expect(out.buttons).toBeGreaterThanOrEqual(1);
  });

  it('shows only the message, with no button, when nothing is due', () => {
    const out = render({ task: null, message: 'Checked off: Morning pills' });
    expect(out.texts).toEqual(['Checked off: Morning pills']);
    expect(out.buttons).toBe(0);
  });

  it('renders nothing when there is no task and no message', () => {
    expect(render({ task: null, message: null }).empty).toBe(true);
  });
});
