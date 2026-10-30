// sunny_app/src/backend/__tests__/pairing.test.ts
//
// Purpose: Unit tests for pairing.ts with Clerk, expo-crypto, AsyncStorage, fetch and the push
// module mocked: the /pair request (cleaned code, nonce, timeout vs offline messages), nonce
// reuse for a retry of the same code, error mapping of the server's body, ticket sign-in
// (including a failing stale sign out), pair() waiting for an unpair in flight, unpair (never
// rejects, every step isolated, shared run), the removal retry backoff, and decidePairing /
// rememberDevice (Clerk-only "unpaired", transient Convex auth, mine failure, removal of a
// non-device account).
//
// Last modified: 2026-10-29

import { beforeEach, describe, expect, it, jest } from '@jest/globals';

import { BackendError } from '../api';
import {
  decidePairing,
  nonceForCode,
  pair,
  pairErrorFromBody,
  rememberDevice,
  removalRetryDelay,
  UNREACHABLE_NOTICE,
  unpair,
  type MineEntry,
  type PairedDevice,
  type PairingInputs,
} from '../pairing';

type AnyMock = (...args: unknown[]) => Promise<unknown>;

const mockStore = new Map<string, string>();
const mockCalls: string[] = [];
const mockUnregister = jest.fn<AnyMock>();
const mockSignOut = jest.fn<AnyMock>();
const mockSignInCreate = jest.fn<AnyMock>();
const mockSetActive = jest.fn<AnyMock>();
const mockRandomUUID = jest.fn<() => string>();
const mockFetch = jest.fn<AnyMock>();
const mockClerk: { session: unknown; client: unknown; throws: boolean } = {
  session: null,
  client: undefined,
  throws: false,
};
const mockStorage = { removeFails: false };

jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem: async (key: string) => mockStore.get(key) ?? null,
    setItem: async (key: string, value: string) => void mockStore.set(key, value),
    removeItem: async (key: string) => {
      if (mockStorage.removeFails) throw new Error('storage down');
      mockStore.delete(key);
    },
  },
}));

jest.mock('@clerk/expo', () => ({
  getClerkInstance: () => {
    if (mockClerk.throws) throw new Error('clerk unavailable');
    return {
      get session() {
        return mockClerk.session;
      },
      get client() {
        return mockClerk.client;
      },
      signOut: () => mockSignOut(),
      setActive: (params: unknown) => mockSetActive(params),
    };
  },
}));

jest.mock('expo-crypto', () => ({
  randomUUID: () => mockRandomUUID(),
}));

jest.mock('../../notifications/push', () => ({
  unregisterStoredPushToken: () => mockUnregister(),
}));

jest.mock('../../logging/logger', () => ({
  logger: { debug: jest.fn(), info: jest.fn(), warning: jest.fn(), error: jest.fn() },
}));

jest.mock('../../config', () => ({ CONVEX_SITE_URL: 'https://site.example' }));

jest.mock('../convex', () => ({ convex: {} }));

const PAIR_BODY = { ticket: 'tkt', householdId: 'h1', deviceId: 'd1', kind: 'senior_phone' };

/**
 * purpose: Build a fetch Response-like object.
 * @param status: (number) HTTP status.
 * @param body: (unknown) JSON body, or undefined for an unreadable body.
 * @return: (object) Something with ok, status and json().
 */
function reply(status: number, body?: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => {
      if (body === undefined) throw new Error('not json');
      return body;
    },
  };
}

/**
 * purpose: Read the JSON body of the nth fetch call.
 * @param index: (number) Zero-based call index.
 * @return: (Record<string, unknown>) The parsed request body.
 */
function sentBody(index = 0): Record<string, unknown> {
  const init = mockFetch.mock.calls[index]?.[1] as { body: string };
  return JSON.parse(init.body) as Record<string, unknown>;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockStore.clear();
  mockCalls.length = 0;
  mockClerk.session = null;
  mockClerk.throws = false;
  mockStorage.removeFails = false;
  mockClerk.client = { signIn: { create: (params: unknown) => mockSignInCreate(params) } };
  let counter = 0;
  mockRandomUUID.mockImplementation(() => `uuid-${++counter}`);
  mockFetch.mockResolvedValue(reply(200, PAIR_BODY));
  mockSignInCreate.mockResolvedValue({ status: 'complete', createdSessionId: 'sess_1' });
  mockSetActive.mockResolvedValue(undefined);
  mockUnregister.mockImplementation(async () => void mockCalls.push('push'));
  mockSignOut.mockImplementation(async () => void mockCalls.push('signOut'));
  global.fetch = mockFetch as unknown as typeof fetch;
});

