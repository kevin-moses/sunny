// sunny_app/src/caregiver/__tests__/TaskRowReopen.test.tsx
//
// Purpose: Tests for reopening a done task from the caregiver Home tab. The real
// CaregiverHomeScreen is rendered (so its wiring of the row's Reopen to useTaskActions is under
// test, not a copy of it) with a day view passed in; only convex.mutation (the network) is
// stubbed, Alert.alert is spied, and native-only modules (symbols, haptics, safe area) are
// mocked. Covers: an editor's reopenable done box is labelled "Reopen <label>", stays checked
// and asks first with the exact title, message and buttons; only one alert at a time per row
// (a second tap while it is up opens none; after Cancel, and after a Reopen followed by Mark
// done, a tap asks again); Cancel sends
// nothing; Reopen sends reopenTaskInstance (not the Mark done mutation), shows "Reopening..."
// with the box checked, not interactive and still labelled "Reopen <label>" with busy set, and
// clears on success; a failure shows the server's message and keeps the box checked; a viewer,
// and a row whose reopenable flag is false, are as before (not interactive, labelled "Mark
// <label> done", no alert); an open task's box still marks it done; a done task in the Leftover
// group reopens the same way; reopening a task whose "Task completed / Undo" toast is still up
// dismisses that toast; the row's reopen handler keeps its identity across action changes.
//
// Last modified: 2026-11-14

import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { ConvexError } from 'convex/values';
import { getFunctionName } from 'convex/server';
import React from 'react';
import { Alert, type AlertButton } from 'react-native';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

import { convex } from '../../backend/convex';
import type { DayTask, DayViewData } from '../../day/types';
import type { DayViewState } from '../../day/useDayView';
import { REOPEN_MESSAGE } from '../CaregiverComponents';
import { CaregiverHomeScreen } from '../CaregiverHomeScreen';

jest.mock('../../backend/convex', () => ({ convex: { mutation: jest.fn() } }));

jest.mock('expo-symbols', () => ({ SymbolView: () => null }));

jest.mock('expo-haptics', () => ({
  impactAsync: jest.fn(async () => undefined),
  selectionAsync: jest.fn(async () => undefined),
  ImpactFeedbackStyle: { Light: 'light' },
}));

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

jest.mock('../../theme/ThemeProvider', () => ({
  useTheme: () => ({ accentColor: '#FA8539', cornerRadius: 12 }),
}));

const mockMutation = convex.mutation as unknown as jest.Mock<(...a: unknown[]) => Promise<unknown>>;
const mounted: ReactTestRenderer[] = [];
let alertSpy: jest.SpiedFunction<typeof Alert.alert>;

/**
 * purpose: Build one of today's tasks.
 * @param overrides: (Partial<Record<keyof DayTask, unknown>>) Fields to set.
 * @return: (DayTask) A 08:00 "Morning pills" task, confirmed by the phone and reopenable.
 */
function makeTask(overrides: Partial<Record<keyof DayTask, unknown>> = {}): DayTask {
  return {
    instanceId: 'inst1',
    displayLabel: 'Morning pills',
    localDate: '2026-11-14',
    scheduledTime: '08:00',
    state: 'confirmed',
    carriedOver: false,
    confirmedAt: Date.parse('2026-11-14T13:02:00Z'),
    confirmedLocalTime: '08:02',
    confirmedVia: 'phone_app',
    confirmReceivedAt: null,
    confirmReceivedLocalTime: null,
    confirmReceivedDaysLater: null,
    claimedBy: null,
    claimedByName: null,
    confirmedBy: 'device_1',
    confirmedByName: null,
    resolutionNote: null,
    reopenable: true,
    ...overrides,
  } as DayTask;
}

/**
 * purpose: The day view state the Home screen takes, holding the given tasks.
 * @param tasks: (DayTask[]) Today's tasks.
 * @return: (DayViewState) The state.
 */
function dayView(tasks: DayTask[]): DayViewState {
  const day = {
    seniorPreferredName: 'Margaret',
    timezone: 'America/New_York',
    localDate: '2026-11-14',
    tasks,
    eventsToday: [],
    upcoming: [],
    upcomingTasks: [],
  } as unknown as DayViewData;
  return { day, agenda: [], errorMessage: null, isOffline: false };
}

/**
 * purpose: Render the Home screen and give access to the first checkbox, texts and the toast.
 * @param tasks: (DayTask[]) Today's tasks.
 * @param canEdit: (boolean) Whether the caregiver is an editor.
 * @return: (object) box, texts, toastShown and update (render new tasks).
 */
