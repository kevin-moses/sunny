// sunny_app/src/day/__tests__/useDoneAction.test.tsx
//
// Purpose: Tests for the phone's Done button. doneTarget (pure): the first due or escalated
// timed task, none when nothing is due, anytime and upcoming tasks never targeted. The real
// useDoneAction hook and the real callMutation / toBackendError, with only convex.mutation
// stubbed (the network boundary): a press confirms the target by instance id via "phone_app"
// and announces the result; no target sends nothing; presses inside the gap and while in flight
// are ignored; a real ConvexError and a plain network Error show their messages and say the
// task is not checked off; offline sends nothing; the result clears itself; a target change
// while in flight keeps the original id; with two tasks due the button is withdrawn for the
// settle period after a success (a second press sends nothing, then the next task is offered
// and can be confirmed, and the first task's line never shows under the second button); a
// hung call shows "Still trying", frees the button, and a late success corrects the line only
// while that line is showing; nothing is set, scheduled or announced after unmount. DoneCard:
// label, one button with its accessibility label, onPress wiring, busy state, message only.
//
// Last modified: 2026-11-09

import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { ConvexError } from 'convex/values';
import { getFunctionName } from 'convex/server';
import React from 'react';
import { AccessibilityInfo } from 'react-native';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

import { convex } from '../../backend/convex';
import { DoneCard } from '../../components/DayComponents';
import type { DayTask } from '../types';
import {
  CONFIRM_TIMEOUT_MS,
  doneTarget,
  MESSAGE_MS,
  OFFLINE_DONE_MESSAGE,
  PRESS_GAP_MS,
  SETTLE_MS,
  STILL_TRYING_MESSAGE,
  useDoneAction,
  type DoneAction,
} from '../useDoneAction';

jest.mock('../../backend/convex', () => ({ convex: { mutation: jest.fn() } }));

jest.mock('expo-symbols', () => ({ SymbolView: () => null }));

jest.mock('../../theme/ThemeProvider', () => ({ useTheme: () => ({ accentColor: '#FA8539' }) }));

const mockMutation = convex.mutation as unknown as jest.Mock<(...a: unknown[]) => Promise<unknown>>;
const mounted: ReactTestRenderer[] = [];
let announce: jest.SpiedFunction<typeof AccessibilityInfo.announceForAccessibility>;

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

/** A second due task. */
const SECOND = (): DayTask =>
  task({ instanceId: 'inst2' as never, displayLabel: 'Evening pills', scheduledTime: '09:00' });

/**
 * purpose: Render the real hook and expose its latest return value; the target and offline
 *          flag can be changed with rerender.
 * @param target: (DayTask | null) The task Done confirms.
 * @param isOffline: (boolean) Whether the phone is offline.
 * @return: (object) get (the current DoneAction), rerender and unmount.
 */
function renderDone(
  target: DayTask | null,
  isOffline = false,
): {
  get: () => DoneAction;
  rerender: (target: DayTask | null, isOffline?: boolean) => void;
  unmount: () => void;
} {
  let latest: DoneAction | undefined;
  const record = (value: DoneAction): void => {
    latest = value;
  };
  /**
   * purpose: Test component that runs the hook and records its latest return value.
   * @param props: ({ t, off }) The target task and the offline flag.
   * @return: (null) Renders nothing.
   */
  const Probe = ({ t, off }: { t: DayTask | null; off: boolean }): null => {
    record(useDoneAction(t, off));
    return null;
  };
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(<Probe t={target} off={isOffline} />);
    mounted.push(renderer);
  });
  return {
    get: () => latest as DoneAction,
    rerender: (t, off = false) => act(() => renderer.update(<Probe t={t} off={off} />)),
    unmount: () => act(() => renderer.unmount()),
  };
}

/**
 * purpose: Press Done inside act and let promises settle.
 * @param h: (object) The rendered hook.
 * @return: (Promise<void>)
 */
async function press(h: { get: () => DoneAction }): Promise<void> {
  await act(async () => {
    h.get().pressDone();
  });
}

/**
 * purpose: Advance fake time inside act.
 * @param ms: (number) Milliseconds.
 * @return: (Promise<void>)
 */
