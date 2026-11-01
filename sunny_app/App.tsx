// sunny_app/App.tsx
//
// Purpose: Root of the Sunny app. Without a Clerk publishable key it shows a configuration
// error screen. Otherwise it wraps the app in ClerkProvider (session in the Keychain via
// Clerk's token cache) and ConvexProviderWithClerk (one client, Clerk "convex" JWT template),
// then follows useSession: a calm "Connecting..." view (with a one-line notice when the backend
// cannot be reached) while Clerk, Convex auth and the household queries load and while a removed
// device is being unpaired. Signed out shows WelcomeScreen, which leads to the caregiver email
// code sign-in (CaregiverSignInScreen) or to PairingScreen for a senior's device. A paired
// senior device gets the paired home: TodayScreen on the senior phone or DisplayScreen on the
// home display, or ConversationScreen while a voice conversation is live; the paired home is
// keyed by household and owns the day view so it survives a conversation. A signed-in caregiver
// gets CaregiverApp (keyed by household) or, without a household, CaregiverOnboardingScreen
// (join with an invite code or create one). Only devices get voice sessions and push
// registration (VoiceProvider is idle without a paired device). Nothing about the pairing or the
// role is stored locally, so an offline cold start shows "Connecting..." until Clerk and Convex
// answer. Stale notification taps are discarded while signed out. Shows a "Trying to reconnect"
// warning and voice errors as banners; __DEV__ builds add a DEV pill for developer settings.
// Provider order: SafeAreaProvider > ThemeProvider > ClerkProvider > ConvexProviderWithClerk >
// VoiceProvider.
//
// Last modified: 2026-10-31

import { ClerkProvider, useAuth } from '@clerk/expo';
import { tokenCache } from '@clerk/expo/token-cache';
import { ConvexProviderWithClerk } from 'convex/react-clerk';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useState } from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';

import { convex } from './src/backend/convex';
import type { PairedDevice, SessionDecision } from './src/backend/pairing';
import { useSession } from './src/backend/useSession';
import { CaregiverApp } from './src/caregiver/CaregiverApp';
import { Banner } from './src/components/Banner';
import { CLERK_PUBLISHABLE_KEY } from './src/config';
import { useDayView } from './src/day/useDayView';
import { discardStaleLaunchTap } from './src/notifications/push';
import { CaregiverOnboardingScreen } from './src/screens/CaregiverOnboardingScreen';
import { CaregiverSignInScreen } from './src/screens/CaregiverSignInScreen';
import { ConfigErrorScreen } from './src/screens/ConfigErrorScreen';
import { DevSettingsSheet } from './src/screens/DevSettingsSheet';
import { DisplayScreen } from './src/screens/DisplayScreen';
import { PairingScreen } from './src/screens/PairingScreen';
import { TodayScreen } from './src/screens/TodayScreen';
import { WelcomeScreen } from './src/screens/WelcomeScreen';
import { BACKGROUND, colors } from './src/theme/colors';
import { ThemeProvider, useTheme } from './src/theme/ThemeProvider';
import { ConversationScreen } from './src/voice/ConversationScreen';
import { useVoice, VoiceProvider } from './src/voice/VoiceProvider';

/**
 * purpose: The home surface of a paired device: the conversation while a voice session is
 *          live, otherwise Today (senior phone) or the display. It owns the day view, so
 *          the day stays loaded while the conversation replaces the home screen.
 * @param props: ({ paired: PairedDevice }) The device's pairing.
 * @return: (JSX.Element) The conversation or the home screen.
 */
function PairedHome({ paired }: { paired: PairedDevice }) {
  const voice = useVoice();
  const dayView = useDayView(paired.householdId);
  if (voice.isInteractive) return <ConversationScreen />;
  if (paired.kind === 'home_display') return <DisplayScreen dayView={dayView} />;
  return <TodayScreen dayView={dayView} />;
}

/**
 * purpose: The warning and error banners stacked at the top of the screen.
 * @return: (JSX.Element) The banners.
 */
function Banners() {
  const voice = useVoice();
  const insets = useSafeAreaInsets();
  const top = insets.top + (__DEV__ ? 40 : 4);
  return (
    <View pointerEvents="box-none" style={[styles.banners, { top }]}>
      {voice.connectionState === 'reconnecting' && (
        <Banner tone="moderate" title="Warning" message="Trying to reconnect" />
      )}
      {voice.error !== null && (
        <Banner tone="serious" title="Error" message={voice.error} onDismiss={voice.clearError} />
      )}
    </View>
  );
}

/**
 * purpose: Debug-only developer tools: a floating pill (top right) that opens the developer
 *          settings sheet in a modal.
 * @return: (JSX.Element) The pill and the modal.
 */
function DevTools() {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const [open, setOpen] = useState(false);
  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Open developer settings"
        onPress={() => setOpen(true)}
        style={[styles.pill, { top: insets.top + 8, borderColor: `${theme.accentColor}66` }]}
      >
        <View style={[styles.dot, { backgroundColor: theme.accentColor }]} />
        <Text style={styles.pillText}>DEV</Text>
      </Pressable>
      <Modal
        visible={open}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setOpen(false)}
      >
        <DevSettingsSheet onClose={() => setOpen(false)} />
      </Modal>
    </>
  );
}