describe('pair', () => {
  it('posts the cleaned code and a CSPRNG nonce to /pair', async () => {
    await pair('abcd-1234');
    expect(mockFetch.mock.calls[0]?.[0]).toBe('https://site.example/pair');
    const body = sentBody();
    expect(body.code).toBe('ABCD1234');
    expect(String(body.pairingNonce)).toMatch(/^uuid-\d+$/);
  });

  it('signs in with the ticket and sets the session active', async () => {
    await pair('ABCD1234');
    expect(mockSignInCreate).toHaveBeenCalledWith({ strategy: 'ticket', ticket: 'tkt' });
    expect(mockSetActive).toHaveBeenCalledWith({ session: 'sess_1' });
  });

  it('clears the pending attempt once pairing succeeds', async () => {
    await pair('ABCD1234');
    expect(mockStore.has('sunny.pairingAttempt')).toBe(false);
  });

  it('signs out an existing session before signing in', async () => {
    mockClerk.session = { id: 'old' };
    await pair('ABCD1234');
    expect(mockSignOut).toHaveBeenCalledTimes(1);
    expect(mockSignInCreate).toHaveBeenCalledTimes(1);
  });

  it('resends the same nonce when the same code is retried after a lost response', async () => {
    mockFetch.mockRejectedValueOnce(new Error('Network request failed'));
    await expect(pair('ABCD1234')).rejects.toMatchObject({ status: 0 });
    await pair('abcd 1234');
    expect(sentBody(1).pairingNonce).toBe(sentBody(0).pairingNonce);
    expect(mockRandomUUID).toHaveBeenCalledTimes(1);
  });

  it('keeps the nonce when sign-in fails so a retry gets a fresh ticket for the same device', async () => {
    mockSignInCreate.mockResolvedValueOnce({
      status: 'needs_first_factor',
      createdSessionId: null,
    });
    await expect(pair('ABCD1234')).rejects.toThrow('Could not finish connecting');
    await pair('ABCD1234');
    expect(sentBody(1).pairingNonce).toBe(sentBody(0).pairingNonce);
  });

  it('uses a different nonce for a different code', async () => {
    mockFetch.mockResolvedValueOnce(reply(404, { error: { code: 'not_found', message: 'No' } }));
    await expect(pair('AAAA1111')).rejects.toBeInstanceOf(BackendError);
    await pair('BBBB2222');
    expect(sentBody(1).pairingNonce).not.toBe(sentBody(0).pairingNonce);
  });

  it('shows the server message and status for a rejected code', async () => {
    mockFetch.mockResolvedValue(
      reply(404, { error: { code: 'not_found', message: 'That code was not found.' } }),
    );
    await expect(pair('ABCD1234')).rejects.toMatchObject({
      message: 'That code was not found.',
      status: 404,
    });
    expect(mockSignInCreate).not.toHaveBeenCalled();
  });

  it('maps a network failure to the offline message with status 0', async () => {
    mockFetch.mockRejectedValue(new TypeError('Network request failed'));
    await expect(pair('ABCD1234')).rejects.toMatchObject({
      message: 'Could not reach Sunny. Check the internet connection.',
      status: 0,
    });
  });

  it('rejects a success body that is missing the ticket', async () => {
    mockFetch.mockResolvedValue(reply(200, { householdId: 'h1', kind: 'senior_phone' }));
    await expect(pair('ABCD1234')).rejects.toBeInstanceOf(BackendError);
    expect(mockSignInCreate).not.toHaveBeenCalled();
  });

  it('fails cleanly when Clerk has no client', async () => {
    mockClerk.client = undefined;
    await expect(pair('ABCD1234')).rejects.toThrow('Could not finish connecting');
  });
});

