import { beforeEach, describe, expect, it, jest } from '@jest/globals';

import type { SessionDecision } from '../../backend/pairing';
import type { DayViewData } from '../../day/types';

type AnyMock = (...args: unknown[]) => Promise<unknown>;

const SITE = 'https://site.example';
const mockNative = {
  storedSiteUrl: jest.fn<() => string | null>(),
  setCredentials: jest.fn<AnyMock>(),
  clearCredentials: jest.fn<AnyMock>(),
  reloadTimelines: jest.fn<() => void>(),
  flushPresses: jest.fn<AnyMock>(),
};
const mockCallAction = jest.fn<AnyMock>();
const mockLogger = { debug: jest.fn(), info: jest.fn(), warning: jest.fn(), error: jest.fn() };

jest.mock('../../../modules/sunny-widget', () => ({ __esModule: true, default: mockNative }));

jest.mock('../../backend/api', () => ({
  callAction: (...args: unknown[]) => mockCallAction(...args),
}));

jest.mock('../../backend/convexApi', () => ({
  api: { deviceApi: { issueToken: 'deviceApi:issueToken' } },
}));

jest.mock('../../config', () => ({ CONVEX_SITE_URL: 'https://site.example' }));

jest.mock('../../logging/logger', () => ({ logger: mockLogger }));

function loadModule(): typeof import('../widgetSync') {
  let loaded: typeof import('../widgetSync') | undefined;
  jest.isolateModules(() => {
    loaded = jest.requireActual<typeof import('../widgetSync')>('../widgetSync');
  });
  if (loaded === undefined) throw new Error('widgetSync did not load');
  return loaded;
}

const paired = (kind: 'senior_phone' | 'home_display'): SessionDecision =>
  ({ state: 'paired', device: { householdId: 'h1', kind } }) as SessionDecision;

beforeEach(() => {
  jest.clearAllMocks();
  mockNative.storedSiteUrl.mockReturnValue(null);
  mockNative.setCredentials.mockResolvedValue(undefined);
  mockNative.clearCredentials.mockResolvedValue(true);
  mockNative.flushPresses.mockResolvedValue('clean');
  mockCallAction.mockResolvedValue({ deviceToken: 'tok-1' });
});

describe('widgetHolderOf', () => {
  const { widgetHolderOf } = loadModule();

  it('gives the widget to the paired senior phone only', () => {
    expect(widgetHolderOf(paired('senior_phone'))).toBe('seniorPhone');
  });

  it('never gives the widget to the home display', () => {
    expect(widgetHolderOf(paired('home_display'))).toBe('none');
  });

  it('never gives the widget to a caregiver or a signed-out phone', () => {
    const caregiver = { state: 'caregiver', home: { householdId: 'h1', role: 'primary' } };
    expect(widgetHolderOf(caregiver as SessionDecision)).toBe('none');
    expect(widgetHolderOf({ state: 'caregiverOnboarding' })).toBe('none');
    expect(widgetHolderOf({ state: 'signedOut' })).toBe('none');
  });

  it('waits while the session is loading or being removed', () => {
    expect(widgetHolderOf({ state: 'loading' })).toBe('undecided');
    expect(widgetHolderOf({ state: 'removed' })).toBe('undecided');
  });
});