/** The screens a signed-out user can move between. */
type SignedOutScreen = 'welcome' | 'caregiver' | 'device';

/**
 * purpose: The signed-out flow: the welcome choice, which leads to the caregiver sign-in or to
 *          device pairing, each with a way back.
 * @return: (JSX.Element) The current signed-out screen.
 */
function SignedOutFlow() {
  const [screen, setScreen] = useState<SignedOutScreen>('welcome');
  /**
   * purpose: Return to the welcome choice.
   * @return: (void) Nothing.
   */
  const back = (): void => setScreen('welcome');
  if (screen === 'caregiver') return <CaregiverSignInScreen onBack={back} />;
  if (screen === 'device') return <PairingScreen onBack={back} />;
  return (
    <WelcomeScreen
      onCaregiver={() => setScreen('caregiver')}
      onSeniorDevice={() => setScreen('device')}
    />
  );
}

/**
 * purpose: The screen for a settled session decision: the welcome flow, the paired home, the
 *          caregiver app or caregiver onboarding.
 * @param props: ({ decision }) The session decision; loading and removed are handled by Root.
 * @return: (JSX.Element) The screen.
 */
function SessionScreen({ decision }: { decision: SessionDecision }) {
  switch (decision.state) {
    case 'paired':
      return <PairedHome key={decision.device.householdId} paired={decision.device} />;
    case 'caregiver':
      return (
        <CaregiverApp
          key={decision.home.householdId}
          householdId={decision.home.householdId}
          role={decision.home.role}
        />
      );
    case 'caregiverOnboarding':
      return <CaregiverOnboardingScreen />;
    default:
      return <SignedOutFlow />;
  }
}

/**
 * purpose: The app shell inside the voice provider: the screen for the session, banners, dev
 *          tools.
 * @param props: ({ decision }) The session decision.
 * @return: (JSX.Element) The shell.
 */
function Shell({ decision }: { decision: SessionDecision }) {
  return (
    <View style={styles.root}>
      <SessionScreen decision={decision} />
      <Banners />
      {__DEV__ && <DevTools />}
    </View>
  );
}

/**
 * purpose: A calm placeholder while the connection or the pairing is being established.
 * @param props: ({ notice }) An optional one-line message shown under "Connecting...".
 * @return: (JSX.Element) The view.
 */
function LoadingView({ notice }: { notice?: string }) {
  return (
    <View style={[styles.root, styles.loading]}>
      <Text style={styles.loadingText}>Connecting...</Text>
      {notice !== undefined && <Text style={styles.loadingNotice}>{notice}</Text>}
    </View>
  );
}

/**
 * purpose: Follow the signed-in account (useSession) and host the voice provider, which is only
 *          given a device for a paired senior device.
 * @return: (JSX.Element) The loading view, or the shell for every other state.
 */
function Root() {
  const decision = useSession();
  const signedOut = decision.state === 'signedOut';

  useEffect(() => {
    if (signedOut) discardStaleLaunchTap();
  }, [signedOut]);

  if (decision.state === 'loading') return <LoadingView notice={decision.notice} />;
  if (decision.state === 'removed') return <LoadingView />;
  const paired = decision.state === 'paired' ? decision.device : null;
  return (
    <VoiceProvider pairedDevice={paired}>
      <Shell decision={decision} />
    </VoiceProvider>
  );
}

/**
 * purpose: Provide Clerk and Convex to the app, wired together so Convex calls carry the
 *          signed-in Clerk session.
 * @return: (JSX.Element) The provider tree around Root.
 */
function BackendProviders() {
  return (
    <ClerkProvider publishableKey={CLERK_PUBLISHABLE_KEY} tokenCache={tokenCache}>
      <ConvexProviderWithClerk client={convex} useAuth={useAuth}>
        <Root />
      </ConvexProviderWithClerk>
    </ClerkProvider>
  );
}

/**
 * purpose: The app root component registered by index.ts.
 * @return: (JSX.Element) The provider tree.
 */
export default function App() {
  return (
    <SafeAreaProvider>
      <ThemeProvider>
        <StatusBar style="dark" />
        {CLERK_PUBLISHABLE_KEY === '' ? <ConfigErrorScreen /> : <BackendProviders />}
      </ThemeProvider>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: BACKGROUND },
  loading: { alignItems: 'center', justifyContent: 'center' },
  loadingText: { fontSize: 20, color: colors.secondaryText },
  loadingNotice: { marginTop: 8, fontSize: 16, color: colors.secondaryText },
  banners: { position: 'absolute', left: 0, right: 0, gap: 8 },
  pill: {
    position: 'absolute',
    right: 16,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 999,
    borderWidth: 1,
    backgroundColor: colors.overlayStrong,
  },
  dot: { width: 8, height: 8, borderRadius: 4 },
  pillText: { fontFamily: 'Menlo', fontSize: 11, fontWeight: '700', color: colors.text },
});
