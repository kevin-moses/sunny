// sunny_app/src/notifications/__tests__/caregiverPush.test.tsx
//
// Purpose: Tests for caregiver push (caregiverPush.ts) through the real CaregiverApp, rendered
// with react-test-renderer. Only the boundaries are mocked: expo-notifications (the native
// module), the network (callMutation, the Convex query hook and connection state), Clerk's
// useAuth, AsyncStorage, and the native symbol and safe-area views. Covers: the "I'm on it"
// category registered with a foreground action; permission asked only while undetermined, the
// APNs token registered when granted and again when the OS rotates it; nothing registered and no
// error when permission is denied; notifications turned off in Settings unregister the token
// when the app returns to the foreground (and turned on again re-register it); no permission prompt on onboarding (no household yet); a
// digest tap opening Chat, an alert's body and other kinds opening Home; "I'm on it" claiming
// the push's task and showing Home, also on a cold start (the launch tap, read once and
// cleared); a failed claim showing no error; no claim for a viewer, another household or a
// dismiss; a response handled once even when seen twice; and sign-out unregistering the token
// before Clerk's session ends. Plus routeCaregiverResponse as a pure function.
//
// Last modified: 2026-11-14

import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { getFunctionName } from 'convex/server';
import type * as NotificationsTypes from 'expo-notifications';
import React from 'react';
import { Alert, AppState, Text } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { callMutation } from '../../backend/api';
import type { HouseholdId } from '../../backend/convexApi';
import { CaregiverApp } from '../../caregiver/CaregiverApp';
import { CaregiverTabBar } from '../../caregiver/CaregiverTabBar';
import { CaregiverOnboardingScreen } from '../../screens/CaregiverOnboardingScreen';
import { CLAIM_ACTION, routeCaregiverResponse } from '../caregiverPush';

/** expo-notifications' identifier for a tap on the notification body. */
const DEFAULT_ACTION = 'expo.modules.notifications.actions.DEFAULT';

jest.mock('expo-notifications', () => ({
  setNotificationHandler: jest.fn(),
  setNotificationCategoryAsync: jest.fn(),
  getPermissionsAsync: jest.fn(),
  requestPermissionsAsync: jest.fn(),
  getDevicePushTokenAsync: jest.fn(),
  addPushTokenListener: jest.fn(),
  getLastNotificationResponse: jest.fn(),
  clearLastNotificationResponse: jest.fn(),
  addNotificationResponseReceivedListener: jest.fn(),
  DEFAULT_ACTION_IDENTIFIER: 'expo.modules.notifications.actions.DEFAULT',
}));

/** The mocked native module, typed for the calls the tests script. */
const mockNotifications = jest.requireMock('expo-notifications') as {
  setNotificationCategoryAsync: jest.Mock<(...a: unknown[]) => Promise<unknown>>;
  getPermissionsAsync: jest.Mock<() => Promise<unknown>>;
  requestPermissionsAsync: jest.Mock<(...a: unknown[]) => Promise<unknown>>;
  getDevicePushTokenAsync: jest.Mock<() => Promise<unknown>>;
  addPushTokenListener: jest.Mock<(l: (t: { data: unknown }) => void) => { remove: () => void }>;
  getLastNotificationResponse: jest.Mock<() => unknown>;
  clearLastNotificationResponse: jest.Mock<() => void>;
  addNotificationResponseReceivedListener: jest.Mock<
    (l: (r: NotificationsTypes.NotificationResponse) => void) => { remove: () => void }
  >;
};

const mockStore = new Map<string, string>();
jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem: async (key: string) => mockStore.get(key) ?? null,
    setItem: async (key: string, value: string) => void mockStore.set(key, value),
    removeItem: async (key: string) => void mockStore.delete(key),
  },
}));

const mockSignOut = jest.fn<() => Promise<unknown>>();
jest.mock('@clerk/expo', () => ({
  useAuth: () => ({ signOut: mockSignOut, userId: 'user_pat' }),
}));

