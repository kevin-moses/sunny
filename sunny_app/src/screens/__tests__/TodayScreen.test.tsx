import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import React from 'react';
import { ActivityIndicator } from 'react-native';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

import { buildAgenda } from '../../day/format';
import type { DayTask, DayViewData } from '../../day/types';
import type { DayViewState } from '../../day/useDayView';
import { instanceIdOf, makeDay, makeEvent, makeTask } from '../../testing/dayFixtures';
import { makeFakePressStore, type FakePressStore } from '../../testing/fakePressStore';
import { TodayScreen } from '../TodayScreen';

let mockConnected = true;
let mockFontsReady = true;
let mockPresses: FakePressStore;

jest.mock('../../widget/pressStore', () => ({
  get phonePresses() {
    return mockPresses;
  },
}));
jest.mock('convex/react', () => ({
  useConvexConnectionState: () => ({ isWebSocketConnected: mockConnected, hasEverConnected: true }),
}));
jest.mock('../../logging/logger', () => ({
  logger: { warning: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 62, bottom: 34, left: 0, right: 0 }),
}));
jest.mock('../../display/theme', () => ({
  ...jest.requireActual<object>('../../display/theme'),
  usePaperFonts: () => mockFontsReady,
}));
jest.mock('../../voice/voiceContext', () => ({
  useVoice: () => ({ connect: async () => undefined, connectionState: 'disconnected' }),
}));
jest.mock('expo-symbols', () => ({
  SymbolView: ({ name }: { name: string }) => {
    const { Text: MockText } = jest.requireActual<typeof import('react-native')>('react-native');
    return <MockText>{`symbol:${name}`}</MockText>;
  },
}));

const NOW = Date.parse('2026-11-09T09:41:00Z');
const renderers: ReactTestRenderer[] = [];

function task(overrides: Partial<DayTask> = {}): DayTask {
  return makeTask(overrides);
}

const BREAKFAST = task({
  instanceId: instanceIdOf('breakfast'),
  displayLabel: 'Breakfast',
  scheduledTime: '08:00',
  state: 'confirmed',
  confirmable: false,
});

const WALK = task({
  instanceId: instanceIdOf('walk'),
  displayLabel: 'Morning walk',
  screenSentence: 'Go for your morning walk.',
  pillDescription: null,
  scheduledTime: '10:15',
  state: 'upcoming',
});

const LUNCH = task({
  instanceId: instanceIdOf('lunch'),
  displayLabel: 'Lunch',
  screenSentence: null,
  pillDescription: null,
  scheduledTime: '12:30',
  state: 'upcoming',
  confirmable: false,
});

const VISIT = makeEvent();

function dayView(
  tasks: DayTask[],
  extra: Partial<DayViewData> = {},
  state: Partial<DayViewState> = {},
): DayViewState {
  const day = makeDay({
    localNow: '2026-11-09T09:41',
    tasks,
    eventsToday: [VISIT],
    nextUp: VISIT,
    ...extra,
  });
  return { day, agenda: buildAgenda(day), errorMessage: null, isOffline: false, ...state };
}

function render(view: DayViewState): ReactTestInstance {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(<TodayScreen dayView={view} />);
  });
  renderers.push(renderer);
  return renderer.root;
}

function words(root: ReactTestInstance): string[] {
  return root
    .findAll((n) => (n.type as unknown) === 'Text')
    .map((n) => String(n.props.children))
    .filter((s) => !s.startsWith('symbol:'));
}

function buttonLabels(root: ReactTestInstance): string[] {
  return root
    .findAll((n) => typeof n.props.style === 'function' && n.props.accessibilityRole === 'button')
    .map((n) => String(n.props.accessibilityLabel));
}

const OLD_WORDS = ['Monday morning', 'November 9', 'Today', 'Next up', 'Coming up'];

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(NOW);
  mockConnected = true;
  mockFontsReady = true;
  mockPresses = makeFakePressStore();
});

afterEach(() => {
  act(() => renderers.splice(0).forEach((r) => r.unmount()));
  jest.useRealTimers();
});

describe('TodayScreen layout', () => {
  it('drops the day header, the date, the Next up card and the section titles', () => {
    const root = render(dayView([BREAKFAST, task(), WALK], { upcoming: [VISIT] }));
    for (const word of OLD_WORDS) expect(words(root)).not.toContain(word);
  });
});