async function advance(ms: number): Promise<void> {
  await act(async () => {
    jest.advanceTimersByTime(ms);
  });
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
    mockMutation.mockReset();
    mockMutation.mockResolvedValue(null);
    announce = jest
      .spyOn(AccessibilityInfo, 'announceForAccessibility')
      .mockImplementation(() => {});
  });

  afterEach(() => {
    act(() => {
      mounted.splice(0).forEach((renderer) => renderer.unmount());
    });
    announce.mockRestore();
    jest.useRealTimers();
  });

  it('confirms the target by instance id as phone_app, shows and announces the result', async () => {
    const h = renderDone(task());
    await press(h);
    expect(mockMutation).toHaveBeenCalledTimes(1);
    const [ref, args] = mockMutation.mock.calls[0];
    expect(getFunctionName(ref as never)).toBe('instances:confirmTaskInstance');
    expect(args).toEqual({ instanceId: 'inst1', via: 'phone_app' });
    expect(h.get().message).toBe('Checked off: Morning pills');
    expect(h.get().busy).toBe(false);
    expect(announce).toHaveBeenCalledWith('Checked off: Morning pills');
  });

  it('sends nothing without a target', async () => {
    const h = renderDone(null);
    await press(h);
    expect(mockMutation).not.toHaveBeenCalled();
    expect(h.get().message).toBeNull();
  });

  it('ignores a second press within the gap', async () => {
    const h = renderDone(task());
    mockMutation.mockRejectedValueOnce(new Error('Network request failed'));
    await press(h);
    await advance(PRESS_GAP_MS - 100);
    await press(h);
    expect(mockMutation).toHaveBeenCalledTimes(1);
  });

  it('accepts a press after the gap', async () => {
    const h = renderDone(task());
    mockMutation.mockRejectedValueOnce(new Error('Network request failed'));
    await press(h);
    await advance(PRESS_GAP_MS + 100);
    await press(h);
    expect(mockMutation).toHaveBeenCalledTimes(2);
  });

  it('ignores presses while a confirm is in flight', async () => {
    let finish!: () => void;
    mockMutation.mockReturnValue(new Promise<void>((resolve) => (finish = resolve)));
    const h = renderDone(task());
    await press(h);
    expect(h.get().busy).toBe(true);
    await advance(PRESS_GAP_MS + 100);
    await press(h);
    expect(mockMutation).toHaveBeenCalledTimes(1);
    await act(async () => finish());
    expect(h.get().busy).toBe(false);
  });

  it('shows a backend error message and says the task is not checked off', async () => {
    mockMutation.mockRejectedValue(
      new ConvexError({ code: 'invalid', message: 'This task is not due yet' }),
    );
    const h = renderDone(task());
    await press(h);
    expect(h.get().message).toBe('This task is not due yet It is not checked off yet.');
    expect(h.get().task).not.toBeNull();
    expect(h.get().busy).toBe(false);
  });

  it('shows the offline message for a network failure', async () => {
    mockMutation.mockRejectedValue(new Error('Network request failed'));
    const h = renderDone(task());
    await press(h);
    expect(h.get().message).toBe(
      'Could not reach Sunny. Check the internet connection. It is not checked off yet.',
    );
  });

  it('sends nothing offline and says so', async () => {
    const h = renderDone(task(), true);
    await press(h);
    expect(mockMutation).not.toHaveBeenCalled();
    expect(h.get().message).toBe(OFFLINE_DONE_MESSAGE);
  });

  it('clears the result line after MESSAGE_MS', async () => {
    const h = renderDone(task());
    await press(h);
    await advance(MESSAGE_MS + 1);
    expect(h.get().message).toBeNull();
  });

  it('confirms the original instance when the target changes while in flight', async () => {
    let finish!: () => void;
    mockMutation.mockReturnValue(new Promise<void>((resolve) => (finish = resolve)));
    const h = renderDone(task());
    await press(h);
    h.rerender(SECOND());
    await act(async () => finish());
    expect(mockMutation.mock.calls[0][1]).toEqual({ instanceId: 'inst1', via: 'phone_app' });
    expect(h.get().message).toBe('Checked off: Morning pills');
  });

  describe('two tasks due', () => {
    it('withdraws the button after a success and refuses a doubting second press', async () => {
      const h = renderDone(task());
      await press(h);
      h.rerender(SECOND());
      expect(h.get().task).toBeNull();
      expect(h.get().message).toBe('Checked off: Morning pills');
      await advance(1000);
      await press(h);
      expect(mockMutation).toHaveBeenCalledTimes(1);
    });

    it('offers the next task after the settle period, without the first task line', async () => {
      const h = renderDone(task());
      await press(h);
      h.rerender(SECOND());
      await advance(SETTLE_MS + 1);
      expect(h.get().task?.instanceId).toBe('inst2');
      expect(h.get().message).toBeNull();
      await press(h);
      expect(mockMutation).toHaveBeenCalledTimes(2);
      expect(mockMutation.mock.calls[1][1]).toEqual({ instanceId: 'inst2', via: 'phone_app' });
      expect(h.get().message).toBe('Checked off: Evening pills');
    });
  });

  describe('a hung call', () => {
    it('shows "Still trying", frees the button and keeps the task offered', async () => {
      mockMutation.mockReturnValue(new Promise(() => {}));
      const h = renderDone(task());
      await press(h);
      expect(h.get().busy).toBe(true);
      await advance(CONFIRM_TIMEOUT_MS + 1);
      expect(h.get().busy).toBe(false);
      expect(h.get().message).toBe(STILL_TRYING_MESSAGE);
      expect(h.get().task).not.toBeNull();
      expect(announce).toHaveBeenCalledWith(STILL_TRYING_MESSAGE);
    });

    it('corrects the line when the late call succeeds while it is still showing', async () => {
      let finish!: () => void;
      mockMutation.mockReturnValue(new Promise<void>((resolve) => (finish = resolve)));
      const h = renderDone(task());
      await press(h);
      await advance(CONFIRM_TIMEOUT_MS + 1);
      await act(async () => finish());
      expect(h.get().message).toBe('Checked off: Morning pills');
      expect(announce).toHaveBeenLastCalledWith('Checked off: Morning pills');
    });

    it('says nothing when the late call succeeds after the line is gone', async () => {
      let finish!: () => void;
      mockMutation.mockReturnValue(new Promise<void>((resolve) => (finish = resolve)));
      const h = renderDone(task());
      await press(h);
      await advance(CONFIRM_TIMEOUT_MS + 1);
      await advance(MESSAGE_MS + 1);
      expect(h.get().message).toBeNull();
      announce.mockClear();
      await act(async () => finish());
      expect(h.get().message).toBeNull();
      expect(announce).not.toHaveBeenCalled();
    });

    it('leaves the line alone when the late call fails', async () => {
      let fail!: (error: Error) => void;
      mockMutation.mockReturnValue(new Promise<void>((_, reject) => (fail = reject)));
      const h = renderDone(task());
      await press(h);
      await advance(CONFIRM_TIMEOUT_MS + 1);
      await act(async () => fail(new Error('Network request failed')));
      expect(h.get().message).toBe(STILL_TRYING_MESSAGE);
    });
  });

  describe('after unmount', () => {
    it('does not announce, set state or schedule timers when a confirm resolves', async () => {
      let finish!: () => void;
      mockMutation.mockReturnValue(new Promise<void>((resolve) => (finish = resolve)));
      const h = renderDone(task());
      await press(h);
      h.unmount();
      const timers = jest.getTimerCount();
      await act(async () => finish());
      expect(announce).not.toHaveBeenCalled();
      expect(jest.getTimerCount()).toBeLessThanOrEqual(timers);
    });

    it('does not announce when a confirm fails', async () => {
      let fail!: (error: Error) => void;
      mockMutation.mockReturnValue(new Promise<void>((_, reject) => (fail = reject)));
      const h = renderDone(task());
      await press(h);
      h.unmount();
      const timers = jest.getTimerCount();
      await act(async () => fail(new Error('Network request failed')));
      expect(announce).not.toHaveBeenCalled();
      expect(jest.getTimerCount()).toBeLessThanOrEqual(timers);
    });
  });
});

