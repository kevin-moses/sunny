import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import React from 'react';
import { AppState, type AppStateStatus, type NativeEventSubscription } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import type { SessionDecision } from '../../backend/pairing';
import type { HouseholdId } from '../../backend/convexApi';
import type { DayViewData } from '../../day/types';
import { logger } from '../../logging/logger';
import { makeDay, makeTask } from '../../testing/dayFixtures';
import { makeFakePressStore, type FakePressStore } from '../../testing/fakePressStore';
import {
  RETRY_MS,
  STUCK_LOG_EVERY_MS,
  STUCK_MS,
  useSurfaceSync,
  useWidgetSync,
} from '../useWidgetSync';

type AnyMock = (...args: unknown[]) => Promise<unknown>;

const mockSend = jest.fn<AnyMock>();
const mockResend = jest.fn<AnyMock>();
const mockRead = jest.fn<AnyMock>();
const mockClear = jest.fn<AnyMock>();
const mockShow = jest.fn<AnyMock>();
let mockPresses: FakePressStore;
let mockConnected = true;

jest.mock('../widgetSync', () => {
  const actual = jest.requireActual<typeof import('../widgetSync')>('../widgetSync');
  return {
    widgetHolderOf: actual.widgetHolderOf,
    surfaceSyncKey: actual.surfaceSyncKey,
    clearWidget: () => mockClear(),
  };
});

jest.mock('../pressStore', () => ({
  get phonePresses() {
    return mockPresses;
  },
  readPressLog: () => mockRead(),
  sendPresses: () => mockSend(),
  resendPresses: () => mockResend(),
  showOnSurfaces: () => mockShow(),
}));

jest.mock('convex/react', () => ({
  useConvexConnectionState: () => ({ isWebSocketConnected: mockConnected, hasEverConnected: true }),
}));

jest.mock('../../../modules/sunny-widget', () => ({ __esModule: true, default: {} }));

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

const NOW = Date.parse('2026-11-09T09:41:00Z');

beforeEach(() => {
  jest.clearAllMocks();
  jest.useFakeTimers();
  jest.setSystemTime(NOW);
  mockPresses = makeFakePressStore();
  mockConnected = true;
  mockSend.mockResolvedValue(undefined);
  mockResend.mockResolvedValue(undefined);
  mockRead.mockResolvedValue(undefined);
  mockShow.mockResolvedValue(undefined);
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
  jest.useRealTimers();
});

describe('useWidgetSync', () => {
  it('reads the press log and sends on mount and whenever the app comes to the foreground', () => {
    mockConnected = false;
    render(<SyncProbe decision={seniorPhone} />);
    expect(mockRead).toHaveBeenCalledTimes(1);
    expect(mockSend).toHaveBeenCalledTimes(1);
    act(() => appStateListener?.('background'));
    act(() => appStateListener?.('active'));
    expect(mockRead).toHaveBeenCalledTimes(2);
    expect(mockSend).toHaveBeenCalledTimes(2);
    expect(mockClear).not.toHaveBeenCalled();
  });

  it('reads the log before the send has finished, so a widget press shows at once', () => {
    mockConnected = false;
    mockSend.mockReturnValue(new Promise(() => undefined));
    render(<SyncProbe decision={seniorPhone} />);
    expect(mockRead).toHaveBeenCalledTimes(1);
  });

  it('clears the widget for a caregiver, a home display and a signed-out phone', () => {
    render(<SyncProbe decision={{ state: 'signedOut' }} />);
    render(<SyncProbe decision={homeDisplay} />);
    expect(mockClear).toHaveBeenCalledTimes(1);
    expect(mockSend).not.toHaveBeenCalled();
    expect(mockResend).not.toHaveBeenCalled();
    expect(mockRead).not.toHaveBeenCalled();
  });

  it('does nothing while the session loads', () => {
    render(<SyncProbe decision={{ state: 'loading' }} />);
    expect(mockSend).not.toHaveBeenCalled();
    expect(mockClear).not.toHaveBeenCalled();
  });

  it('resends with a flush only when the connection comes back', () => {
    mockConnected = false;
    render(<SyncProbe decision={seniorPhone} />);
    expect(mockResend).not.toHaveBeenCalled();
    mockSend.mockClear();
    mockConnected = true;
    render(<SyncProbe decision={seniorPhone} />);
    expect(mockResend).toHaveBeenCalledTimes(1);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('resends every 30 seconds while a press or an undo is unsent, and stops once all are answered', () => {
    render(<SyncProbe decision={seniorPhone} />);
    mockSend.mockClear();
    mockResend.mockClear();
    act(() => void jest.advanceTimersByTime(3 * RETRY_MS));
    expect(mockResend).not.toHaveBeenCalled();
    let pressId = '';
    act(() => {
      pressId = mockPresses.pressedElsewhere({
        instanceId: 'pills',
        step: 0,
        pressedAt: NOW,
      }).pressId;
    });
    act(() => void jest.advanceTimersByTime(2 * RETRY_MS));
    expect(mockResend).toHaveBeenCalledTimes(2);
    act(() => mockPresses.answer(pressId));
    act(() => void jest.advanceTimersByTime(2 * RETRY_MS));
    expect(mockResend).toHaveBeenCalledTimes(2);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('does not keep sending for a home display', () => {
    act(() => {
      mockPresses.pressedElsewhere({ instanceId: 'pills', step: 0, pressedAt: NOW });
    });
    render(<SyncProbe decision={homeDisplay} />);
    act(() => void jest.advanceTimersByTime(2 * RETRY_MS));
    expect(mockSend).not.toHaveBeenCalled();
    expect(mockResend).not.toHaveBeenCalled();
  });

  it('logs a press that has waited ten minutes while online, then once an hour', () => {
    act(() => {
      mockPresses.pressedElsewhere({ instanceId: 'pills', step: 0, pressedAt: NOW - 60_000 });
    });
    render(<SyncProbe decision={seniorPhone} />);
    act(() => void jest.advanceTimersByTime(STUCK_MS - 60_000 - 1));
    expect(logger.error).not.toHaveBeenCalled();
    act(() => void jest.advanceTimersByTime(1));
    expect(logger.error).toHaveBeenCalledTimes(1);
    act(() => void jest.advanceTimersByTime(STUCK_LOG_EVERY_MS));
    expect(logger.error).toHaveBeenCalledTimes(2);
  });

  it('does not call a press stuck while the phone is offline', () => {
    mockConnected = false;
    act(() => {
      mockPresses.pressedElsewhere({ instanceId: 'pills', step: 0, pressedAt: NOW });
    });
    render(<SyncProbe decision={seniorPhone} />);
    act(() => void jest.advanceTimersByTime(STUCK_MS + STUCK_LOG_EVERY_MS));
    expect(logger.error).not.toHaveBeenCalled();
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
    expect(mockShow).toHaveBeenCalledTimes(1);
    render(<ReloadProbe day={{ ...day, tasks: [makeTask()] }} />);
    expect(mockShow).toHaveBeenCalledTimes(2);
  });

  it('does not sync without a day view', () => {
    render(<ReloadProbe day={null} />);
    expect(mockShow).not.toHaveBeenCalled();
  });
});