describe('TodayScreen states', () => {
  it('shows a due task: Now, the sentence, its detail, Done and the day list', () => {
    const root = render(dayView([BREAKFAST, task(), WALK, LUNCH]));
    expect(words(root)).toEqual([
      'Now',
      'Take your morning pills.',
      'the small white ones',
      'Done',
      '8:00 AM',
      'Breakfast',
      '9:30 AM',
      'Morning pills',
      '10:15 AM',
      'Morning walk',
      '12:30 PM',
      'Lunch',
      '2:00 PM',
      'Sarah visits',
      'Talk to Sunny',
    ]);
    expect(buttonLabels(root)).toEqual(['Done: Morning pills', 'Talk to Sunny']);
  });

  it('shows the current step of a step task', () => {
    const stepped = task({
      checklistItems: ['Fill a glass', 'Take the small white ones with water.', 'Rinse'],
      step: { index: 1, count: 3, text: 'Take the small white ones with water.' },
    });
    const root = render(dayView([stepped]));
    expect(words(root).slice(0, 5)).toEqual([
      'Now',
      'Step 2 of 3',
      'Take the small white ones with water.',
      'Morning pills',
      'Done',
    ]);
  });

  it('offers Done early on the next task inside its early hour', () => {
    const root = render(dayView([BREAKFAST, WALK, LUNCH]));
    expect(words(root).slice(0, 3)).toEqual([
      'Coming up at 10:15 AM',
      'Go for your morning walk.',
      'Done early',
    ]);
    expect(buttonLabels(root)[0]).toBe('Done early: Morning walk, coming up at 10:15 am');
  });

  it('after Done shows the undo line, Undo, and when the press was noted', async () => {
    const root = render(dayView([BREAKFAST, task(), LUNCH]));
    await act(async () => {
      root
        .find(
          (n) =>
            typeof n.props.style === 'function' &&
            n.props.accessibilityLabel === 'Done: Morning pills',
        )
        .props.onPress();
      await jest.advanceTimersByTimeAsync(0);
    });
    expect(words(root).slice(0, 3)).toEqual(['Morning pills done.', 'Undo', 'Noted at 9:41 AM']);
    expect(buttonLabels(root)).toEqual(['Undo Morning pills done', 'Talk to Sunny']);
    expect(
      root.find(
        (n) =>
          (n.type as unknown) === 'View' && n.props.accessibilityLabel === '9:30 AM, Morning pills',
      ).props.accessibilityValue,
    ).toEqual({ text: 'Done' });
  });

  function pillsRow(root: ReactTestInstance): ReactTestInstance {
    return root.find(
      (n) =>
        (n.type as unknown) === 'View' && n.props.accessibilityLabel === '9:30 AM, Morning pills',
    );
  }

  it('shows a task pressed on the widget or the Lock Screen as done while that press is unsent', () => {
    const root = render(dayView([BREAKFAST, task(), LUNCH]));
    act(() => {
      mockPresses.pressedElsewhere({ instanceId: 'pills', step: 0, pressedAt: NOW - 60_000 });
    });
    expect(buttonLabels(root)).toEqual(['Talk to Sunny']);
    expect(pillsRow(root).props.accessibilityValue).toEqual({ text: 'Done' });
  });

  it('offers Undo for a Done pressed on the widget moments ago, and Undo shows the task due again', async () => {
    const root = render(dayView([BREAKFAST, task(), LUNCH]));
    act(() => {
      mockPresses.pressedElsewhere({ instanceId: 'pills', step: 0, pressedAt: NOW - 10_000 });
    });
    expect(words(root).slice(0, 3)).toEqual(['Morning pills done.', 'Undo', 'Noted at 9:40 AM']);
    await act(async () => {
      root
        .find(
          (n) =>
            typeof n.props.style === 'function' &&
            n.props.accessibilityLabel === 'Undo Morning pills done',
        )
        .props.onPress();
    });
    expect(mockPresses.log()[0]?.undo).toEqual({ undoneAt: NOW });
    expect(buttonLabels(root)).toEqual(['Done: Morning pills', 'Talk to Sunny']);
  });

  it('keeps a press drawn until the day view has caught up with the answer to it', () => {
    const answered = { applied: true, answeredPresses: 4 };
    act(() => {
      const press = mockPresses.pressedElsewhere({
        instanceId: 'pills',
        step: 0,
        pressedAt: NOW - 60_000,
      });
      mockPresses.answer(press.pressId, answered);
    });
    const behind = render(dayView([BREAKFAST, task(), LUNCH], { answeredPresses: 3 }));
    expect(pillsRow(behind).props.accessibilityValue).toEqual({ text: 'Done' });
    const caughtUp = render(dayView([BREAKFAST, task(), LUNCH], { answeredPresses: 4 }));
    expect(buttonLabels(caughtUp)).toEqual(['Done: Morning pills', 'Talk to Sunny']);
  });

  it('keeps showing the next step of a step task pressed elsewhere', () => {
    const stepped = task({
      checklistItems: ['Fill a glass', 'Take the small white ones with water.', 'Rinse'],
      step: { index: 0, count: 3, text: 'Fill a glass' },
    });
    const root = render(dayView([stepped]));
    act(() => {
      mockPresses.pressedElsewhere({ instanceId: 'pills', step: 0, pressedAt: NOW - 60_000 });
    });
    expect(words(root).slice(0, 3)).toEqual([
      'Now',
      'Step 2 of 3',
      'Take the small white ones with water.',
    ]);
  });

  it('holds Noted with Undo for the 30 seconds of the Undo window before the next task', async () => {
    const evening = task({
      instanceId: instanceIdOf('evening'),
      displayLabel: 'Evening pills',
      screenSentence: null,
      pillDescription: null,
      scheduledTime: '09:35',
    });
    const root = render(dayView([task(), evening]));
    await act(async () => {
      root
        .find(
          (n) =>
            typeof n.props.style === 'function' &&
            n.props.accessibilityLabel === 'Done: Morning pills',
        )
        .props.onPress();
      await jest.advanceTimersByTimeAsync(29_999);
    });
    expect(buttonLabels(root)).toEqual(['Undo Morning pills done', 'Talk to Sunny']);
    await act(async () => {
      await jest.advanceTimersByTimeAsync(1);
    });
    expect(buttonLabels(root)).toEqual(['Done: Evening pills', 'Talk to Sunny']);
  });

  it('with nothing due says so and names the next item', () => {
    const root = render(dayView([BREAKFAST, LUNCH]));
    expect(words(root).slice(0, 2)).toEqual([
      'Nothing to do right now.',
      'Next: Lunch at 12:30 PM',
    ]);
    expect(buttonLabels(root)).toEqual(['Talk to Sunny']);
  });

  it('names the next event of the coming days when today has nothing left', () => {
    const tomorrow = makeEvent({ localDate: '2026-11-10' });
    const root = render(dayView([BREAKFAST], { eventsToday: [], upcoming: [tomorrow] }));
    expect(words(root).slice(0, 2)).toEqual([
      'Nothing to do right now.',
      'Next: Sarah visits tomorrow at 2:00 PM',
    ]);
  });

  it('leaves the Done slot empty when nothing is coming at all', () => {
    const root = render(dayView([BREAKFAST], { eventsToday: [], upcoming: [] }));
    expect(words(root)).toEqual([
      'Nothing to do right now.',
      '8:00 AM',
      'Breakfast',
      'Talk to Sunny',
    ]);
  });

  it('offline: says not connected and, as before, offers no early Done', () => {
    mockConnected = false;
    const root = render(dayView([BREAKFAST, WALK], {}, { isOffline: true }));
    expect(words(root).slice(0, 3)).toEqual([
      'Not connected',
      'Nothing to do right now.',
      'Next: Morning walk at 10:15 AM',
    ]);
  });

  it('a list from an earlier day waits for today with no next item', () => {
    jest.setSystemTime(Date.parse('2026-11-10T09:00:00Z'));
    const root = render(dayView([task()]));
    expect(words(root).slice(0, 2)).toEqual(["Waiting for today's list to load.", '9:30 AM']);
    expect(buttonLabels(root)).toEqual(['Talk to Sunny']);
  });
});