jest.mock('convex/react', () => ({
  useConvexConnectionState: () => ({ isWebSocketConnected: true, hasEverConnected: true }),
}));

jest.mock('../../backend/convex', () => ({
  convex: {},
  useQueryWithStatus: () => ({ status: 'pending', data: undefined, error: undefined }),
}));

jest.mock('../../backend/api', () => ({
  ...jest.requireActual<typeof import('../../backend/api')>('../../backend/api'),
  callMutation: jest.fn(),
}));

jest.mock('../../logging/logger', () => ({
  logger: { debug: jest.fn(), info: jest.fn(), warning: jest.fn(), error: jest.fn() },
}));

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

jest.mock('expo-symbols', () => ({ SymbolView: () => null }));

jest.mock('../../theme/ThemeProvider', () => ({
  useTheme: () => ({
    accentColor: '#FA8539',
    cornerRadius: 12,
    buttonFontSize: 20,
    bodyFontSize: 17,
  }),
}));

const mockCall = callMutation as unknown as jest.Mock<(...a: unknown[]) => Promise<unknown>>;

const HOUSEHOLD = 'household_1' as HouseholdId;
const TOKEN = 'a'.repeat(64);

/** The listener the app registered for notification responses (the warm path). */
let responseListener: ((r: NotificationsTypes.NotificationResponse) => void) | null = null;
/** The listener the app registered for token rotations. */
let tokenListener: ((t: { data: unknown }) => void) | null = null;
/** A fresh notification identifier per response, since handled responses are remembered. */
let nextId = 0;

/**
 * purpose: Build a notification response as expo-notifications delivers it.
 * @param action: (string) The action identifier (DEFAULT_ACTION for a tap on the body).
 * @param data: (Record<string, unknown>) The push's custom keys.
 * @return: (NotificationsTypes.NotificationResponse) The response.
 */
function response(
  action: string,
  data: Record<string, unknown>,
): NotificationsTypes.NotificationResponse {
  nextId += 1;
  return {
    actionIdentifier: action,
    notification: { request: { identifier: `n${nextId}`, content: { data } } },
  } as unknown as NotificationsTypes.NotificationResponse;
}

/** An escalation alert's data for this household. */
const ALERT = {
  notification_id: 'out1',
  kind: 'caregiver_alert',
  household_id: HOUSEHOLD,
  task_instance_id: 'inst_1',
};

/**
 * purpose: The function names of every mutation the app called, in order.
 * @return: (string[]) For example ["households:registerPushToken"].
 */
function calledMutations(): string[] {
  return mockCall.mock.calls.map((c) => getFunctionName(c[0] as never));
}

/**
 * purpose: Let pending promises (permission, token, mutation) settle inside act.
 * @return: (Promise<void>) Resolves after the microtasks ran.
 */
async function flush(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  });
}

/**
 * purpose: Render the caregiver app and let its startup work settle.
 * @param role: ('primary' | 'member' | 'viewer') The caregiver's role.
 * @return: (Promise<ReactTestRenderer>) The renderer.
 */
async function renderApp(
  role: 'primary' | 'member' | 'viewer' = 'member',
): Promise<ReactTestRenderer> {
  let renderer: ReactTestRenderer | undefined;
  await act(async () => {
    renderer = create(<CaregiverApp householdId={HOUSEHOLD} role={role} />);
  });
  mounted.push(renderer!);
  await flush();
  return renderer!;
}

/** Renderers to unmount after each test, so the day view's minute timer stops. */
const mounted: ReactTestRenderer[] = [];

/**
 * purpose: The tab the caregiver app shows.
 * @param renderer: (ReactTestRenderer) The rendered app.
 * @return: (string) home, chat or about.
 */
function activeTab(renderer: ReactTestRenderer): string {
  return renderer.root.findByType(CaregiverTabBar).props.active as string;
}

/**
 * purpose: Deliver a response through the app's listener (a tap while the app runs).
 * @param r: (NotificationsTypes.NotificationResponse) The response.
 * @return: (Promise<void>) Resolves when handled.
 */
