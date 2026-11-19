import * as Notifications from 'expo-notifications';
import { useEffect, useRef } from 'react';
import { Alert, AppState } from 'react-native';

import { callMutation } from '../backend/api';
import { api, type HouseholdId, type TaskInstanceId } from '../backend/convexApi';
import { errorMessage } from '../errors';
import { logger } from '../logging/logger';
import { registerPushToken, unregisterStoredPushToken } from './push';
import type { CAREGIVER_ALERT_CATEGORY as BACKEND_CAREGIVER_ALERT_CATEGORY } from '../../../sunny_backend/convex/lib/apnsPayload';

export const CAREGIVER_ALERT_CATEGORY: typeof BACKEND_CAREGIVER_ALERT_CATEGORY = 'caregiver_alert';

export const CLAIM_FAILED_TITLE = 'Could not claim it';

export const CLAIM_FAILED_MESSAGE = "Open Home and tap I'm on it.";

export const CLAIM_ACTION = 'claim';

export type PushTab = 'home' | 'chat';

const CHAT_PUSH_KINDS: ReadonlySet<string> = new Set(['digest', 'mail_escalation', 'mail_update']);

export interface CaregiverPushRoute {
  tab: PushTab;
  claimInstanceId: TaskInstanceId | null;
}

function dataString(data: Record<string, unknown> | null | undefined, key: string): string | null {
  const value = data?.[key];
  return typeof value === 'string' && value !== '' ? value : null;
}

export function routeCaregiverResponse(
  response: Notifications.NotificationResponse,
  householdId: HouseholdId,
  canClaim: boolean,
): CaregiverPushRoute | null {
  const data = response.notification.request.content.data as Record<string, unknown> | undefined;
  if (response.actionIdentifier === CLAIM_ACTION) {
    const instance = dataString(data, 'task_instance_id');
    const sameHousehold = dataString(data, 'household_id') === householdId;
    const claim = canClaim && sameHousehold && instance !== null;
    return { tab: 'home', claimInstanceId: claim ? (instance as TaskInstanceId) : null };
  }
  if (response.actionIdentifier !== Notifications.DEFAULT_ACTION_IDENTIFIER) return null;
  const kind = dataString(data, 'kind');
  const tab: PushTab = kind !== null && CHAT_PUSH_KINDS.has(kind) ? 'chat' : 'home';
  return { tab, claimInstanceId: null };
}

export async function registerCaregiverCategory(): Promise<void> {
  try {
    await Notifications.setNotificationCategoryAsync(CAREGIVER_ALERT_CATEGORY, [
      {
        identifier: CLAIM_ACTION,
        buttonTitle: "I'm on it",
        options: { opensAppToForeground: true },
      },
    ]);
  } catch (e) {
    logger.warning('Push', `Could not register the alert actions: ${errorMessage(e)}`);
  }
}

export async function registerCaregiverForPush(): Promise<void> {
  try {
    let permission = await Notifications.getPermissionsAsync();
    if (!permission.granted && permission.status === 'undetermined') {
      permission = await Notifications.requestPermissionsAsync({
        ios: { allowAlert: true, allowSound: true, allowBadge: true },
      });
    }
    if (!permission.granted) {
      logger.info('Push', 'Notification permission not granted; texts continue');
      await unregisterStoredPushToken();
      return;
    }
    const deviceToken = await Notifications.getDevicePushTokenAsync();
    if (typeof deviceToken.data === 'string') await registerPushToken(deviceToken.data);
  } catch (e) {
    logger.error('Push', `Caregiver push registration failed: ${errorMessage(e)}`);
  }
}

const handledResponses = new Set<string>();

function firstTime(response: Notifications.NotificationResponse): boolean {
  const key = `${response.notification.request.identifier}|${response.actionIdentifier}`;
  if (handledResponses.has(key)) return false;
  handledResponses.add(key);
  return true;
}

async function claimFromPush(instanceId: TaskInstanceId): Promise<void> {
  try {
    await callMutation(api.instances.claimTaskInstance, { instanceId });
  } catch (e) {
    logger.warning('Push', `Claim from a notification failed: ${errorMessage(e)}`);
    Alert.alert(CLAIM_FAILED_TITLE, CLAIM_FAILED_MESSAGE);
  }
}

export function useCaregiverPush(
  householdId: HouseholdId,
  canClaim: boolean,
  onOpenTab: (tab: PushTab) => void,
): void {
  const onOpenTabRef = useRef(onOpenTab);

  useEffect(() => {
    onOpenTabRef.current = onOpenTab;
  }, [onOpenTab]);

  useEffect(() => {
    void registerCaregiverCategory().then(registerCaregiverForPush);
    const subscription = Notifications.addPushTokenListener((token) => {
      if (typeof token.data === 'string') void registerPushToken(token.data);
    });
    const appState = AppState.addEventListener('change', (state) => {
      if (state === 'active') void registerCaregiverForPush();
    });
    return () => {
      subscription.remove();
      appState.remove();
    };
  }, []);

  useEffect(() => {
    const handle = (response: Notifications.NotificationResponse): void => {
      if (!firstTime(response)) return;
      Notifications.clearLastNotificationResponse();
      const route = routeCaregiverResponse(response, householdId, canClaim);
      if (route === null) return;
      onOpenTabRef.current(route.tab);
      if (route.claimInstanceId !== null) void claimFromPush(route.claimInstanceId);
    };
    const launch = Notifications.getLastNotificationResponse();
    if (launch) handle(launch);
    const subscription = Notifications.addNotificationResponseReceivedListener(handle);
    return () => subscription.remove();
  }, [householdId, canClaim]);
}

export async function signOutCaregiver(signOut: () => Promise<unknown>): Promise<void> {
  await unregisterStoredPushToken();
  await signOut();
}