/**
 * purpose: Whether a rendered node is the outermost composite that carries the button role.
 * @param node: (ReactTestInstance) The node.
 * @return: (boolean) True for a non-host node with accessibilityRole "button" whose parent is not one.
 */
function isButton(node: ReactTestInstance): boolean {
  const own = (n: ReactTestInstance): boolean =>
    typeof n.type !== 'string' && n.props.accessibilityRole === 'button';
  return own(node) && !(node.parent !== null && own(node.parent));
}

describe('DoneCard', () => {
  afterEach(() => {
    act(() => {
      mounted.splice(0).forEach((renderer) => renderer.unmount());
    });
  });

  /**
   * purpose: Render the card and report what it shows.
   * @param props: (object) The task, message, busy flag and press handler.
   * @return: (object) texts, the buttons found, and whether nothing rendered.
   */
  function render(props: {
    task: DayTask | null;
    message: string | null;
    busy?: boolean;
    onPress?: () => void;
  }): {
    texts: string[];
    buttons: ReturnType<ReactTestRenderer['root']['findAll']>;
    empty: boolean;
  } {
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(
        <DoneCard
          task={props.task}
          message={props.message}
          busy={props.busy ?? false}
          onPress={props.onPress ?? (() => {})}
        />,
      );
      mounted.push(renderer);
    });
    const root = renderer.root;
    return {
      texts: root
        .findAll((n) => (n.type as unknown) === 'Text')
        .map((n) => String(n.props.children)),
      buttons: root.findAll(isButton),
      empty: renderer.toJSON() === null,
    };
  }

  it('shows the task label and exactly one Done button with its label', () => {
    const out = render({ task: task(), message: null });
    expect(out.texts).toContain('Morning pills');
    expect(out.texts).toContain('Done');
    expect(out.buttons).toHaveLength(1);
    expect(out.buttons[0].props.accessibilityLabel).toBe('Done: Morning pills');
  });

  it('calls onPress when the button is pressed', () => {
    const onPress = jest.fn();
    const out = render({ task: task(), message: null, onPress });
    act(() => out.buttons[0].props.onPress());
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('shows Saving and a disabled button while busy', () => {
    const out = render({ task: task(), message: null, busy: true });
    expect(out.texts).toContain('Saving');
    expect(out.texts).not.toContain('Done');
    expect(out.buttons[0].props.disabled).toBe(true);
    expect(out.buttons[0].props.accessibilityState).toEqual({ disabled: true, busy: true });
  });

  it('shows only the message, with no button, when nothing is due', () => {
    const out = render({ task: null, message: 'Checked off: Morning pills' });
    expect(out.texts).toEqual(['Checked off: Morning pills']);
    expect(out.buttons).toHaveLength(0);
  });

  it('renders nothing when there is no task and no message', () => {
    expect(render({ task: null, message: null }).empty).toBe(true);
  });
});
