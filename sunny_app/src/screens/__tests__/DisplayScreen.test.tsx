// sunny_app/src/screens/__tests__/DisplayScreen.test.tsx
//
// Purpose: Wiring tests for DisplayScreen: the screen is rendered for real with its voice and
// cue hooks replaced by recorders (they have their own tests), plus the native pieces jest
// cannot run (keep awake, safe area, fonts) and the backend call. Checks that a live voice
// session blocks the due cue, that a cue starting takes a lingering answer off the panel, and
// that a newly due task does the same.
//
// Last modified: 2026-11-09

import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { buildAgenda } from '../../day/format';
import type { DayTask, DayViewData } from '../../day/types';
import type { DayViewState } from '../../day/useDayView';
import type { DisplayVoice } from '../../display/useDisplayVoice';
import { DisplayScreen } from '../DisplayScreen';

const mockDueCue = jest.fn((_tasks: unknown, _blocked: boolean, _onCue: () => void) => undefined);
const mockDismiss = jest.fn();
let mockVoice: DisplayVoice;
const renderers: ReactTestRenderer[] = [];

jest.mock('@react-native-async-storage/async-storage', () =>
  jest.requireActual('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);
jest.mock('expo-keep-awake', () => ({ useKeepAwake: () => undefined }));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
jest.mock('../../display/theme', () => ({
  ...jest.requireActual<object>('../../display/theme'),
  useDisplayFonts: () => true,
}));
jest.mock('../../display/useQuietNotifications', () => ({
  useQuietNotifications: () => undefined,
}));
jest.mock('../../display/useDueCue', () => ({
  useDueCue: (tasks: unknown, blocked: boolean, onCue: () => void) =>
    mockDueCue(tasks, blocked, onCue),
}));
jest.mock('../../display/useDisplayVoice', () => ({
  useDisplayVoice: () => mockVoice,
}));
jest.mock('../../backend/api', () => ({
  callMutation: jest.fn(),
  toBackendError: (error: unknown) => ({ message: String(error) }),
}));

/**
 * purpose: Build a due task.
 * @param instanceId: (string) Its instance id.
 * @return: (DayTask) A due 08:00 medication.
 */
function dueTask(instanceId: string): DayTask {
  return {
    instanceId,
    type: 'medication',
    displayLabel: 'Morning pills',
    spokenPrompt: 'Time for Morning pills.',
    pillDescription: null,
    checklistItems: [],
    scheduledTime: '08:00',
    state: 'due',
    carriedOver: false,
    seniorPrompts: 0,
    snoozed: false,
  } as unknown as DayTask;
}

/**
 * purpose: The day view state the app shell would pass.
 * @param tasks: (DayTask[]) Today's tasks.
 * @return: (DayViewState) A loaded, online day.
 */
function dayView(tasks: DayTask[]): DayViewState {
  const day = {
    localNow: '2026-11-09T08:05:00',
    localDate: '2026-11-09',
    dateLabel: 'November 9',
    header: 'Monday morning',
    tasks,
    eventsToday: [],
    nextUp: null,
    upcoming: [],
  } as unknown as DayViewData;
  return { day, agenda: buildAgenda(day), errorMessage: null, isOffline: false };
}

/**
 * purpose: Render the screen and give a function to re-render it.
 * @param first: (DayViewState) The first day view.
 * @return: ((next: DayViewState) => void) Re-renders with another day view.
 */
function renderScreen(first: DayViewState): (next: DayViewState) => void {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(<DisplayScreen dayView={first} />);
  });
  renderers.push(renderer);
  return (next) =>
    act(() => {
      renderer.update(<DisplayScreen dayView={next} />);
    });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockVoice = {
    card: null,
    active: false,
    status: null,
    talk: jest.fn(),
    dismissAnswer: mockDismiss,
  };
});

afterEach(() => {
  // Unmounting clears the screen's carousel timer, so no handle outlives the test.
  act(() => renderers.splice(0).forEach((r) => r.unmount()));
});

describe('DisplayScreen wiring', () => {
  it('blocks the due cue while a voice session is live', () => {
    mockVoice = { ...mockVoice, active: true };
    renderScreen(dayView([]));
    expect(mockDueCue.mock.calls.at(-1)?.[1]).toBe(true);
  });

  it('lets the due cue play without a voice session', () => {
    renderScreen(dayView([]));
    expect(mockDueCue.mock.calls.at(-1)?.[1]).toBe(false);
  });

  it('takes a lingering answer off the panel when a cue starts', () => {
    renderScreen(dayView([]));
    const onCue = mockDueCue.mock.calls.at(-1)![2];
    act(() => onCue());
    expect(mockDismiss).toHaveBeenCalledTimes(1);
  });

  it('takes a lingering answer off the panel when a task comes due', () => {
    const update = renderScreen(dayView([]));
    expect(mockDismiss).not.toHaveBeenCalled();
    update(dayView([dueTask('t1')]));
    expect(mockDismiss).toHaveBeenCalledTimes(1);
  });
});
