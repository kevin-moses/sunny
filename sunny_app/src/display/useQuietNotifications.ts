// sunny_app/src/display/useQuietNotifications.ts
//
// Purpose: Keeps push notifications from covering or sounding over the home display. The
// backend sends every senior prompt to every paired device, the display included, and the
// app's default (notifications/push.ts) shows a banner with a sound while the app is open. On
// the display that would draw a colored iOS banner over the paper panel and play the system
// sound on top of the display's own due cue (useDueCue), which already covers the same prompt.
// While the display is mounted, notifications that arrive in the foreground are kept in the
// notification list only; when it unmounts, the app's default presentation is restored.
//
// Last modified: 2026-11-09

import * as Notifications from 'expo-notifications';
import { useEffect } from 'react';

/**
 * purpose: How a foreground notification is presented.
 * @param loud: (boolean) Show a banner and play the sound (the app's default), or neither.
 * @return: (Notifications.NotificationHandler) The handler for setNotificationHandler.
 */
function presentation(loud: boolean): Notifications.NotificationHandler {
  return {
    handleNotification: async () => ({
      shouldShowBanner: loud,
      shouldShowList: true,
      shouldPlaySound: loud,
      shouldSetBadge: false,
    }),
  };
}

/**
 * purpose: Silence foreground notification banners and sounds while the display is mounted.
 * @return: (void)
 */
export function useQuietNotifications(): void {
  useEffect(() => {
    Notifications.setNotificationHandler(presentation(false));
    // Restores the presentation push.ts sets for the phone (banner, list and sound).
    return () => Notifications.setNotificationHandler(presentation(true));
  }, []);
}
