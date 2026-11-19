import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import React from 'react';
import { ActivityIndicator, StyleSheet, type ViewStyle } from 'react-native';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

import { buildAgenda } from '../../day/format';
import type { DayTask, DayViewData, EventOccurrence } from '../../day/types';
import { confirmQueue } from '../../day/pendingConfirms';
import type { DayViewState } from '../../day/useDayView';
import { phoneClockTime } from '../../phone/model';
import { TodayScreen } from '../TodayScreen';

const mockStore = new Map<string, string>();
let mockConnected = true;
let mockFontsReady = true;
const mockMutation = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const mockUnsentPresses = jest.fn<() => unknown[]>();

jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem: async (key: string) => mockStore.get(key) ?? null,
    setItem: async (key: string, value: string) => void mockStore.set(key, value),
    removeItem: async (key: string) => void mockStore.delete(key),
  },
}));
jest.mock('expo-crypto', () => ({ randomUUID: () => 'press-0000000000000001' }));
jest.mock('../../../modules/sunny-widget', () => ({
  __esModule: true,
  default: { unsentPresses: () => mockUnsentPresses() },
}));
jest.mock('../../backend/convex', () => ({
  convex: {
    mutation: (...args: unknown[]) => mockMutation(...args),
    connectionState: () => ({ isWebSocketConnected: mockConnected, hasEverConnected: true }),
    subscribeToConnectionState: () => () => undefined,
  },
}));
jest.mock('../../day/pendingConfirms', () => {
  const actual = jest.requireActual<typeof import('../../day/pendingConfirms')>(
    '../../day/pendingConfirms',
  );
  return {
    ...actual,
    confirmQueue: actual.createConfirmQueue({ send: actual.sendConfirm, now: () => Date.now() }),
  };
});
jest.mock('convex/react', () => ({
  useConvexConnectionState: () => ({ isWebSocketConnected: mockConnected, hasEverConnected: true }),
}));
jest.mock('../../logging/logger', () => ({
  logger: { warning: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 62, bottom: 34, left: 0, right: 0 }),
}));
jest.mock('../../phone/theme', () => ({
  ...jest.requireActual<object>('../../phone/theme'),
  usePhoneFonts: () => mockFontsReady,
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
  return {
    instanceId: 'pills',
    taskId: 'pillsTask',
    type: 'medication',
    displayLabel: 'Morning pills',
    screenSentence: 'Take your morning pills.',
    pillDescription: 'the small white ones',
    checklistItems: [],
    step: null,
    scheduledTime: '09:30',
    state: 'due',
    confirmable: true,
    carriedOver: false,
    ...overrides,
  } as unknown as DayTask;
}

const BREAKFAST = task({
  instanceId: 'breakfast' as never,
  displayLabel: 'Breakfast',
  scheduledTime: '08:00',
  state: 'confirmed',
  confirmable: false,
});

const WALK = task({
  instanceId: 'walk' as never,
  displayLabel: 'Morning walk',
  screenSentence: 'Go for your morning walk.',
  pillDescription: null,
  scheduledTime: '10:15',
  state: 'upcoming',
});

const LUNCH = task({
  instanceId: 'lunch' as never,
  displayLabel: 'Lunch',
  screenSentence: null,
  pillDescription: null,
  scheduledTime: '12:30',
  state: 'upcoming',
  confirmable: false,
});

const VISIT = {
  eventId: 'visit',
  label: 'Sarah visits',
  localDate: '2026-11-09',
  startTime: '14:00',
  startsAt: Date.parse('2026-11-09T14:00:00Z'),
  endsAt: null,
} as unknown as EventOccurrence;

function dayView(
  tasks: DayTask[],
  extra: Partial<DayViewData> = {},
  state: Partial<DayViewState> = {},
): DayViewState {
  const day = {
    timezone: 'UTC',
    localNow: '2026-11-09T09:41:00',
    localDate: '2026-11-09',
    dateLabel: 'November 9',
    header: 'Monday morning',
    tasks,
    eventsToday: [VISIT],
    nextUp: VISIT,
    upcoming: [],
    ...extra,
  } as unknown as DayViewData;
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

function styleOf(node: ReactTestInstance): ViewStyle {
  return StyleSheet.flatten(node.props.style) as ViewStyle;
}

const OLD_WORDS = ['Monday morning', 'November 9', 'Today', 'Next up', 'Coming up'];

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(NOW);
  mockStore.clear();
  mockConnected = true;
  mockFontsReady = true;
  mockMutation.mockReset();
  mockMutation.mockResolvedValue({ status: 'confirmed' });
  mockUnsentPresses.mockReturnValue([]);
});

afterEach(async () => {
  act(() => renderers.splice(0).forEach((r) => r.unmount()));
  await act(async () => {
    await confirmQueue.clear();
  });
  jest.useRealTimers();
});

describe('TodayScreen layout', () => {
  it('puts one column on paper, 24 from each side, from the safe areas to the Talk key', () => {
    const root = render(dayView([BREAKFAST, task(), WALK]));
    const views = root.findAll((n) => (n.type as unknown) === 'View');
    expect(styleOf(views[0]!)).toMatchObject({
      flex: 1,
      backgroundColor: '#F7F4EC',
      paddingTop: 62 + 8,
      paddingBottom: 34 + 18,
    });
    expect(styleOf(views[1]!)).toMatchObject({
      flex: 1,
      gap: 14,
      paddingTop: 44,
      paddingHorizontal: 24,
    });
  });

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
    mockMutation.mockReturnValue(new Promise(() => {}));
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
    expect(words(root).slice(0, 3)).toEqual([
      'Morning pills done.',
      'Undo',
      `Noted at ${phoneClockTime(NOW)}`,
    ]);
    expect(buttonLabels(root)).toEqual(['Undo Morning pills done', 'Talk to Sunny']);
    const row = root.find(
      (n) =>
        (n.type as unknown) === 'View' && n.props.accessibilityLabel === '9:30 AM, Morning pills',
    );
    expect(row.props.accessibilityValue).toEqual({ text: 'Done' });
  });

  it('shows a task pressed on the widget or the Lock Screen as done while that press is unsent', () => {
    mockUnsentPresses.mockReturnValue([
      {
        id: 'F2B4E6A8-0000-4000-8000-000000000001',
        instanceId: 'pills',
        step: 0,
        pressedAt: NOW - 60_000,
      },
    ]);
    const root = render(dayView([BREAKFAST, task(), LUNCH]));
    expect(buttonLabels(root)).toEqual(['Talk to Sunny']);
    const row = root.find(
      (n) =>
        (n.type as unknown) === 'View' && n.props.accessibilityLabel === '9:30 AM, Morning pills',
    );
    expect(row.props.accessibilityValue).toEqual({ text: 'Done' });
  });

  it('keeps showing the next step of a step task pressed elsewhere', () => {
    mockUnsentPresses.mockReturnValue([
      {
        id: 'F2B4E6A8-0000-4000-8000-000000000002',
        instanceId: 'pills',
        step: 0,
        pressedAt: NOW - 60_000,
      },
    ]);
    const stepped = task({
      checklistItems: ['Fill a glass', 'Take the small white ones with water.', 'Rinse'],
      step: { index: 0, count: 3, text: 'Fill a glass' },
    });
    const root = render(dayView([stepped]));
    expect(words(root).slice(0, 3)).toEqual([
      'Now',
      'Step 2 of 3',
      'Take the small white ones with water.',
    ]);
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
    const tomorrow = { ...VISIT, localDate: '2026-11-10' } as EventOccurrence;
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
    expect(root.findByType(ActivityIndicator).props.color).toBe('#121212');
    expect(words(root)).toEqual(['Talk to Sunny']);
  });

  it('waits for the paper typefaces before drawing the day', () => {
    mockFontsReady = false;
    const root = render(dayView([task()]));
    expect(root.findAllByType(ActivityIndicator)).toHaveLength(1);
    expect(words(root)).toEqual(['Talk to Sunny']);
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