describe('ensureWidgetToken', () => {
  it('keeps a stored token for this deployment', async () => {
    const { ensureWidgetToken } = loadModule();
    mockNative.storedSiteUrl.mockReturnValue(SITE);
    await expect(ensureWidgetToken()).resolves.toBe(true);
    expect(mockCallAction).not.toHaveBeenCalled();
    expect(mockNative.setCredentials).not.toHaveBeenCalled();
  });

  it('issues and stores a token when there is none', async () => {
    const { ensureWidgetToken } = loadModule();
    await expect(ensureWidgetToken()).resolves.toBe(true);
    expect(mockCallAction).toHaveBeenCalledWith('deviceApi:issueToken', {});
    expect(mockNative.setCredentials).toHaveBeenCalledWith('tok-1', SITE);
  });

  it('issues a new token when the stored one belongs to another deployment', async () => {
    const { ensureWidgetToken } = loadModule();
    mockNative.storedSiteUrl.mockReturnValue('https://old.example');
    await ensureWidgetToken();
    expect(mockCallAction).toHaveBeenCalledTimes(1);
  });

  it('passes on a failed issue so the next foreground tries again', async () => {
    const { ensureWidgetToken } = loadModule();
    mockCallAction.mockRejectedValueOnce(new Error('offline'));
    await expect(ensureWidgetToken()).rejects.toThrow('offline');
    await expect(ensureWidgetToken()).resolves.toBe(true);
    expect(mockCallAction).toHaveBeenCalledTimes(2);
  });

  it('stops issuing tokens once storing one has failed, until the widget is cleared', async () => {
    const { ensureWidgetToken, clearWidget } = loadModule();
    mockNative.setCredentials.mockRejectedValueOnce(new Error('keychain'));
    await expect(ensureWidgetToken()).resolves.toBe(false);
    await expect(ensureWidgetToken()).resolves.toBe(false);
    expect(mockCallAction).toHaveBeenCalledTimes(1);
    expect(mockLogger.error).toHaveBeenCalledTimes(1);
    await clearWidget();
    await expect(ensureWidgetToken()).resolves.toBe(true);
    expect(mockCallAction).toHaveBeenCalledTimes(2);
  });
});

describe('syncWidget', () => {
  it('flushes queued presses and reloads the widget', async () => {
    const { syncWidget } = loadModule();
    mockNative.storedSiteUrl.mockReturnValue(SITE);
    await syncWidget();
    expect(mockNative.flushPresses).toHaveBeenCalledTimes(1);
    expect(mockNative.reloadTimelines).toHaveBeenCalledTimes(1);
  });

  it('issues one new token after a 401 dropped the old one, then flushes again', async () => {
    const { syncWidget } = loadModule();
    mockNative.storedSiteUrl.mockReturnValueOnce(SITE).mockReturnValueOnce(null);
    mockNative.flushPresses.mockResolvedValueOnce('unauthorized').mockResolvedValueOnce('clean');
    await syncWidget();
    expect(mockCallAction).toHaveBeenCalledTimes(1);
    expect(mockNative.flushPresses).toHaveBeenCalledTimes(2);
    expect(mockNative.reloadTimelines).toHaveBeenCalledTimes(1);
  });

  it('does not flush without a stored token', async () => {
    const { syncWidget } = loadModule();
    mockNative.setCredentials.mockRejectedValueOnce(new Error('keychain'));
    await syncWidget();
    expect(mockNative.flushPresses).not.toHaveBeenCalled();
  });

  it('shares one run between overlapping calls', async () => {
    const { syncWidget } = loadModule();
    await Promise.all([syncWidget(), syncWidget()]);
    expect(mockCallAction).toHaveBeenCalledTimes(1);
    expect(mockNative.flushPresses).toHaveBeenCalledTimes(1);
  });

  it('logs a failed sync instead of rejecting', async () => {
    const { syncWidget } = loadModule();
    mockCallAction.mockRejectedValueOnce(new Error('offline'));
    await expect(syncWidget()).resolves.toBeUndefined();
    expect(mockLogger.warning).toHaveBeenCalledTimes(1);
  });
});

describe('widgetReloadKey', () => {
  const { widgetReloadKey } = loadModule();
  const day = {
    localDate: '2026-11-19',
    localNow: '2026-11-19T09:30',
    tasks: [{ id: 't1', state: 'pending' }],
    eventsToday: [],
    nextUp: null,
  } as unknown as DayViewData;

  it('is null without a day view', () => {
    expect(widgetReloadKey(null)).toBeNull();
  });

  it('ignores the minute ticking by', () => {
    const later = { ...day, localNow: '2026-11-19T09:31' } as DayViewData;
    expect(widgetReloadKey(later)).toBe(widgetReloadKey(day));
  });

  it('changes when a task changes', () => {
    const confirmed = {
      ...day,
      tasks: [{ id: 't1', state: 'confirmed' }],
    } as unknown as DayViewData;
    expect(widgetReloadKey(confirmed)).not.toBe(widgetReloadKey(day));
  });
});