describe('pair edge cases', () => {
  it('reports a request that was aborted as taking too long, not as offline', async () => {
    mockFetch.mockRejectedValue(Object.assign(new Error('Aborted'), { name: 'AbortError' }));
    await expect(pair('ABCD1234')).rejects.toMatchObject({
      message: 'Connecting took too long. Please try again.',
      status: 0,
    });
  });

  it('reports a body read that was aborted as taking too long', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => {
        throw Object.assign(new Error('Aborted'), { name: 'AbortError' });
      },
    });
    await expect(pair('ABCD1234')).rejects.toMatchObject({
      message: 'Connecting took too long. Please try again.',
    });
  });

  it('continues pairing when signing out a stale session fails', async () => {
    mockClerk.session = { id: 'old' };
    mockSignOut.mockRejectedValue(new Error('offline'));
    await pair('ABCD1234');
    expect(mockSignInCreate).toHaveBeenCalledTimes(1);
    expect(mockSetActive).toHaveBeenCalledWith({ session: 'sess_1' });
  });

  it('waits for an unpair in flight before touching the pairing attempt', async () => {
    mockClerk.session = { id: 's' };
    let finishPush: () => void = () => undefined;
    mockUnregister.mockImplementation(
      () => new Promise<void>((resolve) => (finishPush = () => resolve())),
    );
    const unpairing = unpair();
    const pairing = pair('ABCD1234');
    await Promise.resolve();
    await Promise.resolve();
    expect(mockFetch).not.toHaveBeenCalled();
    finishPush();
    await unpairing;
    await pairing;
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});

describe('nonceForCode', () => {
  it('reuses the nonce for the same code within 10 minutes', async () => {
    const first = await nonceForCode('ABCD1234', 1_000);
    expect(await nonceForCode('ABCD1234', 1_000 + 9 * 60_000)).toBe(first);
  });

  it('makes a new nonce after 10 minutes', async () => {
    const first = await nonceForCode('ABCD1234', 1_000);
    expect(await nonceForCode('ABCD1234', 1_000 + 10 * 60_000)).not.toBe(first);
  });

  it('ignores a malformed stored attempt', async () => {
    mockStore.set('sunny.pairingAttempt', '{not json');
    expect(await nonceForCode('ABCD1234')).toMatch(/^uuid-\d+$/);
  });
});

describe('pairErrorFromBody', () => {
  it('uses the message of the error body', () => {
    const error = pairErrorFromBody(429, { error: { code: 'limit', message: 'Too many tries' } });
    expect(error).toMatchObject({ message: 'Too many tries', status: 429 });
  });

  it('uses a generic message when the body is missing', () => {
    expect(pairErrorFromBody(502, null)).toMatchObject({
      message: 'Something went wrong. Please try again.',
      status: 502,
    });
  });
});

describe('unpair', () => {
  it('unregisters the push token, then signs out', async () => {
    mockClerk.session = { id: 's' };
    await unpair();
    expect(mockCalls).toEqual(['push', 'signOut']);
  });

  it('shares one run between concurrent calls', async () => {
    mockClerk.session = { id: 's' };
    await Promise.all([unpair(), unpair()]);
    expect(mockSignOut).toHaveBeenCalledTimes(1);
    expect(mockUnregister).toHaveBeenCalledTimes(1);
  });

  it('skips the push token and the sign out when there is no session', async () => {
    await unpair();
    expect(mockUnregister).not.toHaveBeenCalled();
    expect(mockSignOut).not.toHaveBeenCalled();
  });

  it('does not throw when signing out fails', async () => {
    mockClerk.session = { id: 's' };
    mockSignOut.mockRejectedValue(new Error('offline'));
    await expect(unpair()).resolves.toBeUndefined();
  });

  it('forgets a pending pairing attempt', async () => {
    mockStore.set('sunny.pairingAttempt', '{}');
    await unpair();
    expect(mockStore.has('sunny.pairingAttempt')).toBe(false);
  });
});

describe('unpair resilience', () => {
  it('still signs out when clearing the attempt fails, and does not reject', async () => {
    mockClerk.session = { id: 's' };
    mockStorage.removeFails = true;
    await expect(unpair()).resolves.toBeUndefined();
    expect(mockSignOut).toHaveBeenCalledTimes(1);
  });

  it('still signs out when unregistering the push token throws', async () => {
    mockClerk.session = { id: 's' };
    mockUnregister.mockRejectedValue(new Error('boom'));
    await expect(unpair()).resolves.toBeUndefined();
    expect(mockSignOut).toHaveBeenCalledTimes(1);
  });

  it('does not reject when Clerk is unavailable', async () => {
    mockClerk.throws = true;
    await expect(unpair()).resolves.toBeUndefined();
  });
});

