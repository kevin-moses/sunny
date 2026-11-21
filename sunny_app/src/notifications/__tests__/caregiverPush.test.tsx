import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { getFunctionName } from 'convex/server';
import type * as NotificationsTypes from 'expo-notifications';
import React from 'react';
import { Alert, AppState } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { callMutation } from '../../backend/api';
import type { HouseholdId } from '../../backend/convexApi';
import { CaregiverApp } from '../../caregiver/CaregiverApp';
import { CaregiverTabBar } from '../../caregiver/CaregiverTabBar';
import { CaregiverOnboardingScreen } from '../../screens/CaregiverOnboardingScreen';
import { SignedOutFlow } from '../../screens/SignedOutFlow';
import { CLAIM_ACTION, routeCaregiverResponse } from '../caregiverPush';

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

jest.mock('expo-audio', () => ({ setAudioModeAsync: () => Promise.resolve() }));
jest.mock('expo-speech', () => ({ speak: jest.fn(), stop: jest.fn() }));

jest.mock('@clerk/expo/legacy', () => ({
  useSignIn: () => ({ isLoaded: false }),
  useSignUp: () => ({ isLoaded: false }),
}));

jest.mock('../../backend/pairing', () => ({ pair: jest.fn() }));

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

let responseListener: ((r: NotificationsTypes.NotificationResponse) => void) | null = null;
let tokenListener: ((t: { data: unknown }) => void) | null = null;
let nextId = 0;
let lastResponse: NotificationsTypes.NotificationResponse | null = null;

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

const ALERT = {
  notification_id: 'out1',
  kind: 'caregiver_alert',
  household_id: HOUSEHOLD,
  task_instance_id: 'inst_1',
};

function calledMutations(): string[] {
  return mockCall.mock.calls.map((c) => getFunctionName(c[0] as never));
}

async function flush(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  });
}

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

const mounted: ReactTestRenderer[] = [];

function activeTab(renderer: ReactTestRenderer): string {
  return renderer.root.findByType(CaregiverTabBar).props.active as string;
}

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
  lastResponse = null;
  mockNotifications.getLastNotificationResponse.mockImplementation(() => lastResponse);
  mockNotifications.clearLastNotificationResponse.mockImplementation(() => {
    lastResponse = null;
  });
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

  it('a caregiver without a household is not asked, and a stale tap is discarded', async () => {
    lastResponse = response(CLAIM_ACTION, ALERT);
    await act(async () => {
      mounted.push(create(<CaregiverOnboardingScreen />));
    });
    await flush();
    expect(lastResponse).toBeNull();
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

  it('a mail escalation or mail update tap opens Chat', async () => {
    const renderer = await renderApp();
    for (const kind of ['mail_escalation', 'mail_update']) {
      await tap(response(DEFAULT_ACTION, { kind: 'agent_flag', household_id: HOUSEHOLD }));
      expect(activeTab(renderer)).toBe('home');
      await tap(response(DEFAULT_ACTION, { kind, household_id: HOUSEHOLD }));
      expect(activeTab(renderer)).toBe('chat');
    }
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
    lastResponse = launch;
    const renderer = await renderApp();
    expect(calledMutations()).toContain('instances:claimTaskInstance');
    expect(mockNotifications.clearLastNotificationResponse).toHaveBeenCalled();
    expect(activeTab(renderer)).toBe('home');
    await tap(launch);
    expect(calledMutations().filter((n) => n === 'instances:claimTaskInstance')).toHaveLength(1);
  });

  it('a cold start from a digest opens Chat', async () => {
    lastResponse = response(DEFAULT_ACTION, { kind: 'digest', household_id: HOUSEHOLD });
    const renderer = await renderApp();
    expect(activeTab(renderer)).toBe('chat');
  });

  it('a claim call that fails shows a short alert and Home', async () => {
    const alertSpy = jest.spyOn(Alert, 'alert');
    mockCall.mockImplementation(async (ref) =>
      getFunctionName(ref as never) === 'instances:claimTaskInstance'
        ? Promise.reject(new Error('offline'))
        : null,
    );
    const renderer = await renderApp();
    await tap(response(CLAIM_ACTION, ALERT));
    expect(calledMutations()).toContain('instances:claimTaskInstance');
    expect(alertSpy).toHaveBeenCalledTimes(1);
    expect(alertSpy).toHaveBeenCalledWith('Could not claim it', "Open Home and tap I'm on it.");
    expect(activeTab(renderer)).toBe('home');
  });

  it('someone else already on it, or the task done, shows nothing', async () => {
    const alertSpy = jest.spyOn(Alert, 'alert');
    for (const instance of [
      { _id: 'inst_1', state: 'escalated', claimedBy: 'user_max' },
      { _id: 'inst_1', state: 'resolved' },
    ]) {
      mockCall.mockImplementation(async (ref) =>
        getFunctionName(ref as never) === 'instances:claimTaskInstance' ? instance : null,
      );
      const renderer = await renderApp();
      await tap(response(CLAIM_ACTION, ALERT));
      expect(activeTab(renderer)).toBe('home');
    }
    expect(alertSpy).not.toHaveBeenCalled();
  });

  it('a tap made while signed out is discarded and never claims after sign-in', async () => {
    lastResponse = response(CLAIM_ACTION, ALERT);
    let signedOut: ReactTestRenderer | undefined;
    await act(async () => {
      signedOut = create(<SignedOutFlow />);
    });
    const later = response(CLAIM_ACTION, ALERT);
    await act(async () => {
      lastResponse = later;
      responseListener?.(later);
    });
    await act(async () => signedOut!.unmount());
    expect(lastResponse).toBeNull();
    await renderApp();
    expect(calledMutations()).not.toContain('instances:claimTaskInstance');
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