async function tap(r: NotificationsTypes.NotificationResponse): Promise<void> {
  await act(async () => {
    responseListener?.(r);
  });
  await flush();
}

beforeEach(() => {
  jest.clearAllMocks();
  mockStore.clear();
  responseListener = null;
  tokenListener = null;
  mockCall.mockResolvedValue(null);
  mockSignOut.mockResolvedValue(undefined);
  mockNotifications.setNotificationCategoryAsync.mockResolvedValue(null);
  mockNotifications.getPermissionsAsync.mockResolvedValue({
    granted: false,
    status: 'undetermined',
  });
  mockNotifications.requestPermissionsAsync.mockResolvedValue({ granted: true, status: 'granted' });
  mockNotifications.getDevicePushTokenAsync.mockResolvedValue({ type: 'ios', data: TOKEN });
  mockNotifications.getLastNotificationResponse.mockReturnValue(null);
  mockNotifications.addPushTokenListener.mockImplementation((listener) => {
    tokenListener = listener;
    return { remove: () => undefined };
  });
  mockNotifications.addNotificationResponseReceivedListener.mockImplementation((listener) => {
    responseListener = listener;
    return { remove: () => undefined };
  });
});

afterEach(async () => {
  await act(async () => {
    for (const renderer of mounted.splice(0)) renderer.unmount();
  });
  jest.restoreAllMocks();
});

describe('registration', () => {
  it('registers the alert category with one foreground "I\'m on it" action', async () => {
    await renderApp();
    expect(mockNotifications.setNotificationCategoryAsync).toHaveBeenCalledWith('caregiver_alert', [
      {
        identifier: CLAIM_ACTION,
        buttonTitle: "I'm on it",
        options: { opensAppToForeground: true },
      },
    ]);
  });

  it('asks once while undetermined, then registers the token', async () => {
    await renderApp();
    expect(mockNotifications.requestPermissionsAsync).toHaveBeenCalledTimes(1);
    expect(calledMutations()).toEqual(['households:registerPushToken']);
    expect(mockCall.mock.calls[0]![1]).toEqual({ token: TOKEN });
    expect(mockStore.get('sunny.pushToken')).toBe(TOKEN);
  });

  it('does not ask again once granted, and still registers', async () => {
    mockNotifications.getPermissionsAsync.mockResolvedValue({ granted: true, status: 'granted' });
    await renderApp();
    expect(mockNotifications.requestPermissionsAsync).not.toHaveBeenCalled();
    expect(calledMutations()).toEqual(['households:registerPushToken']);
  });

  it('after a refusal asks nothing, registers nothing and shows no error', async () => {
    mockNotifications.getPermissionsAsync.mockResolvedValue({ granted: false, status: 'denied' });
    const renderer = await renderApp();
    expect(mockNotifications.requestPermissionsAsync).not.toHaveBeenCalled();
    expect(mockNotifications.getDevicePushTokenAsync).not.toHaveBeenCalled();
    expect(mockCall).not.toHaveBeenCalled();
    expect(activeTab(renderer)).toBe('home');
  });

  it('notifications turned off in Settings unregister the token on return; on again re-register', async () => {
    let onAppState: ((state: string) => void) | null = null;
    jest.spyOn(AppState, 'addEventListener').mockImplementation((_type, listener) => {
      onAppState = listener as (state: string) => void;
      return { remove: () => undefined } as ReturnType<typeof AppState.addEventListener>;
    });
    await renderApp();
    expect(mockStore.get('sunny.pushToken')).toBe(TOKEN);
    mockNotifications.getPermissionsAsync.mockResolvedValue({ granted: false, status: 'denied' });
    await act(async () => onAppState?.('active'));
    await flush();
    expect(calledMutations()).toEqual([
      'households:registerPushToken',
      'households:unregisterPushToken',
    ]);
    expect(mockStore.has('sunny.pushToken')).toBe(false);
    expect(mockNotifications.requestPermissionsAsync).toHaveBeenCalledTimes(1);
    mockNotifications.getPermissionsAsync.mockResolvedValue({ granted: true, status: 'granted' });
    await act(async () => onAppState?.('active'));
    await flush();
    expect(calledMutations().at(-1)).toBe('households:registerPushToken');
    expect(mockStore.get('sunny.pushToken')).toBe(TOKEN);
  });

  it('registers the new token when the OS rotates it and unregisters the old one', async () => {
    await renderApp();
    const rotated = 'b'.repeat(64);
    await act(async () => {
      tokenListener?.({ data: rotated });
    });
    await flush();
    expect(calledMutations()).toEqual([
      'households:registerPushToken',
      'households:registerPushToken',
      'households:unregisterPushToken',
    ]);
    expect(mockCall.mock.calls[1]![1]).toEqual({ token: rotated });
    expect(mockCall.mock.calls[2]![1]).toEqual({ token: TOKEN });
  });

  it('a caregiver without a household is not asked for permission', async () => {
    await act(async () => {
      mounted.push(create(<CaregiverOnboardingScreen />));
    });
    await flush();
    expect(mockNotifications.getPermissionsAsync).not.toHaveBeenCalled();
    expect(mockNotifications.requestPermissionsAsync).not.toHaveBeenCalled();
    expect(mockCall).not.toHaveBeenCalled();
  });
});

