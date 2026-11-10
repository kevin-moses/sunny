// sunny_app/src/display/useQuietNotifications.ts
//
// Purpose: Keeps push notifications from covering or sounding over the home display. The
// backend sends every senior prompt to every paired device, the display included, and the
// app's default (notifications/push.ts) shows a banner with a sound while the app is open. On
// the display that would draw a colored iOS banner over the paper panel and play the system
// sound on top of the display's own due cue (useDueCue), which already covers the same prompt.
// While the display is mounted, notifications that arrive in the foreground are kept in the
// notification list only; when it unmounts, push.ts's DEFAULT_NOTIFICATION_HANDLER is
// restored, so the two cannot drift apart.
//
// Last modified: 2026-11-09

import * as Notifications from 'expo-notifications';
import { useEffect } from 'react';

import { DEFAULT_NOTIFICATION_HANDLER } from '../notifications/push';

/** Foreground presentation on the display: in the list only, no banner, no sound. */
export const QUIET_NOTIFICATION_HANDLER: Notifications.NotificationHandler = {
  handleNotification: async () => ({
    shouldShowBanner: false,
    shouldShowList: true,
    shouldPlaySound: false,
    shouldSetBadge: false,
  }),
};

/**
 * purpose: Silence foreground notification banners and sounds while the display is mounted.
 * @return: (void)
 */
export function useQuietNotifications(): void {
  useEffect(() => {
    Notifications.setNotificationHandler(QUIET_NOTIFICATION_HANDLER);
    return () => Notifications.setNotificationHandler(DEFAULT_NOTIFICATION_HANDLER);
  }, []);
}
