import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Notifications from 'expo-notifications';
import { useEffect, useRef } from 'react';

import { callMutation } from '../backend/api';
import { api, type TaskInstanceId } from '../backend/convexApi';
import { errorMessage } from '../errors';
import { logger } from '../logging/logger';

const PERMISSION_DELAY_MS = 1000;

const PUSH_TOKEN_KEY = 'sunny.pushToken';

const UNREGISTER_TIMEOUT_MS = 4000;

export interface NotificationTap {
  taskInstanceId?: TaskInstanceId;
}

export const DEFAULT_NOTIFICATION_HANDLER: Notifications.NotificationHandler = {
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
};

Notifications.setNotificationHandler(DEFAULT_NOTIFICATION_HANDLER);

function parseNotificationTap(data: Record<string, unknown> | null | undefined): NotificationTap {
  const value = data?.task_instance_id;
  return typeof value === 'string' && value !== ''
    ? { taskInstanceId: value as TaskInstanceId }
    : {};
}

async function waitAtMost(work: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
  });
  try {
    return await Promise.race([work.then(() => true), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function unregisterToken(token: string): Promise<boolean> {
  return waitAtMost(
    callMutation(api.households.unregisterPushToken, { token }),
    UNREGISTER_TIMEOUT_MS,
  );
}

export async function unregisterStoredPushToken(): Promise<void> {
  try {
    const token = await AsyncStorage.getItem(PUSH_TOKEN_KEY);
    if (token === null) return;
    if (await unregisterToken(token)) await AsyncStorage.removeItem(PUSH_TOKEN_KEY);
    else logger.warning('Push', 'Timed out unregistering the push token');
  } catch (e) {
    logger.warning('Push', `Failed to unregister the push token: ${errorMessage(e)}`);
  }
}

export function discardStaleLaunchTap(): void {
  Notifications.clearLastNotificationResponse();
}

export function useDiscardNotificationTaps(): void {
  useEffect(() => {
    discardStaleLaunchTap();
    const subscription = Notifications.addNotificationResponseReceivedListener(() =>
      discardStaleLaunchTap(),
    );
    return () => subscription.remove();
  }, []);
}

export async function registerPushToken(token: string): Promise<void> {
  try {
    const previous = await AsyncStorage.getItem(PUSH_TOKEN_KEY);
    await callMutation(api.households.registerPushToken, { token });
    await AsyncStorage.setItem(PUSH_TOKEN_KEY, token);
    logger.info('Push', 'Push token registered');
    if (previous !== null && previous !== token) {
      await unregisterToken(previous).catch((e: unknown) =>
        logger.warning('Push', `Failed to unregister the old push token: ${errorMessage(e)}`),
      );
    }
  } catch (e) {
    logger.error('Push', `Failed to register the push token: ${errorMessage(e)}`);
  }
}

async function registerForPush(): Promise<void> {
  const permission = await Notifications.requestPermissionsAsync({
    ios: { allowAlert: true, allowSound: true, allowBadge: true },
  });
  if (!permission.granted) {
    logger.info('Push', 'Notification permission not granted');
    return;
  }
  const deviceToken = await Notifications.getDevicePushTokenAsync();
  if (typeof deviceToken.data === 'string') await registerPushToken(deviceToken.data);
}

function dispatchTap(
  response: Notifications.NotificationResponse,
  onTap: (tap: NotificationTap) => void,
): void {
  if (response.actionIdentifier !== Notifications.DEFAULT_ACTION_IDENTIFIER) return;
  const data = response.notification.request.content.data as Record<string, unknown> | undefined;
  onTap(parseNotificationTap(data));
}

export function usePushNotifications(onTap: (tap: NotificationTap) => void): void {
  const onTapRef = useRef(onTap);

  useEffect(() => {
    onTapRef.current = onTap;
  }, [onTap]);

  useEffect(() => {
    const timer = setTimeout(() => {
      registerForPush().catch((e: unknown) =>
        logger.error('Push', `Registration failed: ${errorMessage(e)}`),
      );
    }, PERMISSION_DELAY_MS);
    const subscription = Notifications.addPushTokenListener((token) => {
      if (typeof token.data === 'string') void registerPushToken(token.data);
    });
    return () => {
      clearTimeout(timer);
      subscription.remove();
    };
  }, []);

  useEffect(() => {
    const launchResponse = Notifications.getLastNotificationResponse();
    if (launchResponse) {
      Notifications.clearLastNotificationResponse();
      dispatchTap(launchResponse, onTapRef.current);
    }
    const subscription = Notifications.addNotificationResponseReceivedListener((response) =>
      dispatchTap(response, onTapRef.current),
    );
    return () => subscription.remove();
  }, []);
}
