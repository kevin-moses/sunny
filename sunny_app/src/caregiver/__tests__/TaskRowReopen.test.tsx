// sunny_app/src/caregiver/__tests__/TaskRowReopen.test.tsx
//
// Purpose: Tests for reopening a done task from the caregiver Home tab's task rows. The real
// TasksCard and TaskRow are rendered from real day-view rows (todaysTasks) and wired to the
// real useTaskActions as CaregiverHomeScreen wires them; only convex.mutation (the network) is
// stubbed and Alert.alert is spied. Covers: an editor's reopenable done box is labelled
// "Reopen <label>", stays checked and asks first with the exact title, message and buttons;
// Cancel sends nothing; Reopen sends reopenTaskInstance, shows "Reopening..." with the box
// checked and not interactive, and clears on success; a failure shows the server's message and
// keeps the box checked; a viewer, and a row whose reopenable flag is false, are as before (not
// interactive, labelled "Mark <label> done", no alert); an open task's box still marks it done;
// and the same holds for a done task in the Leftover group.
//
// Last modified: 2026-11-14

import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { ConvexError } from 'convex/values';
import { getFunctionName } from 'convex/server';
import React, { useMemo } from 'react';
import { Alert, type AlertButton } from 'react-native';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

import { convex } from '../../backend/convex';
import type { TaskInstanceId } from '../../backend/convexApi';
import type { DayTask, DayViewData } from '../../day/types';
import { REOPEN_MESSAGE, TasksCard, type TaskRowActions } from '../CaregiverComponents';
import { todaysTasks } from '../format';
import type { NoteEditor } from '../useNoteEditor';
import { useTaskActions } from '../useTaskActions';

jest.mock('../../backend/convex', () => ({ convex: { mutation: jest.fn() } }));

jest.mock('expo-symbols', () => ({ SymbolView: () => null }));

jest.mock('../../theme/ThemeProvider', () => ({
  useTheme: () => ({ accentColor: '#FA8539', cornerRadius: 12 }),
}));

const mockMutation = convex.mutation as unknown as jest.Mock<(...a: unknown[]) => Promise<unknown>>;
const mounted: ReactTestRenderer[] = [];
let alertSpy: jest.SpiedFunction<typeof Alert.alert>;

/** A note editor that is never open (notes are not under test here). */
const noteEditor: NoteEditor = {
  open: null,
  toggle: () => {},
  setDraft: () => {},
  close: () => {},
};

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
 * purpose: A day view holding the given tasks.
 * @param tasks: (DayTask[]) The tasks.
 * @return: (DayViewData) The day.
 */
function makeDay(tasks: DayTask[]): DayViewData {
  return {
    seniorPreferredName: 'Margaret',
    timezone: 'America/New_York',
    localDate: '2026-11-14',
    tasks,
    eventsToday: [],
    upcoming: [],
    upcomingTasks: [],
  } as unknown as DayViewData;
}

/**
 * purpose: Test screen: the tasks card wired to the real hook the way the Home tab wires it.
 * @param props: ({ day: DayViewData, canEdit: boolean, onMarkDone: (id) => void }) The day,
 *        the caregiver's edit permission and a spy for the Mark done handler.
 * @return: (JSX.Element) The card.
 */
function Screen({
  day,
  canEdit,
  onMarkDone,
}: {
  day: DayViewData;
  canEdit: boolean;
  onMarkDone: (id: TaskInstanceId) => void;
}) {
  const { actions, reopen } = useTaskActions('user_1');
  const rowActions = useMemo<TaskRowActions>(
    () => ({ states: actions, markDone: onMarkDone, reopen: (id) => void reopen(id) }),
    [actions, onMarkDone, reopen],
  );
  const { leftover, today } = todaysTasks(day, 'user_1');
  return (
    <TasksCard
      leftover={leftover}
      today={today}
      canEdit={canEdit}
      rowActions={rowActions}
      noteEditor={noteEditor}
    />
  );
}

/**
 * purpose: Render the screen and give access to the checkbox and the texts.
 * @param tasks: (DayTask[]) Today's tasks.
 * @param canEdit: (boolean) Whether the caregiver is an editor.
 * @return: (object) box (the first checkbox), texts and the Mark done spy.
 */
function render(tasks: DayTask[], canEdit = true) {
  const onMarkDone = jest.fn();
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(<Screen day={makeDay(tasks)} canEdit={canEdit} onMarkDone={onMarkDone} />);
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
    onMarkDone,
  };
}

/**
 * purpose: Tap a checkbox inside act.
 * @param box: (ReactTestInstance) The checkbox.
 * @return: (void)
 */
function tap(box: ReactTestInstance): void {
  act(() => box.props.onPress());
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

beforeEach(() => {
  mockMutation.mockReset();
  mockMutation.mockResolvedValue(null);
  alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
});

afterEach(() => {
  act(() => {
    mounted.splice(0).forEach((renderer) => renderer.unmount());
  });
  alertSpy.mockRestore();
});

describe('reopening a done task', () => {
  it('labels an editor reopenable box "Reopen <label>" and keeps it checked', () => {
    const { box } = render([makeTask()]);
    expect(box().props.accessibilityLabel).toBe('Reopen Morning pills');
    expect(box().props.accessibilityState).toMatchObject({ checked: true, disabled: false });
    expect(box().props.disabled).toBe(false);
  });

  it('asks first with a native alert: title, message, Cancel and a non-destructive Reopen', () => {
    const { box } = render([makeTask()]);
    tap(box());
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

  it('sends nothing on Cancel', async () => {
    const { box } = render([makeTask()]);
    tap(box());
    await choose('Cancel');
    expect(mockMutation).not.toHaveBeenCalled();
  });

  it('on Reopen calls reopenTaskInstance, showing "Reopening..." with the box checked and inert', async () => {
    let finish!: (value: unknown) => void;
    mockMutation.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    const { box, texts } = render([makeTask()]);
    tap(box());
    await choose('Reopen');
    const [ref, args] = mockMutation.mock.calls[0]!;
    expect(getFunctionName(ref as never)).toBe('instances:reopenTaskInstance');
    expect(args).toEqual({ instanceId: 'inst1' });
    expect(texts()).toContain('Reopening...');
    expect(box().props.disabled).toBe(true);
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
    tap(box());
    await choose('Reopen');
    expect(texts()).toContain('This task is no longer on the schedule.');
    expect(texts()).not.toContain('Reopening...');
    expect(box().props.accessibilityState).toMatchObject({ checked: true });
  });

  it('works the same for a done task in the Leftover group', async () => {
    const leftover = makeTask({ carriedOver: true, localDate: '2026-11-13' });
    const { box } = render([leftover, makeTask({ instanceId: 'inst2', state: 'due' })]);
    expect(box().props.accessibilityLabel).toBe('Reopen Morning pills');
    tap(box());
    await choose('Reopen');
    expect(getFunctionName(mockMutation.mock.calls[0]![0] as never)).toBe(
      'instances:reopenTaskInstance',
    );
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

  it('an open task box still marks it done, without asking', () => {
    const { box, onMarkDone } = render([makeTask({ state: 'due', confirmedAt: null })]);
    expect(box().props.accessibilityLabel).toBe('Mark Morning pills done');
    tap(box());
    expect(onMarkDone).toHaveBeenCalledWith('inst1');
    expect(alertSpy).not.toHaveBeenCalled();
  });
});
