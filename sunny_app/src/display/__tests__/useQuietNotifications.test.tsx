import { describe, expect, it, jest } from '@jest/globals';
import * as Notifications from 'expo-notifications';
import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { DEFAULT_NOTIFICATION_HANDLER } from '../../notifications/push';
import { QUIET_NOTIFICATION_HANDLER, useQuietNotifications } from '../useQuietNotifications';

jest.mock('expo-notifications', () => ({ setNotificationHandler: jest.fn() }));
jest.mock('@react-native-async-storage/async-storage', () =>
  jest.requireActual('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);
jest.mock('../../backend/api', () => ({ callMutation: jest.fn() }));
jest.mock('../../logging/logger', () => ({
  logger: { info: jest.fn(), warning: jest.fn(), error: jest.fn() },
}));

function Probe(): null {
  useQuietNotifications();
  return null;
}

const mockSetHandler = jest.mocked(Notifications.setNotificationHandler);

describe('useQuietNotifications', () => {
  it('silences banners and sounds while mounted, then restores the default', async () => {
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(<Probe />);
    });
    expect(mockSetHandler).toHaveBeenLastCalledWith(QUIET_NOTIFICATION_HANDLER);
    const quiet = await QUIET_NOTIFICATION_HANDLER.handleNotification({} as never);
    expect(quiet).toMatchObject({ shouldShowBanner: false, shouldPlaySound: false });

    act(() => renderer.unmount());
    expect(mockSetHandler).toHaveBeenLastCalledWith(DEFAULT_NOTIFICATION_HANDLER);
  });
});