describe('removalRetryDelay', () => {
  it('backs off 2 s, 5 s, 15 s, then every 30 s', () => {
    expect([0, 1, 2, 3, 4, 10].map(removalRetryDelay)).toEqual([
      2000, 5000, 15000, 30000, 30000, 30000,
    ]);
  });
});

/**
 * purpose: Build a households.mine entry.
 * @param deviceKind: (string | null) The device kind; null for a caregiver entry.
 * @param householdId: (string) The household id.
 * @return: (MineEntry) The entry.
 */
function mineEntry(deviceKind: string | null, householdId = 'h1'): MineEntry {
  return {
    household: { _id: householdId },
    role: deviceKind === null ? 'primary' : null,
    deviceKind,
  } as unknown as MineEntry;
}

const DEVICE: PairedDevice = { householdId: 'h1', kind: 'senior_phone' } as PairedDevice;

/**
 * purpose: Build decidePairing inputs for a signed-in, Convex-authenticated device.
 * @param overrides: (Partial<PairingInputs>) Fields to set.
 * @return: (PairingInputs) The inputs.
 */
function inputs(overrides: Partial<PairingInputs> = {}): PairingInputs {
  return {
    clerkLoaded: true,
    clerkSignedIn: true,
    convexLoading: false,
    convexAuthenticated: true,
    mine: undefined,
    mineFailed: false,
    lastDevice: null,
    ...overrides,
  };
}

describe('decidePairing', () => {
  it('is loading until Clerk has loaded', () => {
    expect(decidePairing(inputs({ clerkLoaded: false })).state).toBe('loading');
  });

  it('is unpaired only when Clerk has loaded without a session', () => {
    expect(decidePairing(inputs({ clerkSignedIn: false })).state).toBe('unpaired');
  });

  it('is loading while Convex authenticates', () => {
    expect(decidePairing(inputs({ convexLoading: true, convexAuthenticated: false }))).toEqual({
      state: 'loading',
    });
  });

  it('does not look unpaired when Convex cannot authenticate a Clerk session', () => {
    const decision = decidePairing(inputs({ convexAuthenticated: false }));
    expect(decision).toEqual({ state: 'loading', notice: UNREACHABLE_NOTICE });
  });

  it('keeps the last device seen when Convex auth drops', () => {
    expect(decidePairing(inputs({ convexAuthenticated: false, lastDevice: DEVICE }))).toEqual({
      state: 'paired',
      device: DEVICE,
    });
  });

  it('is loading while mine has not arrived', () => {
    expect(decidePairing(inputs())).toEqual({ state: 'loading' });
  });

  it('shows the notice, or keeps the last device, when mine failed', () => {
    expect(decidePairing(inputs({ mineFailed: true }))).toEqual({
      state: 'loading',
      notice: UNREACHABLE_NOTICE,
    });
    expect(decidePairing(inputs({ mineFailed: true, lastDevice: DEVICE })).state).toBe('paired');
  });

  it('is paired with the device entry from mine', () => {
    const mine = [mineEntry(null, 'h0'), mineEntry('home_display', 'h9')];
    expect(decidePairing(inputs({ mine }))).toEqual({
      state: 'paired',
      device: { householdId: 'h9', kind: 'home_display' },
    });
  });

  it('detects removal: signed in but mine has no device entry', () => {
    expect(decidePairing(inputs({ mine: [] })).state).toBe('removed');
  });

  it('treats a signed-in caregiver account (no device entry) as removed', () => {
    expect(decidePairing(inputs({ mine: [mineEntry(null)], lastDevice: DEVICE })).state).toBe(
      'removed',
    );
  });
});

describe('rememberDevice', () => {
  it('remembers a paired device and keeps the same object when unchanged', () => {
    const first = rememberDevice({ state: 'paired', device: DEVICE }, null);
    expect(first).toBe(DEVICE);
    const same = { householdId: 'h1', kind: 'senior_phone' } as PairedDevice;
    expect(rememberDevice({ state: 'paired', device: same }, DEVICE)).toBe(DEVICE);
  });

  it('keeps the device while loading and forgets it when unpaired or removed', () => {
    expect(rememberDevice({ state: 'loading' }, DEVICE)).toBe(DEVICE);
    expect(rememberDevice({ state: 'unpaired' }, DEVICE)).toBeNull();
    expect(rememberDevice({ state: 'removed' }, DEVICE)).toBeNull();
  });
});
