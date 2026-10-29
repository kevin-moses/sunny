// sunny_app/src/backend/__tests__/pairing.test.ts
//
// Purpose: Unit tests for pairing.ts with Supabase, AsyncStorage and the RPC layer mocked:
// adopting an existing devices row instead of redeeming again, redeeming when there is none,
// the friendly duplicate-key message, restorePairing, and the unpair ordering (push tokens,
// then sign out, then exactly one notification).
//
// Last modified: 2026-10-28

import { beforeEach, describe, expect, it, jest } from '@jest/globals';

import { BackendError } from '../api';
import { pair, restorePairing, subscribePairingLost, unpair } from '../pairing';

type AnyMock = (...args: unknown[]) => Promise<unknown>;

const mockStore = new Map<string, string>();
const mockCallRpc = jest.fn<AnyMock>();
const mockSelectRows = jest.fn<() => Promise<{ data: unknown; error: unknown }>>();
const mockGetSession = jest.fn<AnyMock>();
const mockSignInAnonymously = jest.fn<AnyMock>();
const mockSignOut = jest.fn<AnyMock>();
const mockDeleteTokens = jest.fn<AnyMock>();
/** Order in which the unpair steps ran. */
const mockCalls: string[] = [];

jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem: async (key: string) => mockStore.get(key) ?? null,
    setItem: async (key: string, value: string) => void mockStore.set(key, value),
    removeItem: async (key: string) => void mockStore.delete(key),
  },
}));

jest.mock('../supabase', () => ({
  supabase: {
    auth: {
      getSession: () => mockGetSession(),
      signInAnonymously: () => mockSignInAnonymously(),
      signOut: () => mockSignOut(),
      onAuthStateChange: jest.fn(),
    },
    from: () => ({ select: () => ({ eq: () => mockSelectRows() }) }),
  },
}));

jest.mock('../api', () => {
  class MockBackendError extends Error {
    readonly status: number;
    constructor(message: string, status: number) {
      super(message);
      this.status = status;
    }
  }
  return {
    BackendError: MockBackendError,
    callRpc: (...args: unknown[]) => mockCallRpc(...args),
  };
});

jest.mock('../../notifications/push', () => ({
  deleteOwnPushTokens: () => mockDeleteTokens(),
}));

jest.mock('../../logging/logger', () => ({
  logger: { debug: jest.fn(), info: jest.fn(), warning: jest.fn(), error: jest.fn() },
}));

const ROW = { household_id: 'h1', kind: 'senior_phone' };
const DEVICE = { householdId: 'h1', kind: 'senior_phone' };

beforeEach(() => {
  jest.clearAllMocks();
  mockStore.clear();
  mockCalls.length = 0;
  mockGetSession.mockResolvedValue({ data: { session: { user: { id: 'u1' } } } });
  mockSelectRows.mockResolvedValue({ data: [], error: null });
  mockCallRpc.mockResolvedValue('ok');
  mockDeleteTokens.mockImplementation(async () => void mockCalls.push('tokens'));
  mockSignOut.mockImplementation(async () => void mockCalls.push('signOut'));
});

describe('pair', () => {
  it('adopts an existing device row without redeeming', async () => {
    mockSelectRows.mockResolvedValue({ data: [ROW], error: null });
    expect(await pair('abcd-1234')).toEqual(DEVICE);
    expect(mockCallRpc).not.toHaveBeenCalled();
    expect(mockStore.get('sunny.pairedDevice')).toBe(JSON.stringify(DEVICE));
  });

  it('redeems the cleaned code when there is no row, then reads the row back', async () => {
    mockSelectRows
      .mockResolvedValueOnce({ data: [], error: null })
      .mockResolvedValueOnce({ data: [ROW], error: null });
    expect(await pair('abcd-1234')).toEqual(DEVICE);
    expect(mockCallRpc).toHaveBeenCalledWith('redeem_join_code', { p_code: 'ABCD1234' });
  });

  it('adopts the row when redeem fails with a duplicate key but a row exists', async () => {
    mockSelectRows
      .mockResolvedValueOnce({ data: [], error: null })
      .mockResolvedValueOnce({ data: [ROW], error: null });
    mockCallRpc.mockRejectedValue(new BackendError('duplicate key value (23505)', 409));
    expect(await pair('ABCD1234')).toEqual(DEVICE);
  });

  it('maps a duplicate key with no readable row to a friendly message', async () => {
    mockCallRpc.mockRejectedValue(new BackendError('duplicate key value (23505)', 409));
    await expect(pair('ABCD1234')).rejects.toThrow('This device is already connected to a family.');
  });

  it('passes other redeem errors through', async () => {
    mockCallRpc.mockRejectedValue(new BackendError('Invalid code', 400));
    await expect(pair('ABCD1234')).rejects.toThrow('Invalid code');
  });

  it('fails when no row exists after redeeming', async () => {
    await expect(pair('ABCD1234')).rejects.toThrow('not connected to a family');
  });
});

describe('restorePairing', () => {
  it('adopts and saves the device row of the current session', async () => {
    mockSelectRows.mockResolvedValue({ data: [ROW], error: null });
    expect(await restorePairing()).toEqual(DEVICE);
    expect(mockStore.has('sunny.pairedDevice')).toBe(true);
  });

  it('returns null without a session', async () => {
    mockGetSession.mockResolvedValue({ data: { session: null } });
    expect(await restorePairing()).toBeNull();
  });

  it('returns null when there is no device row', async () => {
    expect(await restorePairing()).toBeNull();
  });

  it('returns null when the read fails', async () => {
    mockSelectRows.mockResolvedValue({ data: null, error: { message: 'offline' } });
    expect(await restorePairing()).toBeNull();
  });
});

describe('unpair', () => {
  it('deletes push tokens, signs out, then notifies exactly once', async () => {
    mockStore.set('sunny.pairedDevice', JSON.stringify(DEVICE));
    const listener = jest.fn(() => void mockCalls.push('notify'));
    const unsubscribe = subscribePairingLost(listener);
    await unpair();
    unsubscribe();
    expect(mockCalls).toEqual(['tokens', 'signOut', 'notify']);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(mockStore.has('sunny.pairedDevice')).toBe(false);
  });

  it('does not notify when there was no saved pairing', async () => {
    const listener = jest.fn();
    const unsubscribe = subscribePairingLost(listener);
    await unpair();
    unsubscribe();
    expect(listener).not.toHaveBeenCalled();
    expect(mockSignOut).toHaveBeenCalledTimes(1);
  });
});
