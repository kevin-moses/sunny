// sunny_app/src/notifications/push.ts
//
// Purpose: Push notifications for the paired senior device. There is no FCM: the raw APNs
// device token is read with expo-notifications and stored in the Supabase push_tokens table
// so the backend can send APNs pushes directly.
//
// Behavior:
//   - Foreground banners: importing this module makes notifications show a banner, list
//     entry and sound while the app is open.
//   - Registration (usePushNotifications): about 1 second after mounting (letting the first
//     screen settle) notification permission is requested (alert, sound, badge); if granted,
//     the APNs token is upserted as { user_id, token } with onConflict 'token' (RLS allows a
//     user to write rows with their own user_id). The token is registered again whenever the
//     OS rotates it (addPushTokenListener).
//   - Taps: a tap while the app is running (warm) and the tap that launched the app (cold
//     start, handled once) call onTap, which starts a voice session with trigger
//     'notification_tap'.
//   - The hook is meant to be mounted only for a paired device. discardStaleLaunchTap()
//     drops a launch tap that arrived while the device was unpaired.
//   - Unpairing: deleteOwnPushTokens() removes this user's push_tokens rows before the
//     session is signed out. The upsert uses onConflict 'token' and RLS blocks updating a row
//     owned by another (earlier anonymous) user, so without this a re-paired device could
//     never re-register its unchanged APNs token.
//   - Known limitation: when the session is lost for good (a definitive refresh-token
//     failure) there is no session left to delete with, so the old rows stay and the
//     re-paired device's upsert is rejected by RLS (logged as "token owned by a previous
//     device session"). The future push sender should drop tokens that APNs reports invalid,
//     or a server-side cleanup should handle it.
//
// Notification payload contract (the push sender must follow it):
//   data: { "task_instance_id": "<uuid of the task_instances row that prompted the push>" }
//   task_instance_id is optional. When it is a string it is forwarded to the livekit-token
//   function as taskInstanceId so the agent opens the conversation in the context of that
//   task.
//
// Last modified: 2026-10-28

import * as Notifications from 'expo-notifications';
import { useEffect, useRef } from 'react';

import { supabase } from '../backend/supabase';
import { errorMessage } from '../errors';
import { logger } from '../logging/logger';

/** Delay before asking for notification permission after mounting, in milliseconds. */
const PERMISSION_DELAY_MS = 1000;

/** What a tapped notification asks the voice layer to do. */
export interface NotificationTap {
  taskInstanceId?: string;
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
  return typeof value === 'string' && value !== '' ? { taskInstanceId: value } : {};
}

/**
 * purpose: Delete the signed-in user's own push_tokens rows (RLS allows a user to delete rows
 *          with their own user_id). Called before signing out on unpair. Never throws.
 * @return: (Promise<void>) resolves when done; failures are logged
 */
export async function deleteOwnPushTokens(): Promise<void> {
  try {
    const { data } = await supabase.auth.getSession();
    const userId = data.session?.user.id;
    if (!userId) return;
    const { error } = await supabase.from('push_tokens').delete().eq('user_id', userId);
    if (error) logger.warning('Push', `Failed to delete push tokens: ${error.message}`);
  } catch (e) {
    logger.warning('Push', `Failed to delete push tokens: ${errorMessage(e)}`);
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
 * purpose: Store an APNs device token for the signed-in user in push_tokens.
 * @param token: (string) the raw APNs device token
 * @return: (Promise<void>) resolves when stored; failures are logged, not thrown
 */
async function upsertPushToken(token: string): Promise<void> {
  const { data } = await supabase.auth.getSession();
  const userId = data.session?.user.id;
  if (!userId) {
    logger.warning('Push', 'No signed-in user; push token not stored');
    return;
  }
  const { error } = await supabase
    .from('push_tokens')
    .upsert({ user_id: userId, token }, { onConflict: 'token' });
  if (!error) {
    logger.info('Push', 'Push token stored');
  } else if (error.code === '42501' || /row-level security/i.test(error.message)) {
    logger.error('Push', 'Push token not stored: token owned by a previous device session');
  } else {
    logger.error('Push', `Failed to store push token: ${error.message}`);
  }
}

/**
 * purpose: Ask for notification permission, then read and store the APNs token.
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
  if (typeof deviceToken.data === 'string') await upsertPushToken(deviceToken.data);
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
      if (typeof token.data === 'string') void upsertPushToken(token.data);
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
