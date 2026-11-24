import { beforeEach, describe, expect, it, jest } from '@jest/globals';

import { logger } from '../../logging/logger';
import { dropLegacyPressQueue, LEGACY_QUEUE_KEYS } from '../legacyQueue';

const mockStore = new Map<string, string>();
let mockFail = false;

jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    multiGet: async (keys: string[]) => {
      if (mockFail) throw new Error('disk gone');
      return keys.map((key) => [key, mockStore.get(key) ?? null]);
    },
    multiRemove: async (keys: string[]) => keys.forEach((key) => mockStore.delete(key)),
  },
}));

jest.mock('../../logging/logger', () => ({
  logger: { warning: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

beforeEach(() => {
  mockStore.clear();
  mockFail = false;
  jest.mocked(logger.error).mockClear();
  jest.mocked(logger.warning).mockClear();
});

describe('dropLegacyPressQueue', () => {
  it('removes what the older queue left behind and logs it', async () => {
    const queued = JSON.stringify([{ instanceId: 'inst1', pressedAt: 1, pressId: 'p' }]);
    mockStore.set(LEGACY_QUEUE_KEYS[0]!, queued);
    mockStore.set('something.else', 'kept');
    await dropLegacyPressQueue();
    expect([...mockStore.keys()]).toEqual(['something.else']);
    expect(logger.error).toHaveBeenCalledWith('PressLog', expect.stringContaining('Dropped'), {
      entries: [{ key: LEGACY_QUEUE_KEYS[0], value: queued }],
    });
  });

  it('says nothing on a phone that never had the older queue', async () => {
    await dropLegacyPressQueue();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('does not fail the launch when storage cannot be read', async () => {
    mockFail = true;
    await expect(dropLegacyPressQueue()).resolves.toBeUndefined();
    expect(logger.warning).toHaveBeenCalledTimes(1);
  });
});