describe('taps', () => {
  it('a digest tap opens Chat', async () => {
    const renderer = await renderApp();
    await tap(response(DEFAULT_ACTION, { kind: 'digest', household_id: HOUSEHOLD }));
    expect(activeTab(renderer)).toBe('chat');
    expect(mockNotifications.clearLastNotificationResponse).toHaveBeenCalled();
  });

  it("an alert's body opens Home and claims nothing", async () => {
    const renderer = await renderApp();
    await tap(response(DEFAULT_ACTION, { kind: 'digest', household_id: HOUSEHOLD }));
    mockCall.mockClear();
    await tap(response(DEFAULT_ACTION, ALERT));
    expect(activeTab(renderer)).toBe('home');
    expect(mockCall).not.toHaveBeenCalled();
  });

  it('other kinds open Home', async () => {
    const renderer = await renderApp();
    for (const kind of ['agent_flag', 'event_notice', 'family_message']) {
      await tap(response(DEFAULT_ACTION, { kind: 'digest', household_id: HOUSEHOLD }));
      await tap(response(DEFAULT_ACTION, { kind, household_id: HOUSEHOLD }));
      expect(activeTab(renderer)).toBe('home');
    }
  });

  it('"I\'m on it" claims the task and shows Home', async () => {
    const renderer = await renderApp();
    await tap(response(DEFAULT_ACTION, { kind: 'digest', household_id: HOUSEHOLD }));
    mockCall.mockClear();
    await tap(response(CLAIM_ACTION, ALERT));
    expect(calledMutations()).toEqual(['instances:claimTaskInstance']);
    expect(mockCall.mock.calls[0]![1]).toEqual({ instanceId: 'inst_1' });
    expect(activeTab(renderer)).toBe('home');
  });

  it('a cold start from "I\'m on it" claims once and clears the launch response', async () => {
    const launch = response(CLAIM_ACTION, ALERT);
    mockNotifications.getLastNotificationResponse.mockReturnValue(launch);
    const renderer = await renderApp();
    expect(calledMutations()).toContain('instances:claimTaskInstance');
    expect(mockNotifications.clearLastNotificationResponse).toHaveBeenCalled();
    expect(activeTab(renderer)).toBe('home');
    // The same response arriving again through the listener is not handled twice.
    await tap(launch);
    expect(calledMutations().filter((n) => n === 'instances:claimTaskInstance')).toHaveLength(1);
  });

  it('a cold start from a digest opens Chat', async () => {
    mockNotifications.getLastNotificationResponse.mockReturnValue(
      response(DEFAULT_ACTION, { kind: 'digest', household_id: HOUSEHOLD }),
    );
    const renderer = await renderApp();
    expect(activeTab(renderer)).toBe('chat');
  });

  it('a claim that fails shows no error', async () => {
    const alertSpy = jest.spyOn(Alert, 'alert');
    mockCall.mockImplementation(async (ref) =>
      getFunctionName(ref as never) === 'instances:claimTaskInstance'
        ? Promise.reject(new Error('forbidden'))
        : null,
    );
    const renderer = await renderApp();
    await tap(response(CLAIM_ACTION, ALERT));
    expect(calledMutations()).toContain('instances:claimTaskInstance');
    expect(alertSpy).not.toHaveBeenCalled();
    const texts = renderer.root.findAllByType(Text).map((t) => String(t.props.children));
    expect(texts.some((t) => /forbidden|went wrong|could not/i.test(t))).toBe(false);
    expect(activeTab(renderer)).toBe('home');
  });

  it('a viewer\'s "I\'m on it" claims nothing', async () => {
    await renderApp('viewer');
    mockCall.mockClear();
    await tap(response(CLAIM_ACTION, ALERT));
    expect(mockCall).not.toHaveBeenCalled();
  });

  it('a dismiss changes nothing', async () => {
    const renderer = await renderApp();
    await tap(response(DEFAULT_ACTION, { kind: 'digest', household_id: HOUSEHOLD }));
    mockCall.mockClear();
    await tap(response('com.apple.UNNotificationDismissActionIdentifier', ALERT));
    expect(mockCall).not.toHaveBeenCalled();
    expect(activeTab(renderer)).toBe('chat');
  });
});

