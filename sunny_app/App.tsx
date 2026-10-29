// sunny_app/App.tsx
//
// Purpose: Root of the Sunny app. Without a Clerk publishable key it shows a configuration
// error screen. Otherwise it wraps the app in ClerkProvider (session in the Keychain via
// Clerk's token cache) and ConvexProviderWithClerk (one client, Clerk "convex" JWT template),
// then follows usePairing: a calm "Connecting..." view (with a one-line notice when the backend
// cannot be reached) while Clerk, Convex auth or households.mine load and while a removed
// device is being unpaired, PairingScreen when Clerk has no session,
// otherwise the paired home: TodayScreen on the senior phone or DisplayScreen on the home
// display, or ConversationScreen while a voice conversation is live. The paired home is keyed
// by household and owns the day view so it survives a conversation. The pairing is not stored
// locally, so an offline cold start shows "Connecting..." until Clerk and Convex answer.
// Stale notification taps are discarded while unpaired. Shows a "Trying to reconnect"
// warning and voice errors as banners; __DEV__ builds add a DEV pill for developer settings.
// Provider order: SafeAreaProvider > ThemeProvider > ClerkProvider > ConvexProviderWithClerk >
// VoiceProvider.
//
// Last modified: 2026-10-29

import { ClerkProvider, useAuth } from '@clerk/expo';
import { tokenCache } from '@clerk/expo/token-cache';
import { ConvexProviderWithClerk } from 'convex/react-clerk';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useState } from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';

import { convex } from './src/backend/convex';
import type { PairedDevice } from './src/backend/pairing';
import { usePairing } from './src/backend/usePairing';
import { Banner } from './src/components/Banner';
import { CLERK_PUBLISHABLE_KEY } from './src/config';
import { useDayView } from './src/day/useDayView';
import { discardStaleLaunchTap } from './src/notifications/push';
import { ConfigErrorScreen } from './src/screens/ConfigErrorScreen';
import { DevSettingsSheet } from './src/screens/DevSettingsSheet';
import { DisplayScreen } from './src/screens/DisplayScreen';
import { PairingScreen } from './src/screens/PairingScreen';
import { TodayScreen } from './src/screens/TodayScreen';
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

/**
 * purpose: The app shell inside the voice provider: pairing screen or paired home, banners,
 *          dev tools.
 * @param props: ({ paired }) The pairing, or null when the device is unpaired.
 * @return: (JSX.Element) The shell.
 */
function Shell({ paired }: { paired: PairedDevice | null }) {
  return (
    <View style={styles.root}>
      {paired === null ? (
        <PairingScreen />
      ) : (
        <PairedHome key={paired.householdId} paired={paired} />
      )}
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
 * purpose: Follow the device's pairing (usePairing) and host the voice provider.
 * @return: (JSX.Element) The loading view, or the shell for an unpaired or paired device.
 */
function Root() {
  const pairing = usePairing();
  const unpaired = pairing.state === 'unpaired';

  useEffect(() => {
    if (unpaired) discardStaleLaunchTap();
  }, [unpaired]);

  if (pairing.state === 'loading') return <LoadingView notice={pairing.notice} />;
  if (pairing.state === 'removed') return <LoadingView />;
  const paired = pairing.state === 'paired' ? pairing.device : null;
  return (
    <VoiceProvider pairedDevice={paired}>
      <Shell paired={paired} />
    </VoiceProvider>
  );
}

/**
 * purpose: Provide Clerk and Convex to the app, wired together so Convex calls carry the
 *          device's Clerk session.
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
