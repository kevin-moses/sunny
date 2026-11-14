// sunny_app/src/notifications/__tests__/usePushNotifications.test.tsx
//
// Purpose: Guards the paired senior device's push behaviour (push.ts usePushNotifications, which
// VoiceProvider mounts) against the caregiver push work: permission is still requested about a
// second after mounting and the token registered; a tap on the body (warm or the launch tap)
// still calls onTap with the push's task instance, which starts a voice session; an "I'm on it"
// action never reaches a senior device's onTap; and the senior path registers no notification
// category. expo-notifications (native), the network (callMutation) and AsyncStorage are mocked.
//
// Last modified: 2026-11-14

import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import type * as NotificationsTypes from 'expo-notifications';
import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { callMutation } from '../../backend/api';
import { usePushNotifications, type NotificationTap } from '../push';

jest.mock('expo-notifications', () => ({
  setNotificationHandler: jest.fn(),
  setNotificationCategoryAsync: jest.fn(),
  getPermissionsAsync: jest.fn(),
  requestPermissionsAsync: jest.fn(),
  getDevicePushTokenAsync: jest.fn(),
  addPushTokenListener: jest.fn(() => ({ remove: () => undefined })),
  getLastNotificationResponse: jest.fn(),
  clearLastNotificationResponse: jest.fn(),
  addNotificationResponseReceivedListener: jest.fn(),
  DEFAULT_ACTION_IDENTIFIER: 'expo.modules.notifications.actions.DEFAULT',
}));

jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem: async () => null,
    setItem: async () => undefined,
    removeItem: async () => undefined,
  },
}));

jest.mock('../../backend/api', () => ({ callMutation: jest.fn() }));

jest.mock('../../logging/logger', () => ({
  logger: { debug: jest.fn(), info: jest.fn(), warning: jest.fn(), error: jest.fn() },
}));

/** The mocked native module, typed for the calls the tests script. */
const mockNotifications = jest.requireMock('expo-notifications') as {
  setNotificationCategoryAsync: jest.Mock<() => Promise<unknown>>;
  getPermissionsAsync: jest.Mock<() => Promise<unknown>>;
  requestPermissionsAsync: jest.Mock<() => Promise<unknown>>;
  getDevicePushTokenAsync: jest.Mock<() => Promise<unknown>>;
  getLastNotificationResponse: jest.Mock<() => unknown>;
  addNotificationResponseReceivedListener: jest.Mock<
    (l: (r: NotificationsTypes.NotificationResponse) => void) => { remove: () => void }
  >;
};

const mockCall = callMutation as unknown as jest.Mock<(...a: unknown[]) => Promise<unknown>>;
const TOKEN = 'c'.repeat(64);

let listener: ((r: NotificationsTypes.NotificationResponse) => void) | null = null;
let renderer: ReactTestRenderer | null = null;

/**
 * purpose: Build a notification response.
 * @param action: (string) The action identifier.
 * @param data: (Record<string, unknown>) The push's custom keys.
 * @return: (NotificationsTypes.NotificationResponse) The response.
 */
function response(
  action: string,
  data: Record<string, unknown>,
): NotificationsTypes.NotificationResponse {
  return {
    actionIdentifier: action,
    notification: { request: { identifier: 'n1', content: { data } } },
  } as unknown as NotificationsTypes.NotificationResponse;
}

/**
 * purpose: A component that mounts the senior device's push hook.
 * @param props: ({ onTap }) The tap callback.
 * @return: (null) Renders nothing.
 */
function SeniorPush({ onTap }: { onTap: (tap: NotificationTap) => void }) {
  usePushNotifications(onTap);
  return null;
}

/**
 * purpose: Mount the hook.
 * @param onTap: ((tap: NotificationTap) => void) The tap callback.
 * @return: (Promise<void>) Resolves when mounted.
 */
async function mount(onTap: (tap: NotificationTap) => void): Promise<void> {
  await act(async () => {
    renderer = create(<SeniorPush onTap={onTap} />);
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.useFakeTimers();
  listener = null;
  mockCall.mockResolvedValue(null);
  mockNotifications.requestPermissionsAsync.mockResolvedValue({ granted: true, status: 'granted' });
  mockNotifications.getDevicePushTokenAsync.mockResolvedValue({ type: 'ios', data: TOKEN });
  mockNotifications.getLastNotificationResponse.mockReturnValue(null);
  mockNotifications.addNotificationResponseReceivedListener.mockImplementation((l) => {
    listener = l;
    return { remove: () => undefined };
  });
});

afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = null;
  jest.useRealTimers();
});

describe('senior device push', () => {
  it('requests permission after a second and registers the token', async () => {
    await mount(jest.fn());
    expect(mockNotifications.requestPermissionsAsync).not.toHaveBeenCalled();
    await act(async () => {
      await jest.advanceTimersByTimeAsync(1000);
    });
    expect(mockNotifications.requestPermissionsAsync).toHaveBeenCalledTimes(1);
    expect(mockCall).toHaveBeenCalledWith(expect.anything(), { token: TOKEN });
    expect(mockNotifications.setNotificationCategoryAsync).not.toHaveBeenCalled();
  });

  it('a tap on the body calls onTap with the task instance', async () => {
    const onTap = jest.fn();
    await mount(onTap);
    await act(async () => {
      listener?.(
        response('expo.modules.notifications.actions.DEFAULT', {
          kind: 'senior_prompt',
          task_instance_id: 'inst_9',
        }),
      );
    });
    expect(onTap).toHaveBeenCalledWith({ taskInstanceId: 'inst_9' });
  });

  it('the launch tap calls onTap once on mount', async () => {
    const onTap = jest.fn();
    mockNotifications.getLastNotificationResponse.mockReturnValue(
      response('expo.modules.notifications.actions.DEFAULT', { task_instance_id: 'inst_1' }),
    );
    await mount(onTap);
    expect(onTap).toHaveBeenCalledTimes(1);
    expect(onTap).toHaveBeenCalledWith({ taskInstanceId: 'inst_1' });
  });

  it('an "I\'m on it" action never reaches onTap', async () => {
    const onTap = jest.fn();
    await mount(onTap);
    await act(async () => {
      listener?.(response('claim', { kind: 'caregiver_alert', task_instance_id: 'inst_9' }));
    });
    expect(onTap).not.toHaveBeenCalled();
    expect(mockCall).not.toHaveBeenCalled();
  });
});
