// sunny_app/src/notifications/caregiverPush.ts
//
// Purpose: Push notifications for a signed-in caregiver who belongs to a household. The paired
// senior device has its own wiring (push.ts usePushNotifications, mounted by VoiceProvider, whose
// taps start a voice session); a caregiver's taps never start voice. This module reuses push.ts
// for the token itself (registerPushToken remembers the token and unregisters a rotated one;
// unregisterStoredPushToken forgets it) and adds:
//   - Registration (useCaregiverPush, mounted by CaregiverApp, so only once the caregiver has a
//     household, never on the sign-in screen): the "caregiver_alert" category with its one
//     action, "I'm on it", is registered; notification permission is asked for only while iOS
//     has not been asked yet (status undetermined), so the caregiver sees the prompt once; when
//     it is granted the APNs token is registered through households.registerPushToken, and again
//     whenever the OS rotates it. Denied permission changes nothing else: the backend keeps
//     texting a caregiver with no token. Each time the app comes back to the foreground the
//     permission is checked again: turned off in Settings, the remembered token is unregistered
//     (APNs would keep accepting pushes the phone never shows, so the backend would never fall
//     back to text); turned back on, the token is registered again.
//   - Taps (routeCaregiverResponse): "I'm on it" claims the push's task_instance_id
//     (instances.claimTaskInstance) and shows Home; tapping an alert's body shows Home; tapping
//     a digest shows Chat; any other kind shows Home; a dismiss does nothing. The action opens
//     the app in the foreground (opensAppToForeground), so the claim runs with the signed-in
//     Clerk session. A claim that finds someone else on it, or the task already done, is not
//     an error (the server returns the instance unchanged and Home shows who is on it); a claim
//     call that fails shows a short alert ("Could not claim it") so the caregiver claims from
//     Home instead. The tap that launched the app (cold start) is read once with
//     getLastNotificationResponse when the caregiver app mounts; every handled response is
//     cleared and remembered, so a remount does not handle it again. A response that arrived
//     while signed out never gets here: the signed-out and onboarding screens discard it
//     (push.ts useDiscardNotificationTaps). A claim is made only for the household on screen
//     and only by a caregiver who may claim (not a viewer).
//   - Sign-out (signOutCaregiver): the remembered token is unregistered (bounded by push.ts's
//     timeout) before the Clerk session ends, while the call can still authenticate.
//
// Notification payload contract (sunny_backend/convex/lib/delivery.ts): data carries
// notification_id, kind, household_id and, for a task, task_instance_id; a claimable caregiver
// alert has aps category "caregiver_alert".
//
// Last modified: 2026-11-14

import * as Notifications from 'expo-notifications';
import { useEffect, useRef } from 'react';
import { Alert, AppState } from 'react-native';

import { callMutation } from '../backend/api';
import { api, type HouseholdId, type TaskInstanceId } from '../backend/convexApi';
import { errorMessage } from '../errors';
import { logger } from '../logging/logger';
import { registerPushToken, unregisterStoredPushToken } from './push';
import type { CAREGIVER_ALERT_CATEGORY as BACKEND_CAREGIVER_ALERT_CATEGORY } from '../../../sunny_backend/convex/lib/apnsPayload';

/**
 * The category of a claimable caregiver alert. It must equal CAREGIVER_ALERT_CATEGORY in
 * sunny_backend/convex/lib/apnsPayload.ts, which the backend sets in aps (pushStyle).
 */
export const CAREGIVER_ALERT_CATEGORY: typeof BACKEND_CAREGIVER_ALERT_CATEGORY = 'caregiver_alert';

/** The alert title shown when the "I'm on it" claim call fails. */
export const CLAIM_FAILED_TITLE = 'Could not claim it';

/** The alert message shown when the "I'm on it" claim call fails. */
export const CLAIM_FAILED_MESSAGE = "Open Home and tap I'm on it.";

/** The identifier of the "I'm on it" action. */
export const CLAIM_ACTION = 'claim';

/** The caregiver tab a tapped notification opens. */
export type PushTab = 'home' | 'chat';

/** What a notification response asks the caregiver app to do. */
export interface CaregiverPushRoute {
  tab: PushTab;
  /** The task to claim ("I'm on it"); null for a plain tap. */
  claimInstanceId: TaskInstanceId | null;
}

/**
 * purpose: A string field of a notification's data, or null when absent or empty.
 * @param data: (Record<string, unknown> | null | undefined) The notification content data.
 * @param key: (string) The key.
 * @return: (string | null) The value.
 */