function render(tasks: DayTask[], canEdit = true) {
  let renderer!: ReactTestRenderer;
  /**
   * purpose: The screen element for a list of tasks.
   * @param list: (DayTask[]) The tasks.
   * @return: (JSX.Element) The element.
   */
  const element = (list: DayTask[]) => (
    <CaregiverHomeScreen
      dayView={dayView(list)}
      canEdit={canEdit}
      userId="user_1"
      onAccountPress={() => {}}
    />
  );
  act(() => {
    renderer = create(element(tasks));
    mounted.push(renderer);
  });
  const outer = (n: ReactTestInstance): boolean =>
    typeof n.type !== 'string' &&
    n.props.accessibilityRole === 'checkbox' &&
    !(n.parent !== null && n.parent.props.accessibilityRole === 'checkbox');
  return {
    box: (): ReactTestInstance => renderer.root.findAll(outer)[0]!,
    texts: (): string[] =>
      renderer.root
        .findAll((n) => (n.type as unknown) === 'Text')
        .map((n) => String(n.props.children)),
    toastShown: (): boolean =>
      renderer.root.findAll((n) => n.props.accessibilityLabel === 'Task completed. Undo available.')
        .length > 0,
    rowReopen: (): unknown =>
      renderer.root.findAll((n) => n.props.onReopen !== undefined && n.props.row !== undefined)[0]!
        .props.onReopen,
    update: (list: DayTask[]) => act(() => renderer.update(element(list))),
  };
}

/**
 * purpose: Tap a checkbox inside act and let promises settle.
 * @param box: (ReactTestInstance) The checkbox.
 * @return: (Promise<void>)
 */
async function tap(box: ReactTestInstance): Promise<void> {
  await act(async () => {
    box.props.onPress();
  });
}

/**
 * purpose: The buttons of the latest alert.
 * @return: (AlertButton[]) Its buttons.
 */
function alertButtons(): AlertButton[] {
  return (alertSpy.mock.calls.at(-1)?.[2] ?? []) as AlertButton[];
}

/**
 * purpose: Choose a button of the latest alert inside act and let promises settle.
 * @param text: (string) The button text.
 * @return: (Promise<void>)
 */
async function choose(text: string): Promise<void> {
  await act(async () => {
    alertButtons()
      .find((b) => b.text === text)
      ?.onPress?.();
  });
}

/**
 * purpose: The names of the mutations sent so far.
 * @return: (string[]) In order.
 */
function sentNames(): string[] {
  return mockMutation.mock.calls.map((c) => getFunctionName(c[0] as never));
}

beforeEach(() => {
  jest.useFakeTimers();
  mockMutation.mockReset();
  mockMutation.mockResolvedValue({ confirmedBy: 'user_1' });
  alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
});

afterEach(() => {
  act(() => {
    mounted.splice(0).forEach((renderer) => renderer.unmount());
  });
  alertSpy.mockRestore();
  jest.useRealTimers();
});