describe('TodayScreen loading and errors', () => {
  it('shows an ink spinner on paper while the day loads, with Talk still there', () => {
    const root = render({ day: null, agenda: [], errorMessage: null, isOffline: false });
    expect(root.findAllByType(ActivityIndicator)).toHaveLength(1);
    expect(words(root)).toEqual(['Talk to Sunny']);
  });

  const loadError: DayViewState = {
    day: null,
    agenda: [],
    errorMessage: 'Could not load.',
    isOffline: false,
  };

  it.each<[string, DayViewState]>([
    ['the day', dayView([task()])],
    ['the offline note', dayView([task()], {}, { isOffline: true })],
    ['a load error', loadError],
  ])('mounts no text, %s and the Talk key included, before the paper typefaces load', (_, view) => {
    mockFontsReady = false;
    const root = render(view);
    expect(root.findAllByType(ActivityIndicator)).toHaveLength(1);
    expect(words(root)).toEqual([]);
    expect(buttonLabels(root)).toEqual([]);
  });

  it('shows a load error in the detail type', () => {
    const root = render({
      day: null,
      agenda: [],
      errorMessage: 'Could not load.',
      isOffline: false,
    });
    expect(words(root)).toEqual(['Could not load.', 'Talk to Sunny']);
    expect(root.findAllByType(ActivityIndicator)).toHaveLength(0);
  });
});