function dataString(data: Record<string, unknown> | null | undefined, key: string): string | null {
  const value = data?.[key];
  return typeof value === 'string' && value !== '' ? value : null;
}

/**
 * purpose: Decide what a notification response does in the caregiver app.
 * @param response: (Notifications.NotificationResponse) The tap or action.
 * @param householdId: (HouseholdId) The household on screen.
 * @param canClaim: (boolean) Whether this caregiver may claim tasks (not a viewer).
 * @return: (CaregiverPushRoute | null) The tab to show and the task to claim, or null for a
 *          response to ignore (a dismiss or an unknown action). "I'm on it" claims only a task of
 *          this household, and only for a caregiver who may claim.
 */
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
  const tab: PushTab = dataString(data, 'kind') === 'digest' ? 'chat' : 'home';
  return { tab, claimInstanceId: null };
}

/**
 * purpose: Register the caregiver alert category and its one action, "I'm on it", which opens
 *          the app in the foreground.
 * @return: (Promise<void>) Resolves when registered; a failure is logged, not thrown.
 */
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

/**
 * purpose: Bring this phone's push registration in line with notification permission: ask
 *          while iOS has not been asked yet, register the APNs token when permission is granted,
 *          and unregister a remembered token when it is not (notifications turned off in
 *          Settings), so the backend goes back to texting this caregiver instead of pushing to a
 *          phone that would not show it. A caregiver who declined is not asked again.
 * @return: (Promise<void>) Resolves when done; failures are logged, not thrown.
 */
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

/** Responses already handled in this app run, by notification and action. */
const handledResponses = new Set<string>();

/**
 * purpose: Mark a response handled, so neither the launch read nor the listener nor a remount
 *          handles it twice.
 * @param response: (Notifications.NotificationResponse) The response.
 * @return: (boolean) True when it was not handled before.
 */
function firstTime(response: Notifications.NotificationResponse): boolean {
  const key = `${response.notification.request.identifier}|${response.actionIdentifier}`;
  if (handledResponses.has(key)) return false;
  handledResponses.add(key);
  return true;
}

/**
 * purpose: Claim a task for the signed-in caregiver. Someone else already on it, or the task
 *          already done, is not a failure (the server leaves the instance as it is and Home
 *          shows who is on it). A call that fails is logged and shown as a short alert, so
 *          "I'm on it" never fails silently.
 * @param instanceId: (TaskInstanceId) The task instance.
 * @return: (Promise<void>) Resolves when the call settles; never rejects.
 */
async function claimFromPush(instanceId: TaskInstanceId): Promise<void> {
  try {
    await callMutation(api.instances.claimTaskInstance, { instanceId });
  } catch (e) {
    logger.warning('Push', `Claim from a notification failed: ${errorMessage(e)}`);
    Alert.alert(CLAIM_FAILED_TITLE, CLAIM_FAILED_MESSAGE);
  }
}

/**
 * purpose: Wire push for the caregiver app: the alert category, permission and token
 *          registration (and re-registration on rotation), and taps, including the tap that
 *          launched the app. onOpenTab is read through a ref, so the latest callback is used
 *          without re-subscribing.
 * @param householdId: (HouseholdId) The caregiver's household.
 * @param canClaim: (boolean) Whether the caregiver may claim tasks (not a viewer).
 * @param onOpenTab: ((tab: PushTab) => void) Shows a tab of the caregiver app.
 * @return: (void)
 */
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
    // Permission can change in Settings while the app is away; re-check on each return.
    const appState = AppState.addEventListener('change', (state) => {
      if (state === 'active') void registerCaregiverForPush();
    });
    return () => {
      subscription.remove();
      appState.remove();
    };
  }, []);

  useEffect(() => {
    /**
     * purpose: Act on one response once: clear it as the last response, show its tab and
     *          claim its task when asked.
     * @param response: (Notifications.NotificationResponse) The response.
     * @return: (void)
     */
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

/**
 * purpose: Sign a caregiver out: unregister this phone's push token first (bounded, never
 *          throws), while the Clerk session can still authenticate the call, then end the
 *          session.
 * @param signOut: (() => Promise<unknown>) Clerk's signOut.
 * @return: (Promise<void>) Resolves when signed out.
 * @raises: Whatever signOut throws.
 */
export async function signOutCaregiver(signOut: () => Promise<unknown>): Promise<void> {
  await unregisterStoredPushToken();
  await signOut();
}
