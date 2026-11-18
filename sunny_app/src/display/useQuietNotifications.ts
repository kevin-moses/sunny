import * as Notifications from 'expo-notifications';
import { useEffect } from 'react';

import { DEFAULT_NOTIFICATION_HANDLER } from '../notifications/push';

export const QUIET_NOTIFICATION_HANDLER: Notifications.NotificationHandler = {
  handleNotification: async () => ({
    shouldShowBanner: false,
    shouldShowList: true,
    shouldPlaySound: false,
    shouldSetBadge: false,
  }),
};

export function useQuietNotifications(): void {
  useEffect(() => {
    Notifications.setNotificationHandler(QUIET_NOTIFICATION_HANDLER);
    return () => Notifications.setNotificationHandler(DEFAULT_NOTIFICATION_HANDLER);
  }, []);
}
