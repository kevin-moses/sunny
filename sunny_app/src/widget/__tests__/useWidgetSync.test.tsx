import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import React from 'react';
import { AppState, type AppStateStatus, type NativeEventSubscription } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import type { SessionDecision } from '../../backend/pairing';
import type { HouseholdId } from '../../backend/convexApi';
import type { DayViewData } from '../../day/types';
import { makeDay, makeTask } from '../../testing/dayFixtures';
import { widgetPressMirror } from '../sharedPresses';
import { useSurfaceSync, useWidgetSync } from '../useWidgetSync';

type AnyMock = (...args: unknown[]) => Promise<unknown>;

const mockSync = jest.fn<AnyMock>();
const mockClear = jest.fn<AnyMock>();
const mockSurfaceSync = jest.fn<() => void>();
const mockStopWatching = jest.fn();
const mockWatchPresses = jest.fn((_watcher: unknown) => mockStopWatching);

jest.mock('../widgetSync', () => {
  const actual = jest.requireActual<typeof import('../widgetSync')>('../widgetSync');
  return {
    widgetHolderOf: actual.widgetHolderOf,
    surfaceSyncKey: actual.surfaceSyncKey,
    syncWidget: () => mockSync(),
    clearWidget: () => mockClear(),
    syncSurfaces: () => mockSurfaceSync(),
  };
});

jest.mock('../../../modules/sunny-widget', () => ({ __esModule: true, default: {} }));

jest.mock('../../day/pendingConfirms', () => ({
  confirmQueue: { watchPresses: (watcher: unknown) => mockWatchPresses(watcher) },
}));

jest.mock('../../backend/api', () => ({ callAction: jest.fn() }));

jest.mock('../../backend/convexApi', () => ({ api: {} }));

jest.mock('../../logging/logger', () => ({
  logger: { debug: jest.fn(), info: jest.fn(), warning: jest.fn(), error: jest.fn() },
}));

let appStateListener: ((state: AppStateStatus) => void) | null = null;
const removeListener = jest.fn();

const HOUSEHOLD = 'h1' as HouseholdId;

const seniorPhone: SessionDecision = {
  state: 'paired',
  device: { householdId: HOUSEHOLD, kind: 'senior_phone' },
};

const homeDisplay: SessionDecision = {
  state: 'paired',
  device: { householdId: HOUSEHOLD, kind: 'home_display' },
};

function SyncProbe({ decision }: { decision: SessionDecision }) {
  useWidgetSync(decision);
  return null;
}

function ReloadProbe({ day }: { day: DayViewData | null }) {
  useSurfaceSync(day);
  return null;
}

let renderer: ReactTestRenderer | null = null;

function render(element: React.ReactElement): void {
  act(() => {
    if (renderer === null) renderer = create(element);
    else renderer.update(element);
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockSync.mockResolvedValue(undefined);
  mockClear.mockResolvedValue(undefined);
  jest.spyOn(AppState, 'addEventListener').mockImplementation((_type, listener) => {
    appStateListener = listener as (state: AppStateStatus) => void;
    const subscription: NativeEventSubscription = { remove: () => removeListener() };
    return subscription;
  });
});

afterEach(() => {
  act(() => renderer?.unmount());
  renderer = null;
  appStateListener = null;
  jest.restoreAllMocks();
});

describe('useWidgetSync', () => {
  it('syncs the senior phone on mount and whenever the app comes to the foreground', () => {
    render(<SyncProbe decision={seniorPhone} />);
    expect(mockSync).toHaveBeenCalledTimes(1);
    act(() => appStateListener?.('background'));
    act(() => appStateListener?.('active'));
    expect(mockSync).toHaveBeenCalledTimes(2);
    expect(mockClear).not.toHaveBeenCalled();
  });

  it('clears the widget for a caregiver, a home display and a signed-out phone', () => {
    render(<SyncProbe decision={{ state: 'signedOut' }} />);
    render(<SyncProbe decision={homeDisplay} />);
    expect(mockClear).toHaveBeenCalledTimes(1);
    expect(mockSync).not.toHaveBeenCalled();
  });

  it("mirrors the app's presses to the widget only while the phone is the paired senior phone", () => {
    render(<SyncProbe decision={seniorPhone} />);
    expect(mockWatchPresses).toHaveBeenCalledWith(widgetPressMirror);
    render(<SyncProbe decision={{ state: 'signedOut' }} />);
    expect(mockStopWatching).toHaveBeenCalledTimes(1);
    expect(mockWatchPresses).toHaveBeenCalledTimes(1);
  });

  it('does nothing while the session loads', () => {
    render(<SyncProbe decision={{ state: 'loading' }} />);
    expect(mockSync).not.toHaveBeenCalled();
    expect(mockClear).not.toHaveBeenCalled();
  });

  it('clears the widget once the phone signs out, and stops listening', () => {
    render(<SyncProbe decision={seniorPhone} />);
    render(<SyncProbe decision={{ state: 'signedOut' }} />);
    expect(removeListener).toHaveBeenCalledTimes(1);
    expect(mockClear).toHaveBeenCalledTimes(1);
  });
});

describe('useSurfaceSync', () => {
  const day = makeDay({ localNow: '2026-11-09T09:30' });

  it('syncs the widget and the Lock Screen when the day view changes, not when only the minute does', () => {
    render(<ReloadProbe day={day} />);
    render(<ReloadProbe day={{ ...day, localNow: '2026-11-09T09:31' }} />);
    expect(mockSurfaceSync).toHaveBeenCalledTimes(1);
    render(<ReloadProbe day={{ ...day, tasks: [makeTask()] }} />);
    expect(mockSurfaceSync).toHaveBeenCalledTimes(2);
  });

  it('does not sync without a day view', () => {
    render(<ReloadProbe day={null} />);
    expect(mockSurfaceSync).not.toHaveBeenCalled();
  });
});