describe('sign-out', () => {
  it('unregisters the token before Clerk signs out', async () => {
    const alertSpy = jest.spyOn(Alert, 'alert');
    const renderer = await renderApp();
    const order: string[] = [];
    mockCall.mockImplementation(async (ref) => {
      order.push(getFunctionName(ref as never));
      return null;
    });
    mockSignOut.mockImplementation(async () => {
      order.push('signOut');
    });
    const account = renderer.root.findAll(
      (node) => node.props.accessibilityLabel === 'Account' && node.props.onPress !== undefined,
    )[0];
    await act(async () => {
      account!.props.onPress();
    });
    const buttons = alertSpy.mock.calls[0]![2] as { text: string; onPress?: () => void }[];
    await act(async () => {
      buttons.find((b) => b.text === 'Sign out')!.onPress!();
    });
    await flush();
    expect(order).toEqual(['households:unregisterPushToken', 'signOut']);
    expect(mockStore.has('sunny.pushToken')).toBe(false);
  });
});

describe('routeCaregiverResponse', () => {
  it('claims only a task of this household, and only for a caregiver who may claim', () => {
    expect(routeCaregiverResponse(response(CLAIM_ACTION, ALERT), HOUSEHOLD, true)).toEqual({
      tab: 'home',
      claimInstanceId: 'inst_1',
    });
    const other = { ...ALERT, household_id: 'household_2' };
    expect(routeCaregiverResponse(response(CLAIM_ACTION, other), HOUSEHOLD, true)).toEqual({
      tab: 'home',
      claimInstanceId: null,
    });
    expect(routeCaregiverResponse(response(CLAIM_ACTION, ALERT), HOUSEHOLD, false)).toEqual({
      tab: 'home',
      claimInstanceId: null,
    });
    const noTask = { ...ALERT, task_instance_id: undefined };
    expect(
      routeCaregiverResponse(response(CLAIM_ACTION, noTask), HOUSEHOLD, true)?.claimInstanceId,
    ).toBeNull();
  });

  it('routes a digest to Chat and everything else to Home; ignores other actions', () => {
    const route = (data: Record<string, unknown>, action = DEFAULT_ACTION) =>
      routeCaregiverResponse(response(action, data), HOUSEHOLD, true);
    expect(route({ kind: 'digest' })).toEqual({ tab: 'chat', claimInstanceId: null });
    expect(route(ALERT)).toEqual({ tab: 'home', claimInstanceId: null });
    expect(route({})).toEqual({ tab: 'home', claimInstanceId: null });
    expect(route(ALERT, 'something_else')).toBeNull();
  });
});
