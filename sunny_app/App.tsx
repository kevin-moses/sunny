// sunny_app/App.tsx
//
// Purpose: Root of the Sunny app. Loads this device's pairing (the saved one, else the one
// restored from an existing session's devices row; a load failure counts as unpaired, and an
// unpaired start discards a stale notification tap), then shows PairingScreen
// when unpaired, TodayScreen on the senior phone, or DisplayScreen on the home display;
// while a voice conversation is live it shows ConversationScreen instead. The day view is
// loaded here, for the paired household, so it survives a conversation. Shows a
// "Trying to reconnect" warning and voice errors as banners. In __DEV__ builds a small
// floating DEV pill opens the developer settings sheet. Provider order: SafeAreaProvider
// > ThemeProvider > VoiceProvider.
//
// Last modified: 2026-10-28

import { StatusBar } from 'expo-status-bar';
import { useEffect, useState } from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  loadPairedDevice,
  restorePairing,
  subscribePairingLost,
  type PairedDevice,
} from './src/backend/pairing';
import { Banner } from './src/components/Banner';
import { useDayView } from './src/day/useDayView';
import { discardStaleLaunchTap } from './src/notifications/push';
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
 * purpose: The app shell inside the voice provider: pairing or home, banners, dev tools.
 * @param props: ({ paired, onPaired }) The pairing (null when unpaired) and the pairing callback.
 * @return: (JSX.Element) The shell.
 */
function Shell({
  paired,
  onPaired,
}: {
  paired: PairedDevice | null;
  onPaired: (device: PairedDevice) => void;
}) {
  return (
    <View style={styles.root}>
      {paired === null ? <PairingScreen onPaired={onPaired} /> : <PairedHome paired={paired} />}
      <Banners />
      {__DEV__ && <DevTools />}
    </View>
  );
}

/**
 * purpose: Load the saved pairing, follow pairing loss, and host the voice provider.
 * @return: (JSX.Element) A blank background until the pairing has loaded, then the shell.
 */
function Root() {
  // undefined until the saved pairing has loaded, then the pairing or null when unpaired.
  const [paired, setPaired] = useState<PairedDevice | null | undefined>(undefined);

  useEffect(() => {
    let active = true;
    loadPairedDevice()
      .then(async (saved) => saved ?? (await restorePairing()))
      .catch(() => null)
      .then((device) => {
        if (device === null) discardStaleLaunchTap();
        if (active) setPaired(device);
      });
    const unsubscribe = subscribePairingLost(() => setPaired(null));
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  if (paired === undefined) return <View style={styles.root} />;
  return (
    <VoiceProvider pairedDevice={paired}>
      <Shell paired={paired} onPaired={setPaired} />
    </VoiceProvider>
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
        <Root />
      </ThemeProvider>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: BACKGROUND },
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
