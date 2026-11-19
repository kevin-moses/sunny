import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import React from 'react';
import { AppState, type AppStateStatus } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import type { SessionDecision } from '../../backend/pairing';
import type { DayViewData } from '../../day/types';
import { useSurfaceSync, useWidgetSync } from '../useWidgetSync';

type AnyMock = (...args: unknown[]) => Promise<unknown>;

const mockSync = jest.fn<AnyMock>();
const mockClear = jest.fn<AnyMock>();
const mockSurfaceSync = jest.fn<() => void>();

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

jest.mock('../../backend/api', () => ({ callAction: jest.fn() }));

jest.mock('../../backend/convexApi', () => ({ api: {} }));

jest.mock('../../logging/logger', () => ({
  logger: { debug: jest.fn(), info: jest.fn(), warning: jest.fn(), error: jest.fn() },
}));

let appStateListener: ((state: AppStateStatus) => void) | null = null;
const removeListener = jest.fn();

const seniorPhone = {
  state: 'paired',
  device: { householdId: 'h1', kind: 'senior_phone' },
} as SessionDecision;

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
    return { remove: removeListener } as unknown as ReturnType<typeof AppState.addEventListener>;
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
    render(
      <SyncProbe
        decision={
          {
            state: 'paired',
            device: { householdId: 'h1', kind: 'home_display' },
          } as SessionDecision
        }
      />,
    );
    expect(mockClear).toHaveBeenCalledTimes(1);
    expect(mockSync).not.toHaveBeenCalled();
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
  const day = {
    localDate: '2026-11-19',
    localNow: '2026-11-19T09:30',
    tasks: [],
    eventsToday: [],
    nextUp: null,
  } as unknown as DayViewData;

  it('syncs the widget and the Lock Screen when the day view changes, not when only the minute does', () => {
    render(<ReloadProbe day={day} />);
    render(<ReloadProbe day={{ ...day, localNow: '2026-11-19T09:31' } as DayViewData} />);
    expect(mockSurfaceSync).toHaveBeenCalledTimes(1);
    render(<ReloadProbe day={{ ...day, tasks: [{ id: 't1' }] } as unknown as DayViewData} />);
    expect(mockSurfaceSync).toHaveBeenCalledTimes(2);
  });

  it('does not sync without a day view', () => {
    render(<ReloadProbe day={null} />);
    expect(mockSurfaceSync).not.toHaveBeenCalled();
  });
});
