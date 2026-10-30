// sunny_app/src/notifications/push.ts
//
// Purpose: Push notifications for the paired senior device. There is no FCM: the raw APNs
// device token is read with expo-notifications and stored in Convex (households.registerPushToken)
// so the backend can send APNs pushes directly.
//
// Behavior:
//   - Foreground banners: importing this module makes notifications show a banner, list
//     entry and sound while the app is open.
//   - Registration (usePushNotifications): about 1 second after mounting (letting the first
//     screen settle) notification permission is requested (alert, sound, badge); if granted,
//     the APNs token is registered with the backend. The token is registered again whenever
//     the OS rotates it (addPushTokenListener), and the previous one is then unregistered. The last token that registered successfully
//     is kept in AsyncStorage so unpairing can unregister it before the session is signed out.
//   - Taps: a tap while the app is running (warm) and the tap that launched the app (cold
//     start, handled once) call onTap, which starts a voice session with trigger
//     'notification_tap'.
//   - The hook is meant to be mounted only for a paired device. discardStaleLaunchTap()
//     drops a launch tap that arrived while the device was unpaired.
//   - Unpairing: unregisterStoredPushToken() removes the remembered token (bounded by a short
//     timeout so an offline device can still unpair). If it cannot run, the backend lets a
//     re-paired device take over a token whose previous owner is gone (an orphaned user).
//
// Notification payload contract (the push sender must follow it):
//   data: { "task_instance_id": "<id of the taskInstances row that prompted the push>" }
//   task_instance_id is optional. When it is a string it is forwarded to voice.livekitToken
//   as taskInstanceId so the agent opens the conversation in the context of that task.
//
// Last modified: 2026-10-29

import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Notifications from 'expo-notifications';
import { useEffect, useRef } from 'react';

import { callMutation } from '../backend/api';
import { api, type TaskInstanceId } from '../backend/convexApi';
import { errorMessage } from '../errors';
import { logger } from '../logging/logger';

/** Delay before asking for notification permission after mounting, in milliseconds. */
const PERMISSION_DELAY_MS = 1000;

/** AsyncStorage key of the last push token that registered successfully. */
const PUSH_TOKEN_KEY = 'sunny.pushToken';

/** Longest unregistering may delay unpairing, in milliseconds. */
const UNREGISTER_TIMEOUT_MS = 4000;

/** What a tapped notification asks the voice layer to do. */
export interface NotificationTap {
  taskInstanceId?: TaskInstanceId;
}

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

/**
 * purpose: Extract the tap context from a notification's data payload.
 * @param data: (Record<string, unknown> | null | undefined) the notification content data
 * @return: (NotificationTap) taskInstanceId set only when task_instance_id is a non-empty string
 */
function parseNotificationTap(data: Record<string, unknown> | null | undefined): NotificationTap {
  const value = data?.task_instance_id;
  return typeof value === 'string' && value !== ''
    ? { taskInstanceId: value as TaskInstanceId }
    : {};
}

/**
 * purpose: Wait for a promise, but no longer than a timeout.
 * @param work: (Promise<unknown>) The work to wait for.
 * @param ms: (number) Longest wait in milliseconds.
 * @return: (Promise<boolean>) True if the work finished, false if the timeout passed first;
 *          rejects if the work rejects first.
 */
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

/**
 * purpose: Ask the backend to unregister a push token, giving up after UNREGISTER_TIMEOUT_MS.
 * @param token: (string) The token.
 * @return: (Promise<boolean>) True if the backend confirmed in time; false on timeout.
 * @raises: BackendError when the call fails.
 */
async function unregisterToken(token: string): Promise<boolean> {
  return waitAtMost(
    callMutation(api.households.unregisterPushToken, { token }),
    UNREGISTER_TIMEOUT_MS,
  );
}

/**
 * purpose: Unregister the remembered push token and forget it once the backend confirmed.
 *          Called before signing out on unpair, while the session can still authenticate the
 *          call. Never throws, and gives up after UNREGISTER_TIMEOUT_MS so an offline device
 *          is not stuck unpairing; the token is then kept remembered.
 * @return: (Promise<void>) resolves when done; failures are logged
 */
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

/**
 * purpose: Forget the notification that launched the app, so a tap from before this device
 *          was paired does not start a surprise session after pairing.
 * @return: (void)
 */
export function discardStaleLaunchTap(): void {
  Notifications.clearLastNotificationResponse();
}

/**
 * purpose: Register an APNs device token for the signed-in device and remember it. When the
 *          OS rotated the token, best-effort unregister the previously remembered one.
 * @param token: (string) the raw APNs device token
 * @return: (Promise<void>) resolves when registered; failures are logged, not thrown
 */
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

/**
 * purpose: Ask for notification permission, then read and register the APNs token.
 * @return: (Promise<void>) resolves when done; does nothing when permission is refused
 */
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

/**
 * purpose: Convert a notification response into a tap and hand it to the callback.
 * @param response: (Notifications.NotificationResponse) the tapped notification
 * @param onTap: ((tap: NotificationTap) => void) callback that starts the voice session
 * @return: (void)
 */
function dispatchTap(
  response: Notifications.NotificationResponse,
  onTap: (tap: NotificationTap) => void,
): void {
  if (response.actionIdentifier !== Notifications.DEFAULT_ACTION_IDENTIFIER) return;
  const data = response.notification.request.content.data as Record<string, unknown> | undefined;
  onTap(parseNotificationTap(data));
}

/**
 * purpose: Wire token registration and tap handling for the paired device. onTap is read
 *          through a ref, so the latest callback is used without re-subscribing.
 * @param onTap: ((tap: NotificationTap) => void) called for each tapped notification
 * @return: (void)
 */
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