describe('reopening a done task', () => {
  it('labels an editor reopenable box "Reopen <label>" and keeps it checked', () => {
    const { box } = render([makeTask()]);
    expect(box().props.accessibilityLabel).toBe('Reopen Morning pills');
    expect(box().props.accessibilityState).toMatchObject({ checked: true, disabled: false });
    expect(box().props.disabled).toBe(false);
  });

  it('asks first with a native alert: title, message, Cancel and a non-destructive Reopen', async () => {
    const { box } = render([makeTask()]);
    await tap(box());
    expect(alertSpy).toHaveBeenCalledTimes(1);
    const [title, message] = alertSpy.mock.calls[0]!;
    expect(title).toBe('Reopen Morning pills?');
    expect(message).toBe(
      'It goes back on the list as not done. Reminders and family alerts that are already overdue will go out right away.',
    );
    expect(message).toBe(REOPEN_MESSAGE);
    expect(alertButtons().map((b) => [b.text, b.style])).toEqual([
      ['Cancel', 'cancel'],
      ['Reopen', 'default'],
    ]);
    expect(mockMutation).not.toHaveBeenCalled();
  });

  it('asks again after a reopen: reopen, mark done, reopen again', async () => {
    const h = render([makeTask()]);
    await tap(h.box());
    await choose('Reopen');
    h.update([makeTask({ state: 'due', confirmedAt: null, confirmedBy: null })]);
    await tap(h.box());
    h.update([makeTask({ state: 'resolved', confirmedBy: 'user_1' })]);
    await tap(h.box());
    expect(alertSpy).toHaveBeenCalledTimes(2);
    expect(alertSpy.mock.calls[1]![0]).toBe('Reopen Morning pills?');
  });

  it('opens only one alert at a time per row; after Cancel a tap asks again', async () => {
    const { box } = render([makeTask()]);
    await tap(box());
    await tap(box());
    expect(alertSpy).toHaveBeenCalledTimes(1);
    await choose('Cancel');
    await tap(box());
    expect(alertSpy).toHaveBeenCalledTimes(2);
  });

  it('sends nothing on Cancel', async () => {
    const { box } = render([makeTask()]);
    await tap(box());
    await choose('Cancel');
    expect(mockMutation).not.toHaveBeenCalled();
  });

  it('on Reopen calls reopenTaskInstance, showing "Reopening..." with the box checked and inert', async () => {
    let finish!: (value: unknown) => void;
    mockMutation.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    const { box, texts } = render([makeTask()]);
    await tap(box());
    await choose('Reopen');
    expect(sentNames()).toEqual(['instances:reopenTaskInstance']);
    expect(mockMutation.mock.calls[0]![1]).toEqual({ instanceId: 'inst1' });
    expect(texts()).toContain('Reopening...');
    expect(box().props.disabled).toBe(true);
    expect(box().props.accessibilityLabel).toBe('Reopen Morning pills');
    expect(box().props.accessibilityState).toMatchObject({
      checked: true,
      disabled: true,
      busy: true,
    });
    await act(async () => finish(null));
    expect(texts()).not.toContain('Reopening...');
  });

  it('shows the server refusal on failure and keeps the box checked', async () => {
    mockMutation.mockRejectedValue(
      new ConvexError({ code: 'invalid', message: 'This task is no longer on the schedule.' }),
    );
    const { box, texts } = render([makeTask()]);
    await tap(box());
    await choose('Reopen');
    expect(texts()).toContain('This task is no longer on the schedule.');
    expect(texts()).not.toContain('Reopening...');
    expect(box().props.accessibilityState).toMatchObject({ checked: true });
  });

  it('works the same for a done task in the Leftover group', async () => {
    const leftover = makeTask({ carriedOver: true, localDate: '2026-11-13' });
    const { box } = render([leftover, makeTask({ instanceId: 'inst2', state: 'due' })]);
    expect(box().props.accessibilityLabel).toBe('Reopen Morning pills');
    await tap(box());
    await choose('Reopen');
    expect(sentNames()).toEqual(['instances:reopenTaskInstance']);
  });

  it('dismisses the "Task completed / Undo" toast of the task it reopens', async () => {
    const open = makeTask({ state: 'due', confirmedAt: null, confirmedBy: null });
    const h = render([open]);
    await tap(h.box());
    expect(h.toastShown()).toBe(true);
    h.update([makeTask({ state: 'resolved', confirmedBy: 'user_1' })]);
    await tap(h.box());
    await choose('Reopen');
    expect(sentNames()).toEqual(['instances:confirmTaskInstance', 'instances:reopenTaskInstance']);
    expect(h.toastShown()).toBe(false);
  });

  it('gives the rows a reopen handler that keeps its identity across action changes', async () => {
    let finish!: (value: unknown) => void;
    mockMutation.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    const h = render([makeTask()]);
    const first = h.rowReopen();
    await tap(h.box());
    await choose('Reopen');
    expect(h.rowReopen()).toBe(first);
    await act(async () => finish(null));
  });
});

describe('when reopening is not allowed', () => {
  it.each([
    ['a viewer', makeTask(), false],
    ['a row whose reopenable flag is false', makeTask({ reopenable: false }), true],
  ])('%s sees the checked box exactly as before', (_name, task, canEdit) => {
    const { box } = render([task], canEdit);
    expect(box().props.accessibilityLabel).toBe('Mark Morning pills done');
    expect(box().props.accessibilityState).toMatchObject({ checked: true, disabled: true });
    expect(box().props.disabled).toBe(true);
    expect(alertSpy).not.toHaveBeenCalled();
  });

  it('an open task box still marks it done, without asking', async () => {
    const { box } = render([makeTask({ state: 'due', confirmedAt: null })]);
    expect(box().props.accessibilityLabel).toBe('Mark Morning pills done');
    await tap(box());
    expect(sentNames()).toEqual(['instances:confirmTaskInstance']);
    expect(alertSpy).not.toHaveBeenCalled();
  });
});
