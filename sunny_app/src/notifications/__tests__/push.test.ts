// sunny_app/src/notifications/__tests__/push.test.ts
//
// Purpose: Unit tests for unregisterStoredPushToken (unregisters and forgets the remembered
// token, does nothing without one, never throws, gives up after a timeout and then keeps the
// token remembered) and registerPushToken (remembers the token, unregisters the previous one
// after a rotation).
//
// Last modified: 2026-10-29

import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

import { registerPushToken, unregisterStoredPushToken } from '../push';

const mockStore = new Map<string, string>();
const mockMutation = jest.fn<(...args: unknown[]) => Promise<unknown>>();

jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem: async (key: string) => mockStore.get(key) ?? null,
    setItem: async (key: string, value: string) => void mockStore.set(key, value),
    removeItem: async (key: string) => void mockStore.delete(key),
  },
}));

jest.mock('expo-notifications', () => ({ setNotificationHandler: jest.fn() }));

jest.mock('../../backend/api', () => ({
  callMutation: (...args: unknown[]) => mockMutation(...args),
}));

jest.mock('../../logging/logger', () => ({
  logger: { debug: jest.fn(), info: jest.fn(), warning: jest.fn(), error: jest.fn() },
}));

beforeEach(() => {
  jest.clearAllMocks();
  mockStore.clear();
  mockMutation.mockResolvedValue(null);
});

afterEach(() => {
  jest.useRealTimers();
});

describe('unregisterStoredPushToken', () => {
  it('unregisters the remembered token and forgets it', async () => {
    mockStore.set('sunny.pushToken', 'apns-1');
    await unregisterStoredPushToken();
    expect(mockMutation).toHaveBeenCalledWith(expect.anything(), { token: 'apns-1' });
    expect(mockStore.has('sunny.pushToken')).toBe(false);
  });

  it('does nothing when no token was registered', async () => {
    await unregisterStoredPushToken();
    expect(mockMutation).not.toHaveBeenCalled();
  });

  it('does not throw when the backend call fails', async () => {
    mockStore.set('sunny.pushToken', 'apns-1');
    mockMutation.mockRejectedValue(new Error('boom'));
    await expect(unregisterStoredPushToken()).resolves.toBeUndefined();
  });

  it('gives up after the timeout when the backend never answers', async () => {
    jest.useFakeTimers();
    mockStore.set('sunny.pushToken', 'apns-1');
    mockMutation.mockReturnValue(new Promise(() => undefined));
    const done = unregisterStoredPushToken();
    await jest.advanceTimersByTimeAsync(5000);
    await expect(done).resolves.toBeUndefined();
    expect(mockStore.get('sunny.pushToken')).toBe('apns-1');
  });
});

describe('registerPushToken', () => {
  it('registers and remembers a first token without unregistering anything', async () => {
    await registerPushToken('apns-1');
    expect(mockMutation).toHaveBeenCalledTimes(1);
    expect(mockStore.get('sunny.pushToken')).toBe('apns-1');
  });

  it('unregisters the previous token when the OS rotates it', async () => {
    mockStore.set('sunny.pushToken', 'apns-old');
    await registerPushToken('apns-new');
    expect(mockMutation).toHaveBeenNthCalledWith(1, expect.anything(), { token: 'apns-new' });
    expect(mockMutation).toHaveBeenNthCalledWith(2, expect.anything(), { token: 'apns-old' });
    expect(mockStore.get('sunny.pushToken')).toBe('apns-new');
  });

  it('does not unregister when the token is unchanged', async () => {
    mockStore.set('sunny.pushToken', 'apns-1');
    await registerPushToken('apns-1');
    expect(mockMutation).toHaveBeenCalledTimes(1);
  });

  it('keeps the old token remembered when registering the new one fails', async () => {
    mockStore.set('sunny.pushToken', 'apns-old');
    mockMutation.mockRejectedValue(new Error('boom'));
    await registerPushToken('apns-new');
    expect(mockStore.get('sunny.pushToken')).toBe('apns-old');
  });
});
