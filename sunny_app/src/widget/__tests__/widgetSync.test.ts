import { beforeEach, describe, expect, it, jest } from '@jest/globals';

import type { SessionDecision } from '../../backend/pairing';
import type { HouseholdId } from '../../backend/convexApi';
import { makeDay, makeTask } from '../../testing/dayFixtures';

type AnyMock = (...args: unknown[]) => Promise<unknown>;

const SITE = 'https://site.example';
const mockNative = {
  storedSiteUrl: jest.fn<() => Promise<string | null>>(),
  setCredentials: jest.fn<AnyMock>(),
  clearCredentials: jest.fn<AnyMock>(),
  syncSurfaces: jest.fn<AnyMock>(),
  flushPresses: jest.fn<AnyMock>(),
  unsentPresses: jest.fn<() => Promise<unknown>>(),
};
const mockCallAction = jest.fn<AnyMock>();
const mockLogger = { debug: jest.fn(), info: jest.fn(), warning: jest.fn(), error: jest.fn() };

jest.mock('../../../modules/sunny-widget', () => ({ __esModule: true, default: mockNative }));

class MockBackendError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

jest.mock('../../backend/api', () => ({
  BackendError: MockBackendError,
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

const HOUSEHOLD = 'h1' as HouseholdId;

const paired = (kind: 'senior_phone' | 'home_display'): SessionDecision => ({
  state: 'paired',
  device: { householdId: HOUSEHOLD, kind },
});

beforeEach(() => {
  jest.clearAllMocks();
  mockNative.storedSiteUrl.mockResolvedValue(null);
  mockNative.setCredentials.mockResolvedValue(undefined);
  mockNative.clearCredentials.mockResolvedValue(undefined);
  mockNative.flushPresses.mockResolvedValue('clean');
  mockNative.syncSurfaces.mockResolvedValue(undefined);
  mockNative.unsentPresses.mockResolvedValue([]);
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
    const caregiver: SessionDecision = {
      state: 'caregiver',
      home: { householdId: HOUSEHOLD, role: 'primary' },
    };
    expect(widgetHolderOf(caregiver)).toBe('none');
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
    mockNative.storedSiteUrl.mockResolvedValue(SITE);
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
    mockNative.storedSiteUrl.mockResolvedValue('https://old.example');
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

  it('stops asking once the server refuses this pairing a token, until the widget is cleared', async () => {
    const { ensureWidgetToken, clearWidget } = loadModule();
    mockCallAction.mockRejectedValueOnce(new MockBackendError('revoked', 403));
    await expect(ensureWidgetToken()).resolves.toBe(false);
    await expect(ensureWidgetToken()).resolves.toBe(false);
    expect(mockCallAction).toHaveBeenCalledTimes(1);
    expect(mockNative.setCredentials).not.toHaveBeenCalled();
    await clearWidget();
    await expect(ensureWidgetToken()).resolves.toBe(true);
    expect(mockCallAction).toHaveBeenCalledTimes(2);
    expect(mockNative.setCredentials).toHaveBeenCalledWith('tok-1', SITE);
  });

  it('asks again on the next foreground after a refusal that can change', async () => {
    const { ensureWidgetToken } = loadModule();
    mockCallAction.mockRejectedValueOnce(new MockBackendError('too many', 429));
    await expect(ensureWidgetToken()).rejects.toThrow('too many');
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
  it('flushes queued presses, then syncs the widget and the Lock Screen', async () => {
    const { syncWidget } = loadModule();
    mockNative.storedSiteUrl.mockResolvedValue(SITE);
    await syncWidget();
    expect(mockNative.flushPresses).toHaveBeenCalledTimes(1);
    expect(mockNative.syncSurfaces).toHaveBeenCalledTimes(1);
  });

  it('issues one new token after a 401 dropped the old one, then flushes again', async () => {
    const { syncWidget } = loadModule();
    mockNative.storedSiteUrl.mockResolvedValueOnce(SITE).mockResolvedValueOnce(null);
    mockNative.flushPresses.mockResolvedValueOnce('unauthorized').mockResolvedValueOnce('clean');
    await syncWidget();
    expect(mockCallAction).toHaveBeenCalledTimes(1);
    expect(mockNative.flushPresses).toHaveBeenCalledTimes(2);
    expect(mockNative.syncSurfaces).toHaveBeenCalledTimes(1);
  });

  it('neither flushes nor asks again after this pairing was refused a token', async () => {
    const { syncWidget } = loadModule();
    mockCallAction.mockRejectedValueOnce(new MockBackendError('revoked', 403));
    await syncWidget();
    await syncWidget();
    expect(mockCallAction).toHaveBeenCalledTimes(1);
    expect(mockNative.flushPresses).not.toHaveBeenCalled();
    expect(mockLogger.warning).not.toHaveBeenCalled();
  });

  it('does not flush without a stored token', async () => {
    const { syncWidget } = loadModule();
    mockNative.setCredentials.mockRejectedValueOnce(new Error('keychain'));
    await syncWidget();
    expect(mockNative.flushPresses).not.toHaveBeenCalled();
  });

  it('reads the presses the widget still has to send once the flush is over', async () => {
    const { syncWidget } = loadModule();
    mockNative.storedSiteUrl.mockResolvedValue(SITE);
    await syncWidget();
    expect(mockNative.unsentPresses).toHaveBeenCalledTimes(1);
    expect(mockNative.flushPresses.mock.invocationCallOrder[0]).toBeLessThan(
      mockNative.unsentPresses.mock.invocationCallOrder[0]!,
    );
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

describe('clearWidget', () => {
  function nativeStore(writeGate: Promise<unknown> = Promise.resolve()): {
    token: () => string | null;
  } {
    let token: string | null = null;
    mockNative.storedSiteUrl.mockImplementation(async () => (token === null ? null : SITE));
    mockNative.clearCredentials.mockImplementation(async () => {
      token = null;
    });
    mockNative.setCredentials.mockImplementation(async (value) => {
      await writeGate;
      token = String(value);
    });
    return { token: () => token };
  }

  function deferred(): { promise: Promise<unknown>; resolve: (value: unknown) => void } {
    let resolve!: (value: unknown) => void;
    const promise = new Promise<unknown>((r) => {
      resolve = r;
    });
    return { promise, resolve };
  }

  async function settle(): Promise<void> {
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
  }

  it('leaves no token behind when it runs while a sync is still issuing one', async () => {
    const { syncWidget, clearWidget } = loadModule();
    const native = nativeStore();
    const issue = deferred();
    mockCallAction.mockReturnValueOnce(issue.promise);
    const sync = syncWidget();
    await settle();
    const cleared = clearWidget();
    issue.resolve({ deviceToken: 'tok-late' });
    await Promise.all([sync, cleared]);
    expect(native.token()).toBeNull();
  });

  it('leaves no token behind when it runs while the stored site is being read', async () => {
    const { syncWidget, clearWidget } = loadModule();
    const native = nativeStore();
    const site = deferred();
    mockNative.storedSiteUrl.mockReturnValueOnce(site.promise as Promise<string | null>);
    const sync = syncWidget();
    await clearWidget();
    site.resolve(null);
    await sync;
    expect(native.token()).toBeNull();
  });

  it('leaves no token behind when it runs while a token is being stored', async () => {
    const { syncWidget, clearWidget } = loadModule();
    const write = deferred();
    const native = nativeStore(write.promise);
    const sync = syncWidget();
    await settle();
    const cleared = clearWidget();
    write.resolve(undefined);
    await Promise.all([sync, cleared]);
    expect(native.token()).toBeNull();
  });

  it('lets a sync after it issue a new token', async () => {
    const { syncWidget, clearWidget } = loadModule();
    const native = nativeStore();
    await clearWidget();
    await syncWidget();
    expect(native.token()).toBe('tok-1');
  });
});

describe('syncSurfaces', () => {
  it('asks the native side to sync and logs a failure instead of throwing', async () => {
    const { syncSurfaces } = loadModule();
    mockNative.syncSurfaces.mockRejectedValueOnce(new Error('native'));
    syncSurfaces();
    await Promise.resolve();
    await Promise.resolve();
    expect(mockNative.syncSurfaces).toHaveBeenCalledTimes(1);
    expect(mockLogger.warning).toHaveBeenCalledTimes(1);
  });
});

describe('surfaceSyncKey', () => {
  const { surfaceSyncKey } = loadModule();
  const day = makeDay({ localNow: '2026-11-09T09:30', tasks: [makeTask({ state: 'due' })] });

  it('is null without a day view', () => {
    expect(surfaceSyncKey(null)).toBeNull();
  });

  it('ignores the minute ticking by', () => {
    const later = { ...day, localNow: '2026-11-09T09:31' };
    expect(surfaceSyncKey(later)).toBe(surfaceSyncKey(day));
  });

  it('changes when a task changes', () => {
    const confirmed = { ...day, tasks: [makeTask({ state: 'confirmed' })] };
    expect(surfaceSyncKey(confirmed)).not.toBe(surfaceSyncKey(day));
  });
});
