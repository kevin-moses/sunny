import { describe, expect, it, jest } from '@jest/globals';

import { isOfflineFrom } from '../useDayView';

jest.mock('../../backend/convex', () => ({ useQueryWithStatus: jest.fn() }));

describe('isOfflineFrom', () => {
  it('is offline when the socket is down after having connected', () => {
    expect(isOfflineFrom({ hasEverConnected: true, isWebSocketConnected: false })).toBe(true);
  });

  it('is online while the socket is connected', () => {
    expect(isOfflineFrom({ hasEverConnected: true, isWebSocketConnected: true })).toBe(false);
  });

  it('is not offline before the first connection', () => {
    expect(isOfflineFrom({ hasEverConnected: false, isWebSocketConnected: false })).toBe(false);
  });
});
